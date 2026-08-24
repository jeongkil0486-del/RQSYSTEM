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
        _updateDayMaxCardSummary();
        alert("월 휴무 제한이 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
}

// ── 월 휴무 제한 팝업 (카드의 [설정 관리] 버튼) ─────────────────────────────────
// 팝업을 열고 닫는 것 자체는 아무것도 저장하지 않는다 — 실제 저장은 기존
// saveDayMaxConstraint()(사용자가 직접 적용을 눌렀을 때)에서만 일어난다.
function _updateDayMaxCardSummary() {
    var el = document.getElementById("dayMaxCardSummary");
    if (!el) return;
    var v = getFirebaseItem("rq_config_day_max", null);
    el.innerText = v !== null ? ("현재 " + v + "명") : "현재 -명";
}

function openMonthlyLimitModal() {
    if (!isAdmin && !isSuperAdmin) return;
    var el = document.getElementById("dayMaxConfig");
    if (el) el.value = getFirebaseItem("rq_config_day_max", "10");
    var modalEl = document.getElementById("monthlyLimitModal");
    if (modalEl) modalEl.style.display = "flex";
}

function closeMonthlyLimitModal() {
    var modalEl = document.getElementById("monthlyLimitModal");
    if (modalEl) modalEl.style.display = "none";
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

// ── 조별 휴무 제한 / 특정일 휴무 제한 UI ──────────────────────────────────────
// ⚠️ 날짜 선택 + 현재값 표시 + 적용 + 일괄 삭제는 이제 공통 관리 팝업
// (js/date-select.js 의 openDateManageModal)에서 전부 처리한다. 이 파일에는
// 팝업이 사용하는 데이터 헬퍼(_buildGroupDayLimitsFromLiveData)와, 과거
// 호환 목적으로 남겨둔 setSpecialDayLimit(단일 날짜 API, 더 이상 UI에서
// 호출되지 않음)만 남긴다.

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
        var label    = _escapeHtml(emp.name || "삭제된 직원") + " (" + _escapeHtml(empNo) + ")";
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
window.openMonthlyLimitModal      = openMonthlyLimitModal;
window.closeMonthlyLimitModal     = closeMonthlyLimitModal;
window.saveGlobalUserMaxConstraint = saveGlobalUserMaxConstraint;
window.saveAnnualUserMaxConstraint = saveAnnualUserMaxConstraint;
window.setSpecialDayLimit         = setSpecialDayLimit;
window.triggerAnnualUpload        = triggerAnnualUpload;
window.downloadAnnualTemplate     = downloadAnnualTemplate;
