/**
 * staff-overview.js
 * 직원모드 전용: [전체 신청 현황] / [신청 가능 현황] 탭.
 * 기존 calendar.js / [내 신청] 달력 로직은 건드리지 않고, 탭 전환으로
 * dashboardBody(내 신청 달력)와 이 파일이 그리는 두 패널을 show/hide 한다.
 *
 * 서버 호출은 탭당 월 단위 1회(fn.getStaffScheduleOverview / fn.getStaffDailyAvailability).
 * [전체 직원]/[내 조] 필터는 이미 받은 결과를 클라이언트에서 filter/render 할 뿐,
 * 서버를 다시 호출하지 않는다.
 */

var _staffActiveTab = "my";
var _staffOverviewFilter = "all";
var _staffOverviewCache = null;      // { key, data }
var _staffAvailabilityCache = null;  // { key, data }

function _staffCacheKey() {
    return currentDept + "|" + getTargetYearMonth().fullStr;
}

function _daysInTargetMonth() {
    var tm = getTargetYearMonth();
    return new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
}

// ── 탭 전환 ──────────────────────────────────────────────────────────────────
function switchStaffTab(tab) {
    _staffActiveTab = tab;

    // 내 신청 화면에서 신청/취소가 일어날 수 있으므로, 다시 조회 탭으로
    // 이동할 때 이전 월 데이터를 재사용하지 않도록 캐시를 무효화한다.
    if (tab === "my") {
        _staffOverviewCache = null;
        _staffAvailabilityCache = null;
    }

    ["my", "overview", "availability"].forEach(function(t) {
        var btn = document.getElementById("staffTabBtn-" + t);
        if (btn) btn.classList.toggle("active", t === tab);
    });

    var dashBody = document.getElementById("dashboardBody");
    var staffBar = document.getElementById("staffFilterBar");
    var overviewPanel = document.getElementById("staffOverviewPanel");
    var availabilityPanel = document.getElementById("staffAvailabilityPanel");

    if (dashBody) dashBody.style.display = (tab === "my") ? "grid" : "none";
    if (staffBar) staffBar.style.display = (tab === "my") ? "flex" : "none";
    if (overviewPanel) overviewPanel.style.display = (tab === "overview") ? "block" : "none";
    if (availabilityPanel) availabilityPanel.style.display = (tab === "availability") ? "block" : "none";

    if (tab === "overview") {
        var key = _staffCacheKey();
        if (_staffOverviewCache && _staffOverviewCache.key === key) {
            renderStaffOverviewTable(_staffOverviewCache.data);
        } else {
            refreshStaffOverview();
        }
    } else if (tab === "availability") {
        var key2 = _staffCacheKey();
        if (_staffAvailabilityCache && _staffAvailabilityCache.key === key2) {
            renderStaffAvailabilityList(_staffAvailabilityCache.data);
        } else {
            refreshStaffAvailability();
        }
    }
}

// ── 전체 신청 현황 ────────────────────────────────────────────────────────────
function refreshStaffOverview() {
    if (isAdmin || isSuperAdmin) return;
    var wrap = document.getElementById("staffOverviewTableWrap");
    if (wrap) wrap.innerHTML = '<div class="staff-overview-loading">불러오는 중...</div>';

    var deptId = currentDept;
    var yyyymm = getTargetYearMonth().fullStr;
    var key = deptId + "|" + yyyymm;

    fn.getStaffScheduleOverview({ deptId: deptId, yyyymm: yyyymm }).then(function(result) {
        var data = result.data || { yyyymm: yyyymm, myGroups: [], employees: [] };
        _staffOverviewCache = { key: key, data: data };
        renderStaffOverviewTable(data);
    }).catch(function(e) {
        if (wrap) wrap.innerHTML = '<div class="staff-overview-error">불러오기 실패: ' + ((e && e.message) || "알 수 없는 오류") + '</div>';
    });
}

function setStaffOverviewFilter(filter) {
    _staffOverviewFilter = filter;
    ["all", "mygroup"].forEach(function(f) {
        var btn = document.getElementById("staffOverviewFilter-" + f);
        if (btn) btn.classList.toggle("active", f === filter);
    });
    if (_staffOverviewCache) renderStaffOverviewTable(_staffOverviewCache.data);
}

function renderStaffOverviewTable(data) {
    var wrap = document.getElementById("staffOverviewTableWrap");
    if (!wrap) return;

    var myGroups = data.myGroups || [];
    var employees = data.employees || [];
    var totalDays = _daysInTargetMonth();

    var mygroupBtn = document.getElementById("staffOverviewFilter-mygroup");
    if (mygroupBtn) {
        var unassigned = myGroups.length === 0;
        mygroupBtn.disabled = unassigned;
        mygroupBtn.title = unassigned ? "미배정" : "";
        mygroupBtn.classList.toggle("disabled", unassigned);
        if (unassigned && _staffOverviewFilter === "mygroup") {
            _staffOverviewFilter = "all";
            var allBtn = document.getElementById("staffOverviewFilter-all");
            if (allBtn) allBtn.classList.add("active");
            mygroupBtn.classList.remove("active");
        }
    }

    var rows = employees;
    if (_staffOverviewFilter === "mygroup") {
        rows = employees.filter(function(emp) {
            return emp.group && myGroups.indexOf(emp.group) !== -1;
        });
    }

    var html = '<table class="staff-overview-table"><thead><tr><th class="staff-overview-sticky-col">직원명</th>';
    for (var d = 1; d <= totalDays; d++) html += '<th>' + d + '</th>';
    html += '</tr></thead><tbody>';

    if (rows.length === 0) {
        html += '<tr><td class="staff-overview-sticky-col" colspan="1">-</td>'
              + '<td colspan="' + totalDays + '" style="text-align:center;color:var(--text-sub);">표시할 직원이 없습니다.</td></tr>';
    } else {
        rows.forEach(function(emp) {
            var isMe = emp.uid === currentUid;
            html += '<tr class="' + (isMe ? "staff-overview-me" : "") + '">';
            html += '<td class="staff-overview-sticky-col">' + _escapeHtml(emp.name || emp.empNo || "") + '</td>';
            for (var day = 1; day <= totalDays; day++) {
                var val = (emp.days || {})[String(day)] || "";
                html += '<td>' + _escapeHtml(val) + '</td>';
            }
            html += '</tr>';
        });
    }

    html += '</tbody></table>';
    wrap.innerHTML = html;
}

// ── 신청 가능 현황 ────────────────────────────────────────────────────────────
var STAFF_REASON_LABEL = {
    ALREADY_REQUESTED:   "이미 신청함",
    DAY_LIMIT:            "전체 한도 마감",
    GROUP_LIMIT:          "소속 조 한도 마감",
    USER_LIMIT:           "개인 휴무 한도 도달",
    ANNUAL_LIMIT:         "연차 한도 도달",
    SCHEDULE_USER_LIMIT:  "개인 코드 한도 도달",
    SCHEDULE_GROUP_LIMIT: "소속 조 코드 한도 마감",
    REQUEST_PERIOD:       "신청 기간 아님",
    INVALID_SCHEDULE_CODE: "유효하지 않은 코드"
};

function refreshStaffAvailability() {
    if (isAdmin || isSuperAdmin) return;
    var listEl = document.getElementById("staffAvailabilityList");
    if (listEl) listEl.innerHTML = '<div class="staff-overview-loading">불러오는 중...</div>';

    var deptId = currentDept;
    var yyyymm = getTargetYearMonth().fullStr;
    var key = deptId + "|" + yyyymm;

    fn.getStaffDailyAvailability({ deptId: deptId, yyyymm: yyyymm }).then(function(result) {
        var data = result.data || { yyyymm: yyyymm, myGroups: [], days: {} };
        _staffAvailabilityCache = { key: key, data: data };
        renderStaffAvailabilityList(data);
    }).catch(function(e) {
        if (listEl) listEl.innerHTML = '<div class="staff-overview-error">불러오기 실패: ' + ((e && e.message) || "알 수 없는 오류") + '</div>';
    });
}

function _staffAvailabilityRow(label, item) {
    if (!item) return "";
    var stateClass = item.allowed ? "staff-avail-ok" : "staff-avail-no";
    var stateText = item.allowed ? "가능" : ("마감" + (item.reasonCode && STAFF_REASON_LABEL[item.reasonCode] ? " · " + STAFF_REASON_LABEL[item.reasonCode] : ""));
    return '<div class="staff-avail-row">'
         + '<span class="staff-avail-label">' + _escapeHtml(label) + '</span>'
         + '<span class="staff-avail-state ' + stateClass + '">' + _escapeHtml(stateText) + '</span>'
         + '</div>';
}

var STAFF_TYPE_LABEL = { normal: "휴무", petition: "청원", annual: "연차" };

function renderStaffAvailabilityList(data) {
    var listEl = document.getElementById("staffAvailabilityList");
    if (!listEl) return;

    var days = data.days || {};
    var totalDays = _daysInTargetMonth();
    var tm = getTargetYearMonth();
    var html = "";

    for (var d = 1; d <= totalDays; d++) {
        var dayStr = String(d);
        var info = days[dayStr];
        html += '<div class="staff-avail-card">';
        html += '<div class="staff-avail-date">' + parseInt(tm.month, 10) + '월 ' + d + '일</div>';

        if (!info) {
            html += '<div class="staff-overview-loading">데이터 없음</div>';
        } else if (info.existingRequest) {
            var reqType = info.existingRequest.type;
            var reqLabel = (reqType === "schedule")
                ? (info.existingRequest.scheduleCode || "근무코드")
                : (STAFF_TYPE_LABEL[reqType] || reqType);
            html += '<div class="staff-avail-row staff-avail-done">'
                  + '<span class="staff-avail-label">이미 신청</span>'
                  + '<span class="staff-avail-state staff-avail-info">' + _escapeHtml(reqLabel) + '</span>'
                  + '</div>';
        } else {
            html += _staffAvailabilityRow("휴무", info.normal);
            html += _staffAvailabilityRow("연차", info.annual);
            html += _staffAvailabilityRow("청원", info.petition);
            var scheduleKeys = Object.keys(info.schedule || {});
            scheduleKeys.forEach(function(codeName) {
                html += _staffAvailabilityRow(codeName, info.schedule[codeName]);
            });
        }

        html += '</div>';
    }

    listEl.innerHTML = html;
}

function _escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}
