/**
 * admin-users.js
 * Employee list display, group assignment helpers,
 * employee create, password reset, sort mode.
 */

var allowedUsersSortMode = "empNo";

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

    if (!deptEmployees || deptEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>등록된 직원이 없습니다.</div>";
        return;
    }

    var html = "<strong style='color:#fff;font-size:13px;'>직원 목록 (" + deptEmployees.length + "명)</strong>";
    html += "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>드래그로 순서 변경 → 스케줄 다운로드 순서에 반영</div>";
    html += "<div id='empDragList' style='display:flex;flex-wrap:wrap;gap:5px;'>";
    deptEmployees.forEach(function(emp, idx) {
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
            // deptEmployees 배열 재정렬 (exportToExcel 순서에 직결)
            var moved = deptEmployees.splice(dragSrcIdx, 1)[0];
            deptEmployees.splice(destIdx, 0, moved);
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

// ── 조별 배정 보드 — 드래그 + textarea 직접 입력 병행 ─────────────────────────
function drawLiveGroupBoards() {
    var board = document.getElementById("groupListTooltipBoard");
    if (!board) return;

    // 현재 각 조에 배정된 직원 id 집합
    var assignedGroup = {};
    ["A","B","C","D","E"].forEach(function(g) {
        getLiveGroupList(g).forEach(function(id) { assignedGroup[id] = g; });
    });

    var html = "<strong style='color:#fff;font-size:13px;'>조별 배정</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 6px;'>직원 태그를 조 드롭존으로 드래그하거나 사번 직접 입력 후 저장.</div>";

    // 드래그 소스: 전체 직원 태그
    html += "<div style='margin-bottom:6px;'>"
          + "<span style='color:#bdc3c7;font-size:11px;'>전체 직원:</span>"
          + "<div id='groupEmpPool' style='display:flex;flex-wrap:wrap;gap:4px;margin-top:3px;'>";
    deptEmployees.forEach(function(emp) {
        var token = emp.empNo || emp.uid;
        var inGroup = assignedGroup[emp.uid] || assignedGroup[String(emp.empNo).toLowerCase()] || "";
        var badge = emp.name + (inGroup ? " [" + inGroup + "]" : "");
        html += "<span class='group-drag-emp' draggable='true' data-token='" + token + "'"
              + " style='background:rgba(52,152,219,0.2);border:1px solid #3498db;border-radius:4px;"
              + "padding:3px 7px;font-size:12px;color:#74b9ff;cursor:grab;user-select:none;white-space:nowrap;'"
              + ">" + badge + "</span>";
    });
    html += "</div></div>";

    // A~E 조별 행
    ["A","B","C","D","E"].forEach(function(group) {
        var list   = getLiveGroupList(group);
        var tokens = list.map(function(id) {
            var emp = employeeByUid[id] || employeeByEmpNo[String(id).toLowerCase()];
            return emp ? emp.empNo : id;
        });
        var names = list.map(function(id) {
            var emp = employeeByUid[id] || employeeByEmpNo[String(id).toLowerCase()];
            return emp ? emp.name : id;
        });

        html += "<div style='margin:5px 0;display:flex;gap:6px;align-items:flex-start;'>";
        html += "<label style='color:#fff;font-weight:bold;width:26px;line-height:28px;flex-shrink:0;'>" + group + "</label>";
        // textarea (직접 입력 유지)
        html += "<textarea id='groupInput" + group + "' rows='2'"
              + " style='width:180px;font-size:12px;border-radius:4px;border:1px solid #666;padding:4px;'"
              + " placeholder='사번 또는 UID'>"
              + tokens.join(", ") + "</textarea>";
        // 드롭존
        html += "<div id='groupDropZone" + group + "'"
              + " style='flex:1;min-height:34px;background:rgba(255,255,255,0.04);border:1px dashed #555;"
              + "border-radius:4px;padding:4px;display:flex;flex-wrap:wrap;gap:3px;align-content:flex-start;'>";
        html += names.length
            ? names.map(function(name) {
                return "<span class='group-member' style='font-size:12px;'>" + name + "</span>";
              }).join("")
            : "<span style='color:#444;font-size:11px;'>여기로 드래그</span>";
        html += "</div></div>";
    });

    html += "<button type='button' class='config-save-btn' style='margin-top:6px;' onclick='saveAllGroupsFromInputs()'>저장</button>";
    board.innerHTML = html;

    // 드래그앤드롭 이벤트 등록
    // 소스: .group-drag-emp 태그
    board.querySelectorAll(".group-drag-emp").forEach(function(el) {
        el.addEventListener("dragstart", function(e) {
            e.dataTransfer.setData("text/plain", this.getAttribute("data-token"));
            e.dataTransfer.effectAllowed = "copy";
            this.style.opacity = "0.5";
        });
        el.addEventListener("dragend", function() { this.style.opacity = ""; });
    });

    // 드롭 타깃: 각 조의 textarea + 드롭존
    ["A","B","C","D","E"].forEach(function(group) {
        var ta = document.getElementById("groupInput" + group);
        var dz = document.getElementById("groupDropZone" + group);
        [ta, dz].forEach(function(target) {
            if (!target) return;
            target.addEventListener("dragover", function(e) {
                e.preventDefault();
                e.dataTransfer.dropEffect = "copy";
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
                // textarea에 사번 추가 (중복 방지)
                var cur   = ta.value.trim();
                var parts = cur ? cur.split(",").map(function(s) { return s.trim(); }).filter(Boolean) : [];
                if (parts.indexOf(token) < 0) {
                    parts.push(token);
                    ta.value = parts.join(", ");
                }
            });
        });
    });
}

function saveAllGroupsFromInputs() {
    if (!isAdmin && !isSuperAdmin) return;

    var groups = {};
    ["A","B","C","D","E"].forEach(function(group) {
        var el = document.getElementById("groupInput" + group);
        if (!el) return;
        var raw = el.value.trim();
        groups[group] = raw ? raw.split(",").map(function(s) { return s.trim(); }).filter(Boolean) : [];
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
