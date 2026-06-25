/**
 * auth.js — 사번 + 비밀번호 로그인 (v3)
 *
 * resolveEmpLogin Cloud Function 완전 제거.
 * 사번 → 가상이메일 변환을 프론트에서 직접 수행한 뒤
 * Firebase Auth 표준 signInWithEmailAndPassword 로 검증.
 *
 * 보안:
 *  - 가상이메일 도메인이 결정론적이므로 서버 조회 불필요.
 *  - Auth 오류 코드에서 사번 존재 여부가 드러나지 않도록 메시지 통일.
 *  - 이메일 주소는 화면/로그/에러 메시지 어디에도 표시하지 않음.
 *
 * 사번 정규화: 소문자 변환 + 앞뒤 공백 제거
 *   → functions/src/index.js 의 normalizeEmpNo() 와 동일한 규칙.
 */

/** 사번 정규화 (서버 index.js 의 normalizeEmpNo 와 반드시 동일) */
function normalizeEmpNo(raw) {
    return String(raw || "").trim().toLowerCase();
}

/** 사번 → 가상이메일 (서버 index.js 의 empNoToEmail 와 반드시 동일) */
function empNoToEmail(empNo) {
    return normalizeEmpNo(empNo) + "@trinity-staff.internal";
}

function checkAuth() {
    var rawEmpNo = document.getElementById("username").value;
    var pass     = document.getElementById("password").value.trim();

    var empNo = normalizeEmpNo(rawEmpNo);

    if (!empNo || !pass) {
        alert("사번과 비밀번호를 모두 입력해주세요.");
        return;
    }

    setLoginButtonState(true, "로그인 중...");

    // 사번 → 가상이메일 (클라이언트 직접 계산, 서버 조회 없음)
    var virtualEmail = empNoToEmail(empNo);

    // Firebase Auth 표준 로그인 — 비밀번호는 Auth 서버가 검증
    auth.signInWithEmailAndPassword(virtualEmail, pass)
        .catch(function(error) {
            var code = error.code || "";
            var msg  = "사번 또는 비밀번호가 올바르지 않습니다.";

            // 존재 여부를 구분하지 않고 동일 메시지
            // (auth/user-not-found, auth/wrong-password, auth/invalid-credential 모두 동일)
            if (code === "auth/too-many-requests") {
                msg = "로그인 시도가 너무 많습니다. 잠시 후 다시 시도해주세요.";
            } else if (code === "auth/network-request-failed") {
                msg = "네트워크 오류가 발생했습니다. 인터넷 연결을 확인해주세요.";
            }
            // virtualEmail 을 alert 에 절대 포함하지 않음

            alert(msg);
            setLoginButtonState(false, "로그인");
        });
    // 성공은 onAuthStateChanged → handleSignedInUser 가 처리
}

function loginSuccess(name) {
    currentUser = name;
    setLoginButtonState(false, "로그인");
    refreshData();
    document.getElementById("loginArea").style.display = "none";
    modal.style.display = "flex";
}
