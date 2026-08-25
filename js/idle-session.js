/**
 * idle-session.js — 무활동 자동 로그아웃 (2차 보안 개선)
 *
 * 정책: 로그인 사용자 공통 30분 무활동 시 자동 signOut.
 * (role별 다른 시간은 이번 단계에서 넣지 않음 — 필요해지면 IDLE_TIMEOUT_MS 하나만 바꾸면 된다.)
 *
 * ⚠️ setTimeout/setInterval 자체는 브라우저 탭이 background로 가거나 PC가 sleep
 * 상태가 되면 실행이 지연될 수 있으므로 절대 그것만 믿지 않는다. 반드시
 * Date.now() - lastActivity 로 실제 경과 시간을 계산해서 판단하며, 특히
 * visibilitychange/focus 시점에 즉시 재검사해 복귀하자마자 초과분을 놓치지 않는다.
 *
 * 멀티탭: localStorage에 lastActivity(타임스탬프)만 저장해 탭 간에 공유한다.
 * 비밀번호/Firebase token/개인정보는 절대 저장하지 않는다. 한 탭에서 idle logout이
 * 발생하면 별도 localStorage 키(idleLogoutAt)에 신호를 남기고, 다른 탭은 `storage`
 * 이벤트로 이를 감지해 자신도 즉시 로그아웃 상태로 전환한다.
 *
 * main.js의 기존 auth.onAuthStateChanged 핸들러(로그인/로그아웃 UI 전환)는 건드리지
 * 않는다 — Firebase Auth SDK는 여러 개의 onAuthStateChanged 리스너를 동시에 지원하므로,
 * 이 파일은 완전히 독립된 두 번째 리스너로 idle 감시의 시작/정지만 담당한다.
 */

var IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30분 — 정책 변경 시 이 상수만 수정

var IDLE_LAST_ACTIVITY_KEY = "rq_idle_last_activity"; // localStorage, 탭 간 공유(비민감 timestamp만)
var IDLE_LOGOUT_SIGNAL_KEY = "rq_idle_logout_at";      // 다른 탭에 "방금 idle logout 됐다"고 알리는 신호
var IDLE_WRITE_THROTTLE_MS = 5000;                     // 활동 이벤트마다 매번 storage에 쓰지 않도록 throttle
var IDLE_CHECK_INTERVAL_MS = 60 * 1000;                // 주기적 재검사 간격(1분) — 실제 판단은 항상 경과시간 기준

var ACTIVITY_EVENTS = ["mousedown", "pointerdown", "keydown", "touchstart", "scroll"];

var _idleActive = false;               // 로그인 상태에서만 true (idle 감시가 켜져 있는지)
var _idleLoggingOut = false;           // signOut 중복 호출 방지
var _idleCheckTimer = null;
var _idleListenersAttached = false;
var _idleStorageListenerAttached = false;
var _idleLastWriteAt = 0;

function _idleNow() { return Date.now(); }

function _idleReadLastActivity() {
    try {
        var raw = localStorage.getItem(IDLE_LAST_ACTIVITY_KEY);
        var n = raw ? parseInt(raw, 10) : NaN;
        return isNaN(n) ? null : n;
    } catch (e) { return null; }
}

function _idleWriteLastActivity(ts) {
    try { localStorage.setItem(IDLE_LAST_ACTIVITY_KEY, String(ts)); } catch (e) {}
}

/** 활동 이벤트 핸들러 — throttle하여 과도한 localStorage write를 막는다. */
function recordIdleActivity() {
    if (!_idleActive) return;
    var now = _idleNow();
    if (now - _idleLastWriteAt < IDLE_WRITE_THROTTLE_MS) return;
    _idleLastWriteAt = now;
    _idleWriteLastActivity(now);
}

/** Date.now() - lastActivity 기준 실제 경과시간을 검사한다(타이머 지연에 의존하지 않음). */
function _idleCheckElapsed() {
    if (!_idleActive || _idleLoggingOut) return;
    var last = _idleReadLastActivity();
    if (last == null) {
        _idleWriteLastActivity(_idleNow()); // 최초 기록
        return;
    }
    if (_idleNow() - last >= IDLE_TIMEOUT_MS) {
        _idlePerformLogout();
    }
}

function _idlePerformLogout() {
    if (_idleLoggingOut) return;
    _idleLoggingOut = true;
    stopIdleSessionWatch();
    try { localStorage.setItem(IDLE_LOGOUT_SIGNAL_KEY, String(_idleNow())); } catch (e) {}

    if (typeof auth !== "undefined" && auth && auth.currentUser) {
        auth.signOut().then(function() {
            alert("장시간 사용하지 않아 자동 로그아웃되었습니다.");
        }).catch(function() {});
    }
}

function _idleOnActivity() { recordIdleActivity(); }
function _idleOnVisibilityOrFocus() { _idleCheckElapsed(); }

/** 다른 탭에서 idle logout 신호가 오면 이 탭도 즉시 로그아웃 상태로 전환한다. */
function _idleOnStorage(e) {
    if (!e || e.key !== IDLE_LOGOUT_SIGNAL_KEY || !e.newValue) return;
    if (typeof auth !== "undefined" && auth && auth.currentUser && !_idleLoggingOut) {
        _idlePerformLogout();
    }
}

function startIdleSessionWatch() {
    if (_idleActive) return;
    _idleActive = true;
    _idleLoggingOut = false;
    _idleWriteLastActivity(_idleNow());

    if (!_idleListenersAttached) {
        ACTIVITY_EVENTS.forEach(function(evt) {
            document.addEventListener(evt, _idleOnActivity, { passive: true });
        });
        document.addEventListener("visibilitychange", _idleOnVisibilityOrFocus);
        window.addEventListener("focus", _idleOnVisibilityOrFocus);
        _idleListenersAttached = true;
    }
    if (!_idleStorageListenerAttached) {
        window.addEventListener("storage", _idleOnStorage);
        _idleStorageListenerAttached = true;
    }

    if (_idleCheckTimer) clearInterval(_idleCheckTimer);
    _idleCheckTimer = setInterval(_idleCheckElapsed, IDLE_CHECK_INTERVAL_MS);
}

function stopIdleSessionWatch() {
    _idleActive = false;
    if (_idleCheckTimer) { clearInterval(_idleCheckTimer); _idleCheckTimer = null; }
    if (_idleListenersAttached) {
        ACTIVITY_EVENTS.forEach(function(evt) {
            document.removeEventListener(evt, _idleOnActivity);
        });
        document.removeEventListener("visibilitychange", _idleOnVisibilityOrFocus);
        window.removeEventListener("focus", _idleOnVisibilityOrFocus);
        _idleListenersAttached = false;
    }
    if (_idleStorageListenerAttached) {
        window.removeEventListener("storage", _idleOnStorage);
        _idleStorageListenerAttached = false;
    }
    try { localStorage.removeItem(IDLE_LAST_ACTIVITY_KEY); } catch (e) {}
}

auth.onAuthStateChanged(function(user) {
    if (user) startIdleSessionWatch();
    else stopIdleSessionWatch();
});
