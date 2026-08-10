/**
 * date-select.js
 * 공통 날짜 선택 모달 — 특정일 휴무 제한 / 조별 휴무 제한 / 조별 근무 제한
 * 3개 기능에서 공용으로 사용한다. (동일한 달력 코드를 반복 작성하지 않기 위함)
 *
 * mode 별로 선택 상태를 독립적으로 관리하므로, 한 기능에서 선택한 날짜가
 * 다른 기능의 모달을 열었을 때 섞여서 보이지 않는다.
 *
 * 여기서 다루는 "선택 상태"는 어디까지나 화면상의 임시 상태이며, Firebase에는
 * 각 기능의 "적용" 버튼을 눌러야 저장된다. 신청 대상 월이 바뀌면(getTargetYearMonth
 * 변경) 이미 저장된 Firebase 값은 그대로 두고, 아직 적용하지 않은 선택 상태만
 * 초기화한다.
 */

var DATE_SELECT_MODES = ["SPECIAL_DAY_LIMIT", "GROUP_DAY_LIMIT", "SC_GROUP_DAY_LIMIT"];

var dateSelectorState = {
    mode: null,
    monthKey: null,
    onConfirm: null,
    selectedDays: {
        SPECIAL_DAY_LIMIT: [],
        GROUP_DAY_LIMIT: [],
        SC_GROUP_DAY_LIMIT: []
    }
};

var DATE_SELECT_TITLES = {
    SPECIAL_DAY_LIMIT: "특정일 휴무 제한 — 날짜 선택",
    GROUP_DAY_LIMIT: "조별 휴무 제한 — 날짜 선택",
    SC_GROUP_DAY_LIMIT: "조별 근무 제한 — 날짜 선택"
};

function _resetDateSelectionIfMonthChanged() {
    var tm = getTargetYearMonth();
    if (dateSelectorState.monthKey !== tm.fullStr) {
        dateSelectorState.selectedDays = {
            SPECIAL_DAY_LIMIT: [],
            GROUP_DAY_LIMIT: [],
            SC_GROUP_DAY_LIMIT: []
        };
        dateSelectorState.monthKey = tm.fullStr;
    }
    return tm;
}

/**
 * openDateSelectionModal(mode, onConfirm)
 * mode  : "SPECIAL_DAY_LIMIT" | "GROUP_DAY_LIMIT" | "SC_GROUP_DAY_LIMIT"
 * onConfirm(selectedDaysArray) : 선택 완료 버튼을 눌렀을 때 호출되는 콜백
 */
function openDateSelectionModal(mode, onConfirm) {
    if (DATE_SELECT_MODES.indexOf(mode) === -1) return;
    var tm = _resetDateSelectionIfMonthChanged();

    dateSelectorState.mode = mode;
    dateSelectorState.onConfirm = onConfirm || null;

    var titleEl = document.getElementById("dateSelectTitle");
    if (titleEl) titleEl.innerText = DATE_SELECT_TITLES[mode] || "날짜 선택";
    var monthLabel = document.getElementById("dateSelectMonthLabel");
    if (monthLabel) monthLabel.innerText = tm.year + "년 " + parseInt(tm.month, 10) + "월";

    renderDateSelectionCalendar();

    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "flex";
}

function renderDateSelectionCalendar() {
    var grid = document.getElementById("dateSelectGrid");
    if (!grid || !dateSelectorState.mode) return;

    var tm = getTargetYearMonth();
    var y = parseInt(tm.year, 10);
    var m = parseInt(tm.month, 10);
    var firstDow = new Date(y, m - 1, 1).getDay();
    var totalDays = new Date(y, m, 0).getDate();
    var selected = dateSelectorState.selectedDays[dateSelectorState.mode] || [];

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
        html += "<span class='" + cls + "' data-day='" + d + "' onclick='toggleDateSelection(" + d + ")'>" + d + "</span>";
    }
    grid.innerHTML = html;
    _updateDateSelectSummary();
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
}

function _updateDateSelectSummary() {
    var el = document.getElementById("dateSelectSummary");
    if (!el || !dateSelectorState.mode) return;
    var list = (dateSelectorState.selectedDays[dateSelectorState.mode] || []).slice().sort(function(a, b) { return a - b; });
    el.innerText = list.length ? ("선택된 날짜: " + list.map(function(d) { return d + "일"; }).join(", ")) : "선택된 날짜: 없음";
}

function closeDateSelectionModal() {
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl) modalEl.style.display = "none";
}

function confirmDateSelection() {
    var mode = dateSelectorState.mode;
    if (!mode) { closeDateSelectionModal(); return; }
    var list = (dateSelectorState.selectedDays[mode] || []).slice().sort(function(a, b) { return a - b; });
    var cb = dateSelectorState.onConfirm;
    closeDateSelectionModal();
    if (typeof cb === "function") cb(list);
}

/** 선택된 날짜 목록을 "3일, 7일, 12일" 형태 문자열로 반환 (요약 표시용) */
function getSelectedDaysLabel(mode) {
    var list = (dateSelectorState.selectedDays[mode] || []).slice().sort(function(a, b) { return a - b; });
    return list.length ? list.map(function(d) { return d + "일"; }).join(", ") : "";
}

document.addEventListener("keydown", function(e) {
    if (e.key !== "Escape") return;
    var modalEl = document.getElementById("dateSelectModal");
    if (modalEl && modalEl.style.display && modalEl.style.display !== "none") closeDateSelectionModal();
});
