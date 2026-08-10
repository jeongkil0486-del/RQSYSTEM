/**
 * limits.js
 * Admin-side config helpers for request limits and annual quota upload.
 */

function formatDateTimeString(val) {
    if (!val) return "Not set";
    var d = (typeof val === "number") ? new Date(val) : new Date(val);
    if (isNaN(d.getTime())) return "Not set";
    return d.getFullYear() + "-"
        + String(d.getMonth() + 1).padStart(2, "0") + "-"
        + String(d.getDate()).padStart(2, "0") + " "
        + String(d.getHours()).padStart(2, "0") + ":"
        + String(d.getMinutes()).padStart(2, "0");
}

function getTargetYearMonth() {
    var now = new Date();
    var next = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    var defaultYM = next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0");
    var saved = getFirebaseItem("rq_current_target_year_month", defaultYM);
    var savedStr = String(saved || "");
    var parts;

    if (/^\d{6}$/.test(savedStr)) {
        parts = [savedStr.slice(0, 4), savedStr.slice(4, 6)];
    } else {
        parts = savedStr.split("-");
    }
    if (parts.length < 2 || !parts[0] || !parts[1]) {
        parts = defaultYM.split("-");
    }

    return {
        year:    parts[0],
        month:   String(parts[1]).padStart(2, "0"),
        fullStr: parts[0] + String(parts[1]).padStart(2, "0"),
        label:   parts[0] + "." + parseInt(parts[1], 10)
    };
}

function initYearMonthSelects(year, month) {
    var selY = document.getElementById("targetYear");
    var selM = document.getElementById("targetMonth");
    if (!selY || !selM) return;

    if (selY.options.length === 0) {
        var curY = new Date().getFullYear();
        for (var y = curY - 1; y <= curY + 2; y++) {
            var yOpt = document.createElement("option");
            yOpt.value = String(y);
            yOpt.text  = String(y);
            selY.appendChild(yOpt);
        }
    }
    if (selM.options.length === 0) {
        for (var m = 1; m <= 12; m++) {
            var mOpt = document.createElement("option");
            mOpt.value = String(m).padStart(2, "0");
            mOpt.text  = String(m);
            selM.appendChild(mOpt);
        }
    }

    selY.value = String(year);
    selM.value = String(month).padStart(2, "0");
}

function _refreshAfterAdminConfigSave(options) {
    options = options || {};
    if (options.reconnect && currentDept && typeof connectDeptDBSafe === "function") {
        return connectDeptDBSafe(currentDept).then(function() {
            refreshData();
        });
    }
    refreshData();
    return Promise.resolve();
}

// ── 신청 년/월 저장 ────────────────────────────────────────────────────────────
// 저장 형식: "YYYY-MM" (DB/liveDBData)  fullStr: "YYYYMM"
// 반복 변경이 가능하도록 connectDeptDB에 overrideYyyymm을 명시 전달
function saveYearMonthConfig() {
    if (!isAdmin && !isSuperAdmin) return;

    var selY = document.getElementById("targetYear");
    var selM = document.getElementById("targetMonth");
    if (!selY || !selM) return;

    var y = String(selY.value || "").trim();
    var m = String(selM.value || "").trim().padStart(2, "0");
    if (!y || !m || y.length !== 4) {
        alert("년/월을 올바르게 선택해주세요.");
        return;
    }

    var ymDash = y + "-" + m;   // "2025-07" — liveDBData/DB 저장 형식
    var ymFull = y + m;         // "202507"  — DB 경로/fullStr 형식

    var ymPrev = getTargetYearMonth().fullStr;  // 현재 연결 달 (로그인/새로고침 시 읽히는 경로)

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: ymFull,
        config: { targetYearMonth: ymDash }
    }).then(function() {
        // 현재 연결 달 config에도 targetYearMonth 저장
        // → 다음 로그인 시 이 경로를 읽어서 올바른 달로 자동 보정됨
        if (ymPrev && ymPrev !== ymFull) {
            return fn.saveDeptConfig({
                deptId: currentDept,
                yyyymm: ymPrev,
                config: { targetYearMonth: ymDash }
            });
        }
        return Promise.resolve();
    }).then(function() {
        liveDBData["rq_current_target_year_month"] = ymDash;
        return connectDeptDBSafe(currentDept, ymFull);
    }).then(function() {
        refreshData();
        alert("신청 년/월이 " + y + "년 " + parseInt(m, 10) + "월로 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function saveDayMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("dayMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 1) {
        alert("1 이상의 숫자를 입력해주세요.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { dayMax: val }
    }).then(function() {
        liveDBData["rq_config_day_max"] = val;
        refreshData();
        alert("월 휴무 제한이 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function saveGlobalUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("globalUserMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 1) {
        alert("1 이상의 숫자를 입력해주세요.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { globalUserMax: val }
    }).then(function() {
        liveDBData["rq_config_global_user_max"] = val;
        refreshData();
        alert("휴무 개수 제한이 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function saveAnnualUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("annualUserMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 0) {
        alert("0 이상의 숫자를 입력해주세요.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { annualUserMax: val }
    }).then(function() {
        liveDBData["rq_config_annual_user_max"] = val;
        refreshData();
        alert("연차 기본 한도가 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

// ── 조별 휴무 제한 (날짜별) ────────────────────────────────────────────────────
// departments/{deptId}/configs/{yyyymm}/groupDayLimits/{day}/{A|B|C|D|E} = 인원수
// 이 키가 한 번이라도 저장되면(빈 객체라도) 그 달은 날짜별 방식이 source of truth가
// 되며, 과거의 월 전체 공통 groupMaxA~E 값(레거시)은 더 이상 적용되지 않는다.
// (레거시 groupMaxA~E 는 이 달에 groupDayLimits 가 전혀 없을 때만 서버에서 fallback으로 쓰인다.)
function _buildGroupDayLimitsFromLiveData() {
    var src = liveDBData["_groupDayLimits"] || {};
    var out = {};
    Object.keys(src).forEach(function(day) {
        out[day] = Object.assign({}, src[day] || {});
    });
    return out;
}

function openGroupDayDateModal() {
    if (!isAdmin && !isSuperAdmin) return;
    openDateSelectionModal("GROUP_DAY_LIMIT", function(days) {
        var el = document.getElementById("groupDaySelectedSummary");
        if (el) el.innerText = days.length ? ("선택 날짜: " + days.map(function(d) { return d + "일"; }).join(", ")) : "선택 날짜: 없음";
    });
}

function saveGroupMaxConstraints() {
    if (!isAdmin && !isSuperAdmin) return;

    var vals = {};
    var ok = true;
    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var el = document.getElementById("groupMaxConfig" + group);
        var v  = el ? parseInt(el.value, 10) : NaN;
        if (isNaN(v) || v < 1) ok = false;
        vals[group] = v;
    });
    if (!ok) {
        alert("각 조 한도는 1 이상이어야 합니다.");
        return;
    }

    var days = (dateSelectorState.selectedDays.GROUP_DAY_LIMIT || []).slice();
    if (days.length === 0) {
        alert("날짜 선택 버튼으로 적용할 날짜를 먼저 선택해주세요.");
        return;
    }

    var existing = _buildGroupDayLimitsFromLiveData();
    days.forEach(function(day) {
        var dayKey = String(day);
        existing[dayKey] = Object.assign({}, existing[dayKey] || {}, vals);
    });

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        // groupDayLimitsEnabled: true — 이 달을 "날짜별 조별 휴무 제한" 방식으로
        // 명시 전환한다. 이후 날짜별 설정을 모두 삭제해도 이 플래그는 유지되어
        // (설정 전체 초기화 전까지) 절대 legacy groupMaxA~E로 되돌아가지 않는다.
        config: { groupDayLimits: existing, groupDayLimitsEnabled: true }
    }).then(function() {
        liveDBData["_groupDayLimits"] = existing;
        liveDBData["_groupDayLimitsEnabled"] = true;
        refreshData();
        if (typeof drawGroupDayLimitBoard === "function") drawGroupDayLimitBoard();
        alert("조별 휴무 제한이 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function deleteGroupDayLimitFromBoard(event, day) {
    event.preventDefault();
    if (!confirm(day + "일의 조별 휴무 제한을 삭제하시겠습니까?")) return;

    var existing = _buildGroupDayLimitsFromLiveData();
    delete existing[String(day)];

    // ⚠️ 날짜별 설정을 전부 지워 existing이 {} 가 되더라도 groupDayLimitsEnabled는
    // 절대 건드리지 않는다(=true 유지) — 이 달은 이미 날짜별 방식으로 전환되었으므로
    // legacy groupMaxA~E로 되돌아가면 안 된다.
    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { groupDayLimits: existing }
    }).then(function() {
        liveDBData["_groupDayLimits"] = existing;
        drawGroupDayLimitBoard();
    }).catch(function(e) {
        alert((e && e.message) || "삭제 실패");
    });
}

function drawGroupDayLimitBoard() {
    if (typeof _isPageActive === "function" && !_isPageActive("requests")) {
        _dirtyGroupDayLimitBoard = true;
        return;
    }
    _dirtyGroupDayLimitBoard = false;

    var container = document.getElementById("groupDayLimitTooltipBoard");
    if (!container) return;

    var data = liveDBData["_groupDayLimits"] || {};
    var days = Object.keys(data).map(function(d) { return parseInt(d, 10); }).sort(function(a, b) { return a - b; });

    var html = "<strong style='color:#fff;font-size:13px;'>날짜별 제한 현황</strong>"
             + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 해당 날짜 삭제</div>";
    if (days.length === 0) {
        html += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(설정된 날짜별 제한 없음)</div>";
    } else {
        html += "<div style='display:flex;flex-direction:column;gap:4px;'>";
        days.forEach(function(day) {
            var g = data[String(day)] || {};
            var parts = ["A", "B", "C", "D", "E"].filter(function(x) { return g[x] != null; })
                .map(function(x) { return x + " " + g[x]; }).join(" / ");
            html += "<span class='gdl-badge' data-day='" + day + "'"
                  + " style='background:rgba(46,204,113,0.2);border:1px solid #2ecc71;border-radius:5px;"
                  + "padding:4px 8px;font-size:12px;color:#8af5b2;font-weight:bold;cursor:context-menu;white-space:normal;'>"
                  + day + "일 &nbsp; " + (parts || "제한 없음") + "</span>";
        });
        html += "</div>";
    }
    container.innerHTML = html;
    container.oncontextmenu = function(e) {
        var badge = e.target.closest(".gdl-badge");
        if (!badge) return;
        e.preventDefault();
        deleteGroupDayLimitFromBoard(e, badge.getAttribute("data-day"));
    };
}

// ── 특정일 휴무 제한 (복수 날짜 일괄 적용) ─────────────────────────────────────
// 저장 구조는 기존과 동일한 specialDayLimits/{day} = 인원수 를 그대로 사용하고,
// 날짜 선택 모달로 고른 날짜 각각에 대해 기존 setSpecialDayLimit 을 순차 호출한다.
function openSpecialDayDateModal() {
    if (!isAdmin && !isSuperAdmin) return;
    openDateSelectionModal("SPECIAL_DAY_LIMIT", function(days) {
        var el = document.getElementById("specialDaySelectedSummary");
        if (el) el.innerText = days.length ? ("선택 날짜: " + days.map(function(d) { return d + "일"; }).join(", ")) : "선택 날짜: 없음";
    });
}

function applySpecialDayLimits() {
    if (!isAdmin && !isSuperAdmin) return;

    var limitInput = document.getElementById("specialDayLimit");
    var limitVal = limitInput ? parseInt(limitInput.value, 10) : NaN;
    if (isNaN(limitVal) || limitVal < 0) {
        alert("0 이상의 숫자를 입력해주세요.");
        return;
    }

    var days = (dateSelectorState.selectedDays.SPECIAL_DAY_LIMIT || []).slice();
    if (days.length === 0) {
        alert("날짜 선택 버튼으로 적용할 날짜를 먼저 선택해주세요.");
        return;
    }

    var tm = getTargetYearMonth();
    var idx = 0;
    function runNext() {
        if (idx >= days.length) {
            refreshData();
            if (typeof updateLimitTooltipBoard === "function") updateLimitTooltipBoard();
            alert("특정일 휴무 제한이 저장되었습니다.");
            return;
        }
        var day = days[idx];
        fn.setSpecialDayLimit({ deptId: currentDept, yyyymm: tm.fullStr, day: day, limit: limitVal })
          .then(function() {
              liveDBData["rq_special_limit_" + tm.fullStr + "_" + day] = limitVal;
              idx++;
              runNext();
          }).catch(function(e) {
              alert(((e && e.message) || "저장 실패") + " (" + day + "일)");
          });
    }
    runNext();
}

function setSpecialDayLimit(isSet) {
    if (!isAdmin && !isSuperAdmin) return;

    var dayInput   = (document.getElementById("specialDayInput") || {}).value || "";
    var limitInput = (document.getElementById("specialDayLimit") || {}).value || "";
    var tm         = getTargetYearMonth();
    var dayNum     = parseInt(dayInput, 10);

    if (!dayInput || isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
        alert("1~31 사이의 일자를 입력해주세요.");
        return;
    }

    var limitValue = null;
    if (isSet) {
        limitValue = parseInt(limitInput, 10);
        if (isNaN(limitValue) || limitValue < 0) {
            alert("0 이상의 숫자를 입력해주세요.");
            return;
        }
    }

    fn.setSpecialDayLimit({
        deptId: currentDept,
        yyyymm: tm.fullStr,
        day:    dayNum,
        limit:  limitValue
    }).then(function() {
        var key = "rq_special_limit_" + tm.fullStr + "_" + dayNum;
        if (limitValue === null) delete liveDBData[key];
        else liveDBData[key] = limitValue;

        document.getElementById("specialDayInput").value = "";
        document.getElementById("specialDayLimit").value = "";
        refreshData();
        alert(isSet ? "특정일 제한이 저장되었습니다." : "특정일 제한이 삭제되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

function getAnnualQuota(userNameOrUid) {
    var userLimits = liveDBData["_userLimits"] || {};
    var uid = userNameOrUid || currentUid;

    if (userLimits[uid] && userLimits[uid].annualQuota != null) {
        return parseInt(userLimits[uid].annualQuota, 10);
    }
    if (userNameOrUid && employeeByName[userNameOrUid]) {
        uid = employeeByName[userNameOrUid].uid;
        if (userLimits[uid] && userLimits[uid].annualQuota != null) {
            return parseInt(userLimits[uid].annualQuota, 10);
        }
    }
    return null;
}

function triggerAnnualUpload() {
    var fi = document.getElementById("annualExcelUpload");
    if (!fi) return;
    fi.onchange = function() {
        if (fi.files && fi.files.length > 0) uploadAnnualExcel();
    };
    fi.click();
}

function _syncAnnualQuotaLiveData(rows, errors) {
    var failedEmpNos   = {};
    var nextUserLimits = {};

    (errors || []).forEach(function(item) {
        if (item && item.empNo != null) {
            failedEmpNos[String(item.empNo).trim().toLowerCase()] = true;
        }
    });

    Object.keys(liveDBData["_userLimits"] || {}).forEach(function(uid) {
        nextUserLimits[uid] = Object.assign({}, liveDBData["_userLimits"][uid] || {});
    });

    (rows || []).forEach(function(row) {
        var empNoKey = String((row && row.empNo) || "").trim().toLowerCase();
        if (!empNoKey || failedEmpNos[empNoKey]) return;
        var emp = employeeByEmpNo[empNoKey];
        if (!emp || !emp.uid) return;
        var current = Object.assign({}, nextUserLimits[emp.uid] || {});
        current.annualQuota = parseInt(row.quota, 10);
        nextUserLimits[emp.uid] = current;
    });

    if (typeof _applyUserLimitsToLiveData === "function") {
        _applyUserLimitsToLiveData(nextUserLimits);
    } else {
        liveDBData["_userLimits"] = nextUserLimits;
    }
}

function uploadAnnualExcel() {
    if (!isAdmin && !isSuperAdmin) return;

    var fi = document.getElementById("annualExcelUpload");
    if (!fi || !fi.files || !fi.files[0]) {
        alert("엑셀 파일을 선택해주세요.");
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
            var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
            var toUpload = [];
            var errors   = [];

            for (var i = 1; i < rows.length; i++) {
                var empNo = rows[i][0] !== undefined ? String(rows[i][0]).trim() : "";
                var quota = rows[i][1] !== undefined ? parseInt(rows[i][1], 10) : NaN;
                if (!empNo) continue;
                if (isNaN(quota) || quota < 0) {
                    errors.push("row " + (i + 1) + ": 올바르지 않은 연차");
                    continue;
                }
                toUpload.push({ empNo: empNo, quota: quota });
            }

            if (toUpload.length === 0) {
                alert("유효한 행이 없습니다.\n" + errors.join("\n"));
                return;
            }

            fn.uploadAnnualQuotas({
                deptId: currentDept,
                yyyymm: getTargetYearMonth().fullStr,
                rows:   toUpload
            }).then(function(result) {
                var errs = (result.data && result.data.errors) || [];
                _syncAnnualQuotaLiveData(toUpload, errs);
                fi.value = "";
                refreshData();
                drawAnnualStatusBoard();
                alert("연차 업로드 완료.");
            }).catch(function(e) {
                alert((e && e.message) || "업로드 실패");
            });
        } catch (err) {
            alert("엑셀 파싱 오류: " + ((err && err.message) || err));
        }
    };
    reader.readAsArrayBuffer(fi.files[0]);
}

function downloadAnnualTemplate() {
    var ws = XLSX.utils.aoa_to_sheet([
        ["empNo", "annualQuota"],
        ["EMP001", 15],
        ["EMP002", 10]
    ]);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "annual_quota_template");
    XLSX.writeFile(wb, "annual_quota_template.xlsx");
}

var annualStatusSearchTerm = "";

// ── 연차 현황 검색(사번/이름) — UI 필터링만, 기존 데이터/로직은 그대로 ─────────
function filterAnnualStatusBoard(term) {
    annualStatusSearchTerm = String(term || "").trim().toLowerCase();
    drawAnnualStatusBoard();
}

function drawAnnualStatusBoard() {
    // page-employees가 active가 아니면 dirty 플래그만 세우고 건너뜀
    if (typeof _isPageActive === "function" && !_isPageActive("employees")) {
        _dirtyAnnualStatusBoard = true;
        return;
    }
    _dirtyAnnualStatusBoard = false;

    var container = document.getElementById("annualStatusTooltipBoard");
    if (!container) return;

    // 검색 입력칸은 최초 1회만 생성하고, 이후에는 목록 부분만 다시 그린다.
    // (매번 전체를 다시 그리면 입력 중 포커스/커서가 끊기므로 분리)
    var listEl = document.getElementById("annualStatusTooltipBoardList");
    if (!listEl) {
        container.innerHTML =
            "<div class='emp-search-row'><input type='text' id='annualStatusSearchInput' class='form-input' placeholder='사번 또는 이름 검색'></div>" +
            "<div id='annualStatusTooltipBoardList'></div>";
        listEl = document.getElementById("annualStatusTooltipBoardList");
        var searchInput = document.getElementById("annualStatusSearchInput");
        if (searchInput) {
            searchInput.value = annualStatusSearchTerm;
            searchInput.addEventListener("input", function() {
                filterAnnualStatusBoard(this.value);
            });
        }
    }

    var userLimits = liveDBData["_userLimits"] || {};
    var annualMax  = parseInt(getFirebaseItem("rq_config_annual_user_max", "15"), 10);
    var term = annualStatusSearchTerm;
    var html = "<strong style='color:#fff;font-size:13px;'>연차 현황</strong>"
        + "<div style='font-size:11px;color:#bdc3c7;margin:4px 0 8px;'>할당/사용/잔여</div>"
        + "<div class='annual-list-grid'>";

    var uidSet = {};
    deptEmployees.forEach(function(emp) { uidSet[emp.uid] = true; });
    Object.keys(userLimits).forEach(function(uid) { uidSet[uid] = true; });
    Object.keys(adminViewCache || {}).forEach(function(uid) { uidSet[uid] = true; });

    var hasAny = false;
    Object.keys(uidSet).forEach(function(uid) {
        var emp = employeeByUid[uid] || {};
        var empNo = String(emp.empNo || "").trim();
        if (!empNo) return;

        if (term) {
            var matches = empNo.toLowerCase().indexOf(term) !== -1 ||
                          String(emp.name || "").toLowerCase().indexOf(term) !== -1;
            if (!matches) return;
        }

        var ul    = userLimits[uid] || {};
        var quota = ul.annualQuota != null ? parseInt(ul.annualQuota, 10) : annualMax;
        var days  = (adminViewCache && adminViewCache[uid]) || {};
        var used  = 0;

        Object.keys(days).forEach(function(day) {
            if (days[day] && days[day].type === "annual") used++;
        });

        hasAny = true;
        var remain   = quota - used;
        var label    = (emp.name || "삭제된 직원") + " (" + empNo + ")";
        var bgColor  = remain <= 0 ? "rgba(229,57,53,0.25)"  : remain <= 2 ? "rgba(245,127,23,0.25)"  : "rgba(46,125,50,0.25)";
        var bdColor  = remain <= 0 ? "#e53935"               : remain <= 2 ? "#f57f17"               : "#43a047";
        var txColor  = remain <= 0 ? "#ff8a80"               : remain <= 2 ? "#ffcc02"               : "#a5d6a7";

        html += "<span style='background:" + bgColor + ";border:1px solid " + bdColor + ";border-radius:5px;"
            + "padding:4px 8px;font-size:12px;color:" + txColor + ";font-weight:bold;white-space:normal;word-break:break-word;'>"
            + label + " " + quota + "/" + used + "/" + remain + "</span>";
    });

    if (!hasAny) {
        html += "<span style='color:#aaa;font-style:italic;font-size:12px;'>" + (term ? "검색 결과가 없습니다." : "연차 데이터 없음") + "</span>";
    }

    html += "</div>";
    listEl.innerHTML = html;
}

function deleteAnnualQuotaFromBoard(event, empNo) {
    event.preventDefault();
    if (!confirm("[" + empNo + "] 연차 할당을 삭제하시겠습니까?")) return;

    fn.setUserLimit({
        deptId:      currentDept,
        yyyymm:      getTargetYearMonth().fullStr,
        targetEmpNo: empNo,
        limitType:   "annualQuota",
        count:       null
    }).then(function() {
        var emp = employeeByEmpNo[String(empNo || "").trim().toLowerCase()];
        if (emp && liveDBData["_userLimits"] && liveDBData["_userLimits"][emp.uid]) {
            var next = Object.assign({}, liveDBData["_userLimits"]);
            next[emp.uid] = Object.assign({}, next[emp.uid]);
            delete next[emp.uid].annualQuota;
            if (typeof _applyUserLimitsToLiveData === "function") {
                _applyUserLimitsToLiveData(next);
            } else {
                liveDBData["_userLimits"] = next;
            }
        }
        refreshData();
        drawAnnualStatusBoard();
    }).catch(function(e) {
        alert((e && e.message) || "삭제 실패");
    });
}

window.saveYearMonthConfig        = saveYearMonthConfig;
window.saveDayMaxConstraint       = saveDayMaxConstraint;
window.saveGlobalUserMaxConstraint = saveGlobalUserMaxConstraint;
window.saveAnnualUserMaxConstraint = saveAnnualUserMaxConstraint;
window.saveGroupMaxConstraints    = saveGroupMaxConstraints;
window.setSpecialDayLimit         = setSpecialDayLimit;
window.openSpecialDayDateModal    = openSpecialDayDateModal;
window.applySpecialDayLimits      = applySpecialDayLimits;
window.openGroupDayDateModal      = openGroupDayDateModal;
window.drawGroupDayLimitBoard     = drawGroupDayLimitBoard;
window.deleteGroupDayLimitFromBoard = deleteGroupDayLimitFromBoard;
window.triggerAnnualUpload        = triggerAnnualUpload;
window.downloadAnnualTemplate     = downloadAnnualTemplate;
