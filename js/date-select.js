/**
 * date-select.js
 * 공통 날짜별 설정 관리 팝업 — 특정일 휴무 제한 / 조별 휴무 제한 / 조별 근무 제한
 * 3개 기능에서 공용으로 사용한다. (동일한 달력 코드를 반복 작성하지 않기 위함)
 *
 * "왼쪽 달력 + 오른쪽 상세/설정" 한 팝업 안에서 현황 확인/날짜 선택/설정/수정/
 * 일괄 삭제를 모두 처리한다. 각 모드(SPECIAL_DAY_LIMIT / GROUP_DAY_LIMIT /
 * SC_GROUP_DAY_LIMIT)의 실제 데이터 read/write는 DATE_MANAGE_ADAPTERS 에
 * 모아두고, 달력/선택/렌더링 등 공통 UI 로직은 이 파일이 한 번만 구현한다.
 *
 * 저장 방식은 saveDeptConfig 를 통한 "현재 월 전체 값 재구성 후 replace"이며,
 * 적용/삭제 모두 기존에 저장된 다른 날짜 값을 절대 누락시키지 않는다.
 * groupDayLimitsEnabled / scGroupDayLimitsEnabled 명시적 flag는 적용 시에만
 * 세팅하고, 삭제 시에는 절대 건드리지 않는다(legacy로 되돌아가지 않기 위함).
 */

var DATE_SELECT_MODES = ["SPECIAL_DAY_LIMIT", "GROUP_DAY_LIMIT", "SC_GROUP_DAY_LIMIT"];

var dateSelectorState = {
    mode: null,
    monthKey: null,
    activeDate: null,   // 마지막으로 클릭한 날짜 — 오른쪽 "현재 설정" 표시 기준
    scCode: null,        // SC_GROUP_DAY_LIMIT 전용: 현재 선택된 근무 코드
    selectedDays: {
        SPECIAL_DAY_LIMIT: [],
        GROUP_DAY_LIMIT: [],
        SC_GROUP_DAY_LIMIT: []
    }
};

var DATE_SELECT_TITLES = {
    SPECIAL_DAY_LIMIT: "특정일 휴무 제한 관리",
    GROUP_DAY_LIMIT: "조별 휴무 제한 관리",
    SC_GROUP_DAY_LIMIT: "조별 근무 제한 관리"
};

// ── 모드별 데이터 어댑터 ────────────────────────────────────────────────────
// hasSetting/getCurrentText/getAllConfiguredDays 는 달력 dot·오른쪽 패널 렌더링에,
// readFormValues/apply/bulkDelete 는 적용·일괄삭제 버튼 동작에 쓰인다.
var DATE_MANAGE_ADAPTERS = {

    SPECIAL_DAY_LIMIT: {
        needsCode: false,

        hasSetting: function(day) {
            var tm = getTargetYearMonth();
            return liveDBData["rq_special_limit_" + tm.fullStr + "_" + day] !== undefined;
        },
        getCurrentText: function(day) {
            var tm = getTargetYearMonth();
            var v = liveDBData["rq_special_limit_" + tm.fullStr + "_" + day];
            return v !== undefined ? ("제한 인원: " + v + "명") : "설정 없음";
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
        // (setSpecialDayLimit 를 날짜마다 순차 호출하지 않고 단일 batch 저장으로 처리)
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
        needsCode: false,

        hasSetting: function(day) {
            var d = (liveDBData["_groupDayLimits"] || {})[String(day)];
            return !!(d && Object.keys(d).length > 0);
        },
        getCurrentText: function(day) {
            var d = (liveDBData["_groupDayLimits"] || {})[String(day)];
            if (!d) return "설정 없음";
            var parts = ["A", "B", "C", "D", "E"]
                .filter(function(g) { return d[g] != null; })
                .map(function(g) { return g + "조 " + d[g] + "명"; });
            return parts.length ? parts.join("\n") : "설정 없음";
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
        needsCode: true,

        hasSetting: function(day) {
            var d = (liveDBData["_scGroupDayLimits"] || {})[String(day)];
            if (!d) return false;
            var prefix = (dateSelectorState.scCode || "") + "_";
            return Object.keys(d).some(function(k) { return k.indexOf(prefix) === 0; });
        },
        getCurrentText: function(day) {
            var codeName = dateSelectorState.scCode;
            var d = (liveDBData["_scGroupDayLimits"] || {})[String(day)] || {};
            var lines = ["A", "B", "C", "D", "E"].map(function(g) {
                var v = d[codeName + "_" + g];
                return g + "조 " + (v != null ? (v + "명") : "설정 없음");
            });
            return lines.join("\n");
        },
        getAllConfiguredDays: function() {
            var src = liveDBData["_scGroupDayLimits"] || {};
            var prefix = (dateSelectorState.scCode || "") + "_";
            return Object.keys(src).filter(function(day) {
                var d = src[day];
                return d && Object.keys(d).some(function(k) { return k.indexOf(prefix) === 0; });
            }).map(function(day) { return parseInt(day, 10); });
        },
        readFormValues: function() {
            var codeName = dateSelectorState.scCode;
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
            var codeName = dateSelectorState.scCode;
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
    if (dateSelectorState.monthKey !== tm.fullStr) {
        dateSelectorState.selectedDays = {
            SPECIAL_DAY_LIMIT: [],
            GROUP_DAY_LIMIT: [],
            SC_GROUP_DAY_LIMIT: []
        };
        dateSelectorState.activeDate = null;
        dateSelectorState.monthKey = tm.fullStr;
    }
    return tm;
}

// ── 팝업 열기/닫기 ───────────────────────────────────────────────────────────
function openDateManageModal(mode) {
    if (!isAdmin && !isSuperAdmin) return;
    if (DATE_SELECT_MODES.indexOf(mode) === -1) return;
    var tm = _resetDateSelectionIfMonthChanged();

    dateSelectorState.mode = mode;
    dateSelectorState.activeDate = null;

    var titleEl = document.getElementById("dateSelectTitle");
    if (titleEl) titleEl.innerText = DATE_SELECT_TITLES[mode] || "날짜별 설정 관리";
    var monthLabel = document.getElementById("dateSelectMonthLabel");
    if (monthLabel) monthLabel.innerText = tm.year + "년 " + parseInt(tm.month, 10) + "월";

    var scCodeRow  = document.getElementById("dmScCodeRow");
    var specialRow = document.getElementById("dmSpecialInputRow");
    var groupRow   = document.getElementById("dmGroupInputRow");

    if (mode === "SC_GROUP_DAY_LIMIT") {
        if (scCodeRow)  scCodeRow.style.display = "";
        if (specialRow) specialRow.style.display = "none";
        if (groupRow)   groupRow.style.display = "";
        _populateDmScCodeSelect();
    } else if (mode === "GROUP_DAY_LIMIT") {
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

    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "flex";
}

function closeDateManageModal() {
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "none";
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
    dateSelectorState.scCode = first;
    sel.value = first;
}

function onDmScCodeChange(codeName) {
    dateSelectorState.scCode = codeName;
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
function renderDateSelectionCalendar() {
    var grid = document.getElementById("dateSelectGrid");
    if (!grid || !dateSelectorState.mode) return;

    var tm = getTargetYearMonth();
    var y = parseInt(tm.year, 10);
    var m = parseInt(tm.month, 10);
    var firstDow = new Date(y, m - 1, 1).getDay();
    var totalDays = new Date(y, m, 0).getDate();
    var selected = dateSelectorState.selectedDays[dateSelectorState.mode] || [];
    var adapter = DATE_MANAGE_ADAPTERS[dateSelectorState.mode];

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
        if (dateSelectorState.activeDate === d) cls += " active";
        var hasSetting = adapter ? adapter.hasSetting(d) : false;
        html += "<span class='" + cls + "' data-day='" + d + "' onclick='onDateManageCellClick(" + d + ")'>"
              + "<span class='dm-cell-num'>" + d + "</span>"
              + (hasSetting ? "<span class='dm-cell-dot'></span>" : "")
              + "</span>";
    }
    grid.innerHTML = html;
    _updateDateSelectSummary();
}

function onDateManageCellClick(day) {
    dateSelectorState.activeDate = day;
    toggleDateSelection(day); // 내부에서 renderDateSelectionCalendar() 재호출
    _updateDmRightPanel();
}

function toggleDateSelection(day) {
    var mode = dateSelectorState.mode;
    if (!mode) return;
    var list = dateSelectorState.selectedDays[mode] || [];
    var idx = list.indexOf(day);
    if (idx === -1) list.push(day);
    else list.splice(idx, 1);
    dateSelectorState.selectedDays[mode] = list;
    renderDateSelectionCalendar();
}

function clearDateSelection() {
    var mode = dateSelectorState.mode;
    if (!mode) return;
    dateSelectorState.selectedDays[mode] = [];
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

/** 현재 모드(SC 모드는 현재 코드 기준)에서 실제로 설정이 존재하는 날짜를 모두 선택한다 */
function selectAllConfiguredDates() {
    var mode = dateSelectorState.mode;
    var adapter = DATE_MANAGE_ADAPTERS[mode];
    if (!adapter) return;
    dateSelectorState.selectedDays[mode] = adapter.getAllConfiguredDays().sort(function(a, b) { return a - b; });
    renderDateSelectionCalendar();
    _updateDmRightPanel();
}

function _updateDateSelectSummary() {
    var el = document.getElementById("dateSelectSummary");
    if (!el || !dateSelectorState.mode) return;
    var list = (dateSelectorState.selectedDays[dateSelectorState.mode] || []).slice().sort(function(a, b) { return a - b; });
    el.innerText = list.length ? (list.length + "개 날짜 선택됨: " + list.map(function(d) { return d + "일"; }).join(", ")) : "선택된 날짜: 없음";
}

// ── 오른쪽 패널: 현재 설정 표시 ───────────────────────────────────────────────
function _updateDmRightPanel() {
    var mode = dateSelectorState.mode;
    var adapter = DATE_MANAGE_ADAPTERS[mode];
    var currentEl = document.getElementById("dmCurrentSetting");
    if (!adapter || !currentEl) return;

    var tm = getTargetYearMonth();
    var day = dateSelectorState.activeDate;
    if (day == null) {
        currentEl.innerText = "날짜를 선택하세요";
        return;
    }
    var label = parseInt(tm.month, 10) + "월 " + day + "일";
    if (mode === "SC_GROUP_DAY_LIMIT") {
        label = "코드 " + (dateSelectorState.scCode || "-") + " · " + label;
    }
    currentEl.innerText = label + "\n" + adapter.getCurrentText(day);
}

// ── 적용 / 일괄 삭제 ─────────────────────────────────────────────────────────
function applyDateManageSetting() {
    if (!isAdmin && !isSuperAdmin) return;
    var mode = dateSelectorState.mode;
    var adapter = DATE_MANAGE_ADAPTERS[mode];
    if (!adapter) return;

    var days = (dateSelectorState.selectedDays[mode] || []).slice();
    if (days.length === 0) { alert("적용할 날짜를 먼저 선택해주세요."); return; }

    var formValues = adapter.readFormValues();
    if (formValues === null) return; // adapter가 이미 alert 처리함

    adapter.apply(days, formValues).then(function() {
        dateSelectorState.selectedDays[mode] = [];
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
    var mode = dateSelectorState.mode;
    var adapter = DATE_MANAGE_ADAPTERS[mode];
    if (!adapter) return;

    var days = (dateSelectorState.selectedDays[mode] || []).slice().sort(function(a, b) { return a - b; });
    if (days.length === 0) { alert("삭제할 날짜를 먼저 선택해주세요."); return; }

    var daysLabel = days.map(function(d) { return d + "일"; }).join(", ");
    var featureLabel = mode === "SPECIAL_DAY_LIMIT" ? "특정일 휴무 제한"
                      : mode === "GROUP_DAY_LIMIT"   ? "조별 휴무 제한"
                      : ("[" + (dateSelectorState.scCode || "") + "] 근무 제한");
    var confirmMsg = "선택한 " + days.length + "개 날짜의 " + featureLabel + "을 삭제하시겠습니까?\n" + daysLabel;
    if (!confirm(confirmMsg)) return;

    adapter.bulkDelete(days).then(function() {
        dateSelectorState.selectedDays[mode] = [];
        renderDateSelectionCalendar();
        _updateDmRightPanel();
        if (typeof _updateDateManageCardSummaries === "function") _updateDateManageCardSummaries();
        if (typeof refreshData === "function") refreshData();
    }).catch(function(e) {
        alert((e && e.message) || "삭제 실패");
    });
}

// ── 카드 요약 텍스트 (설정된 날짜 N일) ────────────────────────────────────────
function _updateDateManageCardSummaries() {
    var tm = getTargetYearMonth();

    var specialEl = document.getElementById("specialDayCardSummary");
    if (specialEl) {
        var prefix = "rq_special_limit_" + tm.fullStr + "_";
        var n = Object.keys(liveDBData).filter(function(k) { return k.indexOf(prefix) === 0; }).length;
        specialEl.innerText = "설정된 날짜 " + n + "일";
    }

    var groupEl = document.getElementById("groupDayCardSummary");
    if (groupEl) {
        var gCount = Object.keys(liveDBData["_groupDayLimits"] || {}).length;
        groupEl.innerText = "설정된 날짜 " + gCount + "일";
    }

    var scEl = document.getElementById("scGroupDayCardSummary");
    if (scEl) {
        var src = liveDBData["_scGroupDayLimits"] || {};
        var scDays = 0;
        Object.keys(src).forEach(function(day) {
            if (Object.keys(src[day] || {}).length > 0) scDays++;
        });
        scEl.innerText = scDays > 0 ? ("설정된 날짜 " + scDays + "일 (전체 코드 합계)") : "설정된 날짜 없음";
    }
}

document.addEventListener("keydown", function(e) {
    if (e.key !== "Escape") return;
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl && modalEl.style.display && modalEl.style.display !== "none") closeDateManageModal();
});
