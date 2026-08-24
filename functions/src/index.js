/**
 * functions/src/index.js
 * Firebase Cloud Functions — 1세대 callable, enforceAppCheck: false
 * 프로젝트: taerq-67005
 *
 * 웹 클라이언트에서 fnClient.httpsCallable("함수명") 으로 호출.
 * 모든 함수는 Firebase Auth 토큰이 있어야 호출 가능 (context.auth 검증).
 */

"use strict";

const functions = require("firebase-functions");
const admin     = require("firebase-admin");

admin.initializeApp({
    databaseURL: "https://taerq-67005-default-rtdb.firebaseio.com"
});

const db   = admin.database();
const auth = admin.auth();

// ── 공통 헬퍼 ─────────────────────────────────────────────────────────────────

/** 사번 정규화 — 소문자 + trim (웹 auth.js normalizeEmpNo 와 동일) */
function normalizeEmpNo(raw) {
    return String(raw || "").trim().toLowerCase();
}

/** 사번 → 가상이메일 (웹 auth.js empNoToEmail 와 동일) */
function empNoToEmail(empNo) {
    return normalizeEmpNo(empNo) + "@trinity-staff.internal";
}

/** 호출자 uid → users/{uid} 프로필 읽기 */
async function getCallerProfile(uid) {
    const snap = await db.ref("users/" + uid).once("value");
    return snap.exists() ? snap.val() : null;
}

function isPasswordChangeRequired(profile) {
    return !!(
        profile &&
        (
            profile.mustChangePassword === true ||
            profile.mustChangePassword === "true" ||
            profile.passwordResetRequired === true ||
            profile.passwordResetRequired === "true"
        )
    );
}

/** 관리자 권한 확인. admin은 deptId 일치 필요, super_admin은 무제한 */
async function assertAdmin(callerUid, deptId) {
    const profile = await getCallerProfile(callerUid);
    if (!profile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    const role = String(profile.role || "").toLowerCase();
    if (role !== "admin" && role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "관리자 권한 필요");
    if (role === "admin" && deptId) {
        if (String(profile.deptId || "").trim() !== deptId)
            throw new functions.https.HttpsError("permission-denied", "다른 지점 접근 불가");
    }
    return profile;
}

/**
 * publicCounters 재계산 — adminView/{yyyymm} 전체 집계.
 * ⚠️ publicCounters는 "월/특정일 휴무 제한(dayMax)"의 분자로 쓰인다 — 반드시
 * 휴무(normal) 신청만 세고, schedule/annual/petition은 절대 포함하지 않는다.
 * type 필드가 없는 legacy 데이터는 normal로 간주한다(하위호환, getNormalDayRequestCount와 동일 기준).
 */
async function recalcCounters(deptId, yyyymm, days) {
    const avSnap = await db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value");
    const avAll  = avSnap.val() || {};
    const updates = {};
    days.forEach(function(day) {
        const dayStr = String(parseInt(day, 10));
        let count = 0;
        Object.values(avAll).forEach(function(dayMap) {
            const req = dayMap && dayMap[dayStr];
            if (!req) return;
            if ((req.type || "normal") === "normal") count++;
        });
        const path = "departments/" + deptId + "/publicCounters/" + yyyymm + "/" + dayStr;
        updates[path] = count > 0 ? count : null;
    });
    if (Object.keys(updates).length > 0) await db.ref().update(updates);
}

function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj || {}, key);
}

function toIntOr(defaultValue, rawValue) {
    const num = parseInt(rawValue, 10);
    return Number.isFinite(num) ? num : defaultValue;
}

function getRequestLimitMessage(kind) {
    if (kind === "duplicate")
        return new functions.https.HttpsError("already-exists", "이미 신청된 날짜입니다.");
    if (kind === "closed")
        return new functions.https.HttpsError("resource-exhausted", "해당 일자는 신청 마감되었습니다.");
    return new functions.https.HttpsError("resource-exhausted", "신청 한도를 초과했습니다.");
}

/**
 * 조 편성(persistent groups) 관련 공통 헬퍼.
 *
 * ⚠️ RTDB는 빈 배열/빈 객체를 저장하면 그 경로 자체가 사라질 수 있으므로,
 * "persistent/groups 노드가 존재하는지"만으로는 "이미 persistent 방식으로
 * 전환되었는지"를 판단할 수 없다 (A~E를 전부 비운 상태와 아직 한 번도
 * migration되지 않은 상태를 구분할 수 없음). 따라서 반드시 명시적
 * _initialized 마커로만 판단한다.
 *   - _initialized === true  → persistent가 source of truth (A~E가 전부 비어도 유효)
 *   - _initialized 없음      → 과거(마커 도입 이전) 저장분과의 하위호환을 위해
 *                              A~E 중 실제 데이터가 하나라도 있으면 initialized로 인정
 *   - 둘 다 아니면            → 아직 migration되지 않은 상태 (legacy fallback 대상)
 */
function isPersistentGroupsInitialized(pers) {
    if (!pers) return false;
    if (pers._initialized === true) return true;
    return ["A", "B", "C", "D", "E"].some(function(g) {
        return Array.isArray(pers[g]) && pers[g].length > 0;
    });
}

function extractGroupsFromPersistent(pers) {
    const out = {};
    ["A", "B", "C", "D", "E"].forEach(function(g) {
        out[g] = (pers && Array.isArray(pers[g])) ? pers[g] : [];
    });
    return out;
}

/**
 * 조 편성(persistent groups)을 읽는다.
 * persistent/groups가 initialized 상태이면 그것을 source of truth로 사용하고,
 * 아직 migration되지 않은 지점은 과거 월별 설정(configs/{yyyymm}/groups)을
 * legacy fallback으로 사용한다 (실제 migration은 ensurePersistentGroups가 담당).
 */
async function getEffectiveGroups(deptId, cfg) {
    const persSnap = await db.ref("departments/" + deptId + "/persistent/groups").once("value");
    const pers = persSnap.val();
    if (isPersistentGroupsInitialized(pers)) return extractGroupsFromPersistent(pers);
    return cfg.groups || {};
}

/**
 * 날짜별 조별 휴무 제한(groupDayLimits) 사용 여부.
 * ⚠️ RTDB에서는 빈 객체 {}의 "존재 여부"로 모드를 판단하면 안 된다 — 관리자가
 * 날짜별 설정을 전부 개별 삭제하면 groupDayLimits 부모 노드 자체가 사라질 수
 * 있고, 그 순간 legacy groupMaxA~E가 다시 살아나는 문제가 생긴다.
 * 반드시 별도의 명시적 플래그(groupDayLimitsEnabled)로만 판단한다.
 */
function hasGroupDayLimits(cfg) {
    return cfg.groupDayLimitsEnabled === true;
}

/** 날짜별 조별 근무(코드) 제한(scGroupDayLimits) 사용 여부 — 위와 동일한 이유로 명시적 플래그로만 판단 */
function hasScGroupDayLimits(cfg) {
    return cfg.scGroupDayLimitsEnabled === true;
}

function findMemberGroups(groups, uid, empNo) {
    const matched = [];
    const uidStr = String(uid || "").trim();
    const empNoStr = normalizeEmpNo(empNo);

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        const members = Array.isArray(groups[group]) ? groups[group] : [];
        const exists = members.some(function(member) {
            const raw = String(member || "").trim();
            return raw === uidStr || normalizeEmpNo(raw) === empNoStr;
        });
        if (exists) matched.push(group);
    });
    return matched;
}

/**
 * 월/특정일 휴무 제한(dayMax/specialDayLimits) 판정 전용 카운트.
 * ⚠️ 반드시 휴무(normal) 신청만 센다 — schedule(근무코드)/annual(연차)/petition(청원)은
 * 절대 포함하지 않는다. type 필드가 없는 legacy 신청은 다른 곳(예: 프론트 _applyMyRequests,
 * getStaffDailyAvailability의 existingRequest.type)과 동일하게 `req.type || "normal"` 기준으로
 * normal로 간주해 하위호환을 유지한다.
 */
function getNormalDayRequestCount(ledger, day) {
    const dayStr = String(day);
    let count = 0;
    Object.keys(ledger || {}).forEach(function(uid) {
        const userDays = ledger[uid] || {};
        if (!(userDays && hasOwn(userDays, dayStr) && userDays[dayStr])) return;
        const req = userDays[dayStr];
        if ((req.type || "normal") === "normal") count++;
    });
    return count;
}

function getUserRequestCountByType(userDays, type, scheduleCode) {
    let count = 0;
    Object.keys(userDays || {}).forEach(function(day) {
        const req = userDays[day];
        if (!req) return;
        if (req.type !== type) return;
        if (type === "schedule" && scheduleCode && req.scheduleCode !== scheduleCode) return;
        count++;
    });
    return count;
}

function getGroupDayCount(ledger, groups, targetGroup, day, filterFn) {
    const members = Array.isArray(groups[targetGroup]) ? groups[targetGroup] : [];
    const memberSet = {};
    members.forEach(function(member) {
        const raw = String(member || "").trim();
        if (!raw) return;
        memberSet[raw] = true;
        memberSet[normalizeEmpNo(raw)] = true;
    });

    let count = 0;
    Object.keys(ledger || {}).forEach(function(uid) {
        const userDays = ledger[uid] || {};
        const dayReq = userDays[String(day)];
        if (!dayReq || !filterFn(dayReq)) return;

        if (memberSet[uid]) {
            count++;
            return;
        }
        const reqEmpNo = normalizeEmpNo(dayReq.empNo);
        if (reqEmpNo && memberSet[reqEmpNo]) count++;
    });
    return count;
}

async function validateAndStageRequest(deptId, yyyymm, day, uid, profile, type, scheduleCode) {
    const cfgSnap = await db.ref("departments/" + deptId + "/configs/" + yyyymm).once("value");
    const cfg = cfgSnap.val() || {};
    const ledgerRef = db.ref("requestsLedger/" + deptId + "/" + yyyymm);
    const dayStr = String(day);
    const empNo = normalizeEmpNo(profile.empNo);
    const name = profile.legacyName || profile.name || uid;
    const ts = Date.now();
    const reqData = { type, ts, name, empNo };
    if (type === "schedule" && scheduleCode) reqData.scheduleCode = scheduleCode;

    const userLimitCfg = (cfg.userLimits || {})[uid] || {};
    const groups = await getEffectiveGroups(deptId, cfg);
    const matchedGroups = findMemberGroups(groups, uid, empNo);
    const dayMax = toIntOr(10, cfg.dayMax);
    const specialLimitRaw = cfg.specialDayLimits && hasOwn(cfg.specialDayLimits, dayStr) ? cfg.specialDayLimits[dayStr] : null;
    const effectiveDayLimit = specialLimitRaw != null ? toIntOr(dayMax, specialLimitRaw) : dayMax;

    let rejectError = null;
    const txResult = await ledgerRef.transaction(function(current) {
        if (rejectError) return;
        const ledger = current || {};
        const userDays = ledger[uid] || {};
        if (hasOwn(userDays, dayStr) && userDays[dayStr]) {
            rejectError = getRequestLimitMessage("duplicate");
            return;
        }

        if (type === "normal") {
            const dayCount = getNormalDayRequestCount(ledger, dayStr);
            if (dayCount >= effectiveDayLimit) {
                rejectError = getRequestLimitMessage("closed");
                return;
            }

            const personalLimit = userLimitCfg.globalUserMax != null
                ? toIntOr(0, userLimitCfg.globalUserMax)
                : toIntOr(4, cfg.globalUserMax);
            const normalCount = getUserRequestCountByType(userDays, "normal");
            if (normalCount >= personalLimit) {
                rejectError = getRequestLimitMessage("limit");
                return;
            }

            const useGroupDayLimits = hasGroupDayLimits(cfg);
            const exceedsGroup = matchedGroups.some(function(group) {
                let limit;
                if (useGroupDayLimits) {
                    // 날짜별 조별 휴무 제한이 켜진 달: 해당 날짜에 설정된 조 제한이 없으면 거부하지 않음
                    const dayLimits = (cfg.groupDayLimits || {})[dayStr];
                    if (!dayLimits || !hasOwn(dayLimits, group) || dayLimits[group] == null) return false;
                    limit = toIntOr(0, dayLimits[group]);
                } else {
                    // legacy: 월 전체 공통 조별 한도
                    limit = toIntOr(2, cfg["groupMax" + group]);
                }
                const count = getGroupDayCount(ledger, groups, group, dayStr, function(req) {
                    return req && req.type === "normal";
                });
                return count >= limit;
            });
            if (exceedsGroup) {
                rejectError = getRequestLimitMessage("limit");
                return;
            }
        } else if (type === "annual") {
            const annualLimit = userLimitCfg.annualQuota != null
                ? toIntOr(0, userLimitCfg.annualQuota)
                : toIntOr(15, cfg.annualUserMax);
            const annualCount = getUserRequestCountByType(userDays, "annual");
            if (annualCount >= annualLimit) {
                rejectError = getRequestLimitMessage("limit");
                return;
            }
        } else if (type === "schedule") {
            if (!scheduleCode) {
                rejectError = new functions.https.HttpsError("invalid-argument", "scheduleCode 필요");
                return;
            }
            const scheduleCodes = Array.isArray(cfg.scheduleCodes) ? cfg.scheduleCodes : [];
            const scheduleItem = scheduleCodes.find(function(item) { return item && item.name === scheduleCode; });
            if (!scheduleItem) {
                rejectError = new functions.https.HttpsError("invalid-argument", "유효하지 않은 스케줄 코드입니다.");
                return;
            }
            const scheduleLimit = toIntOr(999, scheduleItem.limit);
            const myScheduleCount = getUserRequestCountByType(userDays, "schedule", scheduleCode);
            if (myScheduleCount >= scheduleLimit) {
                rejectError = getRequestLimitMessage("limit");
                return;
            }

            const useScGroupDayLimits = hasScGroupDayLimits(cfg);
            const exceedsGroupCode = matchedGroups.some(function(group) {
                const key = scheduleCode + "_" + group;
                let limit;
                if (useScGroupDayLimits) {
                    // 날짜별 조별 근무(코드) 제한이 켜진 달: 해당 날짜에 설정된 제한이 없으면 거부하지 않음
                    const dayLimits = (cfg.scGroupDayLimits || {})[dayStr];
                    if (!dayLimits || !hasOwn(dayLimits, key) || dayLimits[key] == null) return false;
                    limit = toIntOr(0, dayLimits[key]);
                } else {
                    // legacy: 월 전체 공통 코드별 조 한도
                    if (!cfg.scGroupLimits || !hasOwn(cfg.scGroupLimits, key)) return false;
                    limit = toIntOr(0, cfg.scGroupLimits[key]);
                }
                const count = getGroupDayCount(ledger, groups, group, dayStr, function(req) {
                    return req && req.type === "schedule" && req.scheduleCode === scheduleCode;
                });
                return count >= limit;
            });
            if (exceedsGroupCode) {
                rejectError = getRequestLimitMessage("limit");
                return;
            }
        } else if (type !== "petition") {
            rejectError = new functions.https.HttpsError("invalid-argument", "지원하지 않는 신청 유형입니다.");
            return;
        }

        const next = Object.assign({}, ledger);
        next[uid] = Object.assign({}, userDays, { [dayStr]: reqData });
        return next;
    });

    if (!txResult.committed) throw (rejectError || new functions.https.HttpsError("aborted", "신청 저장에 실패했습니다."));
    return reqData;
}

const RUN_OPTS = { enforceAppCheck: false };

// ── 1. submitRequest — 직원 신청 ──────────────────────────────────────────────
exports.submitRequest = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const uid    = context.auth.uid;
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const day    = String(parseInt(data.day || "0", 10));
    const type   = String(data.type   || "normal");
    const scheduleCode = data.scheduleCode ? String(data.scheduleCode).trim() : null;

    if (!deptId || !yyyymm || !day) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const profile = await getCallerProfile(uid);
    if (!profile) throw new functions.https.HttpsError("not-found", "프로필 없음");
    if (String(profile.deptId || "").trim() !== deptId)
        throw new functions.https.HttpsError("permission-denied", "다른 지점 신청은 허용되지 않습니다.");

    const reqData = await validateAndStageRequest(deptId, yyyymm, day, uid, profile, type, scheduleCode);

    const updates = {};
    updates["userRequests/" + uid + "/" + yyyymm + "/" + day] = reqData;
    updates["departments/" + deptId + "/adminView/" + yyyymm + "/" + uid + "/" + day] = reqData;
    await db.ref().update(updates);
    await recalcCounters(deptId, yyyymm, [day]);

    return { ok: true };
});

// ── 2. cancelRequest — 직원 본인 취소 ────────────────────────────────────────
exports.cancelRequest = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const uid    = context.auth.uid;
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const day    = String(parseInt(data.day || "0", 10));

    if (!deptId || !yyyymm || !day) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const avPath  = "departments/" + deptId + "/adminView/" + yyyymm + "/" + uid + "/" + day;
    const avSnap  = await db.ref(avPath).once("value");
    const hadEntry = avSnap.exists();

    const updates = {};
    updates["userRequests/" + uid + "/" + yyyymm + "/" + day] = null;
    updates[avPath] = null;
    updates["requestsLedger/" + deptId + "/" + yyyymm + "/" + uid + "/" + day] = null;
    await db.ref().update(updates);

    if (hadEntry) await recalcCounters(deptId, yyyymm, [day]);

    return { ok: true };
});

// ── 3. adminCancelRequest — 관리자 타인 취소 ─────────────────────────────────
const { adminCancelRequest } = require("./adminCancelRequest");
exports.adminCancelRequest = adminCancelRequest;

// ── 4. saveDeptConfig — 관리자 설정 저장 ─────────────────────────────────────
/**
 * configs/{yyyymm} 전체 객체에서 직원(staff)에게 노출해도 안전한 필드만 남긴 사본을
 * 만든다. departments/{deptId}/staffConfig/{yyyymm}에 미러링되어, 직원 realtime
 * listener는 이 sanitized path만 읽는다.
 * ⚠️ configs/{yyyymm} 자체의 RTDB .read는 admin/super_admin 전용으로 제한했으므로,
 * 이 미러가 없으면 직원 대시보드의 실시간 dayMax/특정일 제한/신청기간 등이 전부
 * 끊긴다 — database.rules.json 변경과 반드시 함께 적용해야 하는 짝 변경이다.
 *
 * ⚠️ blacklist(userLimits만 제거)가 아니라 explicit allowlist를 사용한다 — configs에
 * 앞으로 새로운 관리자 전용/민감 필드가 추가돼도 이 목록에 명시적으로 추가하지 않는 한
 * staffConfig에는 절대 노출되지 않는 것이 안전 기본값이다. 목록은 js/firebase-store.js의
 * _applyCfgToLiveData()가 실제로 읽는 필드 전체(userLimits 제외)와 정확히 일치시킨다.
 */
var STAFF_CONFIG_ALLOWLIST = [
    "openAt", "closeAt", "dayMax", "globalUserMax", "annualUserMax", "targetYearMonth",
    "groupMaxA", "groupMaxB", "groupMaxC", "groupMaxD", "groupMaxE",
    "scheduleCodes", "specialDayLimits", "scGroupLimits",
    "groupDayLimits", "groupDayLimitsEnabled",
    "scGroupDayLimits", "scGroupDayLimitsEnabled",
    "groups" // legacy fallback — persistent groups 미전환 지점에서만 _applyCfgToLiveData가 사용
];

function _buildStaffSafeConfig(merged) {
    const safe = {};
    STAFF_CONFIG_ALLOWLIST.forEach(function(key) {
        if (Object.prototype.hasOwnProperty.call(merged, key)) safe[key] = merged[key];
    });
    return safe;
}

exports.saveDeptConfig = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const config = data.config || {};

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    const cfgPath = "departments/" + deptId + "/configs/" + yyyymm;
    const cfgSnap = await db.ref(cfgPath).once("value");
    const existing = cfgSnap.val() || {};

    // null 값은 삭제, 나머지는 병합
    const merged = Object.assign({}, existing);
    Object.keys(config).forEach(function(k) {
        if (config[k] === null) delete merged[k];
        else merged[k] = config[k];
    });

    const updates = {};
    updates[cfgPath] = merged;
    updates["departments/" + deptId + "/staffConfig/" + yyyymm] = _buildStaffSafeConfig(merged);
    await db.ref().update(updates);
    return { ok: true };
});

// ── 5. setSpecialDayLimit — 특정일 한도 ──────────────────────────────────────
exports.setSpecialDayLimit = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const day    = String(parseInt(data.day || "0", 10));
    const limit  = data.limit === null ? null : parseInt(data.limit, 10);

    if (!deptId || !yyyymm || !day) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    // specialDayLimits는 staffConfig 미러에도 포함되므로 두 경로를 함께 갱신한다.
    const updates = {};
    updates["departments/" + deptId + "/configs/" + yyyymm + "/specialDayLimits/" + day] = limit;
    updates["departments/" + deptId + "/staffConfig/" + yyyymm + "/specialDayLimits/" + day] = limit;
    await db.ref().update(updates);
    return { ok: true };
});

// ── 5b. backfillStaffConfig — 기존 configs → staffConfig 1회성 안전 백필 ──────
// ⚠️ saveDeptConfig({config:{}})를 재사용하지 않는 이유: saveDeptConfig는 매번
// configs/{yyyymm}를 "읽고 → 병합 → 다시 쓰는" 라운드트립을 거치므로, 다른 관리자가
// 그 사이에 실제로 저장한 값이 있으면 그 변경분을 되돌려 쓰는 lost-update 경쟁
// 상태가 이론적으로 발생할 수 있다(백필 자체는 내용을 안 바꾸려는 의도라도, 구현이
// read-then-write 라운드트립인 이상 이 위험은 사라지지 않는다).
// 이 함수는 configs/{yyyymm}를 오직 읽기만 하고 절대 다시 쓰지 않으며, 파생 데이터인
// staffConfig/{yyyymm}만(동일한 STAFF_CONFIG_ALLOWLIST 기준으로) (재)생성한다 —
// 원본(configs)을 전혀 건드리지 않으므로 몇 번을 실행해도 안전하고(idempotent),
// 동시성 문제가 없다. 배포 순서상 "Functions 배포 → 이 함수로 backfill → Rules 배포"
// 로 staffConfig를 먼저 채워둔 뒤에 staff의 configs 직접 read를 막을 수 있다.
exports.backfillStaffConfig = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    const cfgSnap = await db.ref("departments/" + deptId + "/configs/" + yyyymm).once("value");
    const existing = cfgSnap.val() || {};
    const staffSafe = _buildStaffSafeConfig(existing);

    await db.ref("departments/" + deptId + "/staffConfig/" + yyyymm).set(staffSafe);
    return { ok: true, fields: Object.keys(staffSafe) };
});

// ── 6. setUserLimit — 직원별 한도 ────────────────────────────────────────────
exports.setUserLimit = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId      = String(data.deptId || "").trim();
    const yyyymm      = String(data.yyyymm || "").trim();
    const targetEmpNo = normalizeEmpNo(data.targetEmpNo);
    const limitType   = String(data.limitType || "globalUserMax");
    const count       = data.count === null ? null : parseInt(data.count, 10);

    if (!deptId || !yyyymm || !targetEmpNo) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    // uid 조회
    const email = empNoToEmail(targetEmpNo);
    let targetUid;
    try {
        const userRecord = await auth.getUserByEmail(email);
        targetUid = userRecord.uid;
    } catch (e) {
        throw new functions.https.HttpsError("not-found", "해당 사번의 계정 없음: " + targetEmpNo);
    }

    const path = "departments/" + deptId + "/configs/" + yyyymm + "/userLimits/" + targetUid + "/" + limitType;
    await db.ref(path).set(count);
    return { ok: true };
});

// ── 7. resetAllRequests — 전체 신청 초기화 ───────────────────────────────────
exports.resetAllRequests = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    // adminView에서 모든 uid 목록 가져와서 userRequests도 삭제
    const avSnap = await db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value");
    const avAll  = avSnap.val() || {};
    const updates = {};

    Object.keys(avAll).forEach(function(uid) {
        updates["userRequests/" + uid + "/" + yyyymm] = null;
        updates["requestsLedger/" + deptId + "/" + yyyymm + "/" + uid] = null;
    });
    updates["departments/" + deptId + "/adminView/" + yyyymm] = null;
    updates["departments/" + deptId + "/publicCounters/" + yyyymm] = null;

    await db.ref().update(updates);
    return { ok: true };
});

// ── 8. resetEmployeePassword — 직원 비밀번호 초기화 ──────────────────────────
// ⚠️ 권한 검증(role/deptId 비교)이 전부 끝나기 전에는 절대 target Auth 계정을
// 건드리지 않는다. assertAdmin(uid, null)은 호출자가 admin/super_admin인지만
// 확인하며, target의 role/deptId는 target profile을 조회한 뒤 별도로 검증한다.
//   - 일반 admin: 자기 지점(deptId)의 role=staff 계정만 초기화 가능.
//   - super_admin: staff/admin 계정 초기화 가능, 다른 super_admin 계정은 금지.
exports.resetEmployeePassword = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await assertAdmin(context.auth.uid, null); // super_admin or admin
    const callerRole = String(callerProfile.role || "").toLowerCase();

    const empNo      = normalizeEmpNo(data.empNo);
    const newPassword = String(data.newPassword || "").trim();
    if (!empNo || newPassword.length < 6) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const email = empNoToEmail(empNo);
    let targetUid;
    try {
        const rec = await auth.getUserByEmail(email);
        targetUid = rec.uid;
    } catch (e) {
        throw new functions.https.HttpsError("not-found", "해당 사번 없음: " + empNo);
    }

    const targetProfile = await getCallerProfile(targetUid);
    if (!targetProfile) throw new functions.https.HttpsError("not-found", "대상 직원 프로필을 찾을 수 없습니다.");
    const targetRole = String(targetProfile.role || "staff").toLowerCase();
    const targetDept = String(targetProfile.deptId || "").trim();

    if (callerRole === "admin") {
        if (targetRole !== "staff")
            throw new functions.https.HttpsError("permission-denied", "일반 관리자는 직원(staff) 계정만 초기화할 수 있습니다.");
        if (targetDept !== String(callerProfile.deptId || "").trim())
            throw new functions.https.HttpsError("permission-denied", "다른 지점의 계정은 초기화할 수 없습니다.");
    } else if (callerRole === "super_admin") {
        if (targetRole === "super_admin")
            throw new functions.https.HttpsError("permission-denied", "다른 슈퍼관리자 계정은 초기화할 수 없습니다.");
    }

    await auth.updateUser(targetUid, { password: newPassword });
    await db.ref("users/" + targetUid).update({
        mustChangePassword: true,
        passwordResetRequired: true
    });
    return { ok: true };
});

exports.completeInitialPasswordChange = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");

    const uid = context.auth.uid;
    const newPassword = String(data.newPassword || "").trim();
    if (newPassword.length < 6)
        throw new functions.https.HttpsError("invalid-argument", "새 비밀번호는 6자 이상이어야 합니다.");

    const profile = await getCallerProfile(uid);
    if (!profile) throw new functions.https.HttpsError("not-found", "프로필 없음");
    if (!isPasswordChangeRequired(profile)) return { ok: true, alreadyCompleted: true };

    await auth.updateUser(uid, { password: newPassword });
    await db.ref("users/" + uid).update({
        mustChangePassword: false,
        passwordResetRequired: false
    });
    return { ok: true };
});

// ── 9. createEmployee — 직원 개별 생성 ───────────────────────────────────────
// ⚠️ deptId 교차 지점 생성은 assertAdmin(uid, deptId)의 dept 비교로 이미 차단되지만
// (admin이 자기 deptId와 다른 deptId를 보내면 즉시 permission-denied), role은
// 전혀 검증되지 않아 일반 admin이 role="admin"/"super_admin"을 보내는 권한 상승이
// 가능했다. role 화이트리스트 + 호출자 role별 생성 가능 role을 auth.createUser()
// 이전에 강제한다(super_admin role은 이 함수로 생성 불가 — 별도 정책 없음).
exports.createEmployee = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await assertAdmin(context.auth.uid, data.deptId ? String(data.deptId).trim() : null);
    const callerRole = String(callerProfile.role || "").toLowerCase();

    const empNo        = normalizeEmpNo(data.empNo);
    const name         = String(data.name         || "").trim();
    const deptId       = String(data.deptId       || "").trim();
    const role         = String(data.role         || "staff").toLowerCase();
    const tempPassword = String(data.tempPassword || "").trim();

    if (!empNo || !name || !deptId || tempPassword.length < 6)
        throw new functions.https.HttpsError("invalid-argument", "필수값 누락 (empNo, name, deptId, tempPassword 6자↑)");

    if (["staff", "admin", "super_admin"].indexOf(role) === -1)
        throw new functions.https.HttpsError("invalid-argument", "유효하지 않은 role입니다.");
    if (role === "super_admin")
        throw new functions.https.HttpsError("permission-denied", "super_admin 계정은 이 기능으로 생성할 수 없습니다.");
    if (callerRole === "admin" && role !== "staff")
        throw new functions.https.HttpsError("permission-denied", "일반 관리자는 staff 계정만 생성할 수 있습니다.");

    const email = empNoToEmail(empNo);

    let userRecord;
    try {
        userRecord = await auth.createUser({ email, password: tempPassword, displayName: name });
    } catch (e) {
        if (e.code === "auth/email-already-exists")
            throw new functions.https.HttpsError("already-exists", "이미 존재하는 사번: " + empNo);
        throw new functions.https.HttpsError("internal", e.message);
    }

    await db.ref("users/" + userRecord.uid).set({
        empNo, name, deptId, role,
        legacyName: name,
        createdAt: Date.now(),
        mustChangePassword: true,
        passwordResetRequired: true
    });

    return { ok: true, uid: userRecord.uid };
});

// ── 10. bulkCreateEmployees — 직원 일괄 생성 ─────────────────────────────────
// ⚠️ assertAdmin(uid, null)은 호출자가 admin/super_admin인지만 확인하고 deptId는
// 비교하지 않는다 — 기존 코드는 이후 각 row의 deptId/role을 전혀 검증하지 않아,
// 일반 admin이 Excel/payload에 다른 지점 deptId나 admin/super_admin role을 섞어
// 보내면 그대로 생성되는 권한 상승 취약점이 있었다. 각 row마다 auth.createUser()
// 이전에 반드시 권한 검증을 수행하고, 위반 row는 계정을 만들지 않은 채
// ok:false로만 기록한다(기존 "행별 성공/실패, 나머지는 계속 처리" 정책은 유지).
exports.bulkCreateEmployees = functions.runWith({ ...RUN_OPTS, timeoutSeconds: 300 }).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await assertAdmin(context.auth.uid, null);
    const callerRole = String(callerProfile.role || "").toLowerCase();
    const callerDept = String(callerProfile.deptId || "").trim();

    const rows = Array.isArray(data.rows) ? data.rows : [];
    if (rows.length === 0) throw new functions.https.HttpsError("invalid-argument", "rows가 비어있음");

    const results = [];
    let rowIndex = 0;
    for (const row of rows) {
        rowIndex++;
        const empNo        = normalizeEmpNo(row.empNo);
        const name         = String(row.name         || "").trim();
        const deptId       = String(row.deptId       || "").trim();
        const role         = String(row.role         || "staff").toLowerCase();
        const tempPassword = String(row.tempPassword || "").trim();
        const recoveryEmail = row.recoveryEmail ? String(row.recoveryEmail).trim() : null;

        if (!empNo || !name || !deptId || tempPassword.length < 6) {
            results.push({ ok: false, empNo, error: "필수값 누락" });
            continue;
        }
        if (["staff", "admin", "super_admin"].indexOf(role) === -1) {
            results.push({ ok: false, empNo, error: "유효하지 않은 role입니다." });
            continue;
        }
        if (role === "super_admin") {
            results.push({ ok: false, empNo, error: "super_admin 계정은 이 기능으로 생성할 수 없습니다." });
            continue;
        }
        if (callerRole === "admin") {
            if (deptId !== callerDept) {
                results.push({ ok: false, empNo, error: "다른 지점 직원은 생성할 수 없습니다." });
                continue;
            }
            if (role !== "staff") {
                results.push({ ok: false, empNo, error: "일반 관리자는 staff 계정만 생성할 수 있습니다." });
                continue;
            }
        }
        const email = empNoToEmail(empNo);
        try {
            const rec = await auth.createUser({ email, password: tempPassword, displayName: name });
            const profile = {
                empNo,
                name,
                deptId,
                role,
                legacyName: name,
                createdAt: Date.now(),
                mustChangePassword: true,
                passwordResetRequired: true,
                sortOrder: (row.sortOrder != null ? Number(row.sortOrder) : rowIndex)
            };
            if (recoveryEmail) profile.recoveryEmail = recoveryEmail;
            await db.ref("users/" + rec.uid).set(profile);
            results.push({ ok: true, empNo, uid: rec.uid });
        } catch (e) {
            results.push({ ok: false, empNo, error: e.message });
        }
    }
    return { results };
});

// ── 11. deleteEmployee — 직원 삭제 ───────────────────────────────────────────
exports.deleteEmployee = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile || callerProfile.role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "슈퍼관리자 전용");

    const empNo = normalizeEmpNo(data.empNo);
    if (!empNo) throw new functions.https.HttpsError("invalid-argument", "empNo 필요");
    if (empNo === "sa001")
        throw new functions.https.HttpsError("failed-precondition", "기본 슈퍼관리자 계정은 삭제할 수 없습니다.");

    const email = empNoToEmail(empNo);
    let uid;
    try {
        const rec = await auth.getUserByEmail(email);
        uid = rec.uid;
    } catch (e) {
        throw new functions.https.HttpsError("not-found", "해당 사번 없음: " + empNo);
    }
    if (uid === context.auth.uid)
        throw new functions.https.HttpsError("failed-precondition", "현재 로그인한 슈퍼관리자 본인은 삭제할 수 없습니다.");

    await auth.deleteUser(uid);
    await db.ref("users/" + uid).remove();
    return { ok: true };
});

// ── 12. saveGroupAssignment — 조별 배정 저장 (지점 공통 영구 설정) ───────────
// ⚠️ 조 편성은 더 이상 "월별 설정"이 아니다. departments/{deptId}/persistent/groups
//    에 저장되며, 신청 대상 월(yyyymm)이 바뀌어도 그대로 유지된다.
//    yyyymm 파라미터는 과거 클라이언트와의 호환을 위해 계속 받지만 저장 경로에는
//    더 이상 사용하지 않는다.
exports.saveGroupAssignment = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const groups = data.groups || {};

    if (!deptId) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    // _initialized: true — 관리자가 조 편성을 한 번이라도 저장하면 이 지점은
    // persistent 방식으로 전환된 것으로 명시 확정한다. A~E를 전부 비운 채
    // 저장해도(=RTDB에서 A~E 키 자체가 사라져도) _initialized만은 남아있으므로
    // "아직 migration 안 됨"과 절대 혼동되지 않는다.
    const normalized = { _initialized: true };
    ["A", "B", "C", "D", "E"].forEach(function(g) {
        normalized[g] = Array.isArray(groups[g]) ? groups[g] : [];
    });

    await db.ref("departments/" + deptId + "/persistent/groups").set(normalized);
    return { ok: true, groups: extractGroupsFromPersistent(normalized) };
});

// ── 12b. ensurePersistentGroups — legacy 월별 조 편성을 persistent로 1회 migration ──
// 관리자가 별도 작업을 하지 않아도, 아직 persistent 방식으로 전환되지 않은 지점의
// 조 편성을 서버가 안전하게 옮겨준다. 클라이언트는 임의의 groups 데이터를 보낼 수
// 없고(요청 바디의 groups는 사용하지 않음), 서버가 기존 DB의 legacy 데이터를 읽어
// persistent로 옮기는 역할만 한다. staff도 호출 가능하지만 반드시 자기 지점에
// 한해서만 동작한다 (assertAdmin이 아닌 별도의 "본인 지점" 검증 사용).
exports.ensurePersistentGroups = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    if (!deptId) throw new functions.https.HttpsError("invalid-argument", "deptId 필요");

    const profile = await getCallerProfile(context.auth.uid);
    if (!profile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    const role = String(profile.role || "").toLowerCase();
    if (role !== "super_admin") {
        if (String(profile.deptId || "").trim() !== deptId)
            throw new functions.https.HttpsError("permission-denied", "다른 지점 접근 불가");
    }

    const groupsRef = db.ref("departments/" + deptId + "/persistent/groups");
    const persSnap = await groupsRef.once("value");
    const pers = persSnap.val();

    if (pers && pers._initialized === true) {
        return { ok: true, migrated: false, groups: extractGroupsFromPersistent(pers) };
    }

    if (pers && isPersistentGroupsInitialized(pers)) {
        // 하위호환: marker 도입 이전에 이미 실제 조 편성이 저장돼 있던 지점 — marker만 보완
        await groupsRef.update({ _initialized: true });
        return { ok: true, migrated: false, groups: extractGroupsFromPersistent(pers) };
    }

    // ── 아직 persistent 방식으로 전환되지 않은 지점: legacy configs/{yyyymm}/groups 검색 ──
    function hasAnyMember(g) {
        return !!g && ["A", "B", "C", "D", "E"].some(function(k) {
            return Array.isArray(g[k]) && g[k].length > 0;
        });
    }

    const yyyymm = String(data.yyyymm || "").trim();
    let legacyGroups = null;

    if (/^\d{6}$/.test(yyyymm)) {
        const curSnap = await db.ref("departments/" + deptId + "/configs/" + yyyymm + "/groups").once("value");
        const curGroups = curSnap.val();
        if (hasAnyMember(curGroups)) legacyGroups = curGroups;
    }

    if (!legacyGroups) {
        const configsSnap = await db.ref("departments/" + deptId + "/configs").once("value");
        const configsAll = configsSnap.val() || {};
        const candidates = Object.keys(configsAll)
            .filter(function(k) { return /^\d{6}$/.test(k); })
            .sort()
            .reverse(); // 최신 월부터 검색
        for (const ym of candidates) {
            const g = configsAll[ym] && configsAll[ym].groups;
            if (hasAnyMember(g)) { legacyGroups = g; break; }
        }
    }

    const normalized = { _initialized: true };
    ["A", "B", "C", "D", "E"].forEach(function(g) {
        normalized[g] = (legacyGroups && Array.isArray(legacyGroups[g])) ? legacyGroups[g] : [];
    });

    await groupsRef.set(normalized);
    return { ok: true, migrated: !!legacyGroups, groups: extractGroupsFromPersistent(normalized) };
});

// ── 13. getSuperAdminSummary — 슈퍼관리자 현황 ───────────────────────────────
exports.getSuperAdminSummary = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile || callerProfile.role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "슈퍼관리자 전용");

    const yyyymm = String(data.yyyymm || "").trim();
    if (!yyyymm) throw new functions.https.HttpsError("invalid-argument", "yyyymm 필요");

    const snap = await db.ref("departments").once("value");
    const depts = snap.val() || {};
    const summary = {};

    Object.keys(depts).forEach(function(dept) {
        const counters = (depts[dept].publicCounters || {})[yyyymm] || {};
        if (Object.keys(counters).length > 0) summary[dept] = counters;
    });

    return { summary };
});

// ── 14. listDepartments — 지점 목록 ──────────────────────────────────────────
exports.listDepartments = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile || callerProfile.role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "슈퍼관리자 전용");

    const snap = await db.ref("departments").once("value");
    const departments = snap.exists() ? Object.keys(snap.val()) : [];
    return { departments };
});

// ── 15. listDeptEmployees — 지점 직원 목록 ───────────────────────────────────
exports.listDeptEmployees = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    if (!deptId) throw new functions.https.HttpsError("invalid-argument", "deptId 필요");
    await assertAdmin(context.auth.uid, deptId);

    const snap = await db.ref("users").orderByChild("deptId").equalTo(deptId).once("value");
    const employees = [];
    snap.forEach(function(child) {
        const p = child.val();
        const role = String(p.role || "staff").toLowerCase();
        // admin/super_admin 계정은 운영 직원 목록에서 제외.
        // 비밀번호 초기화 등 별도 기능은 empNo→email 직접 조회를 사용하므로 영향 없음.
        if (role !== "staff") return;
        employees.push({
            uid:       child.key,
            empNo:     p.empNo || "",
            name:      p.legacyName || p.name || "",
            role:      role,
            deptId:    p.deptId || "",
            sortOrder: (p.sortOrder != null ? Number(p.sortOrder) : null)
        });
    });
    return { employees };
});

// ── 16. uploadAnnualQuotas — 연차 일괄 업로드 ────────────────────────────────
exports.uploadAnnualQuotas = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const rows   = Array.isArray(data.rows) ? data.rows : [];

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    const errors = [];
    const updates = {};

    for (const row of rows) {
        const empNo = normalizeEmpNo(row.empNo);
        const quota = parseInt(row.quota, 10);
        if (!empNo || isNaN(quota) || quota < 0) {
            errors.push({ empNo, error: "올바르지 않은 값" });
            continue;
        }
        const email = empNoToEmail(empNo);
        try {
            const rec = await auth.getUserByEmail(email);
            updates["departments/" + deptId + "/configs/" + yyyymm + "/userLimits/" + rec.uid + "/annualQuota"] = quota;
        } catch (e) {
            errors.push({ empNo, error: "계정 없음" });
        }
    }

    if (Object.keys(updates).length > 0) await db.ref().update(updates);
    return { ok: true, errors };
});

// ── 17. resyncDerivedData — 파생 데이터 재동기화 ─────────────────────────────
exports.resyncDerivedData = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    // adminView 전체를 읽어 publicCounters 재계산.
    // ⚠️ publicCounters는 휴무(normal) 제한의 분자다 — schedule/annual/petition은 제외하고,
    // type 필드가 없는 legacy 신청은 normal로 간주한다(recalcCounters/getNormalDayRequestCount와 동일 기준).
    const avSnap = await db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value");
    const avAll  = avSnap.val() || {};
    const dayCounts = {};

    Object.values(avAll).forEach(function(dayMap) {
        Object.keys(dayMap || {}).forEach(function(day) {
            const req = dayMap[day];
            if (!req) return;
            if ((req.type || "normal") !== "normal") return;
            dayCounts[day] = (dayCounts[day] || 0) + 1;
        });
    });

    const counterPath = "departments/" + deptId + "/publicCounters/" + yyyymm;
    await db.ref(counterPath).set(Object.keys(dayCounts).length > 0 ? dayCounts : null);
    return { ok: true };
});

// ── 19. bulkDeleteEmployees — 직원 일괄 삭제 (슈퍼관리자 전용) ─────────────────
// 클라이언트에서 엑셀로 업로드한 사번 목록을 받아 일괄 삭제한다.
// 각 항목별로 성공/실패 사유를 반환하며, 중간 실패가 있어도 나머지 항목은 계속 처리한다.
// 보호 조건(서버에서 강제):
//   - 호출자가 super_admin이어야 함
//   - sa001 삭제 불가
//   - 호출자 본인 삭제 불가
//   - role이 admin 또는 super_admin인 계정 삭제 불가
exports.bulkDeleteEmployees = functions.runWith({ ...RUN_OPTS, timeoutSeconds: 300 }).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile || String(callerProfile.role || "").toLowerCase() !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "슈퍼관리자 전용");

    const empNos = Array.isArray(data.empNos) ? data.empNos : [];
    if (empNos.length === 0) throw new functions.https.HttpsError("invalid-argument", "empNos가 비어있음");

    const results = [];
    for (const rawEmpNo of empNos) {
        const empNo = normalizeEmpNo(rawEmpNo);
        if (!empNo) {
            results.push({ empNo: String(rawEmpNo || ""), ok: false, error: "사번이 비어있음" });
            continue;
        }
        // sa001 보호
        if (empNo === "sa001") {
            results.push({ empNo, ok: false, error: "기본 슈퍼관리자 계정은 삭제할 수 없습니다" });
            continue;
        }
        const email = empNoToEmail(empNo);
        let uid, targetProfile;
        try {
            const rec = await auth.getUserByEmail(email);
            uid = rec.uid;
        } catch (e) {
            results.push({ empNo, ok: false, error: "존재하지 않는 사번" });
            continue;
        }
        // 호출자 본인 보호
        if (uid === context.auth.uid) {
            results.push({ empNo, ok: false, error: "현재 로그인한 슈퍼관리자 본인은 삭제할 수 없습니다" });
            continue;
        }
        // 관리자/슈퍼관리자 계정 삭제 방지
        try {
            const snap = await db.ref("users/" + uid).once("value");
            targetProfile = snap.exists() ? snap.val() : null;
        } catch (e) {
            targetProfile = null;
        }
        const targetRole = String((targetProfile && targetProfile.role) || "").toLowerCase();
        if (targetRole === "admin" || targetRole === "super_admin") {
            results.push({ empNo, ok: false, error: "관리자/슈퍼관리자 계정은 삭제할 수 없습니다 (role: " + targetRole + ")" });
            continue;
        }
        try {
            await auth.deleteUser(uid);
            await db.ref("users/" + uid).remove();
            results.push({
                empNo,
                ok: true,
                uid,
                name: (targetProfile && (targetProfile.legacyName || targetProfile.name)) || "",
                deptId: (targetProfile && targetProfile.deptId) || ""
            });
        } catch (e) {
            results.push({ empNo, ok: false, error: e.message || "삭제 실패" });
        }
    }
    return { results };
});

// ── 20. saveNotice — 지점 공지 저장/수정 (관리자/슈퍼관리자 전용) ──────────────
// 반드시 trinity_system/{deptId}/notices/{noticeId} 경로만 사용.
// 전지점(ALL) 공지 경로는 존재하지 않으며 이 함수로도 만들 수 없음.
// - 일반관리자(admin): 본인 deptId 외 저장 불가 (서버 강제)
// - 슈퍼관리자(super_admin): 파라미터 deptId 지점 공지만 저장
exports.saveNotice = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    const role = String(callerProfile.role || "").toLowerCase();
    if (role !== "admin" && role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "관리자 권한 필요");

    const deptId = String(data.deptId || "").trim();
    if (!deptId)
        throw new functions.https.HttpsError("invalid-argument", "deptId 필요");

    // 일반관리자는 자기 지점만
    if (role === "admin" && String(callerProfile.deptId || "").trim() !== deptId)
        throw new functions.https.HttpsError("permission-denied", "다른 지점 공지 저장 불가");

    const title   = String(data.title   || "").trim();
    const content = String(data.content || "").trim();
    if (!title || !content)
        throw new functions.https.HttpsError("invalid-argument", "제목과 내용은 필수입니다");

    const important = data.important === true;
    const active    = data.active !== false; // 기본 true
    const now       = Date.now();
    const noticeId  = data.noticeId || null;
    const path      = "trinity_system/" + deptId + "/notices/";

    if (noticeId) {
        // 수정: 기존 공지 존재 여부 확인
        const existing = await db.ref(path + noticeId).once("value");
        if (!existing.exists())
            throw new functions.https.HttpsError("not-found", "공지가 존재하지 않습니다");
        await db.ref(path + noticeId).update({ title, content, important, active, updatedAt: now });
        return { ok: true, noticeId };
    } else {
        // 신규
        const ref = db.ref(path).push();
        await ref.set({ title, content, important, active,
                        createdBy: context.auth.uid, createdAt: now, updatedAt: now });
        return { ok: true, noticeId: ref.key };
    }
});

// ── 21. deleteNotice — 지점 공지 삭제 (관리자/슈퍼관리자 전용) ────────────────
exports.deleteNotice = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    const role = String(callerProfile.role || "").toLowerCase();
    if (role !== "admin" && role !== "super_admin")
        throw new functions.https.HttpsError("permission-denied", "관리자 권한 필요");

    const deptId   = String(data.deptId   || "").trim();
    const noticeId = String(data.noticeId || "").trim();
    if (!deptId || !noticeId)
        throw new functions.https.HttpsError("invalid-argument", "deptId, noticeId 필요");

    // 일반관리자는 자기 지점만
    if (role === "admin" && String(callerProfile.deptId || "").trim() !== deptId)
        throw new functions.https.HttpsError("permission-denied", "다른 지점 공지 삭제 불가");

    await db.ref("trinity_system/" + deptId + "/notices/"     + noticeId).remove();
    await db.ref("trinity_system/" + deptId + "/noticeReads/" + noticeId).remove();
    return { ok: true };
});

// ── 22. listNotices — 지점 공지 목록 조회 ────────────────────────────────────
// 직원은 자기 deptId 공지만, 관리자는 자기 deptId(또는 지정 deptId), 슈퍼관리자는 임의 deptId.
// includeReads=true 이면 noticeReads/{noticeId}/{uid} 도 함께 반환해 클라이언트에서 읽음 여부 판단.
exports.listNotices = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");

    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");

    const role    = String(callerProfile.role || "").toLowerCase();
    const reqDept = String(data.deptId || "").trim();

    // ── deptId 검증 ──────────────────────────────────────────────────────────
    if (!reqDept)
        throw new functions.https.HttpsError("invalid-argument", "deptId 필요");
    if (reqDept.toUpperCase() === "ALL")
        throw new functions.https.HttpsError("invalid-argument", "전지점(ALL) 공지는 지원하지 않습니다");
    if (/[/.#$[\]]/.test(reqDept))
        throw new functions.https.HttpsError("invalid-argument", "deptId에 사용할 수 없는 문자가 포함되어 있습니다");

    // 직원/관리자는 자기 지점만 접근 가능
    if (role !== "super_admin") {
        const callerDept = String(callerProfile.deptId || "").trim();
        if (callerDept !== reqDept)
            throw new functions.https.HttpsError("permission-denied", "다른 지점 공지 조회 불가");
    }

    const noticesSnap = await db.ref("trinity_system/" + reqDept + "/notices").once("value");
    const notices = noticesSnap.val() || {};
    const noticeIds = Object.keys(notices);

    console.log("[listNotices] uid:", context.auth.uid,
        "| role:", role,
        "| reqDept:", reqDept,
        "| callerDept:", callerProfile.deptId || "(없음)",
        "| noticesCount:", noticeIds.length,
        "| noticeIds:", JSON.stringify(noticeIds));

    // ── 읽음 여부: noticeReads 전체 조회 금지 ────────────────────────────────
    // 각 noticeId 별로 호출자 uid 경로만 개별 읽기
    const myReads = {};
    await Promise.all(noticeIds.map(async function(nid) {
        const readSnap = await db.ref(
            "trinity_system/" + reqDept + "/noticeReads/" + nid + "/" + context.auth.uid
        ).once("value");
        myReads[nid] = readSnap.val() === true;
    }));

    console.log("[listNotices] myReads:", JSON.stringify(myReads));
    return { notices, myReads };
});

// ── 23. markNoticeRead — 공지 읽음 처리 ──────────────────────────────────────
// 호출자 uid 기준으로만 reads를 기록. 다른 직원 reads는 절대 수정하지 않음.
exports.markNoticeRead = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");

    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");

    const role     = String(callerProfile.role || "").toLowerCase();
    const deptId   = String(data.deptId   || "").trim();
    const noticeId = String(data.noticeId || "").trim();

    // ── deptId / noticeId 검증 ────────────────────────────────────────────────
    if (!deptId || !noticeId)
        throw new functions.https.HttpsError("invalid-argument", "deptId, noticeId 필요");
    if (deptId.toUpperCase() === "ALL")
        throw new functions.https.HttpsError("invalid-argument", "전지점(ALL) 공지는 지원하지 않습니다");
    if (/[/.#$[\]]/.test(deptId))
        throw new functions.https.HttpsError("invalid-argument", "deptId에 사용할 수 없는 문자가 포함되어 있습니다");
    if (/[/.#$[\]]/.test(noticeId))
        throw new functions.https.HttpsError("invalid-argument", "noticeId에 사용할 수 없는 문자가 포함되어 있습니다");

    // 직원/관리자는 자기 지점 공지만 읽음 처리 가능
    if (role !== "super_admin") {
        const callerDept = String(callerProfile.deptId || "").trim();
        if (callerDept !== deptId)
            throw new functions.https.HttpsError("permission-denied", "다른 지점 공지 접근 불가");
    }

    // 공지 존재 여부 확인
    const snap = await db.ref("trinity_system/" + deptId + "/notices/" + noticeId).once("value");
    if (!snap.exists()) throw new functions.https.HttpsError("not-found", "공지가 존재하지 않습니다");

    // 호출자 본인 uid만 기록
    await db.ref("trinity_system/" + deptId + "/noticeReads/" + noticeId + "/" + context.auth.uid).set(true);
    return { ok: true };
});

// ── 공통 헬퍼: yyyymm의 총 일수 ─────────────────────────────────────────────
function daysInMonth(yyyymm) {
    const year  = parseInt(String(yyyymm).slice(0, 4), 10);
    const month = parseInt(String(yyyymm).slice(4, 6), 10);
    if (!Number.isFinite(year) || !Number.isFinite(month)) return 31;
    return new Date(year, month, 0).getDate();
}

// ── 24. getStaffScheduleOverview — 직원모드: 같은 지점 전체 신청 현황 조회 ──
// staff 본인 조회용 read-only 함수. adminView 는 서버(Admin SDK)에서만 읽고
// 클라이언트에는 화면 표시에 필요한 최소 데이터만 반환한다(개인정보/관리자 설정 제외).
exports.getStaffScheduleOverview = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const profile = await getCallerProfile(context.auth.uid);
    if (!profile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    // ⚠️ 호출자가 요청 body에 임의의 deptId를 넣어도 반드시 자기 프로필의
    // deptId와 일치해야만 조회를 허용한다 (다른 지점 데이터 조회 차단).
    if (String(profile.deptId || "").trim() !== deptId)
        throw new functions.https.HttpsError("permission-denied", "다른 지점 접근 불가");

    const [usersSnap, avSnap, cfgSnap, persSnap] = await Promise.all([
        db.ref("users").orderByChild("deptId").equalTo(deptId).once("value"),
        db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value"),
        db.ref("departments/" + deptId + "/configs/" + yyyymm).once("value"),
        db.ref("departments/" + deptId + "/persistent/groups").once("value")
    ]);

    const cfg = cfgSnap.val() || {};
    const pers = persSnap.val();
    const groups = isPersistentGroupsInitialized(pers) ? extractGroupsFromPersistent(pers) : (cfg.groups || {});
    const myEmpNo = normalizeEmpNo(profile.empNo);
    const myGroups = findMemberGroups(groups, context.auth.uid, myEmpNo);

    const avAll = avSnap.val() || {};
    const employees = [];
    usersSnap.forEach(function(child) {
        const p = child.val() || {};
        const role = String(p.role || "staff").toLowerCase();
        if (role !== "staff") return; // admin/super_admin 제외

        const uid = child.key;
        const empNo = p.empNo || "";
        const name = p.legacyName || p.name || "";
        const empGroups = findMemberGroups(groups, uid, empNo);

        const days = {};
        const avDays = avAll[uid] || {};
        Object.keys(avDays).forEach(function(day) {
            const req = avDays[day];
            if (!req) return;
            if (req.type === "normal") days[day] = "휴";
            else if (req.type === "petition") days[day] = "청";
            else if (req.type === "annual") days[day] = "연";
            else if (req.type === "schedule" && req.scheduleCode) days[day] = req.scheduleCode;
        });

        employees.push({
            uid: uid,
            empNo: empNo,
            name: name,
            group: empGroups.length > 0 ? empGroups[0] : null,
            sortOrder: (p.sortOrder != null ? Number(p.sortOrder) : null),
            days: days
        });
    });

    // 다운로드(exportToExcel)와 동일한 정렬: sortOrder 우선, 없으면 empNo 사전순
    employees.sort(function(a, b) {
        var aHas = (a.sortOrder != null);
        var bHas = (b.sortOrder != null);
        if (aHas && bHas)  return a.sortOrder - b.sortOrder;
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return String(a.empNo || "").localeCompare(String(b.empNo || ""), undefined, { numeric: true, sensitivity: "base" });
    });

    return { yyyymm: yyyymm, myGroups: myGroups, employees: employees };
});

// ── 25. getStaffDailyAvailability — 직원모드: 날짜별 신청 가능 현황 조회 ────
// 조회 전용 preview. 실제 신청 가부의 최종 source of truth는 항상
// submitRequest()의 트랜잭션 검증이며, 여기서는 동일한 규칙(같은 공통 헬퍼)을
// 재사용해 "현재 시점 기준" 미리보기만 제공한다. 조회 시점과 실제 신청 시점
// 사이에 다른 직원의 신청으로 한도가 찰 수 있으므로 결과가 달라질 수 있다.
exports.getStaffDailyAvailability = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const uid = context.auth.uid;
    const profile = await getCallerProfile(uid);
    if (!profile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");
    if (String(profile.deptId || "").trim() !== deptId)
        throw new functions.https.HttpsError("permission-denied", "다른 지점 접근 불가");

    const [cfgSnap, ledgerSnap] = await Promise.all([
        db.ref("departments/" + deptId + "/configs/" + yyyymm).once("value"),
        db.ref("requestsLedger/" + deptId + "/" + yyyymm).once("value")
    ]);
    const cfg = cfgSnap.val() || {};
    const ledger = ledgerSnap.val() || {};
    const groups = await getEffectiveGroups(deptId, cfg);
    const empNo = normalizeEmpNo(profile.empNo);
    const matchedGroups = findMemberGroups(groups, uid, empNo);

    const userDays = ledger[uid] || {};
    const userLimitCfg = (cfg.userLimits || {})[uid] || {};
    const dayMax = toIntOr(10, cfg.dayMax);
    const scheduleCodes = Array.isArray(cfg.scheduleCodes) ? cfg.scheduleCodes : [];
    const useGroupDayLimits = hasGroupDayLimits(cfg);
    const useScGroupDayLimits = hasScGroupDayLimits(cfg);
    const now = Date.now();
    const openAt = cfg.openAt ? new Date(cfg.openAt).getTime() : null;
    const closeAt = cfg.closeAt ? new Date(cfg.closeAt).getTime() : null;
    const outsideRequestPeriod = (Number.isFinite(openAt) && now < openAt)
        || (Number.isFinite(closeAt) && now > closeAt);

    const annualLimit = userLimitCfg.annualQuota != null
        ? toIntOr(0, userLimitCfg.annualQuota)
        : toIntOr(15, cfg.annualUserMax);
    const annualCount = getUserRequestCountByType(userDays, "annual");

    const totalDays = daysInMonth(yyyymm);
    const days = {};

    for (let d = 1; d <= totalDays; d++) {
        const dayStr = String(d);
        const existing = (hasOwn(userDays, dayStr) && userDays[dayStr]) ? userDays[dayStr] : null;
        const dayResult = {
            existingRequest: existing ? { type: existing.type || "normal", scheduleCode: existing.scheduleCode || null } : null,
            normal: null,
            annual: null,
            petition: null,
            schedule: {}
        };

        if (existing) {
            dayResult.normal   = { allowed: false, reasonCode: "ALREADY_REQUESTED" };
            dayResult.annual   = { allowed: false, reasonCode: "ALREADY_REQUESTED" };
            dayResult.petition = { allowed: false, reasonCode: "ALREADY_REQUESTED" };
            scheduleCodes.forEach(function(item) {
                dayResult.schedule[item.name] = { allowed: false, reasonCode: "ALREADY_REQUESTED" };
            });
            days[dayStr] = dayResult;
            continue;
        }

        // 기존 직원 신청 UI(calendar.js)의 openAt/closeAt 정책과 동일하게,
        // 신청 기간 밖에서는 실제로 선택할 수 없는 항목을 가능으로 표시하지 않는다.
        if (outsideRequestPeriod) {
            dayResult.normal   = { allowed: false, reasonCode: "REQUEST_PERIOD" };
            dayResult.annual   = { allowed: false, reasonCode: "REQUEST_PERIOD" };
            dayResult.petition = { allowed: false, reasonCode: "REQUEST_PERIOD" };
            scheduleCodes.forEach(function(item) {
                dayResult.schedule[item.name] = { allowed: false, reasonCode: "REQUEST_PERIOD" };
            });
            days[dayStr] = dayResult;
            continue;
        }

        // ── normal(휴무) ──
        const specialLimitRaw = cfg.specialDayLimits && hasOwn(cfg.specialDayLimits, dayStr) ? cfg.specialDayLimits[dayStr] : null;
        const effectiveDayLimit = specialLimitRaw != null ? toIntOr(dayMax, specialLimitRaw) : dayMax;
        const dayCount = getNormalDayRequestCount(ledger, dayStr);
        if (dayCount >= effectiveDayLimit) {
            dayResult.normal = { allowed: false, reasonCode: "DAY_LIMIT" };
        } else {
            const personalLimit = userLimitCfg.globalUserMax != null
                ? toIntOr(0, userLimitCfg.globalUserMax)
                : toIntOr(4, cfg.globalUserMax);
            const normalCount = getUserRequestCountByType(userDays, "normal");
            if (normalCount >= personalLimit) {
                dayResult.normal = { allowed: false, reasonCode: "USER_LIMIT" };
            } else {
                let blockedGroup = null;
                for (const group of matchedGroups) {
                    let limit;
                    if (useGroupDayLimits) {
                        const dayLimits = (cfg.groupDayLimits || {})[dayStr];
                        if (!dayLimits || !hasOwn(dayLimits, group) || dayLimits[group] == null) continue;
                        limit = toIntOr(0, dayLimits[group]);
                    } else {
                        limit = toIntOr(2, cfg["groupMax" + group]);
                    }
                    const count = getGroupDayCount(ledger, groups, group, dayStr, function(req) {
                        return req && req.type === "normal";
                    });
                    if (count >= limit) { blockedGroup = group; break; }
                }
                dayResult.normal = blockedGroup
                    ? { allowed: false, reasonCode: "GROUP_LIMIT" }
                    : { allowed: true, reasonCode: null };
            }
        }

        // ── annual(연차) ──
        dayResult.annual = annualCount >= annualLimit
            ? { allowed: false, reasonCode: "ANNUAL_LIMIT", remaining: 0 }
            : { allowed: true, reasonCode: null, remaining: annualLimit - annualCount };

        // ── petition(청원) — 기존 submitRequest 정책상 별도 한도 없음, 중복 신청만 차단(이미 위에서 처리) ──
        dayResult.petition = { allowed: true, reasonCode: null };

        // ── schedule(근무코드) ──
        scheduleCodes.forEach(function(item) {
            const scheduleLimit = toIntOr(999, item.limit);
            const myScheduleCount = getUserRequestCountByType(userDays, "schedule", item.name);
            if (myScheduleCount >= scheduleLimit) {
                dayResult.schedule[item.name] = { allowed: false, reasonCode: "SCHEDULE_USER_LIMIT" };
                return;
            }
            let blockedGroup = null;
            for (const group of matchedGroups) {
                const key = item.name + "_" + group;
                let limit;
                if (useScGroupDayLimits) {
                    const dayLimits = (cfg.scGroupDayLimits || {})[dayStr];
                    if (!dayLimits || !hasOwn(dayLimits, key) || dayLimits[key] == null) continue;
                    limit = toIntOr(0, dayLimits[key]);
                } else {
                    if (!cfg.scGroupLimits || !hasOwn(cfg.scGroupLimits, key)) continue;
                    limit = toIntOr(0, cfg.scGroupLimits[key]);
                }
                const count = getGroupDayCount(ledger, groups, group, dayStr, function(req) {
                    return req && req.type === "schedule" && req.scheduleCode === item.name;
                });
                if (count >= limit) { blockedGroup = group; break; }
            }
            dayResult.schedule[item.name] = blockedGroup
                ? { allowed: false, reasonCode: "SCHEDULE_GROUP_LIMIT" }
                : { allowed: true, reasonCode: null };
        });

        days[dayStr] = dayResult;
    }

    return { yyyymm: yyyymm, myGroups: matchedGroups, days: days };
});
