/**
 * staff-overview.js
 * 직원모드 전용: [전체 신청 현황] / [신청 가능 현황] 탭.
 * 기존 calendar.js / [내 신청] 달력 로직은 건드리지 않고, 탭 전환으로
 * dashboardBody(내 신청 달력)와 이 파일이 그리는 두 패널을 show/hide 한다.
 *
 * 서버 호출은 탭당 월 단위 1회(fn.getStaffScheduleOverview / fn.getStaffDailyAvailability).
 * [전체 직원]/[소속 조] 필터, 신청 가능 현황의 상태/종류/근무코드 필터 모두
 * 이미 받은 결과를 클라이언트에서 filter/render 할 뿐, 서버를 다시 호출하지 않는다.
 */

var _staffActiveTab = "my";
var _staffOverviewFilter = "all";
var _staffOverviewCache = null;      // { key, data }
var _staffAvailabilityCache = null;  // { key, data }

// 신청 가능 현황 필터 상태 — 서버 재호출 없이 렌더링만 다시 한다.
// 같은 세션/같은 대상 월 안에서는 탭 왕복해도 유지한다.
var _staffAvailStatusFilter = "all";   // all | allowed | blocked | done
var _staffAvailTypeFilter = "all";     // all | normal | annual | petition | schedule
var _staffAvailCodeFilter = "all";     // "all" 또는 실제 scheduleCode 문자열(exact)

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
    var mygroupHint = document.getElementById("staffOverviewMygroupHint");
    if (mygroupBtn) {
        var unassigned = myGroups.length === 0;
        mygroupBtn.disabled = unassigned;
        mygroupBtn.title = unassigned ? "소속 조 미배정" : "";
        mygroupBtn.classList.toggle("disabled", unassigned);
        if (mygroupHint) mygroupHint.style.display = unassigned ? "inline" : "none";
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
                // 긴 근무코드(D_A 등)가 PC 고정폭 column에서 잘려도 hover로 전체 값을 확인할 수 있게 title 부여.
                html += '<td' + (val ? (' title="' + _escapeHtml(val) + '"') : '') + '>' + _escapeHtml(val) + '</td>';
            }
            html += '</tr>';
        });
    }

    html += '</tbody></table>';
    wrap.innerHTML = html;
}

// ── 신청 가능 현황 ────────────────────────────────────────────────────────────
// reasonCode 는 성격에 따라 "마감"/"불가" 두 계열로 나눠 표시한다(백엔드 reasonCode 자체는 무변경).
var STAFF_REASON_CLOSED = {  // 정원/한도가 이미 찬 경우 — "마감"이 자연스럽다
    DAY_LIMIT:            "전체 한도",
    GROUP_LIMIT:           "소속 조 한도",
    SCHEDULE_GROUP_LIMIT:  "소속 조 코드 한도"
};
var STAFF_REASON_BLOCKED = { // 애초에 신청 조건이 안 되는 경우 — "불가"가 자연스럽다
    USER_LIMIT:            "개인 휴무 한도 도달",
    ANNUAL_LIMIT:          "연차 한도 도달",
    SCHEDULE_USER_LIMIT:   "개인 코드 한도 도달",
    REQUEST_PERIOD:        "신청 기간 아님",
    INVALID_SCHEDULE_CODE: "유효하지 않은 코드"
};
function _staffReasonText(reasonCode) {
    if (STAFF_REASON_CLOSED[reasonCode]) return "마감 · " + STAFF_REASON_CLOSED[reasonCode];
    if (STAFF_REASON_BLOCKED[reasonCode]) return "불가 · " + STAFF_REASON_BLOCKED[reasonCode];
    return "마감"; // 알 수 없는 reasonCode에 대한 안전한 기본값
}

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

// ── 신청 가능 현황 필터 (client-side only — 서버 재호출 없음) ───────────────────
function setStaffAvailStatusFilter(filter) {
    _staffAvailStatusFilter = filter;
    ["all", "allowed", "blocked", "done"].forEach(function(f) {
        var btn = document.getElementById("staffAvailStatusFilter-" + f);
        if (btn) btn.classList.toggle("active", f === filter);
    });
    if (_staffAvailabilityCache) renderStaffAvailabilityList(_staffAvailabilityCache.data);
}

function setStaffAvailTypeFilter(filter) {
    _staffAvailTypeFilter = filter;
    ["all", "normal", "annual", "petition", "schedule"].forEach(function(f) {
        var btn = document.getElementById("staffAvailTypeFilter-" + f);
        if (btn) btn.classList.toggle("active", f === filter);
    });
    if (_staffAvailabilityCache) renderStaffAvailabilityList(_staffAvailabilityCache.data);
}

function setStaffAvailCodeFilter(codeName) {
    _staffAvailCodeFilter = codeName || "all";
    if (_staffAvailabilityCache) renderStaffAvailabilityList(_staffAvailabilityCache.data);
}

/** availability 응답의 info.schedule key들을 등장 순서대로 수집한다 (하드코딩 금지, exact codeName 그대로 사용) */
function _staffAvailCollectScheduleCodes(data) {
    var days = data.days || {};
    var seen = {};
    var list = [];
    Object.keys(days)
        .sort(function(a, b) { return parseInt(a, 10) - parseInt(b, 10); })
        .forEach(function(dayStr) {
            var info = days[dayStr];
            if (!info || !info.schedule) return;
            Object.keys(info.schedule).forEach(function(codeName) {
                if (seen[codeName]) return;
                seen[codeName] = true;
                list.push(codeName);
            });
        });
    return list;
}

function _staffUpdateAvailCodeSelect(data) {
    var sel = document.getElementById("staffAvailCodeSelect");
    if (!sel) return;
    var codes = _staffAvailCollectScheduleCodes(data);

    // 새로고침 후 이전에 선택했던 코드가 새 응답에 더 이상 없으면 "전체 코드"로 되돌린다.
    if (_staffAvailCodeFilter !== "all" && codes.indexOf(_staffAvailCodeFilter) === -1) {
        _staffAvailCodeFilter = "all";
    }

    var html = '<option value="all">전체 코드</option>';
    codes.forEach(function(c) {
        html += '<option value="' + _escapeHtml(c) + '">' + _escapeHtml(c) + '</option>';
    });
    sel.innerHTML = html;
    sel.value = _staffAvailCodeFilter;
}

var STAFF_TYPE_LABEL = { normal: "휴무", petition: "청원", annual: "연차" };

function _staffAvailabilityRow(label, item) {
    if (!item) return "";
    var stateClass = item.allowed ? "staff-avail-ok" : "staff-avail-no";
    var stateText = item.allowed ? "가능" : _staffReasonText(item.reasonCode);
    return '<div class="staff-avail-row">'
         + '<span class="staff-avail-label">' + _escapeHtml(label) + '</span>'
         + '<span class="staff-avail-state ' + stateClass + '">' + _escapeHtml(stateText) + '</span>'
         + '</div>';
}

function renderStaffAvailabilityList(data) {
    var listEl = document.getElementById("staffAvailabilityList");
    if (!listEl) return;

    var days = data.days || {};
    var totalDays = _daysInTargetMonth();
    var tm = getTargetYearMonth();

    _staffUpdateAvailCodeSelect(data);

    var codeFilterRow = document.getElementById("staffAvailCodeFilterRow");
    if (codeFilterRow) codeFilterRow.style.display = (_staffAvailTypeFilter === "schedule") ? "flex" : "none";

    var html = "";
    var visibleDays = 0;

    for (var d = 1; d <= totalDays; d++) {
        var dayStr = String(d);
        var info = days[dayStr];
        var rowsHtml = [];

        if (!info) {
            // 정상적으로는 발생하지 않지만(서버가 항상 1~말일을 채움), 방어적으로 처리.
            if (_staffAvailStatusFilter === "all" && _staffAvailTypeFilter === "all") {
                rowsHtml.push('<div class="staff-overview-loading">데이터 없음</div>');
            }
        } else if (info.existingRequest) {
            // ⚠️ 신청 완료 날짜는 서버에서 이미 모든 항목이 ALREADY_REQUESTED로 채워져
            // 있으므로, "신청 가능/신청 불가" 상태 필터에는 포함시키지 않고 "신청 완료"
            // 필터(또는 전체)에서만 별도 한 줄로 보여준다.
            var reqType = info.existingRequest.type;
            var statusOk = (_staffAvailStatusFilter === "all" || _staffAvailStatusFilter === "done");
            var typeOk = (_staffAvailTypeFilter === "all" || _staffAvailTypeFilter === reqType);
            var codeOk = (reqType !== "schedule") || (_staffAvailCodeFilter === "all") || (_staffAvailCodeFilter === info.existingRequest.scheduleCode);
            if (statusOk && typeOk && codeOk) {
                var reqLabel = (reqType === "schedule")
                    ? (info.existingRequest.scheduleCode || "근무코드")
                    : (STAFF_TYPE_LABEL[reqType] || reqType);
                rowsHtml.push(
                    '<div class="staff-avail-row staff-avail-done">'
                    + '<span class="staff-avail-label">이미 신청</span>'
                    + '<span class="staff-avail-state staff-avail-info">' + _escapeHtml(reqLabel) + '</span>'
                    + '</div>'
                );
            }
        } else if (_staffAvailStatusFilter !== "done") {
            // "신청 완료" 필터에서는 미신청 날짜의 개별 가능/불가 항목을 표시하지 않는다.
            var candidates = [];
            if (_staffAvailTypeFilter === "all" || _staffAvailTypeFilter === "normal") {
                candidates.push({ label: "휴무", item: info.normal });
            }
            if (_staffAvailTypeFilter === "all" || _staffAvailTypeFilter === "annual") {
                candidates.push({ label: "연차", item: info.annual });
            }
            if (_staffAvailTypeFilter === "all" || _staffAvailTypeFilter === "petition") {
                candidates.push({ label: "청원", item: info.petition });
            }
            if (_staffAvailTypeFilter === "all" || _staffAvailTypeFilter === "schedule") {
                var scheduleObj = info.schedule || {};
                // ⚠️ codeName은 split/startsWith 등으로 해석하지 않고, 응답의 key를 그대로 exact 비교한다.
                Object.keys(scheduleObj).forEach(function(codeName) {
                    if (_staffAvailCodeFilter !== "all" && _staffAvailCodeFilter !== codeName) return;
                    candidates.push({ label: codeName, item: scheduleObj[codeName] });
                });
            }
            candidates.forEach(function(c) {
                if (!c.item) return;
                if (_staffAvailStatusFilter === "allowed" && !c.item.allowed) return;
                if (_staffAvailStatusFilter === "blocked" && c.item.allowed) return;
                rowsHtml.push(_staffAvailabilityRow(c.label, c.item));
            });
        }

        if (rowsHtml.length === 0) continue; // 필터 결과가 없는 날짜는 카드 자체를 만들지 않는다.

        visibleDays++;
        html += '<div class="staff-avail-card">';
        html += '<div class="staff-avail-date">' + parseInt(tm.month, 10) + '월 ' + d + '일</div>';
        html += rowsHtml.join("");
        html += '</div>';
    }

    listEl.innerHTML = (visibleDays === 0)
        ? '<div class="staff-overview-loading">조건에 맞는 항목이 없습니다.</div>'
        : html;
}

// ⚠️ js/date-select.js에도 동일한 이름의 _escapeHtml()가 있고, 이 파일이 스크립트
// 로드 순서상 더 나중이라(index.html) 전역에서는 이 정의가 이긴다 — 두 정의가
// 서로 다르면(예: 작은따옴표 escape 누락) date-select.js의 data-code='...' 같은
// 홑따옴표 속성 보호가 조용히 약화된다. 반드시 두 파일에서 동일한 5개 문자
// (& < > " ') 를 이스케이프하도록 유지한다.
function _escapeHtml(str) {
    return String(str == null ? "" : str)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}
