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

    currentUid = "";
    currentUser = "";
    currentUserEmail = "";
    currentUserRole = "";
    currentProfile = null;
    currentDept = "";
    isAdmin = false;
    isSuperAdmin = false;
    liveDBData = {};
    allowedUsers = [];
    _countersCache = {};
    currentAppMode = "NORMAL";
    currentScheduleCode = "";
    _superResetTargetAdminId = "";
    currentDeptAccessRestricted = false;
    currentDeptAccessErrorMessage = "";
}

function resetUiToLoggedOut() {
    resetSessionState();

    modal.style.display = "none";
    document.getElementById("loginArea").style.display = "block";
    document.getElementById("username").value = "";
    document.getElementById("password").value = "";

    [
        "targetEmpName",
        "limitEmpName",
        "limitEmpCount",
        "manageIdInput",
        "specialDayInput",
        "specialDayLimit",
        "annualExcelUpload",
        "newAdminPassInput"
    ].forEach(function(id) {
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
    if (scBtn) {
        scBtn.innerText = "코드";
        scBtn.style.display = "none";
    }

    setModeButtonStyles();
    setLoginButtonState(false, "로그인");
}

function applyProfile(user, profile) {
    var role = String(profile.role || "staff").toLowerCase();

    currentUid = user.uid;
    currentUserEmail = user.email || "";
    currentProfile = profile;
    currentUserRole = role;
    currentUser = profile.legacyName || profile.name || user.displayName || user.email || "";
    currentDept = profile.deptId || profile.dept || "";
    isSuperAdmin = role === "super_admin";
    isAdmin = role === "admin";

    if (isSuperAdmin) {
        SUPER_ADMIN_ID = currentUserEmail || currentUser;
        isAdmin = false;
        currentDept = "";
    }
}

function populateDeptSelect() {
    var sel = document.getElementById("superDeptSelect");
    if (!sel) return;

    sel.innerHTML = '<option value="">-- 지점 선택 --</option>';
    ALL_DEPTS.forEach(function(dept) {
        var label = "";
        Object.keys(ADMIN_ACCOUNTS).forEach(function(id) {
            if (ADMIN_ACCOUNTS[id].dept === dept && !label) {
                label = ADMIN_ACCOUNTS[id].label || ADMIN_ACCOUNTS[id].dept;
            }
        });

        var opt = document.createElement("option");
        opt.value = dept;
        opt.text = label || dept;
        sel.appendChild(opt);
    });
}

function loadAdminAccountsDirectory() {
    return db.ref("adminAccounts").once("value").then(function(snap) {
        var data = snap.val() || {};
        ADMIN_ACCOUNTS = data;
        ALL_DEPTS = Object.keys(data).map(function(id) {
            return data[id].dept;
        }).filter(function(value, idx, arr) {
            return value && arr.indexOf(value) === idx;
        });
        _adminAccountsLoaded = true;
        populateDeptSelect();
        return data;
    }).catch(function() {
        ADMIN_ACCOUNTS = {};
        ALL_DEPTS = [];
        _adminAccountsLoaded = true;
        populateDeptSelect();
        return {};
    });
}

function loadUserProfile(uid) {
    return db.ref("users/" + uid).once("value").then(function(snap) {
        return snap.exists() ? snap.val() : null;
    }).catch(function() {
        return null;
    });
}

function hideLegacyPasswordControls() {
    [
        "targetEmpName",
        "newAdminPassInput",
        "superResetAdminBtn",
        "superResetStaffBtn"
    ].forEach(function(id) {
        var el = document.getElementById(id);
        if (el) el.style.display = "none";
    });
}

function updateLoginCopy() {
    var usernameLabel = document.querySelector('label[for="username"]');
    if (usernameLabel) usernameLabel.innerText = "이메일";

    var usernameInput = document.getElementById("username");
    if (usernameInput) {
        usernameInput.placeholder = "가입한 이메일을 입력하세요";
        usernameInput.setAttribute("autocomplete", "username");
    }

    var passwordLabel = document.querySelector('label[for="password"]');
    if (passwordLabel) passwordLabel.innerText = "비밀번호";

    var passwordInput = document.getElementById("password");
    if (passwordInput) {
        passwordInput.placeholder = "비밀번호를 입력하세요";
        passwordInput.setAttribute("autocomplete", "current-password");
    }

    hideLegacyPasswordControls();
    setLoginButtonState(false, "로그인");
}

function renderRestrictedRoleView() {
    var toggleModeBtn = document.getElementById("toggleModeBtn");
    var userResetBtn = document.getElementById("userResetBtn");
    var resetBtn = document.getElementById("resetAllBtn");
    var resetConfigBtn = document.getElementById("resetConfigBtn");
    var adminConsole = document.getElementById("adminConsole");
    var grid = document.getElementById("mainCalendarGrid");
    var message = currentDeptAccessErrorMessage || "권한 설정 중입니다.";

    if (toggleModeBtn) toggleModeBtn.style.display = "none";
    if (userResetBtn) userResetBtn.style.display = "none";
    if (resetBtn) resetBtn.style.display = "none";
    if (resetConfigBtn) resetConfigBtn.style.display = "none";
    if (adminConsole) adminConsole.style.display = isAdmin ? "flex" : "none";
    if (grid) grid.innerHTML = "";

    if (isAdmin) {
        document.getElementById("welcomeMessage").innerHTML =
            "관리자 모드<br><span style='font-size:13px; color:#d9534f; font-weight:bold;'>현재는 새 읽기 경로만 연결된 상태입니다.<br>" + message + "</span>";
    } else {
        document.getElementById("welcomeMessage").innerHTML =
            "직원 모드<br><span style='font-size:13px; color:#007bff; font-weight:bold;'>현재는 새 읽기 경로만 연결된 상태입니다.<br>" + message + "</span>";
    }
}

function applyReadOnlyUi() {
    var noticeId = "readOnlyNotice";
    var welcome = document.getElementById("welcomeMessage");
    if (welcome && !document.getElementById(noticeId)) {
        var notice = document.createElement("div");
        notice.id = noticeId;
        notice.style.marginTop = "8px";
        notice.style.fontSize = "12px";
        notice.style.fontWeight = "bold";
        notice.style.color = "#6c757d";
        notice.innerText = "읽기 전용 단계입니다. 저장과 취소는 다음 단계 Cloud Functions로 이동합니다.";
        welcome.appendChild(notice);
    }

    if (isAdmin) {
        var adminConsole = document.getElementById("adminConsole");
        if (adminConsole) {
            adminConsole.querySelectorAll("button, input, select, textarea").forEach(function(el) {
                el.disabled = true;
            });
        }

        ["resetAllBtn", "resetConfigBtn", "scheduleCodeApplyBtn", "toggleModeBtn", "userResetBtn"].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
    } else {
        ["toggleModeBtn", "scheduleCodeApplyBtn", "userResetBtn"].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = "none";
        });
    }
}

function handleSignedInUser(user) {
    setLoginButtonState(true, "사용자 확인 중...");

    loadUserProfile(user.uid).then(function(profile) {
        if (!profile) {
            throw new Error("사용자 프로필이 없습니다. /users/{uid} 경로를 확인해주세요.");
        }

        applyProfile(user, profile);

        if (!isSuperAdmin && !currentDept) {
            throw new Error("사용자 프로필에 deptId 값이 필요합니다.");
        }

        if (!isSuperAdmin && !currentUser) {
            throw new Error("기존 화면 연결을 위해 profile.name 또는 profile.legacyName 값이 필요합니다.");
        }

        if (isSuperAdmin) {
            return loadAdminAccountsDirectory().then(function() {
                document.getElementById("loginArea").style.display = "none";
                modal.style.display = "flex";
                showSuperAdminPanel();
                setLoginButtonState(false, "로그인");
            });
        }

        loginSuccess(currentUser);
        setLoginButtonState(false, "로그인");
    }).catch(function(error) {
        var message = error && error.message ? error.message : "사용자 정보를 불러오지 못했습니다.";
        alert(message);
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
    if (auth.currentUser) {
        auth.signOut();
        return;
    }

    resetUiToLoggedOut();
}

function resetUserPassword() {
    if (!isAdmin) return;
    alert("직원 비밀번호 초기화는 Firebase Auth 또는 서버 함수에서 처리해야 합니다.");
}

function resetAllPasswords() {
    if (!isAdmin) return;
    alert("일괄 비밀번호 초기화는 Firebase Admin SDK 또는 서버 함수에서 처리해야 합니다.");
}

function resetAdminPassword() {
    alert("관리자 비밀번호 초기화는 브라우저에서 직접 처리하지 않습니다. Firebase Console 또는 Admin SDK를 사용해주세요.");
}

function openSuperResetModal() {
    alert("슈퍼관리자 초기화 기능은 서버 함수로 다시 연결해야 합니다.");
}

function executeSuperReset() {
    alert("슈퍼관리자 초기화 기능은 서버 함수로 다시 연결해야 합니다.");
}

function drawSuperResetPanel() {
    var container = document.getElementById("superResetPanelContent");
    if (!container) return;

    container.innerHTML = "<div style='font-size:13px; color:#555; line-height:1.6;'>직원 비밀번호 초기화는 Firebase Auth 관리자 기능으로 분리 예정입니다.<br>현재 브라우저에서는 직접 처리하지 않도록 막아둔 상태입니다.</div>";
}

function drawSuperAdminPanel() {
    var container = document.getElementById("superAdminPanelContent");
    if (!container) return;

    var adminIds = Object.keys(ADMIN_ACCOUNTS);
    if (adminIds.length === 0) {
        container.innerHTML = "<div style='font-size:13px; color:#666;'>관리자 목록을 아직 불러오지 못했습니다. adminAccounts 경로와 Rules를 확인해주세요.</div>";
        drawSuperResetPanel();
        return;
    }

    var html = "<table style='width:100%; border-collapse:collapse; font-size:13px;'>";
    html += "<tr style='background:#f0f0f0;'><th style='padding:8px; border:1px solid #ddd; text-align:left;'>관리자 ID</th><th style='padding:8px; border:1px solid #ddd;'>지점</th><th style='padding:8px; border:1px solid #ddd;'>상태</th></tr>";
    adminIds.forEach(function(id) {
        html += "<tr>";
        html += "<td style='padding:8px; border:1px solid #ddd; font-weight:bold;'>" + id + "</td>";
        html += "<td style='padding:8px; border:1px solid #ddd; text-align:center; color:#555;'>" + (ADMIN_ACCOUNTS[id].label || ADMIN_ACCOUNTS[id].dept || "-") + "</td>";
        html += "<td style='padding:8px; border:1px solid #ddd; text-align:center; color:#777;'>비밀번호 직접 조회 제거됨</td>";
        html += "</tr>";
    });
    html += "</table>";

    container.innerHTML = html;
    drawSuperResetPanel();
}

function showSuperAdminPanel() {
    document.getElementById("welcomeMessage").innerHTML =
        "슈퍼 관리자 모드<br><span style='font-size:13px; color:#e53935; font-weight:bold;'>비밀번호 직접 조회와 초기화는 제거하고 Firebase Auth 기반으로 이동 중입니다.</span>";

    var toggleModeBtn = document.getElementById("toggleModeBtn");
    var userResetBtn = document.getElementById("userResetBtn");
    var resetBtn = document.getElementById("resetAllBtn");
    var resetConfigBtn = document.getElementById("resetConfigBtn");
    var adminConsole = document.getElementById("adminConsole");
    var scBtn = document.getElementById("scheduleCodeApplyBtn");

    if (toggleModeBtn) toggleModeBtn.style.display = "none";
    if (userResetBtn) userResetBtn.style.display = "none";
    if (resetBtn) resetBtn.style.display = "none";
    if (resetConfigBtn) resetConfigBtn.style.display = "none";
    if (adminConsole) adminConsole.style.display = "none";
    if (scBtn) scBtn.style.display = "none";

    document.getElementById("superAdminPanel").style.display = "flex";
    document.getElementById("mainCalendarGrid").style.display = "none";
    drawSuperAdminPanel();
}

function changeMyAdminPassword() {
    if (!isAdmin) return;

    var newPassInput = document.getElementById("newAdminPassInput");
    var newPass = newPassInput ? newPassInput.value.trim() : "";
    if (newPass === "") {
        alert("새 비밀번호를 입력해주세요.");
        return;
    }

    if (newPass.length < 6) {
        alert("비밀번호는 6자 이상으로 입력해주세요.");
        return;
    }

    if (!auth.currentUser) {
        alert("로그인 세션을 확인할 수 없습니다.");
        return;
    }

    auth.currentUser.updatePassword(newPass).then(function() {
        alert("비밀번호가 변경되었습니다.");
        if (newPassInput) newPassInput.value = "";
    }).catch(function(error) {
        if (error && error.code === "auth/requires-recent-login" && currentUserEmail) {
            return auth.sendPasswordResetEmail(currentUserEmail).then(function() {
                alert("최근 로그인 확인이 필요해서 비밀번호 재설정 메일을 보냈습니다.");
                if (newPassInput) newPassInput.value = "";
            });
        }

        alert(error && error.message ? error.message : "비밀번호 변경에 실패했습니다.");
    });
}

var _legacyRefreshData = refreshData;
refreshData = function() {
    if (isSuperAdmin) {
        return _legacyRefreshData();
    }

    return loadRoleBasedData().then(function() {
        currentDeptAccessRestricted = false;
        currentDeptAccessErrorMessage = "";
        _legacyRefreshData();
        applyReadOnlyUi();
    }).catch(function() {
        renderRestrictedRoleView();
        applyReadOnlyUi();
    });
};

var _legacyEditDate = editDate;
editDate = function() {
    if (isSuperAdmin) {
        return _legacyEditDate.apply(this, arguments);
    }

    alert("읽기 전용 단계입니다. 신청 저장과 취소는 다음 단계 Cloud Functions로 옮길 예정입니다.");
};

updateLoginCopy();
