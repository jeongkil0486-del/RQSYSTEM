/**
 * admin-users.js
 * Employee list display, group assignment helpers,
 * employee create, password reset, sort mode.
 */

var allowedUsersSortMode = "empNo";
var allowedUsersSearchTerm = "";
var groupBoardState = { POOL: [], A: [], B: [], C: [], D: [], E: [] };
var groupBoardStateLoaded = false;

function _getVisibleDeptEmployees() {
    return (Array.isArray(deptEmployees) ? deptEmployees : []).filter(function(emp) {
        return !!(emp && emp.uid && String(emp.empNo || "").trim() && String(emp.name || "").trim());
    });
}

// ── 직원 목록 검색(사번/이름) — UI 필터링만, deptEmployees 원본은 그대로 ────────
function filterAllowedUsersBoard(term) {
    allowedUsersSearchTerm = String(term || "").trim().toLowerCase();
    drawAllowedUsersBoard();
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
    var listContainer = document.getElementById("allowedUsersTooltipBoardList");
    // (구버전 마크업과의 호환을 위해 list 컨테이너가 없으면 board 자체에 그린다)
    var board = listContainer || document.getElementById("allowedUsersTooltipBoard");
    if (!board) return;
    var visibleEmployees = _getVisibleDeptEmployees();

    var term = allowedUsersSearchTerm;
    var filteredEmployees = term ? visibleEmployees.filter(function(emp) {
        return String(emp.empNo || "").toLowerCase().indexOf(term) !== -1 ||
               String(emp.name  || "").toLowerCase().indexOf(term) !== -1;
    }) : visibleEmployees;

    if (visibleEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>등록된 직원이 없습니다.</div>";
        return;
    }
    if (filteredEmployees.length === 0) {
        board.innerHTML = "<div style='color:#aaa;font-size:13px;'>검색 결과가 없습니다.</div>";
        return;
    }

    var html = "<strong style='color:#fff;font-size:13px;'>직원 목록 (" + filteredEmployees.length + " / " + visibleEmployees.length + "명)</strong>";
    html += "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>드래그로 순서 변경 → 스케줄 다운로드 순서에 반영 (검색 중에는 순서 변경이 비활성화됩니다)</div>";
    html += "<div id='empDragList' style='display:flex;flex-wrap:wrap;gap:5px;'>";
    filteredEmployees.forEach(function(emp) {
        var idx = visibleEmployees.indexOf(emp);
        html += "<span" + (term ? "" : " draggable='true'") + " data-empidx='" + idx + "'"
              + " style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;"
              + "border-radius:5px;padding:4px 8px;font-size:12px;color:#2ecc71;"
              + "cursor:" + (term ? "default" : "grab") + ";user-select:none;white-space:nowrap;'"
              + ">"
              + emp.name + " (" + emp.empNo + ")</span>";
    });
    html += "</div>";
    board.innerHTML = html;

    if (term) return; // 검색 중에는 드래그 정렬 비활성화 (인덱스 불일치 방지)

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

// ── 조 관련 ───────────────────────────────────────────────────────────────────
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
    if (!emp) return "삭제된 직원";
    return emp.name + (emp.empNo ? " (" + emp.empNo + ")" : "");
}

function _buildGroupBoardState() {
    var state = { POOL: [], A: [], B: [], C: [], D: [], E: [] };
    var assigned = {};
    var visibleEmployees = _getVisibleDeptEmployees();

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        getLiveGroupList(group).forEach(function(member) {
            var raw = String(member || "").trim();
            if (!raw) return;
            var emp = employeeByUid[raw] || employeeByEmpNo[raw.toLowerCase()];
            if (!emp) return; // 삭제된/존재하지 않는 직원 — 화면에 표시하지 않고 자동으로 무시 (다음 저장 시 DB에서도 정리됨)
            var token = emp.uid || emp.empNo || raw;
            if (assigned[token]) return;
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

// ── 조별 배정 보드 — 드래그 전용, Grid(카드) 배치 + 저장 버튼 Sticky ──────────
function drawLiveGroupBoards() {
    var board = document.getElementById("groupListTooltipBoard");
    if (!board) return;
    if (!groupBoardStateLoaded) _buildGroupBoardState();

    var ZONE_LABELS = { A: "A조", B: "B조", C: "C조", D: "D조", E: "E조", POOL: "미배정" };
    var ZONE_ORDER  = ["A", "B", "C", "D", "E", "POOL"];

    var html = "<strong style='color:#fff;font-size:13px;'>조별 배정</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 6px;'>직원 카드를 드래그해서 조 사이로 이동할 수 있습니다. 직접 입력은 비활성화되었습니다.</div>";

    html += "<div class='group-board-scroll'>";
    html += "<div class='group-grid'>";
    ZONE_ORDER.forEach(function(zone) {
        var emptyMsg = zone === "POOL" ? "미배정 직원 없음" : "여기로 드래그";
        html += "<div class='group-grid-card'>";
        html += "<div class='group-grid-card-title'>" + ZONE_LABELS[zone] + "</div>";
        html += "<div id='groupDropZone" + zone + "' class='group-grid-dropzone' data-zone='" + zone + "'>";
        html += groupBoardState[zone].length ? groupBoardState[zone].map(function(token, index) {
            var isPool = zone === "POOL";
            var bg = isPool ? "rgba(52,152,219,0.2)" : "rgba(46,204,113,0.2)";
            var bd = isPool ? "#3498db" : "#2ecc71";
            var tx = isPool ? "#74b9ff" : "#8af5b2";
            return "<span class='group-drag-emp group-member-chip' draggable='true' data-token='" + token + "' data-zone='" + zone + "' data-index='" + index + "' style='background:" + bg + ";border:1px solid " + bd + ";border-radius:4px;padding:3px 7px;font-size:12px;color:" + tx + ";cursor:grab;user-select:none;white-space:nowrap;'>" + _getGroupBoardTokenLabel(token) + "</span>";
        }).join("") : "<span style='color:#666;font-size:11px;'>" + emptyMsg + "</span>";
        html += "</div></div>";
    });
    html += "</div>"; // .group-grid

    html += "<div class='group-board-stickyfoot'>";
    html += "<button type='button' class='btn btn-primary-sm' onclick='saveAllGroupsFromInputs()'>저장</button>";
    html += "</div>";
    html += "</div>"; // .group-board-scroll

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

    ZONE_ORDER.forEach(function(zone) {
        _bindGroupBoardDropTarget(document.getElementById("groupDropZone" + zone), zone);
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

window.setAllowedUsersSortMode = setAllowedUsersSortMode;
window.filterAllowedUsersBoard = filterAllowedUsersBoard;
