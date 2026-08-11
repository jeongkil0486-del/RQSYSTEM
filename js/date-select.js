/**
 * date-select.js
 * "날짜별 제한 관리" 통합 팝업 — 특정일 휴무 제한 / 조별 휴무 제한 / 조별 근무 제한
 * 3개 기능을 하나의 달력 + 탭으로 관리한다. (동일한 달력 코드를 반복 작성하지 않기 위함)
 *
 * 달력은 하나만 존재하고, 날짜 선택 상태(dateManageState.selectedDays)는 탭을
 * 바꿔도 공유된다 — "날짜를 먼저 고르고 종류를 바꿔가며 설정"할 수 있어야 하기
 * 때문이다. 탭(activeTab)은 어떤 입력 영역을 보여줄지, 적용/일괄삭제가 어떤
 * 데이터를 대상으로 할지만 결정한다.
 *
 * 각 모드(SPECIAL_DAY_LIMIT / GROUP_DAY_LIMIT / SC_GROUP_DAY_LIMIT)의 실제
 * 데이터 read/write는 DATE_MANAGE_ADAPTERS 에 모아두고, 달력/선택/탭 전환 등
 * 공통 UI 로직은 이 파일이 한 번만 구현한다.
 *
 * 저장 방식은 saveDeptConfig 를 통한 "현재 월 전체 값 재구성 후 replace"이며,
 * 적용/삭제 모두 기존에 저장된 다른 날짜·다른 코드 값을 절대 누락시키지 않는다.
 * groupDayLimitsEnabled / scGroupDayLimitsEnabled 명시적 flag는 적용 시에만
 * 세팅하고, 삭제 시에는 절대 건드리지 않는다(legacy로 되돌아가지 않기 위함).
 * SC_GROUP_DAY_LIMIT 의 삭제는 반드시 "codeName_A".."codeName_E" 정확히 5개
 * key만 계산해서 지운다 — prefix/startsWith 매칭은 사용하지 않는다.
 */

var DATE_SELECT_MODES = ["SPECIAL_DAY_LIMIT", "GROUP_DAY_LIMIT", "SC_GROUP_DAY_LIMIT"];

var dateManageState = {
    monthKey: null,
    activeTab: "SPECIAL_DAY_LIMIT",
    activeDate: null,     // 마지막으로 클릭한 날짜 — "현재 설정" 요약 기준 (탭 공용)
    scCode: null,          // SC_GROUP_DAY_LIMIT 탭 전용: 현재 선택된 근무 코드
    selectedDays: []       // 탭 간 공유되는 선택 날짜 목록
};

var DATE_TAB_LABELS = {
    SPECIAL_DAY_LIMIT: "특정일 휴무",
    GROUP_DAY_LIMIT: "조별 휴무",
    SC_GROUP_DAY_LIMIT: "조별 근무"
};

// ── 모드별 데이터 어댑터 ────────────────────────────────────────────────────
// hasAnySetting: 달력 dot(종류별, 코드 무관) 표시용
// hasSetting: "설정된 날짜 전체 선택"에 쓰이는 탭(=코드) 스코프 존재 여부
// getSummaryLine: 오른쪽 "현재 설정" 통합 패널의 한 줄 요약
// readFormValues/apply/bulkDelete: 적용·일괄삭제 버튼 동작
var DATE_MANAGE_ADAPTERS = {

    SPECIAL_DAY_LIMIT: {
        hasAnySetting: function(day) {
            var tm = getTargetYearMonth();
            return liveDBData["rq_special_limit_" + tm.fullStr + "_" + day] !== undefined;
        },
        hasSetting: function(day) {
            return DATE_MANAGE_ADAPTERS.SPECIAL_DAY_LIMIT.hasAnySetting(day);
        },
        getSummaryLine: function(day) {
            var tm = getTargetYearMonth();
            var v = liveDBData["rq_special_limit_" + tm.fullStr + "_" + day];
            return v !== undefined ? (v + "명") : "-";
        },
        getAllConfiguredDays: function() {
            var tm = getTargetYearMonth();
            var prefix = "rq_special_limit_" + tm.fullStr + "_";
            return Object.keys(liveDBData)
                .filter(function(k) { return k.indexOf(prefix) === 0; })
                .map(function(k) { return parseInt(k.slice(prefix.length), 10); });
        },
        readFormValues: function() {
            var el = document.getElementById("dmSpecialLimitInput");
            var v = el ? parseInt(el.value, 10) : NaN;
            if (isNaN(v) || v < 0) { alert("0 이상의 숫자를 입력해주세요."); return null; }
            return v;
        },
        // 현재 월의 specialDayLimits 전체를 재구성해 한 번에 saveDeptConfig 로 저장한다.
        apply: function(days, limitVal) {
            var tm = getTargetYearMonth();
            var existing = _buildSpecialDayLimitsFromLiveData();
            days.forEach(function(day) { existing[String(day)] = limitVal; });
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { specialDayLimits: existing }
            }).then(function() {
                days.forEach(function(day) {
                    liveDBData["rq_special_limit_" + tm.fullStr + "_" + day] = limitVal;
                });
            });
        },
        bulkDelete: function(days) {
            var tm = getTargetYearMonth();
            var existing = _buildSpecialDayLimitsFromLiveData();
            days.forEach(function(day) { delete existing[String(day)]; });
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { specialDayLimits: existing }
            }).then(function() {
                days.forEach(function(day) {
                    delete liveDBData["rq_special_limit_" + tm.fullStr + "_" + day];
                });
            });
        }
    },

    GROUP_DAY_LIMIT: {
        hasAnySetting: function(day) {
            var d = (liveDBData["_groupDayLimits"] || {})[String(day)];
            return !!(d && Object.keys(d).length > 0);
        },
        hasSetting: function(day) {
            return DATE_MANAGE_ADAPTERS.GROUP_DAY_LIMIT.hasAnySetting(day);
        },
        // A~E 실제 값을 "A2 · B3 · C2 · D2 · E3" 형태로 압축 표시한다.
        // 설정되지 않은 조는 숫자 대신 "-"로 짧게 표시 (긴 문구 대신 한 줄 유지).
        getSummaryLine: function(day) {
            var d = (liveDBData["_groupDayLimits"] || {})[String(day)];
            if (!d || Object.keys(d).length === 0) return "-";
            return ["A", "B", "C", "D", "E"].map(function(g) {
                return g + (d[g] != null ? d[g] : "-");
            }).join(" · ");
        },
        getAllConfiguredDays: function() {
            return Object.keys(liveDBData["_groupDayLimits"] || {}).map(function(d) { return parseInt(d, 10); });
        },
        readFormValues: function() {
            var vals = {};
            var ok = true;
            ["A", "B", "C", "D", "E"].forEach(function(g) {
                var el = document.getElementById("dmGroupInput" + g);
                var v = el ? parseInt(el.value, 10) : NaN;
                if (isNaN(v) || v < 1) ok = false;
                vals[g] = v;
            });
            if (!ok) { alert("각 조 한도는 1 이상이어야 합니다."); return null; }
            return vals;
        },
        apply: function(days, vals) {
            var tm = getTargetYearMonth();
            var existing = _buildGroupDayLimitsFromLiveData();
            days.forEach(function(day) {
                var dayKey = String(day);
                existing[dayKey] = Object.assign({}, existing[dayKey] || {}, vals);
            });
            // groupDayLimitsEnabled: true — 이 달을 날짜별 방식으로 명시 전환.
            // 이후 전부 삭제해도 이 플래그는 유지되어 legacy groupMaxA~E로 되돌아가지 않는다.
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { groupDayLimits: existing, groupDayLimitsEnabled: true }
            }).then(function() {
                liveDBData["_groupDayLimits"] = existing;
                liveDBData["_groupDayLimitsEnabled"] = true;
            });
        },
        bulkDelete: function(days) {
            var tm = getTargetYearMonth();
            var existing = _buildGroupDayLimitsFromLiveData();
            days.forEach(function(day) { delete existing[String(day)]; });
            // ⚠️ groupDayLimitsEnabled 는 절대 건드리지 않는다(=true 유지).
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { groupDayLimits: existing }
            }).then(function() {
                liveDBData["_groupDayLimits"] = existing;
            });
        }
    },

    SC_GROUP_DAY_LIMIT: {
        // ⚠️ 달력 dot(종류: 조별 근무)은 "어떤 근무코드든" scGroupDayLimits 설정이
        // 하나 이상 있으면 표시한다 — 현재 선택한 코드와 무관하다.
        hasAnySetting: function(day) {
            var d = (liveDBData["_scGroupDayLimits"] || {})[String(day)];
            return !!(d && Object.keys(d).length > 0);
        },
        // "설정된 날짜 전체 선택"은 현재 선택한 코드에 정확히 한정한다.
        // ⚠️ prefix/startsWith 매칭 금지 — codeName "D" 삭제/조회 시 별개 코드인
        // "D_A"가 만든 키 "D_A_A"까지 "D_"로 시작한다고 오인하는 문제를 막기 위해,
        // 반드시 codeName_A ~ codeName_E "정확히 5개" key의 존재 여부만 검사한다.
        hasSetting: function(day) {
            var d = (liveDBData["_scGroupDayLimits"] || {})[String(day)];
            if (!d) return false;
            var codeName = dateManageState.scCode || "";
            var keys = ["A", "B", "C", "D", "E"].map(function(group) { return codeName + "_" + group; });
            return keys.some(function(key) { return Object.prototype.hasOwnProperty.call(d, key); });
        },
        // "현재 설정" 통합 패널: 현재 선택된 근무코드(scCode)의 A~E 실제 값을
        // "B코드 │ A1 · B- · C2 · D1 · E-" 형태로 보여준다. 같은 날짜에 다른
        // 근무코드 설정도 있으면 줄을 늘리지 않고 끝에 "+N코드"만 덧붙인다.
        // ⚠️ 다른 코드 존재 여부는 key.split("_")[0] 같은 단순 파싱을 쓰지 않는다
        // (codeName 자체에 "_"가 포함될 수 있어 기존 exact-key 규칙이 깨질 수 있음).
        // 반드시 등록된 스케줄 코드 목록을 기준으로 codeName+"_A"~"_E" exact key
        // 존재 여부만 확인한다 — bulkDelete/hasSetting과 동일한 exact-key 규칙.
        getSummaryLine: function(day) {
            var d = (liveDBData["_scGroupDayLimits"] || {})[String(day)] || {};
            var codeName = dateManageState.scCode;
            if (!codeName || Object.keys(d).length === 0) return "-";

            var mainLine = codeName + "코드 │ " + ["A", "B", "C", "D", "E"].map(function(g) {
                var v = d[codeName + "_" + g];
                return g + (v != null ? v : "-");
            }).join(" · ");

            var allCodes = (typeof getScheduleCodeList === "function") ? getScheduleCodeList() : [];
            var otherCount = 0;
            allCodes.forEach(function(c) {
                if (!c || c.name === codeName) return;
                var hasIt = ["A", "B", "C", "D", "E"].some(function(g) {
                    return Object.prototype.hasOwnProperty.call(d, c.name + "_" + g);
                });
                if (hasIt) otherCount++;
            });

            return mainLine + (otherCount > 0 ? ("  +" + otherCount + "코드") : "");
        },
        // 현재 선택 코드의 hasSetting() 기준 그대로 사용한다 (exact-key, prefix 아님).
        getAllConfiguredDays: function() {
            var src = liveDBData["_scGroupDayLimits"] || {};
            var self = DATE_MANAGE_ADAPTERS.SC_GROUP_DAY_LIMIT;
            return Object.keys(src)
                .filter(function(day) { return self.hasSetting(day); })
                .map(function(day) { return parseInt(day, 10); });
        },
        readFormValues: function() {
            var codeName = dateManageState.scCode;
            if (!codeName) { alert("근무 코드를 선택해주세요."); return null; }
            var vals = {};
            var any = false;
            var ok = true;
            ["A", "B", "C", "D", "E"].forEach(function(g) {
                var el = document.getElementById("dmGroupInput" + g);
                if (!el || el.value === "") return;
                var num = parseInt(el.value, 10);
                if (isNaN(num) || num < 0) { ok = false; return; }
                vals[codeName + "_" + g] = num;
                any = true;
            });
            if (!ok) { alert("0 이상의 숫자를 입력해주세요."); return null; }
            if (!any) { alert("최소 하나의 조 값을 입력해주세요."); return null; }
            return vals;
        },
        apply: function(days, vals) {
            var tm = getTargetYearMonth();
            var existing = _buildScGroupDayLimitsFromLiveData();
            days.forEach(function(day) {
                var dayKey = String(day);
                existing[dayKey] = Object.assign({}, existing[dayKey] || {}, vals);
            });
            // scGroupDayLimitsEnabled: true — 이 달을 날짜별 방식으로 명시 전환.
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { scGroupDayLimits: existing, scGroupDayLimitsEnabled: true }
            }).then(function() {
                liveDBData["_scGroupDayLimits"] = existing;
                liveDBData["_scGroupDayLimitsEnabled"] = true;
            });
        },
        // ⚠️ 선택한 코드(scCode)에 해당하는 키(codeName_A~E) "정확히 5개"만 제거한다.
        // prefix/startsWith 매칭은 쓰지 않는다 — codeName이 다른 코드명의 접두사와
        // 겹치는 경우(예: 코드 "D" 삭제 시 실제로는 별개 코드인 "D_A"라는 이름의
        // 코드가 만든 키 "D_A_A"까지 "D_"로 시작한다고 오인해 함께 지워버릴 수 있음)
        // 정확한 키 목록을 직접 계산해 삭제하면 이런 오탐이 원천적으로 불가능하다.
        // 같은 날짜에 있는 다른 코드의 설정은 절대 건드리지 않으며, 그 날짜에
        // 아무 설정도 남지 않은 경우에만 날짜 key 자체를 제거한다.
        bulkDelete: function(days) {
            var tm = getTargetYearMonth();
            var codeName = dateManageState.scCode;
            var existing = _buildScGroupDayLimitsFromLiveData();
            var keysToDelete = ["A", "B", "C", "D", "E"].map(function(group) {
                return codeName + "_" + group;
            });
            days.forEach(function(day) {
                var dayKey = String(day);
                var dayObj = existing[dayKey];
                if (!dayObj) return;
                keysToDelete.forEach(function(key) { delete dayObj[key]; });
                if (Object.keys(dayObj).length === 0) delete existing[dayKey];
                else existing[dayKey] = dayObj;
            });
            // ⚠️ scGroupDayLimitsEnabled 는 절대 건드리지 않는다(=true 유지).
            return fn.saveDeptConfig({
                deptId: currentDept, yyyymm: tm.fullStr,
                config: { scGroupDayLimits: existing }
            }).then(function() {
                liveDBData["_scGroupDayLimits"] = existing;
            });
        }
    }
};

/** 현재 월의 specialDayLimits 전체를 liveDBData 에서 재구성 (rq_special_limit_{yyyymm}_{day} 키 스캔) */
function _buildSpecialDayLimitsFromLiveData() {
    var tm = getTargetYearMonth();
    var prefix = "rq_special_limit_" + tm.fullStr + "_";
    var out = {};
    Object.keys(liveDBData).forEach(function(k) {
        if (k.indexOf(prefix) !== 0) return;
        out[k.slice(prefix.length)] = liveDBData[k];
    });
    return out;
}

function _resetDateSelectionIfMonthChanged() {
    var tm = getTargetYearMonth();
    if (dateManageState.monthKey !== tm.fullStr) {
        // ⚠️ 임시 선택 상태만 초기화한다 — Firebase에 이미 저장된 설정은 그대로 둔다.
        dateManageState.selectedDays = [];
        dateManageState.activeDate = null;
        dateManageState.monthKey = tm.fullStr;
    }
    return tm;
}

// ── 팝업 열기/닫기 ───────────────────────────────────────────────────────────
/** initialTab 을 생략하면 마지막으로 보던 탭(기본 특정일 휴무)으로 연다 */
function openDateManageModal(initialTab) {
    if (!isAdmin && !isSuperAdmin) return;
    var tm = _resetDateSelectionIfMonthChanged();
    var tab = (initialTab && DATE_SELECT_MODES.indexOf(initialTab) !== -1) ? initialTab : (dateManageState.activeTab || "SPECIAL_DAY_LIMIT");

    var monthLabel = document.getElementById("dateSelectMonthLabel");
    if (monthLabel) monthLabel.innerText = tm.year + "년 " + parseInt(tm.month, 10) + "월";

    switchDateManageTab(tab);

    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "flex";
}

function closeDateManageModal() {
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "none";
    // ⚠️ 임시 선택 상태만 초기화한다 — Firebase에 이미 저장된 설정은 절대 건드리지
    // 않는다. 다시 열면 선택 날짜/활성 날짜 없는 상태로 시작해야 한다.
    dateManageState.selectedDays = [];
    dateManageState.activeDate = null;
}

/** 탭 전환 — 달력/선택 날짜/activeDate 는 그대로 유지하고 입력 영역만 바꾼다 */
function switchDateManageTab(tab) {
    if (DATE_SELECT_MODES.indexOf(tab) === -1) return;
    dateManageState.activeTab = tab;

    document.querySelectorAll(".dm-tab-btn").forEach(function(btn) {
        var isActive = btn.getAttribute("data-tab") === tab;
        btn.classList.toggle("active", isActive);
    });

    var scCodeRow  = document.getElementById("dmScCodeRow");
    var specialRow = document.getElementById("dmSpecialInputRow");
    var groupRow   = document.getElementById("dmGroupInputRow");

    if (tab === "SC_GROUP_DAY_LIMIT") {
        if (scCodeRow)  scCodeRow.style.display = "";
        if (specialRow) specialRow.style.display = "none";
        if (groupRow)   groupRow.style.display = "";
        _populateDmScCodeSelect();
    } else if (tab === "GROUP_DAY_LIMIT") {
        if (scCodeRow)  scCodeRow.style.display = "none";
        if (specialRow) specialRow.style.display = "none";
        if (groupRow)   groupRow.style.display = "";
    } else {
        if (scCodeRow)  scCodeRow.style.display = "none";
        if (specialRow) specialRow.style.display = "";
        if (groupRow)   groupRow.style.display = "none";
    }

    _clearDmInputs();
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

function _populateDmScCodeSelect() {
    var sel = document.getElementById("dmScCodeSelect");
    if (!sel) return;
    var list = (typeof getScheduleCodeList === "function") ? getScheduleCodeList() : [];
    sel.innerHTML = "";
    list.forEach(function(c) {
        var opt = document.createElement("option");
        opt.value = c.name;
        opt.innerText = c.name;
        sel.appendChild(opt);
    });
    var first = list.length ? list[0].name : "";
    dateManageState.scCode = first;
    sel.value = first;
}

function onDmScCodeChange(codeName) {
    dateManageState.scCode = codeName;
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

function _clearDmInputs() {
    ["dmSpecialLimitInput", "dmGroupInputA", "dmGroupInputB", "dmGroupInputC", "dmGroupInputD", "dmGroupInputE"]
        .forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = "";
        });
}

// ── 달력 렌더링 ──────────────────────────────────────────────────────────────
// 날짜 셀마다 3종(특정일 휴무/조별 휴무/조별 근무) indicator dot을 모두 표시한다
// (긴 텍스트/숫자는 넣지 않는다 — 상세는 오른쪽 패널/탭 입력에서 확인).
function renderDateSelectionCalendar() {
    var grid = document.getElementById("dateSelectGrid");
    if (!grid) return;

    var tm = getTargetYearMonth();
    var y = parseInt(tm.year, 10);
    var m = parseInt(tm.month, 10);
    var firstDow = new Date(y, m - 1, 1).getDay();
    var totalDays = new Date(y, m, 0).getDate();
    var selected = dateManageState.selectedDays;

    var html = "";
    for (var e = 0; e < firstDow; e++) {
        html += "<span class='date-select-cell empty'></span>";
    }
    for (var d = 1; d <= totalDays; d++) {
        var dow = new Date(y, m - 1, d).getDay();
        var cls = "date-select-cell";
        if (dow === 0) cls += " sun";
        if (dow === 6) cls += " sat";
        if (selected.indexOf(d) !== -1) cls += " selected";
        if (dateManageState.activeDate === d) cls += " active";

        var dots = "";
        if (DATE_MANAGE_ADAPTERS.SPECIAL_DAY_LIMIT.hasAnySetting(d)) dots += "<span class='dm-cell-dot dm-dot-special'></span>";
        if (DATE_MANAGE_ADAPTERS.GROUP_DAY_LIMIT.hasAnySetting(d)) dots += "<span class='dm-cell-dot dm-dot-group'></span>";
        if (DATE_MANAGE_ADAPTERS.SC_GROUP_DAY_LIMIT.hasAnySetting(d)) dots += "<span class='dm-cell-dot dm-dot-sc'></span>";

        html += "<span class='" + cls + "' data-day='" + d + "' onclick='onDateManageCellClick(" + d + ")'>"
              + "<span class='dm-cell-num'>" + d + "</span>"
              + (dots ? "<span class='dm-cell-dots'>" + dots + "</span>" : "")
              + "</span>";
    }
    grid.innerHTML = html;
    _updateDateSelectSummary();
}

// 날짜 클릭 = 선택 토글. activeDate는 selectedDays와 항상 논리적으로 일관되게
// 유지한다 — 선택 해제된 날짜가 activeDate로 stale하게 남으면 안 된다.
function onDateManageCellClick(day) {
    var list = dateManageState.selectedDays;
    var idx = list.indexOf(day);
    if (idx === -1) {
        // 새로 선택: 이 날짜가 곧 활성 날짜가 된다.
        list.push(day);
        dateManageState.activeDate = day;
    } else {
        // 선택 해제: 이 날짜가 activeDate였다면, 남은 선택 중 하나(마지막)로
        // 옮기거나(있으면) null로(없으면) 되돌린다.
        list.splice(idx, 1);
        if (dateManageState.activeDate === day) {
            dateManageState.activeDate = list.length > 0 ? list[list.length - 1] : null;
        }
    }
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

function clearDateSelection() {
    dateManageState.selectedDays = [];
    dateManageState.activeDate = null;
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

/** 현재 탭(SC는 현재 코드) 기준으로 실제 설정이 존재하는 날짜를 모두 선택한다 */
function selectAllConfiguredDates() {
    var adapter = DATE_MANAGE_ADAPTERS[dateManageState.activeTab];
    if (!adapter) return;
    var days = adapter.getAllConfiguredDays().sort(function(a, b) { return a - b; });
    dateManageState.selectedDays = days;
    // stale activeDate 방지: 선택된 날짜가 있으면 그중 하나(마지막)를, 없으면 null.
    dateManageState.activeDate = days.length > 0 ? days[days.length - 1] : null;
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

function _updateDateSelectSummary() {
    var el = document.getElementById("dateSelectSummary");
    if (!el) return;
    var list = dateManageState.selectedDays.slice().sort(function(a, b) { return a - b; });
    el.innerText = list.length ? (list.length + "개 날짜 선택됨: " + list.map(function(d) { return d + "일"; }).join(", ")) : "선택된 날짜: 없음";
}

function _escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, function(ch) {
        return { "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[ch];
    });
}

// ── 오른쪽 패널: 활성 날짜의 3종 통합 요약 (최대 3줄, compact) ─────────────────
// 탭과 무관하게 항상 세 종류(특정일 휴무/조별 휴무/조별 근무)의 "실제 값"을
// 한눈에 보여준다 ("설정됨"처럼 존재 여부만 알려주는 표시는 쓰지 않는다).
// 현재 활성 탭에 해당하는 줄만 살짝 강조한다. 상세 수정은 "새 설정" 입력에서.
function _updateDmRightPanel() {
    var bodyEl = document.getElementById("dmDaySummaryBody");
    if (!bodyEl) return;

    var tm = getTargetYearMonth();
    var day = dateManageState.activeDate;
    if (day == null) {
        bodyEl.textContent = "날짜를 선택하세요";
        return;
    }

    var rows = [
        { tab: "SPECIAL_DAY_LIMIT", label: "특정일",   text: DATE_MANAGE_ADAPTERS.SPECIAL_DAY_LIMIT.getSummaryLine(day) },
        { tab: "GROUP_DAY_LIMIT",   label: "조별휴무", text: DATE_MANAGE_ADAPTERS.GROUP_DAY_LIMIT.getSummaryLine(day) },
        { tab: "SC_GROUP_DAY_LIMIT", label: "조별근무", text: DATE_MANAGE_ADAPTERS.SC_GROUP_DAY_LIMIT.getSummaryLine(day) }
    ];

    var html = "<div class='dm-summary-date'>" + _escapeHtml(parseInt(tm.month, 10) + "월 " + day + "일") + "</div>";
    html += rows.map(function(r) {
        var activeCls = (r.tab === dateManageState.activeTab) ? " active" : "";
        return "<div class='dm-summary-row" + activeCls + "'>"
             + "<span class='dm-summary-label'>" + _escapeHtml(r.label) + "</span>"
             + "<span class='dm-summary-value'>" + _escapeHtml(r.text) + "</span>"
             + "</div>";
    }).join("");

    bodyEl.innerHTML = html;
}

// ── 적용 / 일괄 삭제 (현재 탭 기준) ─────────────────────────────────────────────
function applyDateManageSetting() {
    if (!isAdmin && !isSuperAdmin) return;
    var tab = dateManageState.activeTab;
    var adapter = DATE_MANAGE_ADAPTERS[tab];
    if (!adapter) return;

    var days = dateManageState.selectedDays.slice();
    if (days.length === 0) { alert("적용할 날짜를 먼저 선택해주세요."); return; }

    var formValues = adapter.readFormValues();
    if (formValues === null) return; // adapter가 이미 alert 처리함

    adapter.apply(days, formValues).then(function() {
        // ⚠️ selectedDays/activeDate는 그대로 유지한다 — "날짜를 먼저 고르고
        // 종류를 바꿔가며 연속 설정"할 수 있어야 하므로, 저장 성공 후에도 선택은
        // 사용자가 명시적으로(전체 선택 해제/닫기/월 변경) 해제하기 전까지 남는다.
        // dot/현재 설정 요약/카드 요약만 최신 데이터 기준으로 다시 그린다.
        renderDateSelectionCalendar();
        _updateDmRightPanel();
        if (typeof _updateDateManageCardSummaries === "function") _updateDateManageCardSummaries();
        if (typeof refreshData === "function") refreshData();
        alert("설정이 적용되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function bulkDeleteDateManageSetting() {
    if (!isAdmin && !isSuperAdmin) return;
    var tab = dateManageState.activeTab;
    var adapter = DATE_MANAGE_ADAPTERS[tab];
    if (!adapter) return;

    var days = dateManageState.selectedDays.slice().sort(function(a, b) { return a - b; });
    if (days.length === 0) { alert("삭제할 날짜를 먼저 선택해주세요."); return; }

    var daysLabel = days.map(function(d) { return d + "일"; }).join(", ");
    var featureLabel = tab === "SPECIAL_DAY_LIMIT" ? "특정일 휴무 제한"
                      : tab === "GROUP_DAY_LIMIT"   ? "조별 휴무 제한"
                      : ("[" + (dateManageState.scCode || "") + "] 근무 제한");
    var confirmMsg = "선택한 " + days.length + "개 날짜의 " + featureLabel + "을 삭제하시겠습니까?\n" + daysLabel;
    if (!confirm(confirmMsg)) return;

    adapter.bulkDelete(days).then(function() {
        // ⚠️ "설정이 삭제됨"과 "날짜 선택 자체를 해제함"은 다른 동작이다 —
        // selectedDays/activeDate는 그대로 유지하고, dot/요약만 삭제 결과대로 갱신한다.
        renderDateSelectionCalendar();
        _updateDmRightPanel();
        if (typeof _updateDateManageCardSummaries === "function") _updateDateManageCardSummaries();
        if (typeof refreshData === "function") refreshData();
    }).catch(function(e) {
        alert((e && e.message) || "삭제 실패");
    });
}

// ── "날짜별 제한 관리" 카드 요약 텍스트 ─────────────────────────────────────────
function _updateDateManageCardSummaries() {
    var tm = getTargetYearMonth();
    var el = document.getElementById("dateManageCardSummary");
    if (!el) return;

    var prefix = "rq_special_limit_" + tm.fullStr + "_";
    var specialCount = Object.keys(liveDBData).filter(function(k) { return k.indexOf(prefix) === 0; }).length;
    var groupCount = Object.keys(liveDBData["_groupDayLimits"] || {}).length;

    var scSrc = liveDBData["_scGroupDayLimits"] || {};
    var scCount = 0;
    Object.keys(scSrc).forEach(function(day) {
        if (Object.keys(scSrc[day] || {}).length > 0) scCount++;
    });

    if (specialCount === 0 && groupCount === 0 && scCount === 0) {
        el.innerText = "설정된 날짜 없음";
    } else {
        el.innerText = "특정일 " + specialCount + " · 조별휴무 " + groupCount + " · 조별근무 " + scCount;
    }
}

document.addEventListener("keydown", function(e) {
    if (e.key !== "Escape") return;
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl && modalEl.style.display && modalEl.style.display !== "none") closeDateManageModal();
});
