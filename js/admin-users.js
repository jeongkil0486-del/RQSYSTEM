/**
 * admin-users.js
 * Employee list display, group assignment helpers,
 * employee create, password reset, sort mode.
 */

var allowedUsersSortMode = "empNo";
var groupBoardState = { POOL: [], A: [], B: [], C: [], D: [], E: [] };
var groupBoardStateLoaded = false;

function _getVisibleDeptEmployees() {
    return (Array.isArray(deptEmployees) ? deptEmployees : []).filter(function(emp) {
        return !!(emp && emp.uid && String(emp.empNo || "").trim() && String(emp.name || "").trim());
    });
}

// ── 직원 목록 정렬 (정렬 버튼용 — 표시 순서만, 배열 원본 비변경) ───────────
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

// ── ID 신청 (직원 목록) 보드 — 드래그로 순서 변경 ────────────────────────────
// deptEmployees 배열 순서 = 스케줄 다운로드(exportToExcel) 행 순서
function drawAllowedUsersBoard() {
    var board = document.getElementById("allowedUsersTooltipBoard");
    if (!board) return;
    var visibleEmployees = _getVisibleDeptEmployees();

    if (visibleEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>등록된 직원이 없습니다.</div>";
        return;
    }

    var html = "<strong style='color:#fff;font-size:13px;'>직원 목록 (" + visibleEmployees.length + "명)</strong>";
    html += "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>드래그로 순서 변경 → 스케줄 다운로드 순서에 반영</div>";
    html += "<div id='empDragList' style='display:flex;flex-wrap:wrap;gap:5px;'>";
    visibleEmployees.forEach(function(emp, idx) {
        html += "<span draggable='true' data-empidx='" + idx + "'"
              + " style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;"
              + "border-radius:5px;padding:4px 8px;font-size:12px;color:#2ecc71;"
              + "cursor:grab;user-select:none;white-space:nowrap;'"
              + ">"
              + emp.name + " (" + emp.empNo + ")</span>";
    });
    html += "</div>";
    board.innerHTML = html;

    // HTML5 드래그앤드롭 — deptEmployees 배열 재정렬
    var dragSrcIdx = null;
    board.querySelectorAll("span[draggable]").forEach(function(el) {
        el.addEventListener("dragstart", function(e) {
            dragSrcIdx = parseInt(this.getAttribute("data-empidx"), 10);
            e.dataTransfer.effectAllowed = "move";
            this.style.opacity = "0.5";
        });
        el.addEventListener("dragend", function() {
            this.style.opacity = "";
        });
        el.addEventListener("dragover", function(e) {
            e.preventDefault();
            e.dataTransfer.dropEffect = "move";
            this.style.outline = "2px solid #fff";
        });
        el.addEventListener("dragleave", function() {
            this.style.outline = "";
        });
        el.addEventListener("drop", function(e) {
            e.preventDefault();
            this.style.outline = "";
            var destIdx = parseInt(this.getAttribute("data-empidx"), 10);
            if (dragSrcIdx === null || dragSrcIdx === destIdx) return;
            var orderedVisible = _getVisibleDeptEmployees();
            var moved = orderedVisible.splice(dragSrcIdx, 1)[0];
            orderedVisible.splice(destIdx, 0, moved);
            var hiddenEmployees = (Array.isArray(deptEmployees) ? deptEmployees : []).filter(function(emp) {
                return !(emp && emp.uid && String(emp.empNo || "").trim() && String(emp.name || "").trim());
            });
            deptEmployees = orderedVisible.concat(hiddenEmployees);
            // 조회 맵 재구성
            employeeByUid   = {};
            employeeByEmpNo = {};
            employeeByName  = {};
            allowedUsers    = [];
            deptEmployees.forEach(function(emp) {
                if (!emp || !emp.uid) return;
                employeeByUid[emp.uid] = emp;
                if (emp.empNo) employeeByEmpNo[String(emp.empNo).toLowerCase()] = emp;
                if (emp.name)  employeeByName[emp.name] = emp;
                allowedUsers.push(emp.name);
            });
            drawAllowedUsersBoard();
        });
    });
}

function toggleAllowedUsersBoard(event) {
    drawAllowedUsersBoard();
    var board = document.getElementById("allowedUsersTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

// ── 조 관련 ───────────────────────────────────────────────────────────────────
function toggleGroupBoard(event) {
    groupBoardStateLoaded = false;
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

function _normalizeGroupToken(token) {
    var raw = String(token || "").trim();
    if (!raw) return "";
    var emp = employeeByUid[raw] || employeeByEmpNo[raw.toLowerCase()];
    return emp ? (emp.uid || emp.empNo || raw) : raw;
}

function _getGroupBoardTokenLabel(token) {
    var emp = employeeByUid[token] || employeeByEmpNo[String(token).toLowerCase()];
    if (!emp) return String(token || "");
    return emp.name + (emp.empNo ? " (" + emp.empNo + ")" : "");
}

function _buildGroupBoardState() {
    var state = { POOL: [], A: [], B: [], C: [], D: [], E: [] };
    var assigned = {};
    var visibleEmployees = _getVisibleDeptEmployees();

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        getLiveGroupList(group).forEach(function(member) {
            var token = _normalizeGroupToken(member);
            if (!token || assigned[token]) return;
            assigned[token] = true;
            state[group].push(token);
        });
    });

    visibleEmployees.forEach(function(emp) {
        if (!emp) return;
        var token = _normalizeGroupToken(emp.uid || emp.empNo);
        if (!token || assigned[token]) return;
        state.POOL.push(token);
    });

    groupBoardState = state;
    groupBoardStateLoaded = true;
}

function _moveGroupToken(token, targetZone, targetIndex) {
    if (!targetZone || !groupBoardState[targetZone]) return;
    var normalized = _normalizeGroupToken(token);
    if (!normalized) return;

    Object.keys(groupBoardState).forEach(function(zone) {
        groupBoardState[zone] = (groupBoardState[zone] || []).filter(function(item) {
            return item !== normalized;
        });
    });

    var list = groupBoardState[targetZone];
    var nextIndex = typeof targetIndex === "number" ? targetIndex : list.length;
    if (nextIndex < 0) nextIndex = 0;
    if (nextIndex > list.length) nextIndex = list.length;
    list.splice(nextIndex, 0, normalized);
}

function _bindGroupBoardDropTarget(target, zone, indexResolver) {
    if (!target) return;
    target.addEventListener("dragover", function(e) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        this.style.borderColor = "#fff";
    });
    target.addEventListener("dragleave", function() {
        this.style.borderColor = "";
    });
    target.addEventListener("drop", function(e) {
        e.preventDefault();
        this.style.borderColor = "";
        var token = e.dataTransfer.getData("text/plain");
        if (!token) return;
        var targetIndex = typeof indexResolver === "function" ? indexResolver(this) : undefined;
        _moveGroupToken(token, zone, targetIndex);
        drawLiveGroupBoards();
    });
}

// ── 조별 배정 보드 — 드래그 전용 ─────────────────────────────────────────────
function drawLiveGroupBoards() {
    var board = document.getElementById("groupListTooltipBoard");
    if (!board) return;
    if (!groupBoardStateLoaded) _buildGroupBoardState();

    var html = "<strong style='color:#fff;font-size:13px;'>조별 배정</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 6px;'>직원 ID 목록을 드래그해서 POOL/A/B/C/D/E 사이로만 이동할 수 있습니다. 직접 입력은 비활성화되었습니다.</div>";

    html += "<div style='margin-bottom:8px;display:flex;gap:6px;align-items:flex-start;'>";
    html += "<label style='color:#fff;font-weight:bold;width:38px;line-height:28px;flex-shrink:0;'>POOL</label>";
    html += "<div id='groupDropZonePOOL' class='group-drop-zone' style='flex:1;min-height:38px;background:rgba(255,255,255,0.04);border:1px dashed #555;border-radius:4px;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;'>";
    html += groupBoardState.POOL.length ? groupBoardState.POOL.map(function(token, index) {
        return "<span class='group-drag-emp group-member-chip' draggable='true' data-token='" + token + "' data-zone='POOL' data-index='" + index + "' style='background:rgba(52,152,219,0.2);border:1px solid #3498db;border-radius:4px;padding:3px 7px;font-size:12px;color:#74b9ff;cursor:grab;user-select:none;white-space:nowrap;'>" + _getGroupBoardTokenLabel(token) + "</span>";
    }).join("") : "<span style='color:#666;font-size:11px;'>미배정 직원</span>";
    html += "</div></div>";

    ["A","B","C","D","E"].forEach(function(group) {
        html += "<div style='margin:5px 0;display:flex;gap:6px;align-items:flex-start;'>";
        html += "<label style='color:#fff;font-weight:bold;width:38px;line-height:28px;flex-shrink:0;'>" + group + "</label>";
        html += "<div id='groupDropZone" + group + "' class='group-drop-zone' data-zone='" + group + "' style='flex:1;min-height:38px;background:rgba(255,255,255,0.04);border:1px dashed #555;border-radius:4px;padding:4px;display:flex;flex-wrap:wrap;gap:4px;align-content:flex-start;'>";
        html += groupBoardState[group].length ? groupBoardState[group].map(function(token, index) {
            return "<span class='group-drag-emp group-member-chip' draggable='true' data-token='" + token + "' data-zone='" + group + "' data-index='" + index + "' style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;border-radius:4px;padding:3px 7px;font-size:12px;color:#8af5b2;cursor:grab;user-select:none;white-space:nowrap;'>" + _getGroupBoardTokenLabel(token) + "</span>";
        }).join("") : "<span style='color:#666;font-size:11px;'>여기로 드래그</span>";
        html += "</div></div>";
    });

    html += "<button type='button' class='config-save-btn' style='margin-top:6px;' onclick='saveAllGroupsFromInputs()'>저장</button>";
    board.innerHTML = html;

    board.querySelectorAll(".group-drag-emp").forEach(function(el) {
        el.addEventListener("dragstart", function(e) {
            e.dataTransfer.setData("text/plain", this.getAttribute("data-token"));
            e.dataTransfer.effectAllowed = "move";
            this.style.opacity = "0.5";
        });
        el.addEventListener("dragend", function() {
            this.style.opacity = "";
        });
    });

    _bindGroupBoardDropTarget(document.getElementById("groupDropZonePOOL"), "POOL");
    ["A","B","C","D","E"].forEach(function(group) {
        _bindGroupBoardDropTarget(document.getElementById("groupDropZone" + group), group);
    });

    board.querySelectorAll(".group-member-chip").forEach(function(chip) {
        _bindGroupBoardDropTarget(chip, chip.getAttribute("data-zone"), function(node) {
            return parseInt(node.getAttribute("data-index"), 10);
        });
    });
}

function saveAllGroupsFromInputs() {
    if (!isAdmin && !isSuperAdmin) return;

    var groups = {};
    ["A","B","C","D","E"].forEach(function(group) {
        groups[group] = (groupBoardState[group] || []).slice();
    });

    fn.saveGroupAssignment({ deptId: currentDept, groups: groups, yyyymm: getTargetYearMonth().fullStr })
        .then(function(result) {
            var saved = (result.data && result.data.groups) || groups;
            Object.keys(saved).forEach(function(group) {
                liveDBData["rq_live_group_" + group] = saved[group];
            });
            groupBoardStateLoaded = false;
            drawLiveGroupBoards();
            alert("조 배정이 저장되었습니다.");
        }).catch(function(e) {
            alert((e && e.message) || "저장 실패");
        });
}

// ── 직원 계정 생성 ─────────────────────────────────────────────────────────────
function addAllowedUser() {
    if (!isAdmin && !isSuperAdmin) return;

    var empNoInput = document.getElementById("manageIdInput");
    var empNo = empNoInput ? empNoInput.value.trim() : "";
    if (!empNo) { alert("사번을 입력해주세요."); return; }

    var name = window.prompt("직원 이름:");
    if (!name || !name.trim()) { alert("이름을 입력해야 합니다."); return; }
    name = name.trim();

    var role = window.prompt("권한 (staff / admin):", "staff");
    if (!role) role = "staff";
    role = role.trim().toLowerCase();
    if (role !== "staff" && role !== "admin") {
        alert("권한은 staff 또는 admin 이어야 합니다.");
        return;
    }

    var tempPass = window.prompt("임시 비밀번호 (6자 이상):");
    if (!tempPass || tempPass.length < 6) {
        alert("비밀번호는 6자 이상이어야 합니다.");
        return;
    }

    var deptId = currentDept;
    if (!deptId) { alert("지점 정보가 없습니다. 다시 로그인해주세요."); return; }

    fn.createEmployee({
        empNo:        empNo,
        name:         name,
        deptId:       deptId,
        role:         role,
        tempPassword: tempPass
    }).then(function() {
        if (empNoInput) empNoInput.value = "";
        alert("✅ 계정 생성 완료!\n사번: " + empNo + "\n이름: " + name + "\n권한: " + role);
        if (typeof loadDeptEmployees === "function") {
            loadDeptEmployees(deptId).then(function() { drawAllowedUsersBoard(); });
        }
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

window.toggleGroupBoard        = toggleGroupBoard;
window.toggleAllowedUsersBoard = toggleAllowedUsersBoard;
window.setAllowedUsersSortMode = setAllowedUsersSortMode;
