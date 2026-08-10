/**
 * schedule-codes.js — 스케줄 코드 관리 (Cloud Functions 경유)
 * setFirebaseItem 호출 없음.
 * 저장 구조: departments/{deptId}/configs/{yyyymm}/scheduleCodes  = [{name,limit}]
 *            departments/{deptId}/configs/{yyyymm}/scGroupLimits   = {"코드명_조": n}
 */

function getScheduleCodeList() {
    var raw = getFirebaseItem("schedule_codes_list", null);
    if (!raw) return [];
    try { return typeof raw === "string" ? JSON.parse(raw) : (Array.isArray(raw) ? raw : []); }
    catch (e) { return []; }
}

// ── 코드 생성 ────────────────────────────────────────────────────────────────
function createScheduleCode() {
    if (!isAdmin && !isSuperAdmin) return;
    var codeName = (document.getElementById("scheduleCodeInput") || {}).value || "";
    var limitVal = (document.getElementById("scheduleCodeLimit") || {}).value || "";
    codeName = codeName.trim();
    if (!codeName) { alert("❌ 코드명을 입력해주세요."); return; }
    var limitNum = limitVal === "" ? 999 : parseInt(limitVal);
    if (isNaN(limitNum) || limitNum < 1) { alert("❌ 제한 개수는 1 이상."); return; }

    var list = getScheduleCodeList();
    if (list.find(function(c){ return c.name === codeName; })) {
        alert("이미 존재하는 코드명입니다."); return;
    }
    list.push({ name: codeName, limit: limitNum });

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scheduleCodes: list } })
      .then(function() {
          liveDBData["schedule_codes_list"] = list;
          document.getElementById("scheduleCodeInput").value = "";
          document.getElementById("scheduleCodeLimit").value = "";
          alert("✨ 스케줄 코드 [" + codeName + "] 생성 완료. (제한: " + limitNum + "개)");
          drawScheduleCodeBoard();
      }).catch(function(e) { alert(e.message || "생성 실패"); });
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
          document.getElementById("scheduleCodeInput").value = "";
          alert("🗑️ 삭제 완료.");
          drawScheduleCodeBoard();
      }).catch(function(e) { alert(e.message || "삭제 실패"); });
}

function drawScheduleCodeBoard() {
    // 스케줄 코드 카드가 설정 → 신청관리로 이동함에 따라 page-requests 기준으로 판정
    if (typeof _isPageActive === "function" && !_isPageActive("requests")) {
        _dirtyScheduleCodeBoard = true;
        return;
    }
    _dirtyScheduleCodeBoard = false;

    var container = document.getElementById("scheduleCodeTooltipBoard");
    if (!container) return;
    var list = getScheduleCodeList();
    var html = "<strong style='color:#fff;font-size:13px;'>🗓️ 스케줄 코드 목록</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
    if (list.length === 0) {
        html += "<div style='color:#bdc3c7;font-style:italic;font-size:12px;'>(생성된 코드 없음)</div>";
    } else {
        html += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
        list.forEach(function(c) {
            html += "<span class='sc-code-badge' data-code='" + c.name + "'"
                  + " style='background:rgba(233,30,140,0.3);color:#ff80b0;border:1px solid #e91e8c;"
                  + "border-radius:5px;padding:4px 10px;font-size:12px;font-weight:bold;white-space:nowrap;cursor:context-menu;'>"
                  + c.name + " <span style='color:#f8bbd0;font-weight:normal;pointer-events:none;'>제한 " + c.limit + "개</span></span>";
        });
        html += "</div>";
    }
    container.innerHTML = html;
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
      .then(function() { liveDBData["schedule_codes_list"] = list; drawScheduleCodeBoard(); })
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
    // liveDBData["sc_glimit_코드명_조"] 를 { "코드명_조": n } 형태로 수집 (레거시 월 전체 공통값)
    var result = {};
    Object.keys(liveDBData).forEach(function(k) {
        if (!k.startsWith("sc_glimit_")) return;
        var inner = k.replace("sc_glimit_", ""); // "코드명_조"
        result[inner] = liveDBData[k];
    });
    return result;
}

// ── 조별 근무(코드) 제한 (날짜별) ───────────────────────────────────────────────
// departments/{deptId}/configs/{yyyymm}/scGroupDayLimits/{day}/{코드명_조} = 인원수
// groupDayLimits 와 동일한 방식: 이 키가 한 번이라도 저장되면 그 달은 날짜별 방식이
// source of truth가 되고, 레거시 scGroupLimits(월 전체 공통)는 더 이상 적용되지 않는다.
function _buildScGroupDayLimitsFromLiveData() {
    var src = liveDBData["_scGroupDayLimits"] || {};
    var out = {};
    Object.keys(src).forEach(function(day) {
        out[day] = Object.assign({}, src[day] || {});
    });
    return out;
}

function openScGroupDayDateModal() {
    if (!isAdmin && !isSuperAdmin) return;
    openDateSelectionModal("SC_GROUP_DAY_LIMIT", function(days) {
        var el = document.getElementById("scGroupDaySelectedSummary");
        if (el) el.innerText = days.length ? ("선택 날짜: " + days.map(function(d) { return d + "일"; }).join(", ")) : "선택 날짜: 없음";
    });
}

function saveScGroupLimit() {
    if (!isAdmin && !isSuperAdmin) return;
    var sel      = document.getElementById("scGroupLimitCodeSelect");
    var codeName = sel ? sel.value.trim() : "";
    if (!codeName) { alert("❌ 코드를 선택해주세요."); return; }

    var vals = {};
    var applied = [];
    var ok = true;
    ["A","B","C","D","E"].forEach(function(g) {
        var el = document.getElementById("scGroupLimit" + g);
        if (!el || el.value === "") return;
        var num = parseInt(el.value);
        if (isNaN(num) || num < 0) { ok = false; return; }
        vals[codeName + "_" + g] = num;
        applied.push(g + "조: " + num + "명");
    });
    if (!ok) { alert("❌ 0 이상의 숫자를 입력해주세요."); return; }
    if (applied.length === 0) { alert("❌ 최소 하나의 조 값을 입력해주세요."); return; }

    var days = (dateSelectorState.selectedDays.SC_GROUP_DAY_LIMIT || []).slice();
    if (days.length === 0) { alert("❌ 날짜 선택 버튼으로 적용할 날짜를 먼저 선택해주세요."); return; }

    var existing = _buildScGroupDayLimitsFromLiveData();
    days.forEach(function(day) {
        var dayKey = String(day);
        existing[dayKey] = Object.assign({}, existing[dayKey] || {}, vals);
    });

    // scGroupDayLimitsEnabled: true — 이 달을 "날짜별 조별 근무 제한" 방식으로
    // 명시 전환한다. 이후 날짜별 설정을 모두 삭제해도 이 플래그는 유지되어
    // (설정 전체 초기화 전까지) 절대 legacy scGroupLimits로 되돌아가지 않는다.
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scGroupDayLimits: existing, scGroupDayLimitsEnabled: true } })
      .then(function() {
          liveDBData["_scGroupDayLimits"] = existing;
          liveDBData["_scGroupDayLimitsEnabled"] = true;
          refreshData();
          alert("✨ [" + codeName + "] 조별 근무 제한 적용!\n" + applied.join(" | "));
          drawScGroupLimitBoard();
      }).catch(function(e) { alert(e.message || "저장 실패"); });
}

function deleteScGroupDayLimitFromBoard(event, day) {
    event.preventDefault();
    if (!confirm(day + "일의 조별 근무 제한을 삭제하시겠습니까?")) return;

    var existing = _buildScGroupDayLimitsFromLiveData();
    delete existing[String(day)];

    // ⚠️ 날짜별 설정을 전부 지워 existing이 {} 가 되더라도 scGroupDayLimitsEnabled는
    // 절대 건드리지 않는다(=true 유지) — legacy scGroupLimits로 되돌아가면 안 된다.
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { scGroupDayLimits: existing } })
      .then(function() {
          liveDBData["_scGroupDayLimits"] = existing;
          drawScGroupLimitBoard();
      }).catch(function(e) { alert((e && e.message) || "삭제 실패"); });
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
window.openScGroupDayDateModal = openScGroupDayDateModal;
window.deleteScGroupDayLimitFromBoard = deleteScGroupDayLimitFromBoard;

function drawScGroupLimitBoard() {
    // page-requests가 active가 아니면 dirty 플래그만 세우고 건너뜀
    if (typeof _isPageActive === "function" && !_isPageActive("requests")) {
        _dirtyScGroupLimitBoard = true;
        return;
    }
    _dirtyScGroupLimitBoard = false;

    var container = document.getElementById("scGroupLimitTooltipBoard");
    if (!container) return;

    var data = liveDBData["_scGroupDayLimits"] || {};
    var days = Object.keys(data).map(function(d) { return parseInt(d, 10); }).sort(function(a, b) { return a - b; });

    var html = "<strong style='color:#fff;font-size:13px;'>🔢 조별 근무 제한 현황</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 해당 날짜 삭제</div>";
    if (days.length === 0) {
        html += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(설정된 날짜별 제한 없음)</div>";
    } else {
        html += "<div style='display:flex;flex-direction:column;gap:6px;'>";
        days.forEach(function(day) {
            var entries = data[String(day)] || {};
            var byCode = {};
            var order  = [];
            Object.keys(entries).forEach(function(key) {
                var lastUnderscore = key.lastIndexOf("_");
                if (lastUnderscore < 0) return;
                var code  = key.slice(0, lastUnderscore);
                var group = key.slice(lastUnderscore + 1);
                if (!byCode[code]) { byCode[code] = []; order.push(code); }
                byCode[code].push(group + " " + entries[key]);
            });
            var codeParts = order.map(function(code) {
                return "[" + code + "] " + byCode[code].join(" / ");
            }).join("&nbsp;&nbsp;");
            html += "<span class='scgdl-badge' data-day='" + day + "'"
                  + " style='background:rgba(233,30,140,0.2);border:1px solid #e91e8c;border-radius:5px;"
                  + "padding:4px 8px;font-size:12px;color:#f8bbd0;font-weight:bold;cursor:context-menu;white-space:normal;'>"
                  + day + "일 &nbsp; " + (codeParts || "제한 없음") + "</span>";
        });
        html += "</div>";
    }
    container.innerHTML = html;
    container.oncontextmenu = function(e) {
        var badge = e.target.closest(".scgdl-badge");
        if (!badge) return;
        e.preventDefault();
        deleteScGroupDayLimitFromBoard(e, badge.getAttribute("data-day"));
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

// ── 날짜별 조별 근무(코드) 제한 조회 (클라이언트 사전검사용 — 최종 판정은 서버) ─
// ⚠️ liveDBData["_scGroupDayLimits"] 객체의 존재 여부가 아니라, 명시적 플래그
// liveDBData["_scGroupDayLimitsEnabled"] 로만 날짜별 방식 사용 여부를 판단한다.
// 날짜별 설정을 전부 삭제해 데이터가 비어도(플래그는 true로 남음) 절대 legacy
// 월 전체 공통값(sc_glimit_*)으로 되돌아가지 않는다.
function _resolveScGroupDayLimit(codeName, group, dayStr) {
    var key = codeName + "_" + group;
    if (liveDBData["_scGroupDayLimitsEnabled"] === true) {
        var dayLimits = (liveDBData["_scGroupDayLimits"] || {})[dayStr];
        if (dayLimits && dayLimits[key] != null) return parseInt(dayLimits[key], 10);
        return null;
    }
    var legacy = getScGroupLimit(codeName, group);
    return legacy !== null ? legacy : null;
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
