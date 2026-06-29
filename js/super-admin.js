/**
 * super-admin.js
 * Super admin only panels and actions.
 */

function openSuperResetModal() {
    var modal = document.getElementById("superResetChoiceModal");
    if (modal) modal.style.display = "flex";
}

function executeSuperReset() {
    closeSuperResetModal();
}

function drawSuperResetPanel() {
    var container = document.getElementById("superResetPanelContent");
    if (!container) return;

    container.innerHTML = ""
        + "<div style='display:flex;flex-wrap:wrap;gap:10px;align-items:center;'>"
        + "<label style='font-weight:bold;min-width:92px;'>사번/관리자ID</label>"
        + "<input type='text' id='superResetEmpNo' placeholder='사번 또는 관리자ID' style='width:160px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<label style='font-weight:bold;min-width:72px;'>새 비밀번호</label>"
        + "<input type='password' id='superResetPassword' placeholder='6자 이상' style='width:150px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<button type='button' onclick='performSuperAdminPasswordReset()' style='background:#e65100;color:#fff;border:none;border-radius:6px;padding:9px 16px;font-weight:bold;cursor:pointer;'>비밀번호 초기화</button>"
        + "</div>"
        + "<div style='font-size:12px;color:#666;margin-top:10px;line-height:1.6;'>직원/관리자 계정 모두 초기화할 수 있습니다. 새 비밀번호는 6자 이상이어야 합니다.</div>";
}

function drawSuperDeletePanel() {
    var container = document.getElementById("superDeletePanelContent");
    if (!container) return;

    container.innerHTML = ""
        + "<div style='display:flex;flex-wrap:wrap;gap:10px;align-items:center;'>"
        + "<label style='font-weight:bold;min-width:92px;'>삭제할 사번</label>"
        + "<input type='text' id='superDeleteEmpNo' placeholder='사번 입력' style='width:160px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<button type='button' onclick='performSuperAdminDeleteEmployee()' style='background:#c62828;color:#fff;border:none;border-radius:6px;padding:9px 16px;font-weight:bold;cursor:pointer;'>직원 ID 삭제</button>"
        + "</div>"
        + "<div style='font-size:12px;color:#666;margin-top:10px;line-height:1.6;'>삭제 전 확인창이 표시됩니다. SA001 및 현재 로그인한 슈퍼관리자 본인은 삭제할 수 없습니다.</div>";
}

function performSuperAdminPasswordReset() {
    if (!isSuperAdmin) return;

    var empNoEl = document.getElementById("superResetEmpNo");
    var passEl = document.getElementById("superResetPassword");
    var empNo = empNoEl ? empNoEl.value.trim() : "";
    var newPassword = passEl ? passEl.value.trim() : "";

    if (!empNo) {
        alert("사번 또는 관리자ID를 입력해주세요.");
        return;
    }
    if (newPassword.length < 6) {
        alert("새 비밀번호는 6자 이상이어야 합니다.");
        return;
    }

    fn.resetEmployeePassword({ empNo: empNo, newPassword: newPassword }).then(function() {
        alert("[" + empNo + "] 비밀번호가 초기화되었습니다.");
        if (empNoEl) empNoEl.value = "";
        if (passEl) passEl.value = "";
    }).catch(function(e) {
        alert((e && e.message) || "비밀번호 초기화 실패");
    });
}

function performSuperAdminDeleteEmployee() {
    if (!isSuperAdmin) return;

    var empNoEl = document.getElementById("superDeleteEmpNo");
    var empNo = empNoEl ? empNoEl.value.trim() : "";
    var myEmpNo = currentProfile && currentProfile.empNo ? String(currentProfile.empNo).trim().toLowerCase() : "";

    if (!empNo) {
        alert("삭제할 사번을 입력해주세요.");
        return;
    }
    if (empNo.trim().toLowerCase() === "sa001") {
        alert("기본 슈퍼관리자 계정은 삭제할 수 없습니다.");
        return;
    }
    if (myEmpNo && empNo.trim().toLowerCase() === myEmpNo) {
        alert("현재 로그인한 슈퍼관리자 본인은 삭제할 수 없습니다.");
        return;
    }
    if (!confirm("[" + empNo + "] 직원 계정을 삭제하시겠습니까?")) return;

    fn.deleteEmployee({ empNo: empNo }).then(function() {
        alert("직원 계정이 삭제되었습니다.");
        if (empNoEl) empNoEl.value = "";
        deptEmployees = deptEmployees.filter(function(emp) {
            return String(emp.empNo || "").trim().toLowerCase() !== empNo.trim().toLowerCase();
        });
        employeeByUid = {};
        employeeByEmpNo = {};
        employeeByName = {};
        allowedUsers = [];
        deptEmployees.forEach(function(emp) {
            if (!emp || !emp.uid) return;
            employeeByUid[emp.uid] = emp;
            if (emp.empNo) employeeByEmpNo[String(emp.empNo).toLowerCase()] = emp;
            if (emp.name) employeeByName[emp.name] = emp;
            allowedUsers.push(emp.name);
        });
        if (typeof drawAllowedUsersBoard === "function") drawAllowedUsersBoard();
        if (typeof drawLiveGroupBoards === "function") {
            groupBoardStateLoaded = false;
            drawLiveGroupBoards();
        }
        if (typeof drawAnnualStatusBoard === "function") drawAnnualStatusBoard();
        if (typeof drawSuperAdminPanel === "function") drawSuperAdminPanel();
    }).catch(function(e) {
        alert((e && e.message) || "직원 삭제 실패");
    });
}

function closeSuperResetModal() {
    var modal = document.getElementById("superResetChoiceModal");
    if (modal) modal.style.display = "none";
}
