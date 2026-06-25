/**
 * super-admin.js — 슈퍼관리자 전용 (모든 쓰기는 Cloud Functions)
 */

function openSuperResetModal() {
    alert("직원 비밀번호 초기화는 관리자 콘솔 > 비밀번호 초기화 메뉴를 사용하세요.");
}

function executeSuperReset() {
    alert("직원 비밀번호 초기화는 관리자 콘솔 > 비밀번호 초기화 메뉴를 사용하세요.");
}

function drawSuperResetPanel() {
    var container = document.getElementById("superResetPanelContent");
    if (!container) return;
    container.innerHTML = "<div style='font-size:13px;color:#555;line-height:1.6;'>직원 비밀번호 초기화는 아래 [관리자 콘솔] 에서 사번 + 새 비밀번호를 입력해 처리하세요.<br>브라우저에서 직접 RTDB에 쓰지 않습니다.</div>";
}
