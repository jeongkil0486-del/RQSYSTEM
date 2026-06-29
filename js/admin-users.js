/**
 * admin-users.js
 * Employee list display and group assignment helpers.
 */

var allowedUsersSortMode = "empNo";

function _sortDeptEmployeesForBoard(rows) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    if (allowedUsersSortMode === "name") {
        list.sort(function(a, b) {
            return String(a.name || "").localeCompare(String(b.name || ""), undefined, { sensitivity: "base" });
        });
        return list;
    }
    list.sort(function(a, b) {
        return String(a.empNo || "").localeCompare(String(b.empNo || ""), undefined, { numeric: true, sensitivity: "base" });
    });
    return list;
}

function setAllowedUsersSortMode(mode) {
    allowedUsersSortMode = (mode === "name") ? "name" : "empNo";
    drawAllowedUsersBoard();
}

function drawAllowedUsersBoard() {
    var board = document.getElementById("allowedUsersTooltipBoard");
    if (!board) return;

    if (!deptEmployees || deptEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>No employees loaded.</div>";
        return;
    }

    var sorted = _sortDeptEmployeesForBoard(deptEmployees);
    var empNoActive = allowedUsersSortMode === "empNo";
    var nameActive = allowedUsersSortMode === "name";
    var html = "<strong style='color:#fff;font-size:13px;'>Employees (" + sorted.length + ")</strong>";
    html += "<div style='display:flex;gap:6px;align-items:center;margin-top:8px;'>";
    html += "<button type='button' class='config-save-btn' style='padding:4px 8px;" + (empNoActive ? "background:#1565c0;color:#fff;" : "") + "' onclick='setAllowedUsersSortMode(\"empNo\")'>EmpNo</button>";
    html += "<button type='button' class='config-save-btn' style='padding:4px 8px;" + (nameActive ? "background:#2e7d32;color:#fff;" : "") + "' onclick='setAllowedUsersSortMode(\"name\")'>Name</button>";
    html += "</div>";
    html += "<div style='display:flex;flex-wrap:wrap;gap:5px;margin-top:7px;'>";
    sorted.forEach(function(emp) {
        html += "<span style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;border-radius:5px;padding:4px 8px;font-size:12px;color:#2ecc71;'>"
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
    try {
        return JSON.parse(val);
    } catch (e) {
        return [];
    }
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

    var html = "<strong style='color:#fff;font-size:13px;'>Group Assignment</strong>"
        + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 8px;'>Enter empNo or UID. Names are display only.</div>";

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var list = getLiveGroupList(group);
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
        html += "<textarea id='groupInput" + group + "' rows='2' style='width:210px;font-size:12px;border-radius:4px;border:1px solid #666;padding:5px;' placeholder='empNo or UID'>"
            + tokens.join(", ") + "</textarea>";
        html += "<div style='flex:1;display:flex;flex-wrap:wrap;gap:4px;'>";
        html += names.length
            ? names.map(function(name) { return "<span class='group-member'>" + name + "</span>"; }).join("")
            : "<span style='color:#aaa;font-size:12px;'>empty</span>";
        html += "</div></div>";
    });

    html += "<button type='button' class='config-save-btn' onclick='saveAllGroupsFromInputs()'>Save</button>";
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
            alert("Group assignment saved.");
        }).catch(function(e) {
            alert((e && e.message) || "Save failed.");
        });
}

function addAllowedUser() {
    if (!isAdmin && !isSuperAdmin) return;
    alert("Use the employee registration menu with empNo, name, dept, role and temp password.");
}

function removeAllowedUser() {
    if (!isSuperAdmin) {
        alert("Only super admin can delete employee accounts.");
        return;
    }

    var empNo = document.getElementById("manageIdInput") ? document.getElementById("manageIdInput").value.trim() : "";
    if (!empNo) {
        alert("Enter an empNo to delete.");
        return;
    }
    if (!confirm("Delete employee [" + empNo + "]?")) return;

    fn.deleteEmployee({ empNo: empNo }).then(function() {
        alert("Deleted.");
        if (document.getElementById("manageIdInput")) document.getElementById("manageIdInput").value = "";
        refreshData();
    }).catch(function(e) {
        alert((e && e.message) || "Delete failed.");
    });
}

function setModeButtonStyles() {
    var btn = document.getElementById("toggleModeBtn");
    var scBtn = document.getElementById("scheduleCodeApplyBtn");
    var isSc = (currentAppMode === "SCHEDULE_CODE");

    if (btn) {
        btn.style.backgroundColor = isSc ? "#868e96" : "#ffd600";
        btn.style.color = isSc ? "#fff" : "#222";
        btn.style.border = isSc ? "2px solid transparent" : "2px solid #e53935";
    }
    if (scBtn) {
        scBtn.style.backgroundColor = isSc ? "#ffd600" : "#868e96";
        scBtn.style.color = isSc ? "#222" : "#fff";
        scBtn.style.border = isSc ? "2px solid #e53935" : "2px solid transparent";
    }
}

window.toggleGroupBoard = toggleGroupBoard;
window.toggleAllowedUsersBoard = toggleAllowedUsersBoard;
window.setAllowedUsersSortMode = setAllowedUsersSortMode;

function toggleApplicationMode() {
    var btn = document.getElementById("toggleModeBtn");
    if (currentAppMode === "SCHEDULE_CODE") currentAppMode = "NORMAL";
    else if (currentAppMode === "NORMAL") currentAppMode = "PETITION";
    else if (currentAppMode === "PETITION") currentAppMode = "ANNUAL";
    else currentAppMode = "NORMAL";

    if (btn) {
        if (currentAppMode === "NORMAL") btn.innerText = "?대Т";
        if (currentAppMode === "PETITION") btn.innerText = "泥?썝";
        if (currentAppMode === "ANNUAL") btn.innerText = "?곗감";
    }
    setModeButtonStyles();
}
