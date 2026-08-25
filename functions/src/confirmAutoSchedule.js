/**
 * confirmAutoSchedule.js
 * 관리자 전용 — 자동 스케줄링 초안을 departments/{deptId}/finalSchedules/{yyyymm}에
 * 확정 저장한다. 기존 userRequests/adminView/requestsLedger 는 절대 건드리지 않는
 * 완전히 별도의 source of truth이다.
 *
 * ⚠️ 이 함수는 client가 보낸 어떤 값도 "그 자체로" 신뢰하지 않는다 — 개발자도구/
 * API 직접 호출로 payload를 조작해도 규칙을 어기는 스케줄이 저장될 수 없어야
 * 한다. client의 schedule은 "확정하고 싶은 결과안"일 뿐이고, 실제 검증은 항상
 * 서버가 RTDB의 authoritative source(직원 목록/조 편성/기존 신청/설정/전월 확정본)를
 * 직접 읽어 다시 계산한 값 기준으로 수행한다. 검증을 통과해도 저장되는 값은
 * client payload를 그대로 쓰지 않고, 서버가 authoritative 값으로 재구성한
 * sanitizedFinalSchedule이다(아래 "SANITIZE" 섹션).
 *
 * ─── 통합 방법 (adminCancelRequest.js와 동일한 패턴) ────────────────────────────
 * functions/src/index.js 맨 하단에 아래 2줄 추가:
 *
 *   const { confirmAutoSchedule } = require("./confirmAutoSchedule");
 *   exports.confirmAutoSchedule = confirmAutoSchedule;
 *
 * ─── 입력 ───────────────────────────────────────────────────────────────────
 * {
 *   deptId: string,
 *   yyyymm: string ("YYYYMM"),
 *   employees: { [uid]: { displayName, group, days: { [day]: {type, scheduleCode?, source, originalRequest?, override?} } } },
 *   engineVersion?: string,
 *   generatedAt?: number,
 * }
 * (validationSummary/settingsSnapshot 등 client가 보내는 그 외 필드는 전부 무시된다.)
 *
 * ─── 반환 ───────────────────────────────────────────────────────────────────
 * { ok: true, confirmedAt } — 신규 확정 성공
 * HttpsError("already-exists", ...) — 이미 확정본이 존재(자동 overwrite 금지)
 * HttpsError("invalid-argument"/"permission-denied", ...) — 구조적 검증 실패(즉시 거부)
 * HttpsError("failed-precondition", "...", { code:"schedule-validation-failed", violations:[...], truncated }) —
 *   authoritative 하드 제약조건 검증 실패(구체적 위반 목록 포함, 최대 50개, 저장 0건)
 *
 * ─── 원자성 ─────────────────────────────────────────────────────────────────
 * 검증을 모두 통과한 뒤에만 db.ref(finalSchedulesPath).transaction()으로 "존재하면
 * 중단, 없으면 생성"을 한 번에 처리한다 — 검증 실패 시 write는 전혀 일어나지 않고,
 * 동시 확정 요청 경쟁 상태(TOCTOU)도 없다.
 *
 * ─── 성능 ───────────────────────────────────────────────────────────────────
 * 직원/날짜별로 반복해서 Firebase를 읽지 않는다 — users(dept 조회)/persistent groups/
 * configs/requestsLedger/전월 finalSchedules, 총 5번의 bulk read만 수행하고 이후는
 * 전부 in-memory 계산이다.
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");

// admin.initializeApp()은 index.js에서 한 번만 호출 — 여기서는 생략

const ALLOWED_TYPES   = ["schedule", "normal", "annual", "petition"];
const ALLOWED_SOURCES = ["requested", "auto", "override"];
const FORBIDDEN_KEYS  = ["__proto__", "constructor", "prototype"];
const MAX_VIOLATIONS  = 50;

function _isSafeKey(key) {
    return typeof key === "string" && key.length > 0 && FORBIDDEN_KEYS.indexOf(key) === -1;
}
function _isPlainObject(v) {
    return v !== null && typeof v === "object" && !Array.isArray(v);
}
function normalizeEmpNo(raw) {
    return String(raw || "").trim().toLowerCase();
}

// ═══════════════════════════════════════════════════════════════════════════
// 조 편성(persistent groups) — functions/src/index.js의 동일 헬퍼와 정확히 같은
// semantics(자체 파일로 완결되도록 의도적으로 중복 — adminCancelRequest.js와
// 동일한 이 프로젝트의 기존 관례)를 그대로 재사용한다. 절대 임의로 단순화하지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
function isPersistentGroupsInitialized(pers) {
    if (!pers) return false;
    if (pers._initialized === true) return true;
    return ["A", "B", "C", "D", "E"].some(function (g) {
        return Array.isArray(pers[g]) && pers[g].length > 0;
    });
}
function extractGroupsFromPersistent(pers) {
    const out = {};
    ["A", "B", "C", "D", "E"].forEach(function (g) {
        out[g] = (pers && Array.isArray(pers[g])) ? pers[g] : [];
    });
    return out;
}
function findMemberGroups(groups, uid, empNo) {
    const matched = [];
    const uidStr = String(uid || "").trim();
    const empNoStr = normalizeEmpNo(empNo);
    ["A", "B", "C", "D", "E"].forEach(function (group) {
        const members = Array.isArray(groups[group]) ? groups[group] : [];
        const exists = members.some(function (member) {
            const raw = String(member || "").trim();
            return raw === uidStr || normalizeEmpNo(raw) === empNoStr;
        });
        if (exists) matched.push(group);
    });
    return matched;
}
function hasGroupDayLimits(cfg) { return cfg.groupDayLimitsEnabled === true; }
function hasScGroupDayLimits(cfg) { return cfg.scGroupDayLimitsEnabled === true; }

/** 특정 (day, group)에서 조별 휴무 정원(cap) — js/auto-schedule-engine.js _groupOffCap과 동일 semantics. */
function groupOffCap(cfg, day, group) {
    if (hasGroupDayLimits(cfg)) {
        const dayLimits = (cfg.groupDayLimits || {})[String(day)];
        if (!dayLimits || dayLimits[group] == null) return Infinity;
        return Number(dayLimits[group]);
    }
    const legacy = cfg["groupMax" + group];
    return legacy != null ? Number(legacy) : Infinity;
}
/** 특정 (day, group, code) 조별 근무 정원 — exact-key(codeName+"_"+group)만 사용.
 *
 *  ⚠️ "제약조건 없음"과 "명시적으로 0명"을 절대 같은 값으로 뭉개면 안 된다(Codex High #1
 *  재현 — 과거에는 둘 다 0을 반환해 호출부가 `quota <= 0`으로 검사를 건너뛰었고, 그
 *  결과 명시적으로 0명이어야 할 자리에 실제로 1명이 배정돼도 통과했다). 키가 없으면
 *  null(제약없음), 있으면 그 숫자(0 포함)를 반환한다 — js/auto-schedule-engine.js의
 *  _groupCodeQuota와 정확히 동일한 semantics. */
function groupCodeQuota(cfg, day, group, codeName) {
    const key = codeName + "_" + group;
    if (hasScGroupDayLimits(cfg)) {
        const dayLimits = (cfg.scGroupDayLimits || {})[String(day)];
        if (!dayLimits || !Object.prototype.hasOwnProperty.call(dayLimits, key) || dayLimits[key] == null) return null;
        return Number(dayLimits[key]);
    }
    if (cfg.scGroupLimits && Object.prototype.hasOwnProperty.call(cfg.scGroupLimits, key) && cfg.scGroupLimits[key] != null) {
        return Number(cfg.scGroupLimits[key]);
    }
    return null;
}
/** 특정 day의 전체 휴무 정원(cap) — specialDayLimits[day]가 존재하면 0도 유효값. */
function dayOffCap(cfg, day) {
    const special = cfg.specialDayLimits && Object.prototype.hasOwnProperty.call(cfg.specialDayLimits, String(day))
        ? cfg.specialDayLimits[String(day)] : null;
    return special != null ? Number(special) : Number(cfg.dayMax);
}
/** 근무코드 연결 제한 — exact-key만, D/D_A prefix 혼동 없음. */
function isCodeLinkForbidden(codeLinkRestrictions, prevCode, todayCode) {
    if (!prevCode || !Array.isArray(codeLinkRestrictions)) return false;
    return codeLinkRestrictions.some(function (r) { return r && r.from === prevCode && r.to === todayCode; });
}
/** 근무코드의 "직원 1명당 월간 최대 배정 횟수" 상한 — js/auto-schedule-engine.js
 *  _scheduleCodeMonthlyLimit과 정확히 동일한 semantics(미설정/코드 없음은 null=
 *  상한 없음, 명시적 0은 0으로 그대로 반환 — 0을 unset으로 임의 취급하지 않는다). */
function scheduleCodeMonthlyLimit(scheduleCodesAuth, codeName) {
    const item = (scheduleCodesAuth || []).filter(function (c) { return c && c.name === codeName; })[0];
    if (!item || !Object.prototype.hasOwnProperty.call(item, "limit") || item.limit == null) return null;
    const n = Number(item.limit);
    return Number.isFinite(n) ? n : null;
}

exports.confirmAutoSchedule = functions
    .runWith({ enforceAppCheck: false })
    .https.onCall(async (data, context) => {

    const db = admin.database();

    // ── 1. 인증/기본 입력 구조 검증(구조적 오류는 즉시 거부) ─────────────────────
    if (!context.auth) {
        throw new functions.https.HttpsError("unauthenticated", "로그인이 필요합니다.");
    }
    const callerUid = context.auth.uid;

    const deptId = String((data && data.deptId) || "").trim();
    const yyyymm = String((data && data.yyyymm) || "").trim();
    const employeesPayload = data && data.employees;

    if (!deptId) throw new functions.https.HttpsError("invalid-argument", "deptId가 필요합니다.");
    if (!/^\d{6}$/.test(yyyymm)) throw new functions.https.HttpsError("invalid-argument", "yyyymm 형식이 올바르지 않습니다 (YYYYMM).");
    if (!_isPlainObject(employeesPayload) || Object.keys(employeesPayload).length === 0) {
        throw new functions.https.HttpsError("invalid-argument", "employees가 비어있거나 형식이 올바르지 않습니다.");
    }

    const year = parseInt(yyyymm.slice(0, 4), 10);
    const month = parseInt(yyyymm.slice(4, 6), 10);
    const totalDays = new Date(year, month, 0).getDate();
    const dayKeysExpected = [];
    for (let d = 1; d <= totalDays; d++) dayKeysExpected.push(String(d));

    // ── 2. 호출자 권한 확인 (staff는 무조건 거부, admin은 자기 dept만, client가
    //      보낸 deptId만으로 판단하지 않고 항상 서버가 읽은 caller profile과 대조) ──
    const callerSnap = await db.ref("users/" + callerUid).once("value");
    if (!callerSnap.exists()) {
        throw new functions.https.HttpsError("permission-denied", "호출자 프로필을 찾을 수 없습니다.");
    }
    const callerProfile = callerSnap.val();
    const callerRole = String(callerProfile.role || "").toLowerCase();
    if (callerRole !== "admin" && callerRole !== "super_admin") {
        throw new functions.https.HttpsError("permission-denied", "관리자 권한이 필요합니다.");
    }
    if (callerRole === "admin") {
        const callerDept = String(callerProfile.deptId || "").trim();
        if (callerDept !== deptId) {
            throw new functions.https.HttpsError("permission-denied", "다른 지점의 스케줄은 확정할 수 없습니다.");
        }
    }

    // ── 3. payload 구조/키 안전성 1차 검증 (prototype pollution 방지 포함) ───────
    // 이 단계는 "파싱 가능한 형태인지"만 본다 — 값 자체가 authoritative 규칙과
    // 맞는지는 뒤의 SEMANTIC VALIDATION 단계에서 violations로 모아 반환한다.
    const rawEmployees = {};
    const uids = Object.keys(employeesPayload);
    for (let i = 0; i < uids.length; i++) {
        const uid = uids[i];
        if (!_isSafeKey(uid)) throw new functions.https.HttpsError("invalid-argument", "허용되지 않는 uid 키입니다.");
        const empEntry = employeesPayload[uid];
        if (!_isPlainObject(empEntry) || !_isPlainObject(empEntry.days)) {
            throw new functions.https.HttpsError("invalid-argument", "직원 데이터 형식이 올바르지 않습니다: " + uid);
        }
        const days = empEntry.days;
        const dayKeys = Object.keys(days);
        const sanitizedDays = {};
        for (let j = 0; j < dayKeys.length; j++) {
            const dayKey = dayKeys[j];
            if (!_isSafeKey(dayKey)) throw new functions.https.HttpsError("invalid-argument", "허용되지 않는 날짜 키입니다.");
            const dayNum = parseInt(dayKey, 10);
            if (isNaN(dayNum) || dayNum < 1 || dayNum > totalDays || String(dayNum) !== dayKey) {
                // 예: 30일짜리 달에 "31" 키 → 구조적으로도 즉시 거부(존재하지 않는 날짜).
                throw new functions.https.HttpsError("invalid-argument", "날짜 범위가 올바르지 않습니다(" + yyyymm + "은 " + totalDays + "일까지 존재): " + dayKey);
            }
            const entry = days[dayKey];
            if (!_isPlainObject(entry)) throw new functions.https.HttpsError("invalid-argument", "날짜 데이터 형식이 올바르지 않습니다: " + dayKey);
            if (ALLOWED_TYPES.indexOf(entry.type) === -1) throw new functions.https.HttpsError("invalid-argument", "허용되지 않는 type입니다: " + entry.type);
            const source = entry.source || "requested";
            if (ALLOWED_SOURCES.indexOf(source) === -1) throw new functions.https.HttpsError("invalid-argument", "허용되지 않는 source입니다: " + source);

            sanitizedDays[dayKey] = { type: entry.type, source: source, scheduleCode: entry.scheduleCode != null ? String(entry.scheduleCode).slice(0, 40) : null };
        }
        rawEmployees[uid] = { days: sanitizedDays };
    }

    // ── 4. authoritative source 일괄(bulk) 조회 — 직원/날짜 반복 read 없이 5번만 ──
    const prevYyyymm = (function () {
        const py = (month === 1) ? (year - 1) : year;
        const pm = (month === 1) ? 12 : (month - 1);
        return String(py) + String(pm).padStart(2, "0");
    })();

    const [usersSnap, persGroupsSnap, cfgSnap, ledgerSnap, prevFinalSnap, existingFinalSnap] = await Promise.all([
        db.ref("users").orderByChild("deptId").equalTo(deptId).once("value"),
        db.ref("departments/" + deptId + "/persistent/groups").once("value"),
        db.ref("departments/" + deptId + "/configs/" + yyyymm).once("value"),
        db.ref("requestsLedger/" + deptId + "/" + yyyymm).once("value"),
        db.ref("departments/" + deptId + "/finalSchedules/" + prevYyyymm).once("value"),
        db.ref("departments/" + deptId + "/finalSchedules/" + yyyymm).once("value"),
    ]);

    if (existingFinalSnap.exists()) {
        throw new functions.https.HttpsError("already-exists", "이미 확정된 스케줄이 있습니다.");
    }

    // authoritative 직원 목록: users/{uid}.deptId === deptId && role === "staff" 만.
    const authEmployees = {}; // uid -> {uid, empNo, name, sortOrder}
    usersSnap.forEach(function (child) {
        const p = child.val() || {};
        if (String(p.role || "staff").toLowerCase() !== "staff") return;
        authEmployees[child.key] = {
            uid: child.key,
            empNo: p.empNo || "",
            name: p.legacyName || p.name || "",
            sortOrder: (p.sortOrder != null ? Number(p.sortOrder) : null),
        };
    });

    const cfg = cfgSnap.val() || {};
    const persGroups = persGroupsSnap.val();
    const authGroups = isPersistentGroupsInitialized(persGroups) ? extractGroupsFromPersistent(persGroups) : (cfg.groups || {});

    // uid -> group (findMemberGroups가 A→E 순으로 검사하므로 matched[0]가 "첫 매칭 조" —
    // 클라이언트 엔진(_autoScheduleGroupOfUid)과 동일한 tie-break 기준).
    const groupByUid = {};
    Object.keys(authEmployees).forEach(function (uid) {
        const emp = authEmployees[uid];
        const matched = findMemberGroups(authGroups, uid, emp.empNo);
        if (matched.length > 0) groupByUid[uid] = matched[0];
    });

    // 자동 스케줄링 "대상" 직원 집합 = 해당 dept의 staff 중 조에 배정된 사람만
    // (js/auto-schedule-ui.js _buildAutoScheduleInput의 기준과 동일 — 미배정 직원은 제외).
    const targetUids = Object.keys(authEmployees).filter(function (uid) { return !!groupByUid[uid]; });
    const targetUidSet = {};
    targetUids.forEach(function (uid) { targetUidSet[uid] = true; });

    const ledger = ledgerSnap.val() || {}; // requestsLedger/{deptId}/{yyyymm} — 신청 authoritative source
    const scheduleCodesAuth = Array.isArray(cfg.scheduleCodes) ? cfg.scheduleCodes : [];
    const scheduleCodeNames = {};
    scheduleCodesAuth.forEach(function (c) { if (c && c.name) scheduleCodeNames[c.name] = true; });
    const monthlyOffTarget = cfg.monthlyOffTarget != null ? parseInt(cfg.monthlyOffTarget, 10) : null;
    const maxConsecutiveWork = cfg.maxConsecutiveWork != null ? parseInt(cfg.maxConsecutiveWork, 10) : null;
    const codeLinkRestrictions = Array.isArray(cfg.codeLinkRestrictions) ? cfg.codeLinkRestrictions : [];

    const prevFinal = prevFinalSnap.val();
    const prevDays = new Date(
        (month === 1) ? (year - 1) : year,
        (month === 1) ? 12 : (month - 1),
        0
    ).getDate();
    const prevTailByUid = {};   // uid -> 전월 말일부터의 연속근무일수
    const prevLastCodeByUid = {}; // uid -> 전월 마지막 근무일의 scheduleCode(연결 제한 검사용)
    if (prevFinal && _isPlainObject(prevFinal.employees)) {
        Object.keys(prevFinal.employees).forEach(function (uid) {
            const pdays = (prevFinal.employees[uid] && prevFinal.employees[uid].days) || {};
            let streak = 0;
            for (let d = prevDays; d >= 1; d--) {
                const e = pdays[String(d)];
                if (e && e.type === "schedule") { streak++; if (d === prevDays) prevLastCodeByUid[uid] = e.scheduleCode; }
                else break;
            }
            prevTailByUid[uid] = streak;
        });
    }

    // ── 5. SEMANTIC VALIDATION — 위반사항을 전부 모아서 반환한다(하나 걸리면 즉시
    //      throw하지 않음 — 관리자가 한 번에 문제를 다 볼 수 있어야 하기 때문) ─────
    const violations = [];
    let truncated = false;
    function pushViolation(v) {
        if (violations.length >= MAX_VIOLATIONS) { truncated = true; return; }
        violations.push(v);
    }

    if (monthlyOffTarget == null || maxConsecutiveWork == null) {
        pushViolation({ type: "SETTINGS_MISSING", message: "자동 스케줄링 설정(월 총 휴무일수/최대 연속근무)이 없습니다." });
    }

    // 5-1) 대상 직원 완전성(누락/불필요 직원)
    const payloadUidSet = {};
    Object.keys(rawEmployees).forEach(function (uid) { payloadUidSet[uid] = true; });
    targetUids.forEach(function (uid) {
        if (!payloadUidSet[uid]) pushViolation({ type: "EMPLOYEE_MISSING", uid: uid, message: "대상 직원이 확정 payload에서 누락되었습니다." });
    });
    Object.keys(rawEmployees).forEach(function (uid) {
        if (!authEmployees[uid]) { pushViolation({ type: "EMPLOYEE_UNKNOWN_OR_CROSS_DEPT", uid: uid, message: "해당 지점 소속이 아니거나 존재하지 않는 uid입니다." }); return; }
        if (!targetUidSet[uid]) pushViolation({ type: "EMPLOYEE_NOT_TARGET", uid: uid, message: "자동 스케줄링 대상(조 배정)이 아닌 직원입니다." });
    });

    // 정상 대상 직원만 이후 검증에 사용(불명/비대상 직원의 데이터로 집계를 오염시키지 않음).
    const validUids = targetUids.filter(function (uid) { return !!rawEmployees[uid]; });

    // 5-2) 날짜 완전성 + 기존 신청 원본 재검증(고정 유지/override 정당성) + scheduleCode 유효성
    // + sanitized grid 구성(이후 카운트 검증에 사용할, 서버가 검증까지 마친 grid).
    const sanitizedGrid = {}; // uid -> day -> entry(서버 authoritative 값으로 재구성됨)
    validUids.forEach(function (uid) {
        const payloadDays = rawEmployees[uid].days;
        const ledgerDays = ledger[uid] || {};
        sanitizedGrid[uid] = {};

        dayKeysExpected.forEach(function (dayStr) {
            if (!Object.prototype.hasOwnProperty.call(payloadDays, dayStr)) {
                pushViolation({ type: "DAY_MISSING", uid: uid, day: Number(dayStr), message: "해당 날짜의 배정이 없습니다(부분 확정 금지)." });
                return;
            }
            const entry = payloadDays[dayStr];
            const original = ledgerDays[dayStr]; // authoritative 원 신청(없으면 undefined)

            // strict: normal/annual/petition에 scheduleCode가 붙어 있으면 거부
            if (entry.type !== "schedule" && entry.scheduleCode) {
                pushViolation({ type: "STRAY_SCHEDULE_CODE", uid: uid, day: Number(dayStr), message: entry.type + " 타입에는 scheduleCode가 있을 수 없습니다." });
                return;
            }
            if (entry.type === "schedule") {
                if (!entry.scheduleCode) { pushViolation({ type: "SCHEDULE_CODE_MISSING", uid: uid, day: Number(dayStr), message: "schedule type에는 scheduleCode가 필요합니다." }); return; }
                if (!scheduleCodeNames[entry.scheduleCode]) { pushViolation({ type: "UNKNOWN_SCHEDULE_CODE", uid: uid, day: Number(dayStr), scheduleCode: entry.scheduleCode, message: "등록되지 않은 근무코드입니다." }); return; }
            }

            if (!original) {
                // 원래 아무 신청도 없던 날 — auto로 채워진 것만 허용(annual/petition/override/requested 불가).
                if (entry.source !== "auto") {
                    pushViolation({ type: "INVALID_SOURCE_NO_ORIGINAL", uid: uid, day: Number(dayStr), message: "원 신청이 없는 날짜는 source가 auto여야 합니다." });
                    return;
                }
                if (entry.type !== "normal" && entry.type !== "schedule") {
                    pushViolation({ type: "INVALID_TYPE_NO_ORIGINAL", uid: uid, day: Number(dayStr), message: "원 신청이 없는 날짜는 annual/petition일 수 없습니다." });
                    return;
                }
                sanitizedGrid[uid][dayStr] = entry.type === "schedule"
                    ? { type: "schedule", scheduleCode: entry.scheduleCode, source: "auto" }
                    : { type: "normal", source: "auto" };
                return;
            }

            if (original.type === "annual" || original.type === "petition") {
                // 연차/청원은 절대 변경 불가 — 타입/소스 모두 원본 그대로여야 한다.
                if (entry.type !== original.type || entry.source === "override") {
                    pushViolation({ type: "ANNUAL_PETITION_OVERRIDE_FORBIDDEN", uid: uid, day: Number(dayStr), originalType: original.type, message: "연차/청원은 override로 변경할 수 없습니다." });
                    return;
                }
                sanitizedGrid[uid][dayStr] = { type: original.type, source: "requested" };
                return;
            }

            if (original.type === "schedule") {
                // 신청 근무코드는 자동편성 conflict override 대상이 아니다 — 그대로 유지되어야 한다.
                if (entry.type !== "schedule" || entry.scheduleCode !== original.scheduleCode || entry.source === "override") {
                    pushViolation({ type: "REQUESTED_SCHEDULE_CHANGED", uid: uid, day: Number(dayStr), originalScheduleCode: original.scheduleCode, message: "신청된 근무코드는 변경할 수 없습니다." });
                    return;
                }
                sanitizedGrid[uid][dayStr] = { type: "schedule", scheduleCode: original.scheduleCode, source: "requested" };
                return;
            }

            // original.type === "normal"
            if (entry.source !== "override") {
                // override가 아니면 원본 normal 그대로 유지되어야 한다.
                if (entry.type !== "normal") {
                    pushViolation({ type: "NORMAL_CHANGED_WITHOUT_OVERRIDE", uid: uid, day: Number(dayStr), message: "신청휴무(normal)는 override metadata 없이는 근무로 변경할 수 없습니다." });
                    return;
                }
                sanitizedGrid[uid][dayStr] = { type: "normal", source: "requested" };
                return;
            }

            // source === "override" — normal → schedule 변경만 허용, originalRequest는 client 값을
            // 신뢰하지 않고 서버가 방금 확인한 ledger 원본으로 재구성한다.
            if (entry.type !== "schedule" || !entry.scheduleCode) {
                pushViolation({ type: "INVALID_OVERRIDE_TARGET", uid: uid, day: Number(dayStr), message: "override는 반드시 schedule로만 변경할 수 있습니다." });
                return;
            }
            sanitizedGrid[uid][dayStr] = {
                type: "schedule",
                scheduleCode: entry.scheduleCode,
                source: "override",
                originalRequest: { type: "normal" },
                override: { changedBy: callerUid, changedAt: Date.now(), reason: "auto_schedule_conflict" },
            };
        });

        // payload에만 있고 authoritative 날짜 범위(1..totalDays)에는 없는 키 — 이미 3단계
        // 구조 검증에서 걸러졌으므로 여기서는 추가 조치 불필요.
    });

    // 5-3) 월 총 일반휴무 정확성(annual/petition 제외, normal만 카운트)
    if (monthlyOffTarget != null) {
        validUids.forEach(function (uid) {
            const days = sanitizedGrid[uid] || {};
            let offCount = 0;
            dayKeysExpected.forEach(function (d) { if (days[d] && days[d].type === "normal") offCount++; });
            if (offCount !== monthlyOffTarget) {
                pushViolation({ type: "MONTHLY_OFF_TARGET_MISMATCH", uid: uid, expected: monthlyOffTarget, actual: offCount, message: "월 총 일반휴무 개수가 설정값과 다릅니다." });
            }
        });
    }

    // 5-4) 최대 연속근무(전월 tail 포함) + 5-5) 근무코드 연결 제한(전월 마지막 코드 → 이번달 1일 포함)
    validUids.forEach(function (uid) {
        const days = sanitizedGrid[uid] || {};
        let streak = prevTailByUid[uid] || 0;
        let prevCode = prevLastCodeByUid[uid] || null;
        for (let d = 1; d <= totalDays; d++) {
            const entry = days[String(d)];
            const isWork = !!(entry && entry.type === "schedule");
            if (isWork) streak += 1; else streak = 0;

            if (maxConsecutiveWork != null && streak > maxConsecutiveWork) {
                pushViolation({ type: "MAX_CONSECUTIVE_WORK_EXCEEDED", uid: uid, day: d, streak: streak, limit: maxConsecutiveWork, message: "최대 연속근무를 초과합니다(전월 연속근무 포함)." });
            }
            const curCode = isWork ? entry.scheduleCode : null;
            if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, curCode)) {
                pushViolation({ type: "CODE_LINK_FORBIDDEN", uid: uid, day: d, from: prevCode, to: curCode, message: "근무코드 연결 제한을 위반합니다." });
            }
            prevCode = curCode;
        }
    });

    // 5-6) 조별 근무 exact staffing + 5-7) 특정일 전체 휴무 제한 + 5-8) 조별 휴무 제한
    for (let d = 1; d <= totalDays; d++) {
        const dayStr = String(d);
        const cap = dayOffCap(cfg, d);
        let dayOffUsed = 0;
        validUids.forEach(function (uid) { const e = (sanitizedGrid[uid] || {})[dayStr]; if (e && e.type === "normal") dayOffUsed++; });
        if (dayOffUsed > cap) {
            pushViolation({ type: "DAY_OFF_CAP_EXCEEDED", day: d, expected: cap, actual: dayOffUsed, message: "특정일 전체 휴무 정원을 초과합니다." });
        }

        ["A", "B", "C", "D", "E"].forEach(function (group) {
            const members = validUids.filter(function (uid) { return groupByUid[uid] === group; });

            // ⚠️ "조원이 0명"이라는 사실은 조별 휴무 제한(off cap)에는 실제로 영향이 없다(0명이면
            // normal 사용량도 자연히 0이라 cap을 넘길 수 없음 — 그냥 건너뛰어도 결과는 같다)
            // 하지만 "조별 근무 exact staffing"에는 영향이 없어야 한다 — 명시적으로 설정된
            // 정원(0을 포함해서)은 조원이 0명이어도 반드시 실제 인원(자연히 0명)과 비교해야
            // 한다. 과거에는 이 둘을 하나의 `if (!members.length) return;`으로 묶어서, 조원이
            // 없는 조에 명시적 exact quota(1 이상)가 설정돼 있어도 그 검사 자체를 건너뛰는
            // 실제 버그가 있었다(Codex 재현: B조 0명 + D_A_B quota=1인데 통과). 이제 off cap
            // 검사만 조원이 있을 때로 한정하고, exact staffing 검사는 members가 비어 있어도
            // (실제 인원이 자연히 0으로 계산되어) 항상 수행한다.
            if (members.length > 0) {
                const gCap = groupOffCap(cfg, d, group);
                const groupOffUsed = members.reduce(function (acc, uid) { const e = (sanitizedGrid[uid] || {})[dayStr]; return acc + (e && e.type === "normal" ? 1 : 0); }, 0);
                if (groupOffUsed > gCap) {
                    pushViolation({ type: "GROUP_OFF_CAP_EXCEEDED", day: d, group: group, expected: gCap, actual: groupOffUsed, message: "조별 휴무 정원을 초과합니다." });
                }
            }

            scheduleCodesAuth.forEach(function (codeItem) {
                const quota = groupCodeQuota(cfg, d, group, codeItem.name);
                if (quota == null) return; // 제약 없음(키 자체가 없음) — 명시적 0은 계속 검사됨
                const used = members.reduce(function (acc, uid) {
                    const e = (sanitizedGrid[uid] || {})[dayStr];
                    return acc + (e && e.type === "schedule" && e.scheduleCode === codeItem.name ? 1 : 0);
                }, 0);
                if (used !== quota) {
                    pushViolation({ type: "SC_EXACT_COUNT", day: d, group: group, scheduleCode: codeItem.name, expected: quota, actual: used, message: "조별 근무 정원이 정확히 일치하지 않습니다." });
                }
            });
        });
    }

    // 5-9) 직원별 월간 근무코드 상한(schedule code limit) — client가 보낸 값은
    // 전혀 신뢰하지 않고, cfgSnap에서 방금 읽은 authoritative scheduleCodesAuth의
    // limit과 sanitizedGrid(서버가 재구성한 최종 배정)만으로 재계산한다. client가
    // payload/설정을 조작해도(예: 존재하지 않는 큰 limit 값을 끼워 넣는 시도) 여기서는
    // scheduleCodesAuth만 사용하므로 우회 불가능하다.
    validUids.forEach(function (uid) {
        const days = sanitizedGrid[uid] || {};
        const counts = {};
        dayKeysExpected.forEach(function (dayStr) {
            const e = days[dayStr];
            if (e && e.type === "schedule" && e.scheduleCode) counts[e.scheduleCode] = (counts[e.scheduleCode] || 0) + 1;
        });
        Object.keys(counts).forEach(function (codeName) {
            const limit = scheduleCodeMonthlyLimit(scheduleCodesAuth, codeName);
            if (limit != null && counts[codeName] > limit) {
                pushViolation({
                    type: "SCHEDULE_CODE_MONTHLY_LIMIT_EXCEEDED", uid: uid, scheduleCode: codeName,
                    expected: limit, actual: counts[codeName],
                    message: "직원별 월간 근무코드 제한을 초과합니다.",
                });
            }
        });
    });

    if (violations.length > 0) {
        throw new functions.https.HttpsError(
            "failed-precondition",
            "자동 스케줄 확정 조건을 충족하지 않습니다.",
            { code: "schedule-validation-failed", violations: violations, truncated: truncated }
        );
    }

    // ── 6. SANITIZE — 저장값은 client payload가 아니라 서버가 재구성한 값이다 ─────
    const sanitizedEmployees = {};
    validUids.forEach(function (uid) {
        const emp = authEmployees[uid];
        sanitizedEmployees[uid] = {
            displayName: emp.name || emp.empNo || uid, // server authoritative — client displayName 완전히 폐기
            group: groupByUid[uid],                     // server authoritative — client group 완전히 폐기
            days: sanitizedGrid[uid],
        };
    });

    const settingsSnapshot = {
        monthlyOffTarget: monthlyOffTarget,
        maxConsecutiveWork: maxConsecutiveWork,
        codeLinkRestrictions: codeLinkRestrictions,
        dayMax: cfg.dayMax != null ? cfg.dayMax : null,
        specialDayLimits: cfg.specialDayLimits || {},
        groupDayLimits: cfg.groupDayLimits || {},
        groupDayLimitsEnabled: cfg.groupDayLimitsEnabled === true,
        scGroupDayLimits: cfg.scGroupDayLimits || {},
        scGroupDayLimitsEnabled: cfg.scGroupDayLimitsEnabled === true,
        scGroupLimits: cfg.scGroupLimits || {},
        scheduleCodes: scheduleCodesAuth,
    };

    const confirmedAt = Date.now();
    const finalNode = {
        meta: {
            confirmedAt: confirmedAt,
            confirmedBy: callerUid, // server authoritative — client confirmedBy 없음/무시
            generatedAt: typeof data.generatedAt === "number" ? data.generatedAt : confirmedAt,
            engineVersion: String(data.engineVersion || "1.0.0").slice(0, 40),
            settingsSnapshot: settingsSnapshot,
        },
        employees: sanitizedEmployees,
    };

    // ── 7. 원자적 확정 저장 (검증을 모두 통과한 뒤에만, 이미 존재하면 자동 overwrite 금지) ──
    const finalPath = "departments/" + deptId + "/finalSchedules/" + yyyymm;
    const txResult = await db.ref(finalPath).transaction(function (currentData) {
        if (currentData !== null) return; // undefined 반환 = transaction 중단(기존 값 보존)
        return finalNode;
    });

    if (!txResult.committed) {
        throw new functions.https.HttpsError("already-exists", "이미 확정된 스케줄이 있습니다.");
    }

    return { ok: true, confirmedAt: confirmedAt };
});
