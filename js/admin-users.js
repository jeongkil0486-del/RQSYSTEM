/**
 * admin-users.js
 * Employee list display, group assignment helpers,
 * employee create, password reset, sort mode.
 */

var allowedUsersSortMode = "empNo";

// ── 직원 목록 정렬 ────────────────────────────────────────────────────────────
function _sortDeptEmployeesForBoard(rows) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    if (allowedUsersSortMode === "name") {
        list.sort(function(a, b) {
            return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
        });
        return list;
    }
    // 기본: 사번순
    list.sort(function(a, b) {
        return String(a.empNo || "").localeCompare(String(b.empNo || ""), undefined, { numeric: true, sensitivity: "base" });
    });
    return list;
}

function setAllowedUsersSortMode(mode) {
    allowedUsersSortMode = (mode === "name") ? "name" : "empNo";
    drawAllowedUsersBoard();
}

// ── ID 신청 (직원 목록) 보드 ──────────────────────────────────────────────────
function drawAllowedUsersBoard() {
    var board = document.getElementById("allowedUsersTooltipBoard");
    if (!board) return;

    if (!deptEmployees || deptEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>등록된 직원이 없습니다.</div>";
        return;
    }

    var sorted      = _sortDeptEmployeesForBoard(deptEmployees);
    var empNoActive = (allowedUsersSortMode === "empNo");
    var nameActive  = (allowedUsersSortMode === "name");

    var html = "<strong style='color:#fff;font-size:13px;'>직원 목록 (" + sorted.length + "명)</strong>";

    // 정렬 버튼
    html += "<div style='display:flex;gap:6px;align-items:center;margin-top:8px;'>";
    html += "<button type='button' class='config-save-btn' style='padding:4px 10px;"
          + (empNoActive ? "background:#1565c0;color:#fff;border-color:#1565c0;" : "") + "'"
          + " onclick='setAllowedUsersSortMode(\"empNo\")'>사번순</button>";
    html += "<button type='button' class='config-save-btn' style='padding:4px 10px;"
          + (nameActive ? "background:#2e7d32;color:#fff;border-color:#2e7d32;" : "") + "'"
          + " onclick='setAllowedUsersSortMode(\"name\")'>이름순</button>";
    html += "</div>";

    html += "<div style='display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;'>";
    sorted.forEach(function(emp) {
        html += "<span style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;"
              + "border-radius:5px;padding:4px 8px;font-size:12px;color:#2ecc71;'>"
              + emp.name + " (" + emp.empNo + ", " + emp.role + ")</span>";
    });
    html += "</div>";
    board.innerHTML = html;
}

function toggleAllowedUsersBoard(event) {
    drawAllowedUsersBoard();
    var board = document.getElementById("allowedUsersTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

// ── 조 관련 ───────────────────────────────────────────────────────────────────
function toggleGroupBoard(event) {
    drawLiveGroupBoards();
    var board = document.getElementById("groupListTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

function getLiveGroupList(letter) {
    var val = liveDBData["rq_live_group_" + letter];
    if (!val) return [];
    if (Array.isArray(val)) return val;
    try { return JSON.parse(val); } catch (e) { return []; }
}

function resolveGroupMemberName(member) {
    var raw = String(member || "").trim();
    var emp = employeeByUid[raw] || employeeByEmpNo[raw.toLowerCase()];
    return emp ? emp.name : raw;
}

function groupContainsCurrentUser(groupArray) {
    var empNo = currentProfile && currentProfile.empNo ? String(currentProfile.empNo).toLowerCase() : "";
    return (groupArray || []).some(function(member) {
        var raw = String(member || "").trim();
        if (raw === currentUid) return true;
        return empNo && raw.toLowerCase() === empNo;
    });
}

function drawLiveGroupBoards() {
    var board = document.getElementById("groupListTooltipBoard");
    if (!board) return;

    var html = "<strong style='color:#fff;font-size:13px;'>조별 배정</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 8px;'>사번 또는 UID 입력. 이름은 표시용.</div>";

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var list   = getLiveGroupList(group);
        var tokens = list.map(function(id) {
            var emp = employeeByUid[id] || employeeByEmpNo[String(id).toLowerCase()];
            return emp ? emp.empNo : id;
        });
        var names = list.map(function(id) {
            var emp = employeeByUid[id] || employeeByEmpNo[String(id).toLowerCase()];
            return emp ? emp.name : id;
        });

        html += "<div style='margin:7px 0;display:flex;gap:6px;align-items:flex-start;'>";
        html += "<label style='color:#fff;font-weight:bold;width:26px;line-height:28px;'>" + group + "</label>";
        html += "<textarea id='groupInput" + group + "' rows='2' style='width:210px;font-size:12px;border-radius:4px;border:1px solid #666;padding:5px;' placeholder='사번 또는 UID'>"
              + tokens.join(", ") + "</textarea>";
        html += "<div style='flex:1;display:flex;flex-wrap:wrap;gap:4px;'>";
        html += names.length
            ? names.map(function(name) { return "<span class='group-member'>" + name + "</span>"; }).join("")
            : "<span style='color:#aaa;font-size:12px;'>없음</span>";
        html += "</div></div>";
    });

    html += "<button type='button' class='config-save-btn' onclick='saveAllGroupsFromInputs()'>저장</button>";
    board.innerHTML = html;
}

function saveAllGroupsFromInputs() {
    if (!isAdmin && !isSuperAdmin) return;

    var groups = {};
    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var el = document.getElementById("groupInput" + group);
        if (!el) return;
        var raw = el.value.trim();
        groups[group] = raw ? raw.split(/[,\n]+/).map(function(s) { return s.trim(); }).filter(Boolean) : [];
    });

    fn.saveGroupAssignment({ deptId: currentDept, groups: groups, yyyymm: getTargetYearMonth().fullStr })
        .then(function(result) {
            var saved = (result.data && result.data.groups) || groups;
            Object.keys(saved).forEach(function(group) {
                liveDBData["rq_live_group_" + group] = saved[group];
            });
            drawLiveGroupBoards();
            alert("조 배정이 저장되었습니다.");
        }).catch(function(e) {
            alert((e && e.message) || "저장 실패");
        });
}

// ── 직원 계정 생성 ─────────────────────────────────────────────────────────────
// HTML: manageIdInput(사번) 입력 → addAllowedUser() 클릭
// 이름/권한/비밀번호는 팝업 방식으로 입력
function addAllowedUser() {
    if (!isAdmin && !isSuperAdmin) return;

    var empNoInput = document.getElementById("manageIdInput");
    var empNo = empNoInput ? empNoInput.value.trim() : "";

    if (!empNo) {
        alert("사번을 입력해주세요.");
        return;
    }

    var name = window.prompt("직원 이름을 입력해주세요:");
    if (!name || !name.trim()) { alert("이름을 입력해야 합니다."); return; }
    name = name.trim();

    var role = window.prompt("권한을 입력해주세요 (staff / admin):", "staff");
    if (!role) role = "staff";
    role = role.trim().toLowerCase();
    if (role !== "staff" && role !== "admin") {
        alert("권한은 'staff' 또는 'admin' 중 하나여야 합니다.");
        return;
    }

    var tempPass = window.prompt("임시 비밀번호를 입력해주세요 (6자 이상):");
    if (!tempPass || tempPass.length < 6) {
        alert("비밀번호는 6자 이상이어야 합니다.");
        return;
    }

    var deptId = currentDept;
    if (!deptId) {
        alert("지점 정보가 없습니다. 다시 로그인해주세요.");
        return;
    }

    fn.createEmployee({
        empNo:    empNo,
        name:     name,
        deptId:   deptId,
        role:     role,
        password: tempPass
    }).then(function(result) {
        if (empNoInput) empNoInput.value = "";
        // 직원 목록 갱신
        if (typeof loadDeptEmployees === "function") {
            loadDeptEmployees(deptId).then(function() {
                drawAllowedUsersBoard();
            });
        }
        alert("✅ 계정 생성 완료!\n사번: " + empNo + "\n이름: " + name + "\n권한: " + role);
    }).catch(function(e) {
        alert("계정 생성 실패: " + ((e && e.message) || "알 수 없는 오류"));
    });
}

function removeAllowedUser() {
    if (!isSuperAdmin) {
        alert("직원 삭제는 슈퍼관리자만 가능합니다.");
        return;
    }

    var empNo = document.getElementById("manageIdInput") ? document.getElementById("manageIdInput").value.trim() : "";
    if (!empNo) { alert("삭제할 사번을 입력해주세요."); return; }
    if (!confirm("[" + empNo + "] 직원을 삭제하시겠습니까?")) return;

    fn.deleteEmployee({ empNo: empNo }).then(function() {
        alert("삭제되었습니다.");
        if (document.getElementById("manageIdInput")) document.getElementById("manageIdInput").value = "";
        refreshData();
    }).catch(function(e) {
        alert((e && e.message) || "삭제 실패");
    });
}

// ── 모드 버튼 스타일 ──────────────────────────────────────────────────────────
function setModeButtonStyles() {
    var btn  = document.getElementById("toggleModeBtn");
    var scBtn = document.getElementById("scheduleCodeApplyBtn");
    var isSc = (currentAppMode === "SCHEDULE_CODE");

    if (btn) {
        btn.style.backgroundColor = isSc ? "#868e96" : "#ffd600";
        btn.style.color           = isSc ? "#fff"    : "#222";
        btn.style.border          = isSc ? "2px solid transparent" : "2px solid #e53935";
    }
    if (scBtn) {
        scBtn.style.backgroundColor = isSc ? "#ffd600" : "#868e96";
        scBtn.style.color           = isSc ? "#222"    : "#fff";
        scBtn.style.border          = isSc ? "2px solid #e53935" : "2px solid transparent";
    }
}

// ── 신청 모드 토글 (직원용) ──────────────────────────────────────────────────
function toggleApplicationMode() {
    var btn = document.getElementById("toggleModeBtn");
    if (currentAppMode === "SCHEDULE_CODE") currentAppMode = "NORMAL";
    else if (currentAppMode === "NORMAL")   currentAppMode = "PETITION";
    else if (currentAppMode === "PETITION") currentAppMode = "ANNUAL";
    else currentAppMode = "NORMAL";

    if (btn) {
        if (currentAppMode === "NORMAL")   btn.innerText = "휴무";
        if (currentAppMode === "PETITION") btn.innerText = "청원";
        if (currentAppMode === "ANNUAL")   btn.innerText = "연차";
    }
    setModeButtonStyles();
}

window.toggleGroupBoard          = toggleGroupBoard;
window.toggleAllowedUsersBoard   = toggleAllowedUsersBoard;
window.setAllowedUsersSortMode   = setAllowedUsersSortMode;
