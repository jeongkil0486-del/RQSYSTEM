/**
 * main.js — 세션 관리, 프로필 로드, UI 라우팅
 * 모든 RTDB 쓰기는 Cloud Functions 를 통합니다.
 * 브라우저에서 db.ref(...).set/update/remove 를 직접 호출하지 않습니다.
 */

// ── Cloud Function 래퍼 ───────────────────────────────────────────────────────
var fn = {
  submitRequest:       fnClient.httpsCallable("submitRequest"),
  cancelRequest:       fnClient.httpsCallable("cancelRequest"),
  saveDeptConfig:      fnClient.httpsCallable("saveDeptConfig"),
  setSpecialDayLimit:  fnClient.httpsCallable("setSpecialDayLimit"),
  setUserLimit:        fnClient.httpsCallable("setUserLimit"),
  resetAllRequests:    fnClient.httpsCallable("resetAllRequests"),
  resetEmployeePassword: fnClient.httpsCallable("resetEmployeePassword"),
  createEmployee:      fnClient.httpsCallable("createEmployee"),
  bulkCreateEmployees: fnClient.httpsCallable("bulkCreateEmployees"),
  deleteEmployee:      fnClient.httpsCallable("deleteEmployee"),
  saveGroupAssignment: fnClient.httpsCallable("saveGroupAssignment"),
  getSuperAdminSummary: fnClient.httpsCallable("getSuperAdminSummary"),
  listDepartments:      fnClient.httpsCallable("listDepartments"),
  listDeptEmployees:    fnClient.httpsCallable("listDeptEmployees"),
  uploadAnnualQuotas:   fnClient.httpsCallable("uploadAnnualQuotas"),
  resyncDerivedData:    fnClient.httpsCallable("resyncDerivedData"),
};

// ── UI 헬퍼 ──────────────────────────────────────────────────────────────────
function setLoginButtonState(disabled, label) {
  var loginBtn = document.querySelector(".submit-btn");
  if (!loginBtn) return;
  loginBtn.disabled = !!disabled;
  loginBtn.innerText = label || "로그인";
}

function clearRealtimeListeners() {
  _deptListeners.forEach(function(item) {
    db.ref(item.path).off(item.event, item.fn);
  });
  _deptListeners = [];
  dbListener = null;
}

function resetSessionState() {
  clearRealtimeListeners();
  currentUid          = "";
  currentUser         = "";
  currentUserRole     = "";
  currentProfile      = null;
  currentDept         = "";
  isAdmin             = false;
  isSuperAdmin        = false;
  liveDBData          = {};
  allowedUsers        = [];
  deptEmployees       = [];
  employeeByUid       = {};
  employeeByEmpNo     = {};
  employeeByName      = {};
  adminViewCache      = {};
  _countersCache      = {};
  currentAppMode      = "NORMAL";
  currentScheduleCode = "";
  _superResetTargetAdminId = "";
  currentDeptAccessRestricted   = false;
  currentDeptAccessErrorMessage = "";
  ADMIN_ACCOUNTS      = {};
  ALL_DEPTS           = [];
  _adminAccountsLoaded = false;
}

function resetUiToLoggedOut() {
  resetSessionState();
  modal.style.display = "none";
  document.getElementById("loginArea").style.display = "block";
  document.getElementById("username").value  = "";
  document.getElementById("password").value  = "";

  var ids = [
    "targetEmpName","targetEmpPassword","newAdminPassInput","manageIdInput",
    "specialDayInput","specialDayLimit","annualExcelUpload",
  ];
  ids.forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.value = "";
  });

  var superAdminPanel = document.getElementById("superAdminPanel");
  if (superAdminPanel) superAdminPanel.style.display = "none";
  var superResetModal = document.getElementById("superResetChoiceModal");
  if (superResetModal) superResetModal.style.display = "none";
  var grid = document.getElementById("mainCalendarGrid");
  if (grid) grid.style.display = "";
  var modeBtn = document.getElementById("toggleModeBtn");
  if (modeBtn) modeBtn.innerText = "휴무";
  var scBtn = document.getElementById("scheduleCodeApplyBtn");
  if (scBtn) { scBtn.innerText = "코드"; scBtn.style.display = "none"; }

  setModeButtonStyles();
  setLoginButtonState(false, "로그인");
}

// ── 프로필 적용 ───────────────────────────────────────────────────────────────
function applyProfile(user, profile) {
  var role = String(profile.role || "staff").toLowerCase();
  currentUid       = user.uid;
  currentProfile   = profile;
  currentUserRole  = role;
  // ⚠️ 이메일은 저장하지 않음 — 가상 이메일을 UI 에 절대 표시하지 않음
  currentUser  = profile.legacyName || profile.name || user.displayName || "";
  currentDept  = profile.deptId || "";
  isSuperAdmin = role === "super_admin";
  isAdmin      = role === "admin";
  if (isSuperAdmin) { isAdmin = false; currentDept = ""; }
  SUPER_ADMIN_ID = isSuperAdmin ? (currentUser || user.uid) : null;
}

// ── 지점 목록 ────────────────────────────────────────────────────────────────
function loadDeptList() {
  // super_admin: listDepartments Cloud Function 으로 수신 (직접 DB 읽기 없음)
  // staff/admin: 자기 deptId 만 알면 되므로 전체 목록 불필요 — 호출 안 함
  if (!isSuperAdmin) {
    _adminAccountsLoaded = true;
    return Promise.resolve([]);
  }

  return fn.listDepartments({}).then(function(result) {
    ALL_DEPTS = (result.data && result.data.departments) || [];
    _adminAccountsLoaded = true;
    populateDeptSelect();
    return ALL_DEPTS;
  }).catch(function(err) {
    console.error("지점 목록 로드 실패:", err && err.message);
    ALL_DEPTS = [];
    _adminAccountsLoaded = true;
    populateDeptSelect();
    return [];
  });
}

function populateDeptSelect() {
  var sel = document.getElementById("superDeptSelect");
  if (!sel) return;
  sel.innerHTML = '<option value="">-- 지점 선택 --</option>';
  ALL_DEPTS.forEach(function(dept) {
    var opt = document.createElement("option");
    opt.value = dept;
    opt.text  = dept;
    sel.appendChild(opt);
  });
}

function loadUserProfile(uid) {
  return db.ref("users/" + uid).once("value").then(function(snap) {
    return snap.exists() ? snap.val() : null;
  }).catch(function() { return null; });
}

// ── 로그인 성공 후 ────────────────────────────────────────────────────────────
function handleSignedInUser(user) {
  setLoginButtonState(true, "사용자 확인 중...");

  loadUserProfile(user.uid).then(function(profile) {
    if (!profile) throw new Error("사용자 프로필이 없습니다. (/users/{uid})");

    applyProfile(user, profile);

    if (!isSuperAdmin && !currentDept)
      throw new Error("프로필에 deptId 가 필요합니다.");
    if (!isSuperAdmin && !currentUser)
      throw new Error("프로필에 name 또는 legacyName 이 필요합니다.");

    return loadDeptList();
  }).then(function() {
    if (isSuperAdmin) {
      document.getElementById("loginArea").style.display = "none";
      modal.style.display = "flex";
      showSuperAdminPanel();
      setLoginButtonState(false, "로그인");
      return;
    }

    return connectDeptDBSafe(currentDept).then(function() {
      currentDeptAccessRestricted   = false;
      currentDeptAccessErrorMessage = "";
      loginSuccess(currentUser);
    }).catch(function(err) {
      currentDeptAccessRestricted   = true;
      currentDeptAccessErrorMessage = err && err.message ? err.message : "권한 설정 중";
      loginSuccess(currentUser);
    });
  }).catch(function(error) {
    alert(error && error.message ? error.message : "사용자 정보를 불러오지 못했습니다.");
    auth.signOut();
  });
}

auth.onAuthStateChanged(function(user) {
  if (user) {
    handleSignedInUser(user);
  } else {
    resetUiToLoggedOut();
  }
});

function closeCalendar() {
  if (auth.currentUser) { auth.signOut(); return; }
  resetUiToLoggedOut();
}

// ── 비밀번호 변경 (본인 — Firebase Auth 직접 호출 허용) ─────────────────────
function changeMyPassword() {
  var newPassInput = document.getElementById("newAdminPassInput");
  var newPass = newPassInput ? newPassInput.value.trim() : "";
  if (newPass.length < 6) { alert("비밀번호는 6자 이상이어야 합니다."); return; }
  if (!auth.currentUser)  { alert("로그인 세션이 없습니다."); return; }

  auth.currentUser.updatePassword(newPass).then(function() {
    alert("비밀번호가 변경되었습니다.");
    if (newPassInput) newPassInput.value = "";
  }).catch(function(error) {
    if (error.code === "auth/requires-recent-login") {
      alert("보안을 위해 다시 로그인 후 변경해주세요.");
      auth.signOut();
      return;
    }
    alert(error.message || "비밀번호 변경 실패");
  });
}

// ── 관리자: 직원 비밀번호 초기화 (Cloud Function) ───────────────────────────
function resetUserPassword() {
  if (!isAdmin && !isSuperAdmin) return;
  var empNo   = document.getElementById("targetEmpName") ? document.getElementById("targetEmpName").value.trim() : "";
  var passEl  = document.getElementById("targetEmpPassword") || document.getElementById("newAdminPassInput");
  var newPass = passEl ? passEl.value.trim() : "";

  if (!empNo)            { alert("사번을 입력해주세요."); return; }
  if (!newPass)          { alert("새 비밀번호를 입력해주세요."); return; }
  if (newPass.length < 6){ alert("비밀번호는 6자 이상이어야 합니다."); return; }

  fn.resetEmployeePassword({ empNo: empNo, newPassword: newPass }).then(function() {
    alert("✅ [" + empNo + "] 비밀번호가 초기화되었습니다.");
    document.getElementById("targetEmpName").value = "";
    if (passEl) passEl.value = "";
  }).catch(function(e) {
    alert("초기화 실패: " + (e.message || "알 수 없는 오류"));
  });
}

// ── 관리자: 전체 신청 초기화 (Cloud Function) ────────────────────────────────
function resetAllRequests() {
  if (!isAdmin && !isSuperAdmin) return;
  var tm = getTargetYearMonth();
  if (!confirm("⚠️ " + tm.fullStr + " 전체 신청을 초기화하시겠습니까?")) return;

  fn.resetAllRequests({ deptId: currentDept, yyyymm: tm.fullStr }).then(function() {
    alert("초기화 완료");
    refreshData();
  }).catch(function(e) {
    alert(e.message || "초기화 실패");
  });
}

// ── 관리자: 설정 초기화 (Cloud Function 으로 저장) ───────────────────────────
function resetAllConfigurations() {
  if (!isAdmin && !isSuperAdmin) return;
  if (!confirm("설정을 초기화하시겠습니까?")) return;

  fn.saveDeptConfig({
    deptId: currentDept,
    yyyymm: getTargetYearMonth().fullStr,
    config: { openAt: null, closeAt: null, dayMax: null, globalUserMax: null, annualUserMax: null },
  }).then(function() {
    alert("설정 초기화 완료");
    refreshData();
  }).catch(function(e) {
    alert(e.message || "설정 초기화 실패");
  });
}

// ── 슈퍼관리자 패널 ───────────────────────────────────────────────────────────
function renderRestrictedRoleView() {
  ["toggleModeBtn","userResetBtn","resetAllBtn","resetConfigBtn"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  var adminConsole = document.getElementById("adminConsole");
  if (adminConsole) adminConsole.style.display = "none";
  var grid = document.getElementById("mainCalendarGrid");
  if (grid) grid.innerHTML = "";

  var msg = currentDeptAccessErrorMessage || "권한 설정 중입니다.";
  var wm  = document.getElementById("welcomeMessage");
  if (wm) wm.innerHTML = (isAdmin ? "관리자 모드" : "직원 모드") +
    "<br><span style='font-size:13px; color:#d9534f; font-weight:bold;'>" + msg + "</span>";
}

function showSuperAdminPanel() {
  var wm = document.getElementById("welcomeMessage");
  if (wm) wm.innerHTML = "슈퍼 관리자 모드<br><span style='font-size:13px; color:#e53935; font-weight:bold;'>Firebase Auth + Cloud Functions 기반</span>";

  ["toggleModeBtn","userResetBtn","resetAllBtn","resetConfigBtn","scheduleCodeApplyBtn"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  });
  var adminConsole = document.getElementById("adminConsole");
  if (adminConsole) adminConsole.style.display = "none";
  var panel = document.getElementById("superAdminPanel");
  if (panel) panel.style.display = "flex";
  var grid  = document.getElementById("mainCalendarGrid");
  if (grid) grid.style.display = "none";

  drawSuperAdminPanel();
  drawSuperResetPanel();
}

function drawSuperAdminPanel() {
  var container = document.getElementById("superAdminPanelContent");
  if (!container) return;

  var tm = getTargetYearMonth ? getTargetYearMonth() : { fullStr: "" };

  fn.getSuperAdminSummary({ yyyymm: tm.fullStr }).then(function(result) {
    var summary = result.data.summary || {};
    var depts   = Object.keys(summary);

    if (depts.length === 0) {
      container.innerHTML = "<div style='font-size:13px;color:#666;'>지점 데이터 없음</div>";
      return;
    }

    var html = "<table style='width:100%;border-collapse:collapse;font-size:13px;'>";
    html += "<tr style='background:#f0f0f0;'><th style='padding:8px;border:1px solid #ddd;'>지점</th><th style='padding:8px;border:1px solid #ddd;'>신청 현황 (" + tm.fullStr + ")</th></tr>";
    depts.forEach(function(d) {
      var days   = summary[d];
      var counts = Object.keys(days).map(function(day) { return day + "일:" + days[day]; }).join(", ") || "-";
      html += "<tr><td style='padding:8px;border:1px solid #ddd;font-weight:bold;'>" + d + "</td><td style='padding:8px;border:1px solid #ddd;font-size:12px;color:#555;'>" + counts + "</td></tr>";
    });
    html += "</table>";
    container.innerHTML = html;
  }).catch(function() {
    container.innerHTML = "<div style='font-size:13px;color:#d9534f;'>데이터 로드 실패</div>";
  });
}

// ── 로그인 화면 레이블 (사번으로 표시) ───────────────────────────────────────
function updateLoginCopy() {
  var usernameLabel = document.querySelector('label[for="username"]');
  if (usernameLabel) usernameLabel.innerText = "사번";

  var usernameInput = document.getElementById("username");
  if (usernameInput) {
    usernameInput.placeholder = "사번을 입력하세요";
    usernameInput.setAttribute("autocomplete", "username");
    usernameInput.setAttribute("inputmode", "text");
  }

  var passwordLabel = document.querySelector('label[for="password"]');
  if (passwordLabel) passwordLabel.innerText = "비밀번호";

  var passwordInput = document.getElementById("password");
  if (passwordInput) {
    passwordInput.placeholder = "비밀번호를 입력하세요";
    passwordInput.setAttribute("autocomplete", "current-password");
  }

  // 레거시 비밀번호 컨트롤 숨김
  ["superResetAdminBtn","superResetStaffBtn"].forEach(function(id) {
    var el = document.getElementById(id);
    if (el) el.style.display = "none";
  });

  setLoginButtonState(false, "로그인");
}

// refreshData 래퍼 (접근 제한 상태 처리)
var _legacyRefreshData = typeof refreshData === "function" ? refreshData : function() {};
refreshData = function() {
  if (currentDeptAccessRestricted) {
    renderRestrictedRoleView();
    return;
  }
  return _legacyRefreshData();
};

updateLoginCopy();
