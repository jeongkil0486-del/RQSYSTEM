/**
 * adminCancelRequest.js
 * 관리자 전용 — 특정 직원의 특정 날 신청을 관리자가 직접 취소
 *
 * ─── 통합 방법 ──────────────────────────────────────────────────────────────
 * functions/src/index.js 맨 하단에 아래 2줄 추가:
 *
 *   const { adminCancelRequest } = require("./adminCancelRequest");
 *   exports.adminCancelRequest = adminCancelRequest;
 *
 * ─── 배포 ───────────────────────────────────────────────────────────────────
 *   firebase deploy --only functions:adminCancelRequest
 *
 * ─── allUsers invoker 권한 부여 (GCP Console) ───────────────────────────────
 * 1. https://console.cloud.google.com/functions/list?project=taerq-67005 접속
 * 2. adminCancelRequest 함수 클릭
 * 3. 상단 [권한] 탭 클릭
 * 4. [+ 주 구성원 추가] 클릭
 * 5. 새 주 구성원: allUsers
 * 6. 역할: Cloud Functions 호출자
 * 7. 저장
 *
 * ─── 입력 ───────────────────────────────────────────────────────────────────
 * { deptId: string, yyyymm: string, day: string, targetUid: string }
 *
 * ─── 반환 ───────────────────────────────────────────────────────────────────
 * { ok: true }
 */

const functions = require("firebase-functions");
const admin     = require("firebase-admin");

// admin.initializeApp()은 index.js에서 한 번만 호출 — 여기서는 생략

exports.adminCancelRequest = functions
    .runWith({ enforceAppCheck: false })
    .https.onCall(async (data, context) => {

    // ── 1. 인증 확인 ──────────────────────────────────────────────────────────
    if (!context.auth) {
        throw new functions.https.HttpsError(
            "unauthenticated", "로그인이 필요합니다."
        );
    }
    const callerUid = context.auth.uid;

    // ── 2. 입력값 검증 ────────────────────────────────────────────────────────
    const deptId    = String(data.deptId    || "").trim();
    const yyyymm    = String(data.yyyymm    || "").trim();
    const day       = String(data.day       || "").trim();
    const targetUid = String(data.targetUid || "").trim();

    if (!deptId)
        throw new functions.https.HttpsError("invalid-argument", "deptId가 필요합니다.");
    if (!yyyymm || !/^\d{6}$/.test(yyyymm))
        throw new functions.https.HttpsError("invalid-argument", "yyyymm 형식이 올바르지 않습니다 (YYYYMM).");
    if (!day || isNaN(parseInt(day, 10)))
        throw new functions.https.HttpsError("invalid-argument", "day가 올바르지 않습니다.");
    if (!targetUid)
        throw new functions.https.HttpsError("invalid-argument", "targetUid가 필요합니다.");

    const dayStr = String(parseInt(day, 10)); // 앞 0 제거 통일

    // ── 3. 호출자 권한 확인 ───────────────────────────────────────────────────
    const db = admin.database();

    const callerSnap = await db.ref("users/" + callerUid).once("value");
    if (!callerSnap.exists()) {
        throw new functions.https.HttpsError(
            "permission-denied", "호출자 프로필을 찾을 수 없습니다."
        );
    }
    const callerProfile = callerSnap.val();
    const callerRole    = String(callerProfile.role || "").toLowerCase();

    if (callerRole !== "admin" && callerRole !== "super_admin") {
        throw new functions.https.HttpsError(
            "permission-denied", "관리자 권한이 필요합니다."
        );
    }

    // admin은 자신의 지점만, super_admin은 모든 지점
    if (callerRole === "admin") {
        const callerDept = String(callerProfile.deptId || "").trim();
        if (callerDept !== deptId) {
            throw new functions.https.HttpsError(
                "permission-denied", "다른 지점의 신청은 취소할 수 없습니다."
            );
        }
    }

    // ── 4. adminView에서 해당 항목 존재 확인 (카운터 재계산 필요 여부) ────────
    const avDayPath  = "departments/" + deptId + "/adminView/" + yyyymm + "/" + targetUid + "/" + dayStr;
    const avSnap     = await db.ref(avDayPath).once("value");
    const hadEntry   = avSnap.exists();

    // ── 5. 원자적 삭제 (multi-path update) ───────────────────────────────────
    const reqPath    = "userRequests/"    + targetUid + "/" + yyyymm + "/" + dayStr;
    const ledgerPath = "requestsLedger/" + deptId    + "/" + yyyymm + "/" + targetUid + "/" + dayStr;

    const updates = {};
    updates[reqPath]   = null;   // userRequests/{uid}/{yyyymm}/{day} 삭제
    updates[avDayPath] = null;   // adminView/{uid}/{day} 삭제
    updates[ledgerPath]= null;   // requestsLedger 삭제 (있으면)

    await db.ref().update(updates);

    // ── 6. publicCounters 재계산 ──────────────────────────────────────────────
    if (hadEntry) {
        const avBasePath  = "departments/" + deptId + "/adminView/" + yyyymm;
        const counterPath = "departments/" + deptId + "/publicCounters/" + yyyymm + "/" + dayStr;

        const avAllSnap = await db.ref(avBasePath).once("value");
        const avAll     = avAllSnap.val() || {};

        let newCount = 0;
        Object.values(avAll).forEach(function(days) {
            if (days && days[dayStr]) newCount++;
        });

        await db.ref(counterPath).set(newCount > 0 ? newCount : null);
    }

    return { ok: true };
});
