/**
 * schedule-codes.js — 스케줄 코드 관리 (Cloud Functions 경유)
 * setFirebaseItem 호출 없음.
 * 저장 구조: departments/{deptId}/configs/{yyyymm}/scheduleCodes
 *            = [{name, limit, displayName, color, active}]
 *            (displayName/color/active는 자동 월간 스케줄 기능을 위한 선택 필드.
 *             값이 없으면 각각 name/기본색/true로 간주하여 하위 호환을 유지한다.)
 *            departments/{deptId}/configs/{yyyymm}/scGroupLimits   = {"코드명_조": n}
 */

// 현재 근무코드 수정 중인 코드명 (null = 신규 생성 모드)
var _scEditingCodeName = null;

function getScheduleCodeList() {
    var raw = getFirebaseItem("schedule_codes_list", null);
    if (!raw) return [];
    try { return typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); }
    catch (e) { return []; }
}

// ── 코드 생성 / 수정 저장 ──────────────────────────────────────────────────────
// _scEditingCodeName 이 설정되어 있으면 "수정 저장" 모드로 동작한다.
// 수정 모드에서도 코드명(name)은 절대 변경하지 않는다 — 기존 신청 데이터가
// scheduleCode 값으로 name을 참조하고 있어, name이 바뀌면 과거 신청 내역과의
// 연결이 끊어지기 때문. 표시명/색상/제한/사용여부만 변경 가능.
function createScheduleCode() {
    if (!isAdmin && !isSuperAdmin) return;
    var nameEl    = document.getElementById("scheduleCodeInput");
    var dispEl    = document.getElementById("scheduleCodeDisplayName");
    var colorEl   = document.getElementById("scheduleCodeColor");
    var limitEl   = document.getElementById("scheduleCodeLimit");
    var activeEl  = document.getElementById("scheduleCodeActive");

    var codeName     = ((nameEl || {}).value || "").trim();
    var displayName  = ((dispEl || {}).value || "").trim();
    var color        = (colorEl || {}).value || "";
    var limitVal     = (limitEl || {}).value || "";
    var active       = activeEl ? !!activeEl.checked : true;
    var isEditing    = !!_scEditingCodeName;

    if (!codeName) { alert("❌ 코드명을 입력해주세요."); return; }
    var limitNum = limitVal === "" ? 999 : parseInt(limitVal, 10);
    if (isNaN(limitNum) || limitNum < 1) { alert("❌ 제한 개수는 1 이상."); return; }

    var list = getScheduleCodeList();

    if (isEditing) {
        codeName = _scEditingCodeName; // 안전장치: 수정 모드에서는 항상 원래 이름 유지
        var idx = list.findIndex(function(c){ return c.name === codeName; });
        if (idx === -1) { alert("해당 코드를 찾을 수 없습니다. (이미 삭제되었을 수 있음)"); cancelScheduleCodeEdit(); drawScheduleCodeBoard(); return; }
        list[idx] = Object.assign({}, list[idx], {
            name: codeName, limit: limitNum, displayName: displayName, color: color, active: active
        });
    } else {
        if (list.find(function(c){ return c.name === codeName; })) {
            alert("이미 존재하는 코드명입니다."); return;
        }
        list.push({ name: codeName, limit: limitNum, displayName: displayName, color: color, active: active });
    }

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scheduleCodes: list } })
      .then(function() {
          liveDBData["schedule_codes_list"] = list;
          alert(isEditing
              ? ("✨ [" + (displayName || codeName) + "] 수정 완료.")
              : ("✨ 근무코드 [" + (displayName || codeName) + "] 생성 완료. (제한: " + limitNum + "개)"));
          cancelScheduleCodeEdit();
          drawScheduleCodeBoard();
      }).catch(function(e) { alert(e.message || (isEditing ? "수정 실패" : "생성 실패")); });
}

// ── 코드 수정 모드 진입 (배지 클릭 시 호출) ───────────────────────────────────
function startScheduleCodeEdit(codeName) {
    if (!isAdmin && !isSuperAdmin) return;
    var list = getScheduleCodeList();
    var item = list.find(function(c){ return c.name === codeName; });
    if (!item) return;
    _scEditingCodeName = codeName;

    var nameEl   = document.getElementById("scheduleCodeInput");
    var dispEl   = document.getElementById("scheduleCodeDisplayName");
    var colorEl  = document.getElementById("scheduleCodeColor");
    var limitEl  = document.getElementById("scheduleCodeLimit");
    var activeEl = document.getElementById("scheduleCodeActive");
    var saveBtn  = document.getElementById("scheduleCodeSaveBtn");
    var cancelBtn= document.getElementById("scheduleCodeCancelEditBtn");

    if (nameEl)   { nameEl.value = item.name; nameEl.disabled = true; }
    if (dispEl)   dispEl.value = item.displayName || "";
    if (colorEl)  colorEl.value = item.color || "#e91e8c";
    if (limitEl)  limitEl.value = (item.limit != null ? item.limit : "");
    if (activeEl) activeEl.checked = (item.active !== false);
    if (saveBtn)  saveBtn.innerText = "수정 저장";
    if (cancelBtn) cancelBtn.style.display = "";
}

// ── 코드 수정 모드 취소 / 폼 초기화 ────────────────────────────────────────────
function cancelScheduleCodeEdit() {
    _scEditingCodeName = null;
    var nameEl   = document.getElementById("scheduleCodeInput");
    var dispEl   = document.getElementById("scheduleCodeDisplayName");
    var colorEl  = document.getElementById("scheduleCodeColor");
    var limitEl  = document.getElementById("scheduleCodeLimit");
    var activeEl = document.getElementById("scheduleCodeActive");
    var saveBtn  = document.getElementById("scheduleCodeSaveBtn");
    var cancelBtn= document.getElementById("scheduleCodeCancelEditBtn");

    if (nameEl)   { nameEl.value = ""; nameEl.disabled = false; }
    if (dispEl)   dispEl.value = "";
    if (colorEl)  colorEl.value = "#e91e8c";
    if (limitEl)  limitEl.value = "";
    if (activeEl) activeEl.checked = true;
    if (saveBtn)  saveBtn.innerText = "생성";
    if (cancelBtn) cancelBtn.style.display = "none";
}

// ── 코드 삭제 ────────────────────────────────────────────────────────────────
function deleteScheduleCode() {
    if (!isAdmin && !isSuperAdmin) return;
    var codeName = ((document.getElementById("scheduleCodeInput") || {}).value || "").trim();
    if (!codeName) { alert("삭제할 코드명을 입력해주세요."); return; }
    var list    = getScheduleCodeList();
    var newList = list.filter(function(c){ return c.name !== codeName; });
    if (newList.length === list.length) { alert("해당 코드가 없습니다."); return; }
    if (!confirm("[" + codeName + "] 코드를 삭제하시겠습니까?")) return;

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scheduleCodes: newList } })
      .then(function() {
          liveDBData["schedule_codes_list"] = newList;
          if (_scEditingCodeName === codeName) cancelScheduleCodeEdit();
          else document.getElementById("scheduleCodeInput").value = "";
          alert("🗑️ 삭제 완료.");
          drawScheduleCodeBoard();
      }).catch(function(e) { alert(e.message || "삭제 실패"); });
}

function drawScheduleCodeBoard() {
    // page-autoschedule가 active가 아니면 dirty 플래그만 세우고 건너뜀
    // (근무코드 관리 카드가 설정 페이지에서 자동스케줄 페이지로 이동됨)
    if (typeof _isPageActive === "function" && !_isPageActive("autoschedule")) {
        _dirtyScheduleCodeBoard = true;
        return;
    }
    _dirtyScheduleCodeBoard = false;

    var container = document.getElementById("scheduleCodeTooltipBoard");
    if (!container) return;
    var list = getScheduleCodeList();
    var html = "<strong style='color:#fff;font-size:13px;'>🗓️ 근무코드 목록</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>클릭: 수정 · 우클릭: 삭제</div>";
    if (list.length === 0) {
        html += "<div style='color:#bdc3c7;font-style:italic;font-size:12px;'>(생성된 코드 없음)</div>";
    } else {
        html += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
        list.forEach(function(c) {
            var isActive = (c.active !== false); // 필드 없으면(기존 코드) 사용중으로 간주 — 하위 호환
            var swatch   = c.color || "#e91e8c";
            var label    = c.displayName || c.name;
            html += "<span class='sc-code-badge' data-code='" + c.name + "'"
                  + " style='display:inline-flex;align-items:center;gap:5px;background:rgba(233,30,140,0.3);color:#ff80b0;border:1px solid #e91e8c;"
                  + "border-radius:5px;padding:4px 10px;font-size:12px;font-weight:bold;white-space:nowrap;cursor:pointer;"
                  + (isActive ? "" : "opacity:0.45;") + "'>"
                  + "<span style='display:inline-block;width:9px;height:9px;border-radius:50%;background:" + swatch + ";flex-shrink:0;pointer-events:none;'></span>"
                  + label + " <span style='color:#f8bbd0;font-weight:normal;pointer-events:none;'>제한 " + c.limit + "개</span>"
                  + (isActive ? "" : " <span style='color:#ffab91;font-weight:normal;pointer-events:none;'>(미사용)</span>")
                  + "</span>";
        });
        html += "</div>";
    }
    container.innerHTML = html;
    container.onclick = function(e) {
        var badge = e.target.closest(".sc-code-badge");
        if (!badge) return;
        startScheduleCodeEdit(badge.getAttribute("data-code"));
    };
    container.oncontextmenu = function(e) {
        var badge = e.target.closest(".sc-code-badge");
        if (!badge) return;
        e.preventDefault();
        deleteScheduleCodeFromBoard(e, badge.getAttribute("data-code"));
    };
    updateScGroupLimitCodeSelect();
}

function deleteScheduleCodeFromBoard(event, codeName) {
    event.preventDefault();
    if (!confirm("[" + codeName + "] 코드를 삭제하시겠습니까?")) return;
    var list = getScheduleCodeList().filter(function(c){ return c.name !== codeName; });
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scheduleCodes: list } })
      .then(function() {
          liveDBData["schedule_codes_list"] = list;
          if (_scEditingCodeName === codeName) cancelScheduleCodeEdit();
          drawScheduleCodeBoard();
      })
      .catch(function(e) { alert(e.message || "삭제 실패"); });
}

// ── 조별 코드 제한 ────────────────────────────────────────────────────────────
function updateScGroupLimitCodeSelect() {
    var sel = document.getElementById("scGroupLimitCodeSelect");
    if (!sel) return;
    var list = getScheduleCodeList();
    var cur  = sel.value;
    sel.innerHTML = '<option value="">코드 선택</option>';
    list.forEach(function(c) {
        var opt = document.createElement("option");
        opt.value = c.name; opt.innerText = c.name;
        sel.appendChild(opt);
    });
    if (cur) sel.value = cur;
}

function getScGroupLimit(codeName, groupLetter) {
    var key = "sc_glimit_" + codeName + "_" + groupLetter;
    var val = getFirebaseItem(key, null);
    return val !== null ? parseInt(val) : null;
}

function _buildScGroupLimitsFromLiveData() {
    // liveDBData["sc_glimit_코드명_조"] 를 { "코드명_조": n } 형태로 수집
    var result = {};
    Object.keys(liveDBData).forEach(function(k) {
        if (!k.startsWith("sc_glimit_")) return;
        var inner = k.replace("sc_glimit_", ""); // "코드명_조"
        result[inner] = liveDBData[k];
    });
    return result;
}

function saveScGroupLimit() {
    if (!isAdmin && !isSuperAdmin) return;
    var sel      = document.getElementById("scGroupLimitCodeSelect");
    var codeName = sel ? sel.value.trim() : "";
    if (!codeName) { alert("❌ 코드를 선택해주세요."); return; }

    var existing = _buildScGroupLimitsFromLiveData();
    var applied  = [];
    var ok = true;

    ["A","B","C","D","E"].forEach(function(g) {
        var el = document.getElementById("scGroupLimit" + g);
        if (!el || el.value === "") return;
        var num = parseInt(el.value);
        if (isNaN(num) || num < 0) { ok = false; return; }
        existing[codeName + "_" + g] = num;
        applied.push(g + "조: " + num + "명");
    });

    if (!ok) { alert("❌ 0 이상의 숫자를 입력해주세요."); return; }
    if (applied.length === 0) { alert("❌ 최소 하나의 조 값을 입력해주세요."); return; }

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scGroupLimits: existing } })
      .then(function() {
          // liveDBData 갱신
          Object.keys(existing).forEach(function(key) {
              liveDBData["sc_glimit_" + key] = existing[key];
          });
          alert("✨ [" + codeName + "] 조별 제한 적용!\n" + applied.join(" | "));
          drawScGroupLimitBoard();
      }).catch(function(e) { alert(e.message || "저장 실패"); });
}

function clearScGroupLimit() {
    if (!isAdmin && !isSuperAdmin) return;
    var sel      = document.getElementById("scGroupLimitCodeSelect");
    var codeName = sel ? sel.value.trim() : "";
    if (!codeName) { alert("❌ 코드를 선택해주세요."); return; }
    if (!confirm("[" + codeName + "] 코드의 조별 제한을 전체 해제하시겠습니까?")) return;

    var existing = _buildScGroupLimitsFromLiveData();
    ["A","B","C","D","E"].forEach(function(g) { delete existing[codeName + "_" + g]; });

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scGroupLimits: existing } })
      .then(function() {
          ["A","B","C","D","E"].forEach(function(g) {
              delete liveDBData["sc_glimit_" + codeName + "_" + g];
              var el = document.getElementById("scGroupLimit" + g); if (el) el.value = "";
          });
          alert("✨ 해제 완료.");
          drawScGroupLimitBoard();
      }).catch(function(e) { alert(e.message || "해제 실패"); });
}

window.saveScGroupLimit = saveScGroupLimit;
window.createScheduleCode = createScheduleCode;

function drawScGroupLimitBoard() {
    // page-requests가 active가 아니면 dirty 플래그만 세우고 건너뜀
    if (typeof _isPageActive === "function" && !_isPageActive("requests")) {
        _dirtyScGroupLimitBoard = true;
        return;
    }
    _dirtyScGroupLimitBoard = false;

    var container = document.getElementById("scGroupLimitTooltipBoard");
    if (!container) return;
    var list   = getScheduleCodeList();
    var LABELS = { A:"🔵A조", B:"🟣B조", C:"🟠C조", D:"🟢D조", E:"🔴E조" };
    var html   = "<strong style='color:#fff;font-size:13px;'>🔢 코드별 조별 제한 현황</strong>"
               + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 해당 조 제한 삭제</div>";
    if (list.length === 0) {
        html += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(생성된 코드 없음)</div>";
    } else {
        html += "<div style='display:flex;flex-direction:column;gap:6px;'>";
        list.forEach(function(c) {
            html += "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:4px;'>";
            html += "<span style='color:#ff80b0;font-weight:bold;font-size:13px;'>[" + c.name + "]</span> ";
            var hasLimit = false;
            ["A","B","C","D","E"].forEach(function(g) {
                var v = getScGroupLimit(c.name, g);
                if (v !== null) {
                    hasLimit = true;
                    html += "<span class='scgl-badge' data-code='" + c.name + "' data-group='" + g + "'"
                          + " style='background:rgba(233,30,140,0.25);border:1px solid #e91e8c;border-radius:5px;"
                          + "padding:3px 8px;font-size:12px;color:#f8bbd0;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                          + LABELS[g] + ": " + v + "명</span>";
                }
            });
            if (!hasLimit) html += "<span style='color:#aaa;font-size:11px;'>제한 없음</span>";
            html += "</div>";
        });
        html += "</div>";
    }
    container.innerHTML = html;
    container.oncontextmenu = function(e) {
        var badge = e.target.closest(".scgl-badge");
        if (!badge) return;
        e.preventDefault();
        deleteScGroupLimitFromBoard(e, badge.getAttribute("data-code"), badge.getAttribute("data-group"));
    };
}

function deleteScGroupLimitFromBoard(event, codeName, groupLetter) {
    event.preventDefault();
    if (!confirm("[" + codeName + "] " + groupLetter + "조 제한을 삭제하시겠습니까?")) return;
    var existing = _buildScGroupLimitsFromLiveData();
    delete existing[codeName + "_" + groupLetter];
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scGroupLimits: existing } })
      .then(function() {
          delete liveDBData["sc_glimit_" + codeName + "_" + groupLetter];
          drawScGroupLimitBoard();
      }).catch(function(e) { alert(e.message || "삭제 실패"); });
}

// ── 조별 날짜 카운트 ──────────────────────────────────────────────────────────
function getGroupScCodeCountByDate(groupArray, codeName, date) {
    var tm    = getTargetYearMonth();
    var count = 0;
    groupArray.forEach(function(member) {
        var name = resolveGroupMemberName(member);
        if (liveDBData["sc_" + codeName + "_" + name + "_" + tm.fullStr + "_" + date] !== undefined)
            count++;
    });
    return count;
}

// ── 색상 팔레트 ───────────────────────────────────────────────────────────────
var SC_COLOR_PALETTE = [
    { bg: "#f9a825", border: "#f57f17", color: "#333" },
    { bg: "#1565c0", border: "#0d47a1", color: "#fff" },
    { bg: "#2e7d32", border: "#1b5e20", color: "#fff" },
    { bg: "#e91e8c", border: "#880e4f", color: "#fff" },
    { bg: "#6a1b9a", border: "#4a148c", color: "#fff" },
    { bg: "#bf360c", border: "#870000", color: "#fff" },
    { bg: "#00838f", border: "#004d56", color: "#fff" },
    { bg: "#558b2f", border: "#33691e", color: "#fff" },
];
var _scColorMap = {};
var _scColorIdx = 0;

function getScheduleCodeColor(codeName) {
    if (_scColorMap[codeName] === undefined) {
        _scColorMap[codeName] = _scColorIdx % SC_COLOR_PALETTE.length;
        _scColorIdx++;
    }
    return SC_COLOR_PALETTE[_scColorMap[codeName]];
}

// ── 코드 모드 토글 (직원용) ───────────────────────────────────────────────────
function toggleScheduleCodeMode() {
    var scBtn    = document.getElementById("scheduleCodeApplyBtn");
    var fullList = getScheduleCodeList();
    var availList = fullList.filter(function(c) {
        // active === false 인 코드만 명시적으로 제외 (필드 없는 기존 코드는 그대로 사용 가능 — 하위 호환)
        if (c.active === false) return false;
        return getMyScheduleCodeCount(c.name) < c.limit;
    });
    if (availList.length === 0) {
        alert("사용 가능한 스케줄 코드가 없습니다."); return;
    }
    if (currentAppMode !== "SCHEDULE_CODE") {
        currentAppMode      = "SCHEDULE_CODE";
        currentScheduleCode = availList[0].name;
    } else {
        var curIdx  = availList.findIndex(function(c){ return c.name === currentScheduleCode; });
        var nextIdx = (curIdx + 1) % availList.length;
        currentScheduleCode = availList[nextIdx].name;
    }
    if (scBtn) scBtn.innerText = currentScheduleCode;
    setModeButtonStyles();
    refreshData();
}

function getMyScheduleCodeCount(codeName) {
    var tm     = getTargetYearMonth();
    var prefix = "sc_" + codeName + "_" + currentUser + "_" + tm.fullStr + "_";
    return Object.keys(liveDBData).filter(function(k){ return k.startsWith(prefix); }).length;
}

function getScheduleCodeUsedCount(codeName) {
    var prefix = "sc_" + codeName + "_";
    return Object.keys(liveDBData).filter(function(k){ return k.startsWith(prefix); }).length;
}
