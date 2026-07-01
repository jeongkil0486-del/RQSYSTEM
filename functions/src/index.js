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

admin.initializeApp();

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


/** 공지 deptId 검증 — ALL/경로문자 차단, 실제 지점 존재 확인 */
async function assertValidNoticeDept(deptId) {
    const clean = String(deptId || "").trim();
    if (!clean || clean.toUpperCase() === "ALL" || clean.indexOf("/") >= 0 || clean.indexOf(".") >= 0 || clean.indexOf("#") >= 0 || clean.indexOf("$") >= 0 || clean.indexOf("[") >= 0 || clean.indexOf("]") >= 0) {
        throw new functions.https.HttpsError("invalid-argument", "유효하지 않은 지점입니다");
    }
    const snap = await db.ref("departments/" + clean).once("value");
    if (!snap.exists()) {
        throw new functions.https.HttpsError("not-found", "존재하지 않는 지점입니다");
    }
    return clean;
}

/** publicCounters 재계산 — adminView/{yyyymm} 전체 집계 */
async function recalcCounters(deptId, yyyymm, days) {
    const avSnap = await db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value");
    const avAll  = avSnap.val() || {};
    const updates = {};
    days.forEach(function(day) {
        const dayStr = String(parseInt(day, 10));
        let count = 0;
        Object.values(avAll).forEach(function(dayMap) {
            if (dayMap && dayMap[dayStr]) count++;
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

function getDayRequestCount(ledger, day) {
    const dayStr = String(day);
    let count = 0;
    Object.keys(ledger || {}).forEach(function(uid) {
        const userDays = ledger[uid] || {};
        if (userDays && hasOwn(userDays, dayStr) && userDays[dayStr]) count++;
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
    const groups = cfg.groups || {};
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
            const dayCount = getDayRequestCount(ledger, dayStr);
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

            const exceedsGroup = matchedGroups.some(function(group) {
                const limit = toIntOr(2, cfg["groupMax" + group]);
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

            const exceedsGroupCode = matchedGroups.some(function(group) {
                const key = scheduleCode + "_" + group;
                if (!cfg.scGroupLimits || !hasOwn(cfg.scGroupLimits, key)) return false;
                const limit = toIntOr(0, cfg.scGroupLimits[key]);
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
exports.saveDeptConfig = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const config = data.config || {};

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    const cfgRef  = db.ref("departments/" + deptId + "/configs/" + yyyymm);
    const cfgSnap = await cfgRef.once("value");
    const existing = cfgSnap.val() || {};

    // null 값은 삭제, 나머지는 병합
    const merged = Object.assign({}, existing);
    Object.keys(config).forEach(function(k) {
        if (config[k] === null) delete merged[k];
        else merged[k] = config[k];
    });

    await cfgRef.set(merged);
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

    const path = "departments/" + deptId + "/configs/" + yyyymm + "/specialDayLimits/" + day;
    await db.ref(path).set(limit);
    return { ok: true };
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
exports.resetEmployeePassword = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    await assertAdmin(context.auth.uid, null); // super_admin or admin

    const empNo      = normalizeEmpNo(data.empNo);
    const newPassword = String(data.newPassword || "").trim();
    if (!empNo || newPassword.length < 6) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");

    const email = empNoToEmail(empNo);
    let uid;
    try {
        const rec = await auth.getUserByEmail(email);
        uid = rec.uid;
    } catch (e) {
        throw new functions.https.HttpsError("not-found", "해당 사번 없음: " + empNo);
    }
    await auth.updateUser(uid, { password: newPassword });
    await db.ref("users/" + uid).update({
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
exports.createEmployee = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const callerProfile = await assertAdmin(context.auth.uid, data.deptId ? String(data.deptId).trim() : null);

    const empNo        = normalizeEmpNo(data.empNo);
    const name         = String(data.name         || "").trim();
    const deptId       = String(data.deptId       || "").trim();
    const role         = String(data.role         || "staff").toLowerCase();
    const tempPassword = String(data.tempPassword || "").trim();

    if (!empNo || !name || !deptId || tempPassword.length < 6)
        throw new functions.https.HttpsError("invalid-argument", "필수값 누락 (empNo, name, deptId, tempPassword 6자↑)");

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
exports.bulkCreateEmployees = functions.runWith({ ...RUN_OPTS, timeoutSeconds: 300 }).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    await assertAdmin(context.auth.uid, null);

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

// ── 12. saveGroupAssignment — 조별 배정 저장 ─────────────────────────────────
exports.saveGroupAssignment = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");
    const deptId = String(data.deptId || "").trim();
    const yyyymm = String(data.yyyymm || "").trim();
    const groups = data.groups || {};

    if (!deptId || !yyyymm) throw new functions.https.HttpsError("invalid-argument", "필수값 누락");
    await assertAdmin(context.auth.uid, deptId);

    await db.ref("departments/" + deptId + "/configs/" + yyyymm + "/groups").set(groups);
    return { ok: true, groups };
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
        employees.push({
            uid:       child.key,
            empNo:     p.empNo || "",
            name:      p.legacyName || p.name || "",
            role:      p.role  || "staff",
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

    // adminView 전체를 읽어 publicCounters 재계산
    const avSnap = await db.ref("departments/" + deptId + "/adminView/" + yyyymm).once("value");
    const avAll  = avSnap.val() || {};
    const dayCounts = {};

    Object.values(avAll).forEach(function(dayMap) {
        Object.keys(dayMap || {}).forEach(function(day) {
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

    const deptId = await assertValidNoticeDept(data.deptId);

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

    const deptId   = await assertValidNoticeDept(data.deptId);
    const noticeId = String(data.noticeId || "").trim();
    if (!noticeId)
        throw new functions.https.HttpsError("invalid-argument", "noticeId 필요");

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

    const role   = String(callerProfile.role || "").toLowerCase();
    const reqDept = await assertValidNoticeDept(data.deptId);

    // 직원/관리자는 자기 지점만 접근 가능
    if (role !== "super_admin") {
        const callerDept = String(callerProfile.deptId || "").trim();
        if (callerDept !== reqDept)
            throw new functions.https.HttpsError("permission-denied", "다른 지점 공지 조회 불가");
    }

    const noticesSnap = await db.ref("trinity_system/" + reqDept + "/notices").once("value");
    const notices = noticesSnap.val() || {};

    // 읽음 정보: 전체 직원 reads 조회 금지. 공지별로 호출자 uid 경로만 확인
    const myReads = {};
    await Promise.all(Object.keys(notices).map(async function(nid) {
        const readSnap = await db.ref("trinity_system/" + reqDept + "/noticeReads/" + nid + "/" + context.auth.uid).once("value");
        myReads[nid] = readSnap.exists();
    }));

    return { notices, myReads };
});

// ── 23. markNoticeRead — 공지 읽음 처리 ──────────────────────────────────────
// 호출자 uid 기준으로만 reads를 기록. 다른 직원 reads는 절대 수정하지 않음.
exports.markNoticeRead = functions.runWith(RUN_OPTS).https.onCall(async (data, context) => {
    if (!context.auth) throw new functions.https.HttpsError("unauthenticated", "로그인 필요");

    const callerProfile = await getCallerProfile(context.auth.uid);
    if (!callerProfile) throw new functions.https.HttpsError("permission-denied", "프로필 없음");

    const role    = String(callerProfile.role || "").toLowerCase();
    const deptId  = await assertValidNoticeDept(data.deptId);
    const noticeId = String(data.noticeId || "").trim();

    if (!noticeId) throw new functions.https.HttpsError("invalid-argument", "noticeId 필요");

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
