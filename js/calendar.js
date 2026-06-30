/**
 * calendar.js — 달력 렌더링 + 신청/취소 (Cloud Functions 경유)
 *
 * ⚠️ setFirebaseItem / db.ref().set() 는 이 파일에서 사용하지 않습니다.
 *    모든 쓰기는 fn.xxx() (Cloud Function) 을 통합니다.
 */

function generateCalendarGrid() {
    var gridContainer = document.getElementById("mainCalendarGrid");
    if (!gridContainer) return;
    gridContainer.innerHTML = "";
    var fragment = document.createDocumentFragment();

    var daysHeader = [
        { txt: "일", cls: "days sun" }, { txt: "월", cls: "days" }, { txt: "화", cls: "days" },
        { txt: "수", cls: "days" }, { txt: "목", cls: "days" }, { txt: "금", cls: "days" }, { txt: "토", cls: "days sat" }
    ];
    daysHeader.forEach(function(h) {
        var hDiv = document.createElement("div");
        hDiv.className = h.cls;
        hDiv.innerText = h.txt;
        fragment.appendChild(hDiv);
    });

    var tm = getTargetYearMonth();
    var targetYearNum  = parseInt(tm.year);
    var targetMonthNum = parseInt(tm.month);
    var firstDay       = new Date(targetYearNum, targetMonthNum - 1, 1);
    var startDow       = firstDay.getDay();
    var totalDays      = new Date(targetYearNum, targetMonthNum, 0).getDate();

    for (var e = 0; e < startDow; e++) {
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty";
        fragment.appendChild(emptyDiv);
    }
    for (var d = 1; d <= totalDays; d++) {
        var dateDiv = document.createElement("div");
        var dow = new Date(targetYearNum, targetMonthNum - 1, d).getDay();
        var cls = "date";
        if (dow === 0) cls += " sun";
        if (dow === 6) cls += " sat";
        dateDiv.className = cls;
        dateDiv.id = "d-" + d;
        (function(day) {
            dateDiv.onclick = function() { editDate(day); };
        })(d);
        fragment.appendChild(dateDiv);
    }
    gridContainer.appendChild(fragment);
}

var _pendingDayActions = {};
var _resetInFlight = false;

function _getDayActionKey(day) {
    return getTargetYearMonth().fullStr + ":" + String(day);
}

function _isDayActionPending(day) {
    return !!_pendingDayActions[_getDayActionKey(day)];
}

function _setDayActionPending(day, pending) {
    var key = _getDayActionKey(day);
    if (pending) _pendingDayActions[key] = true;
    else delete _pendingDayActions[key];
}

function _setDayProcessingIndicator(day, pending) {
    var cell = document.getElementById("d-" + day);
    if (!cell) return;

    var indicator = cell.querySelector(".user-note.processing");
    if (pending) {
        if (!indicator) {
            indicator = document.createElement("div");
            indicator.className = "user-note processing";
            indicator.style.background = "#fff3cd";
            indicator.style.color = "#8a6d3b";
            indicator.style.border = "1px solid #ffe08a";
            indicator.style.fontWeight = "bold";
            cell.appendChild(indicator);
        }
        indicator.innerText = "처리중...";
        cell.setAttribute("data-processing", "1");
        return;
    }

    if (indicator) indicator.remove();
    cell.removeAttribute("data-processing");
}

function _runDayRequest(day, requestFn, errorMessage) {
    if (_isDayActionPending(day)) return Promise.resolve(false);

    _setDayActionPending(day, true);
    _setDayProcessingIndicator(day, true);

    return requestFn().then(function() {
        return true;
    }).catch(function(e) {
        alert((e && e.message) || errorMessage);
        throw e;
    }).finally(function() {
        _setDayActionPending(day, false);
        _setDayProcessingIndicator(day, false);
    });
}

function updateLimitTooltipBoard() {
    var limitContainer   = document.getElementById("limitListTooltipBoard");
    var specialContainer = document.getElementById("specialDayTooltipBoard");
    if (!limitContainer || !specialContainer) return;

    var limitedUsers = [];
    var specialDays  = [];
    var tm = getTargetYearMonth();

    Object.keys(liveDBData).forEach(function(key) {
        if (key.startsWith("rq_limit_uid_")) {
            var uid = key.replace("rq_limit_uid_", "");
            var emp = employeeByUid[uid] || {};
            limitedUsers.push({ uid: uid, empNo: emp.empNo || uid, name: emp.name || "삭제된 직원", count: liveDBData[key] });
        } else if (key.startsWith("rq_special_limit_" + tm.fullStr + "_")) {
            specialDays.push({ day: key.replace("rq_special_limit_" + tm.fullStr + "_", ""), count: liveDBData[key] });
        }
    });

    var limitHtml = "<strong style='color:#fff;font-size:13px;'>📊 직원별 개별 한도 현황</strong>"
                  + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
    if (limitedUsers.length === 0) {
        limitHtml += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(개별 제한 없음)</div>";
    } else {
        limitHtml += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
        limitedUsers.sort(function(a, b) { return a.name.localeCompare(b.name); }).forEach(function(item) {
            limitHtml += "<span class='lim-badge' data-empno='" + item.empNo + "'"
                       + " style='background:rgba(52,152,219,0.25);border:1px solid #3498db;border-radius:5px;"
                       + "padding:4px 8px;font-size:12px;color:#74b9ff;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                       + item.name + ": " + item.count + "개</span>";
        });
        limitHtml += "</div>";
    }
    limitContainer.innerHTML = limitHtml;
    limitContainer.oncontextmenu = function(e) {
        var badge = e.target.closest(".lim-badge");
        if (!badge) return;
        e.preventDefault();
        deleteUserLimitFromBoard(e, badge.getAttribute("data-empno"));
    };

    var specialHtml = "<strong style='color:#fff;font-size:13px;'>🎯 당월 특정일 제한 현황</strong>"
                    + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
    if (specialDays.length === 0) {
        specialHtml += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(특정일 제한 없음)</div>";
    } else {
        specialHtml += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
        specialDays.sort(function(a, b) { return parseInt(a.day) - parseInt(b.day); }).forEach(function(item) {
            specialHtml += "<span class='sp-day-badge' data-day='" + item.day + "'"
                         + " style='background:rgba(52,152,219,0.25);border:1px solid #54a0ff;border-radius:5px;"
                         + "padding:4px 8px;font-size:12px;color:#74b9ff;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                         + item.day + "일: " + item.count + "명</span>";
        });
        specialHtml += "</div>";
    }
    specialContainer.innerHTML = specialHtml;
    specialContainer.oncontextmenu = function(e) {
        var badge = e.target.closest(".sp-day-badge");
        if (!badge) return;
        e.preventDefault();
        deleteSpecialDayFromBoard(e, badge.getAttribute("data-day"));
    };
}

// ── Cloud Function 경유 삭제 ──────────────────────────────────────────────────
function deleteSpecialDayFromBoard(event, day) {
    event.preventDefault();
    var tm = getTargetYearMonth();
    if (!confirm(parseInt(tm.month) + "월 " + day + "일 특정일 제한을 삭제하시겠습니까?")) return;

    fn.setSpecialDayLimit({ deptId: currentDept, yyyymm: tm.fullStr, day: day, limit: null })
      .then(function() {
          delete liveDBData["rq_special_limit_" + tm.fullStr + "_" + day];
          updateLimitTooltipBoard();
      }).catch(function(e) { alert(e.message || "삭제 실패"); });
}

function deleteUserLimitFromBoard(event, empNo) {
    event.preventDefault();
    if (!confirm("[" + empNo + "] 직원의 개별 신청 제한을 삭제하시겠습니까?")) return;

    fn.setUserLimit({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, targetEmpNo: empNo, limitType: "globalUserMax", count: null })
      .then(function() {
          delete liveDBData["rq_limit_emp_" + empNo];
          var emp = employeeByEmpNo[String(empNo || "").toLowerCase()];
          if (emp) delete liveDBData["rq_limit_uid_" + emp.uid];
          updateLimitTooltipBoard();
      }).catch(function(e) { alert(e.message || "삭제 실패"); });
}

// ── refreshData ───────────────────────────────────────────────────────────────
function refreshData() {
    if (isSuperAdmin) { showSuperAdminPanel(); return; }

    var tm = getTargetYearMonth();
    generateCalendarGrid();

    if (isAdmin) {
        if (document.getElementById("startDateTimeConfig"))
            document.getElementById("startDateTimeConfig").value = getFirebaseItem("rq_allowed_start_datetime", "");
        if (document.getElementById("endDateTimeConfig"))
            document.getElementById("endDateTimeConfig").value   = getFirebaseItem("rq_allowed_end_datetime", "");
        if (document.getElementById("targetYear")) initYearMonthSelects(tm.year, tm.month);
        if (document.getElementById("dayMaxConfig"))
            document.getElementById("dayMaxConfig").value          = getFirebaseItem("rq_config_day_max", "10");
        if (document.getElementById("globalUserMaxConfig"))
            document.getElementById("globalUserMaxConfig").value   = getFirebaseItem("rq_config_global_user_max", "4");
        if (document.getElementById("annualUserMaxConfig"))
            document.getElementById("annualUserMaxConfig").value   = getFirebaseItem("rq_config_annual_user_max", "15");
        ["A","B","C","D","E"].forEach(function(g) {
            var el = document.getElementById("groupMaxConfig" + g);
            if (el) el.value = getFirebaseItem("rq_config_group_max_" + g, "2");
        });

        var deptLabel = currentDept ? " [" + currentDept + "]" : "";
        document.getElementById("welcomeMessage").innerHTML =
            "👑 " + tm.label + deptLabel + " [관리자 모드]<br>" +
            "<span style='font-size:13px;color:#d9534f;font-weight:bold;'>날짜 클릭 시 특정 직원의 신청 내역 개별 삭제 가능</span>";

        var ids = { toggleModeBtn: "none", userResetBtn: "none", resetAllBtn: "flex", resetConfigBtn: "flex", adminConsole: "flex" };
        Object.keys(ids).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = ids[id];
        });

        loadAdminCalendarData();
        updateDashboardStatCards();
        if (typeof refreshRecentFeed === "function") refreshRecentFeed();
        updateLimitTooltipBoard();
        drawAllowedUsersBoard();
        groupBoardStateLoaded = false;
        drawLiveGroupBoards();
        drawScheduleCodeBoard();
        drawScGroupLimitBoard();
        updateScGroupLimitCodeSelect();
        drawAnnualStatusBoard();
    } else {
        var savedConfig    = getFirebaseItem("rq_allowed_start_datetime", null);
        var savedEndConfig = getFirebaseItem("rq_allowed_end_datetime", null);
        var noticeStr      = "언제나 신청 가능";
        if (savedConfig && savedEndConfig) {
            noticeStr = formatDateTimeString(savedConfig) + " ~ " + formatDateTimeString(savedEndConfig);
        } else if (savedConfig) {
            noticeStr = formatDateTimeString(savedConfig) + " 부터 신청 가능";
        } else if (savedEndConfig) {
            noticeStr = formatDateTimeString(savedEndConfig) + " 까지 신청 가능";
        }

        var myCurrentCount = getMyTotalCount();
        var myAnnualCount  = getMyAnnualCount();
        var customLimitStr = getFirebaseItem("rq_limit_uid_" + currentUid, null);
        var globalUserMax  = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
        var personalQuota  = getAnnualQuota(currentUser);
        var annualMaxLimit = personalQuota !== null ? personalQuota : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
        var maxLimit       = customLimitStr !== null ? parseInt(customLimitStr) : globalUserMax;

        var btnMap = { toggleModeBtn: "flex", userResetBtn: "flex", resetAllBtn: "none", resetConfigBtn: "none", adminConsole: "none" };
        Object.keys(btnMap).forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.style.display = btnMap[id];
        });

        var scBtn  = document.getElementById("scheduleCodeApplyBtn");
        var scList = getScheduleCodeList();
        if (scBtn) {
            scBtn.style.display = scList.length > 0 ? "flex" : "none";
            scBtn.innerText = (currentAppMode === "SCHEDULE_CODE" && currentScheduleCode) ? currentScheduleCode : "근무";
        }
        var toggleModeBtn = document.getElementById("toggleModeBtn");
        if (toggleModeBtn) {
            if (currentAppMode === "NORMAL")   toggleModeBtn.innerText = "휴무";
            if (currentAppMode === "PETITION") toggleModeBtn.innerText = "청원";
            if (currentAppMode === "ANNUAL")   toggleModeBtn.innerText = "연차";
        }
        setModeButtonStyles();

        var scInfoStr = "";
        if (scList.length > 0) {
            scInfoStr = "<br><span class='wm-row'><span class='wm-label'>근무 코드</span> " + scList.map(function(c) {
                return c.name + ": " + getMyScheduleCodeCount(c.name) + "/" + c.limit + "개";
            }).join(" | ") + "</span>";
        }

        document.getElementById("welcomeMessage").innerHTML =
            "<span class='wm-period'>" + tm.label + "</span><br>" +
            "<span style='font-size:13px;color:#007bff;font-weight:bold;'>[" + currentUser + "]님 로그인함 (날짜 클릭 시 즉시 신청/취소)<br>" +
            "<span class='wm-row'><span class='wm-label'>휴무</span> <mark style='background:#e6f2ff;color:#0056b3;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myCurrentCount + " / " + maxLimit + "</mark>" +
            " | 연차 <mark style='background:#e6f4ea;color:#137333;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myAnnualCount + " / " + annualMaxLimit + "</mark>" +
            " (※ 청원 무제한)</span>" + scInfoStr + "<br>" +
            "<span class='wm-row wm-nowrap'><span class='wm-label'>기간</span> " + noticeStr + "</span></span>";

        loadUserCalendarData();
    }
}

// ── 상단 "나의 현황" 요약(휴무/연차/근무코드 카운터)만 다시 계산해서 갱신 ──────────
// firebase-store.js 의 _updateMyUserCells() (userRequests/{uid}/{yyyymm} 실시간
// 리스너) 에서 호출된다. 신청/취소 시 달력 셀은 즉시 갱신되지만, 상단 요약 카운터는
// refreshData() 전체를 다시 돌리지 않으면 갱신되지 않아 "새로고침해야만 반영되는"
// 문제가 있었음 — 이 함수가 그 누락된 갱신 경로를 담당한다. (refreshData() 의
// 요약 계산 로직과 동일하게 유지)
function _updateMyStatusSummary(tm) {
    if (isAdmin || isSuperAdmin) return;
    var welcomeEl = document.getElementById("welcomeMessage");
    if (!welcomeEl) return;
    if (!tm) tm = getTargetYearMonth();

    var savedConfig    = getFirebaseItem("rq_allowed_start_datetime", null);
    var savedEndConfig = getFirebaseItem("rq_allowed_end_datetime", null);
    var noticeStr      = "언제나 신청 가능";
    if (savedConfig && savedEndConfig) {
        noticeStr = formatDateTimeString(savedConfig) + " ~ " + formatDateTimeString(savedEndConfig);
    } else if (savedConfig) {
        noticeStr = formatDateTimeString(savedConfig) + " 부터 신청 가능";
    } else if (savedEndConfig) {
        noticeStr = formatDateTimeString(savedEndConfig) + " 까지 신청 가능";
    }

    var myCurrentCount = getMyTotalCount();
    var myAnnualCount  = getMyAnnualCount();
    var customLimitStr = getFirebaseItem("rq_limit_uid_" + currentUid, null);
    var globalUserMax  = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
    var personalQuota  = getAnnualQuota(currentUser);
    var annualMaxLimit = personalQuota !== null ? personalQuota : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
    var maxLimit       = customLimitStr !== null ? parseInt(customLimitStr) : globalUserMax;

    var scList = getScheduleCodeList();
    var scInfoStr = "";
    if (scList.length > 0) {
        scInfoStr = "<br><span class='wm-row'><span class='wm-label'>근무 코드</span> " + scList.map(function(c) {
            return c.name + ": " + getMyScheduleCodeCount(c.name) + "/" + c.limit + "개";
        }).join(" | ") + "</span>";
    }

    welcomeEl.innerHTML =
        "<span class='wm-period'>" + tm.label + "</span><br>" +
        "<span style='font-size:13px;color:#007bff;font-weight:bold;'>[" + currentUser + "]님 로그인함 (날짜 클릭 시 즉시 신청/취소)<br>" +
        "<span class='wm-row'><span class='wm-label'>휴무</span> <mark style='background:#e6f2ff;color:#0056b3;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myCurrentCount + " / " + maxLimit + "</mark>" +
        " | 연차 <mark style='background:#e6f4ea;color:#137333;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myAnnualCount + " / " + annualMaxLimit + "</mark>" +
        " (※ 청원 무제한)</span>" + scInfoStr + "<br>" +
        "<span class='wm-row wm-nowrap'><span class='wm-label'>기간</span> " + noticeStr + "</span></span>";
}

// ── 내 신청 전체 초기화 (직원용) ──────────────────────────────────────────────
function resetMyRequests() {
    if (isAdmin || isSuperAdmin) return;
    document.getElementById("resetChoiceModal").style.display = "flex";
}

function closeResetChoiceModal() {
    document.getElementById("resetChoiceModal").style.display = "none";
}

function executeResetChoice(mode) {
    if (_resetInFlight) return;
    closeResetChoiceModal();
    var tm      = getTargetYearMonth();
    var yyyymm  = tm.fullStr;
    var daysToCancel = [];
    // liveDBData ??? ????? ??? ???
    var prefix = "rq_" + currentUser + "_" + yyyymm + "_";
    Object.keys(liveDBData).forEach(function(key) {
        if (!key.startsWith(prefix)) return;
        var tail = key.replace(prefix, "");
        // day ??? (tail = "5" or "5_petition" or "5_annual")
        var day = tail.split("_")[0];
        if (!day || isNaN(parseInt(day))) return;
        var type = "";
        if (tail.endsWith("_annual"))   type = "annual";
        else if (tail.endsWith("_petition")) type = "petition";
        else type = "normal";
        if (mode === "ALL"      && type !== "annual") daysToCancel.push({ day: day, type: type });
        if (mode === "HOLIDAY"  && (type === "normal" || type === "petition")) daysToCancel.push({ day: day, type: type });
        if (mode === "SCHEDULE") { /* ??? sc_ ??? */ }
    });
    // ????????
    if (mode === "ALL" || mode === "SCHEDULE") {
        var scPattern = "_" + currentUser + "_" + yyyymm + "_";
        Object.keys(liveDBData).forEach(function(key) {
            if (key.startsWith("sc_") && !key.startsWith("sc_glimit_") && key.includes(scPattern)) {
                var parts = key.split("_");
                var day   = parts[parts.length - 1];
                if (day && !isNaN(parseInt(day))) {
                    daysToCancel.push({ day: day, type: "schedule" });
                }
            }
        });
    }
    if (daysToCancel.length === 0) {
        alert("\uCDE8\uC18C\uD560 \uB0B4\uC5ED\uC774 \uC5C6\uC2B5\uB2C8\uB2E4.");
        return;
    }
    _resetInFlight = true;
    var processed = 0;
    function runNext(index) {
        if (index >= daysToCancel.length) {
            _resetInFlight = false;
            alert("\uC804\uCCB4 \uCD08\uAE30\uD654 \uC644\uB8CC (" + processed + "\uAC74)");
            return;
        }
        var item = daysToCancel[index];
        _runDayRequest(item.day, function() {
            return fn.cancelRequest({ deptId: currentDept, yyyymm: yyyymm, day: item.day });
        }, "\uC77C\uAD04 \uCDE8\uC18C \uC2E4\uD328, \uC624\uB958 \uB85C\uADF8\uB97C \uD655\uC778\uD574\uC8FC\uC138\uC694.").then(function(success) {
            if (success) processed++;
            runNext(index + 1);
        }).catch(function() {
            _resetInFlight = false;
        });
    }
    runNext(0);
}

// ── 날짜 클릭 (신청/취소) ─────────────────────────────────────────────────────
function editDate(date) {
    var tm = getTargetYearMonth();
    if (isSuperAdmin) return;
    if (isAdmin) { manageAdminSelection(date); return; }
    if (_isDayActionPending(date)) return;
    // ??? ????(??????????? ??? ???????????????
    var openAt  = getFirebaseItem("rq_allowed_start_datetime", null);
    var closeAt = getFirebaseItem("rq_allowed_end_datetime", null);
    var now     = Date.now();
    if (openAt && now < new Date(openAt).getTime()) {
        alert("\uC544\uC9C1 \uC2E0\uCCAD \uAE30\uAC04 \uC804\uC785\uB2C8\uB2E4.\\n\uC624\uD508: " + formatDateTimeString(openAt));
        return;
    }
    if (closeAt && now > new Date(closeAt).getTime()) {
        alert("\uC2E0\uCCAD \uAE30\uAC04\uC774 \uB9C8\uAC10\uB418\uC5C8\uC2B5\uB2C8\uB2E4.\\n\uB9C8\uAC10: " + formatDateTimeString(closeAt));
        return;
    }
    var prefix  = "rq_" + currentUser + "_" + tm.fullStr + "_";
    var dayStr  = String(date);
    var existingNormal   = getFirebaseItem(prefix + dayStr, null);
    var existingPetition = getFirebaseItem(prefix + dayStr + "_petition", null);
    var existingAnnual   = getFirebaseItem(prefix + dayStr + "_annual", null);
    if (existingNormal === null && existingPetition === null && existingAnnual === null) {
        var myCache = (adminViewCache && adminViewCache[currentUid]) || {};
        var cachedReq = myCache[dayStr] || myCache[String(parseInt(dayStr, 10))];
        if (cachedReq && cachedReq.type) {
            if (cachedReq.type === "normal") existingNormal = cachedReq.ts || 1;
            if (cachedReq.type === "petition") existingPetition = cachedReq.ts || 1;
            if (cachedReq.type === "annual") existingAnnual = cachedReq.ts || 1;
        }
    }
    var existingScCode = null;
    var scList = getScheduleCodeList();
    scList.forEach(function(c) {
        var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + dayStr;
        if (liveDBData[scKey] !== undefined) existingScCode = c.name;
    });
    var cancelType = existingNormal !== null ? "normal"
                   : existingPetition !== null ? "petition"
                   : existingAnnual !== null ? "annual"
                   : existingScCode !== null ? "schedule"
                   : null;
    if (cancelType) {
        var label = { normal: "\uC77C\uBC18 \uD734\uBB34", petition: "\uCCAD\uC6D0 \uD734\uBB34", annual: "\uC5F0\uCC28", schedule: "\uC2A4\uCF00\uC904 \uCF54\uB4DC [" + existingScCode + "]" }[cancelType];
        if (!confirm(parseInt(tm.month) + "\uC6D4 " + date + "\uC77C " + label + "\uB97C \uCDE8\uC18C\uD558\uC2DC\uACA0\uC2B5\uB2C8\uAE4C?")) return;
        _runDayRequest(dayStr, function() {
            return fn.cancelRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr });
        }, "\uC2E0\uCCAD \uC2E4\uD328").catch(function() {});
        return;
    }
    if (currentAppMode === "SCHEDULE_CODE") {
        if (!currentScheduleCode) { alert("\uC2A4\uCF00\uC904 \uCF54\uB4DC\uAC00 \uC120\uD0DD\uB418\uC9C0 \uC54A\uC558\uC2B5\uB2C8\uB2E4."); return; }
        var codeObj = scList.find(function(c) { return c.name === currentScheduleCode; });
        if (!codeObj) { alert("\uC120\uD0DD\uD55C \uCF54\uB4DC\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4."); return; }
        if (getMyScheduleCodeCount(currentScheduleCode) >= codeObj.limit) {
            alert("[" + currentScheduleCode + "] \uCF54\uB4DC \uAC1C\uC778 \uD55C\uB3C4(" + codeObj.limit + "\uAC74) \uCD08\uACFC");
            return;
        }
        _runDayRequest(dayStr, function() {
            return fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "schedule", scheduleCode: currentScheduleCode });
        }, "\uC2E0\uCCAD \uC2E4\uD328").catch(function() {});
        return;
    }
    if (currentAppMode === "PETITION") {
        _runDayRequest(dayStr, function() {
            return fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "petition" });
        }, "\uCCAD\uC6D0 \uC2E0\uCCAD \uC2E4\uD328").catch(function() {});
        return;
    }
    if (currentAppMode === "ANNUAL") {
        var myAnnualCount = getMyAnnualCount();
        var personalQuota = getAnnualQuota(currentUser);
        var annualMax     = personalQuota !== null ? personalQuota : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
        if (myAnnualCount >= annualMax) {
            alert("\uC5F0\uCC28 \uD55C\uB3C4(" + annualMax + "\uAC74) \uCD08\uACFC");
            return;
        }
        _runDayRequest(dayStr, function() {
            return fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "annual" });
        }, "\uC5F0\uCC28 \uC2E0\uCCAD \uC2E4\uD328").catch(function() {});
        return;
    }
    var specialLimit   = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + dayStr, null);
    var configDayMax   = specialLimit !== null ? parseInt(specialLimit) : parseInt(getFirebaseItem("rq_config_day_max", "10"));
    var dayTotalCount  = getDayTotalCount(date);
    if (dayTotalCount >= configDayMax) {
        alert(parseInt(tm.month) + "\uC6D4 " + date + "\uC77C\uC740 \uB9C8\uAC10\uB418\uC5C8\uC2B5\uB2C8\uB2E4 (" + configDayMax + "\uBA85 \uD55C\uB3C4)");
        return;
    }
    var myTotalCount  = getMyTotalCount();
    var customLimit   = getFirebaseItem("rq_limit_uid_" + currentUid, null);
    var globalUserMax = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
    var myMax         = customLimit !== null ? parseInt(customLimit) : globalUserMax;
    if (myTotalCount >= myMax) {
        alert("\uC774\uBC88 \uB2EC \uC2E0\uCCAD \uD55C\uB3C4(" + myMax + "\uAC74)\uB97C \uBAA8\uB450 \uC0AC\uC6A9\uD588\uC2B5\uB2C8\uB2E4");
        return;
    }
    var groups = ["A","B","C","D","E"];
    for (var gi = 0; gi < groups.length; gi++) {
        var g    = groups[gi];
        var grp  = getLiveGroupList(g);
        if (!groupContainsCurrentUser(grp)) continue;
        var gMax = parseInt(getFirebaseItem("rq_config_group_max_" + g, "2"));
        if (getGroupCountByDate(grp, date) >= gMax) {
            alert(g + "\uC870 \uC77C\uC790 \uD55C\uB3C4(" + gMax + "\uBA85) \uCD08\uACFC");
            return;
        }
    }
    _runDayRequest(dayStr, function() {
        return fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "normal" });
    }, "\uC2E0\uCCAD \uC2E4\uD328").catch(function() {});
}

// ── 관리자: 날짜 클릭 → 신청 삭제 ───────────────────────────────────────────
function manageAdminSelection(date) {
    if (!isAdmin && !isSuperAdmin) return;
    var tm     = getTargetYearMonth();
    var dayStr = String(date);
    if (_isDayActionPending(dayStr)) return;
    var applicants = getAdminApplicantsByDay(dayStr);
    openApplicantDetailModal(date, tm, applicants);
}

// ── 신청 상세 모달: 신청 순서(ts 오름차순, getAdminApplicantsByDay 에서 이미 정렬됨)대로
//    번호를 매겨 표시하고, 각 행의 취소 버튼으로 기존 adminCancelRequest 를 그대로 호출한다.
function openApplicantDetailModal(date, tm, applicants) {
    var modalEl = document.getElementById("applicantDetailModal");
    var titleEl = document.getElementById("applicantModalTitle");
    var bodyEl  = document.getElementById("applicantModalBody");
    if (!modalEl || !titleEl || !bodyEl) return;

    titleEl.innerText = parseInt(tm.month, 10) + "월 " + date + "일 신청 목록 (" + applicants.length + "건)";

    if (applicants.length === 0) {
        bodyEl.innerHTML = "<div class='applicant-empty'>신청 내역이 없습니다.</div>";
    } else {
        bodyEl.innerHTML = "";
        applicants.forEach(function(a, i) {
            var row = document.createElement("div");
            row.className = "applicant-row";

            var num = document.createElement("div");
            num.className = "ap-num";
            num.innerText = (i + 1);
            row.appendChild(num);

            var info = document.createElement("div");
            info.className = "ap-info";
            var nameDiv = document.createElement("div");
            nameDiv.className = "ap-name";
            nameDiv.innerText = a.name;
            var typeDiv = document.createElement("div");
            typeDiv.className = "ap-type";
            typeDiv.innerText = getRequestTypeLabel(a.req);
            info.appendChild(nameDiv);
            info.appendChild(typeDiv);
            row.appendChild(info);

            var cancelBtn = document.createElement("button");
            cancelBtn.className = "ap-cancel-btn";
            cancelBtn.innerText = "취소";
            cancelBtn.onclick = function() {
                _adminCancelFromModal(date, tm, a, cancelBtn);
            };
            row.appendChild(cancelBtn);

            bodyEl.appendChild(row);
        });
    }

    modalEl.style.display = "flex";
}

function closeApplicantDetailModal() {
    var modalEl = document.getElementById("applicantDetailModal");
    if (modalEl) modalEl.style.display = "none";
}

function _adminCancelFromModal(date, tm, target, btnEl) {
    if (!confirm(target.label + "\n\n해당 신청을 취소하시겠습니까?")) return;
    var dayStr = String(date);
    if (btnEl) { btnEl.disabled = true; btnEl.innerText = "처리중..."; }

    _runDayRequest(dayStr, function() {
        return fn.adminCancelRequest({
            deptId:    currentDept,
            yyyymm:    tm.fullStr,
            day:       dayStr,
            targetUid: target.uid
        });
    }, "취소 실패: 알 수 없는 오류").then(function(success) {
        if (success) {
            // 모달 내 목록을 새 데이터로 다시 그려서 즉시 갱신
            var refreshed = getAdminApplicantsByDay(dayStr);
            openApplicantDetailModal(date, tm, refreshed);
        }
    }).catch(function() {
        if (btnEl) { btnEl.disabled = false; btnEl.innerText = "취소"; }
    });
}

// ── 관리자: 신청 기간 저장 (Cloud Function) ───────────────────────────────────
function saveDateTimeConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = document.getElementById("startDateTimeConfig") ? document.getElementById("startDateTimeConfig").value : "";
    if (!val) { alert("오픈 일시를 선택해주세요."); return; }

    var ts = new Date(val).getTime();
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { openAt: ts } })
      .then(function() { liveDBData["rq_allowed_start_datetime"] = val; alert("✨ 적용 완료."); })
      .catch(function(e) { alert(e.message || "저장 실패"); });
}

function saveEndDateTimeConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = document.getElementById("endDateTimeConfig") ? document.getElementById("endDateTimeConfig").value : "";
    if (!val) { alert("마감 일시를 선택해주세요."); return; }

    var ts = new Date(val).getTime();
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { closeAt: ts } })
      .then(function() { liveDBData["rq_allowed_end_datetime"] = val; alert("✨ 적용 완료."); })
      .catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 관리자: 직원별 신청 한도 설정 ────────────────────────────────────────────
function setUserRequestLimit(isSet) {
    if (!isAdmin && !isSuperAdmin) return;
    var empNo    = document.getElementById("limitEmpName").value.trim();
    var yyyymm   = getTargetYearMonth().fullStr;

    if (!empNo) { alert("사번을 입력해주세요."); return; }

    if (isSet) {
        var countInput = document.getElementById("limitEmpCount").value.trim();
        var countVal   = parseInt(countInput);
        if (countInput === "" || isNaN(countVal) || countVal < 0) {
            alert("0 이상의 숫자를 입력해주세요.");
            return;
        }
        fn.setUserLimit({ deptId: currentDept, yyyymm: yyyymm, targetEmpNo: empNo, limitType: "globalUserMax", count: countVal })
          .then(function() { alert("📊 적용 완료."); document.getElementById("limitEmpName").value = ""; document.getElementById("limitEmpCount").value = ""; })
          .catch(function(e) { alert(e.message || "설정 실패"); });
    } else {
        fn.setUserLimit({ deptId: currentDept, yyyymm: yyyymm, targetEmpNo: empNo, limitType: "globalUserMax", count: null })
          .then(function() { alert("✨ 초기화 완료."); document.getElementById("limitEmpName").value = ""; })
          .catch(function(e) { alert(e.message || "초기화 실패"); });
    }
}

// ── 관리자: 기본 설정 저장 ────────────────────────────────────────────────────
function saveDayMaxConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt(document.getElementById("dayMaxConfig").value);
    if (isNaN(val) || val < 1) { alert("1 이상의 숫자를 입력하세요."); return; }

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { dayMax: val } })
      .then(function() { liveDBData["rq_config_day_max"] = val; alert("적용 완료."); })
      .catch(function(e) { alert(e.message || "실패"); });
}

function saveGlobalUserMaxConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt(document.getElementById("globalUserMaxConfig").value);
    if (isNaN(val) || val < 1) { alert("1 이상의 숫자를 입력하세요."); return; }

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { globalUserMax: val } })
      .then(function() { liveDBData["rq_config_global_user_max"] = val; alert("적용 완료."); })
      .catch(function(e) { alert(e.message || "실패"); });
}

function saveAnnualUserMaxConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt(document.getElementById("annualUserMaxConfig").value);
    if (isNaN(val) || val < 1) { alert("1 이상의 숫자를 입력하세요."); return; }

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { annualUserMax: val } })
      .then(function() { liveDBData["rq_config_annual_user_max"] = val; alert("적용 완료."); })
      .catch(function(e) { alert(e.message || "실패"); });
}

function saveGroupMaxConfig(groupLetter) {
    if (!isAdmin && !isSuperAdmin) return;
    var el  = document.getElementById("groupMaxConfig" + groupLetter);
    var val = el ? parseInt(el.value) : NaN;
    if (isNaN(val) || val < 1) { alert("1 이상의 숫자를 입력하세요."); return; }

    var cfg = {};
    cfg["groupMax" + groupLetter] = val;
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: cfg })
      .then(function() { liveDBData["rq_config_group_max_" + groupLetter] = val; alert("적용 완료."); })
      .catch(function(e) { alert(e.message || "실패"); });
}

// ── 관리자: 특정일 한도 ───────────────────────────────────────────────────────
function saveSpecialDayLimit() {
    if (!isAdmin && !isSuperAdmin) return;
    var day   = document.getElementById("specialDayInput").value.trim();
    var limit = document.getElementById("specialDayLimit").value.trim();
    var tm    = getTargetYearMonth();

    if (!day || !limit) { alert("일자와 한도를 입력하세요."); return; }

    fn.setSpecialDayLimit({ deptId: currentDept, yyyymm: tm.fullStr, day: day, limit: parseInt(limit) })
      .then(function() {
          liveDBData["rq_special_limit_" + tm.fullStr + "_" + day] = parseInt(limit);
          alert("적용 완료.");
          document.getElementById("specialDayInput").value  = "";
          document.getElementById("specialDayLimit").value  = "";
          updateLimitTooltipBoard();
      }).catch(function(e) { alert(e.message || "실패"); });
}


// ── 읽기 전용 카운터/집계 함수 ────────────────────────────────────────────────
function getGroupCountByDate(groupArray, date) {
    var tm    = getTargetYearMonth();
    var count = 0;
    groupArray.forEach(function(member) {
        var empName = resolveGroupMemberName(member);
        var key = "rq_" + empName + "_" + tm.fullStr + "_" + date;
        if (liveDBData[key] !== undefined) count++;
    });
    return count;
}

function getMyTotalCount() {
    var tm     = getTargetYearMonth();
    var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
    return Object.keys(liveDBData).filter(function(k) {
        return k.startsWith(prefix) && !k.endsWith("_petition") && !k.endsWith("_annual");
    }).length;
}

function getMyAnnualCount() {
    var tm     = getTargetYearMonth();
    var suffix = "_annual";
    var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
    return Object.keys(liveDBData).filter(function(k) {
        return k.startsWith(prefix) && k.endsWith(suffix);
    }).length;
}

function getDayTotalCountAll(date) {
    return _countersCache[String(date)] || 0;
}

function getDayTotalCount(date) {
    return getDayTotalCountAll(date);
}

function getRequestTypeLabel(req) {
    if (!req) return "";
    if (req.type === "petition") return "청원";
    if (req.type === "annual") return "연차";
    if (req.type === "schedule") return "근무:" + (req.scheduleCode || "");
    return "휴무";
}

function getAdminApplicantsByDay(day) {
    var dayStr = String(day);
    var applicants = [];

    Object.keys(adminViewCache || {}).forEach(function(uid) {
        var days = adminViewCache[uid] || {};
        var req = days[dayStr] || days[String(parseInt(dayStr, 10))];
        if (!req) return;

        var emp = employeeByUid[uid] || {};
        var name = emp.name || req.name || uid;
        applicants.push({
            uid: uid,
            name: name,
            req: req,
            ts: (req && req.ts) ? req.ts : 0,
            label: name + " (" + getRequestTypeLabel(req) + ")"
        });
    });

    // ⚠️ 먼저 신청한 사람이 항상 1번, 2번, 3번 순서로 표시되어야 한다.
    // 기존에는 이름 가나다순(localeCompare)으로 정렬되어 있어서 신청 순서와
    // 무관하게 보였던 문제가 있었음 — 신청 시각(ts) 오름차순으로 정렬하도록 수정.
    // ts 가 없는 과거 데이터는 맨 뒤로 보내되 그 안에서는 이름순 유지(안정성).
    applicants.sort(function(a, b) {
        if (a.ts && b.ts) return a.ts - b.ts;
        if (a.ts && !b.ts) return -1;
        if (!a.ts && b.ts) return 1;
        return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    });
    return applicants;
}

function loadUserCalendarData() {
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
    var scList    = getScheduleCodeList();
    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;
        var fragment = document.createDocumentFragment();
        var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var dayMax = specialLimit !== null ? parseInt(specialLimit) : configDayMax;
        var count  = _countersCache[String(d)] || 0;
        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = d;
        fragment.appendChild(numDiv);
        var badge = document.createElement("div");
        badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
        badge.innerText = count + "/" + dayMax + "\uBA85";
        fragment.appendChild(badge);
        var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
        if (liveDBData[prefix + d]) {
            var n1 = document.createElement("div");
            n1.className = "user-note";
            n1.innerText = "\uD734\uBB34";
            fragment.appendChild(n1);
        }
        if (liveDBData[prefix + d + "_petition"]) {
            var n2 = document.createElement("div");
            n2.className = "user-note petition";
            n2.innerText = "\uCCAD\uC6D0";
            fragment.appendChild(n2);
        }
        if (liveDBData[prefix + d + "_annual"]) {
            var n3 = document.createElement("div");
            n3.className = "user-note annual";
            n3.innerText = "\uC5F0\uCC28";
            fragment.appendChild(n3);
        }
        scList.forEach(function(c) {
            var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + d;
            if (liveDBData[scKey]) {
                var n4 = document.createElement("div");
                n4.className = "user-note schedule";
                n4.innerText = c.name;
                fragment.appendChild(n4);
            }
        });
        cell.appendChild(fragment);
    }
}

// ── 신청 유형별 요약 집계 ──────────────────────────────────────────────────────
// 같은 날짜에 신청자가 많아도 셀에는 "휴무 (3)" 처럼 유형별 개수만 표시하고,
// 클릭 시 상세 모달에서 실제 명단(신청 순서대로)을 보여준다.
function _summarizeApplicantsByType(applicants) {
    var order = [];      // 표시 순서 보존
    var groups = {};     // key -> { label, cls, items: [] }

    applicants.forEach(function(a) {
        var type = (a.req && a.req.type) || "normal";
        var key, label, cls;
        if (type === "petition") { key = "petition"; label = "청원"; cls = "petition-item"; }
        else if (type === "annual") { key = "annual"; label = "연차"; cls = "annual-item"; }
        else if (type === "schedule") {
            var code = (a.req && a.req.scheduleCode) || "코드";
            key = "schedule_" + code; label = code; cls = "schedule-item";
        } else { key = "normal"; label = "휴무"; cls = ""; }

        if (!groups[key]) { groups[key] = { label: label, cls: cls, items: [] }; order.push(key); }
        groups[key].items.push(a);
    });

    return order.map(function(key) { return groups[key]; });
}

function loadAdminCalendarData() {
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;
        var fragment = document.createDocumentFragment();
        var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var dayMax = specialLimit !== null ? parseInt(specialLimit) : configDayMax;
        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = d;
        fragment.appendChild(numDiv);
        var count  = _countersCache[String(d)] || 0;
        var badge  = document.createElement("div");
        badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
        badge.innerText = count + "/" + dayMax + "\uBA85";
        fragment.appendChild(badge);

        var applicants = getAdminApplicantsByDay(d);
        if (applicants.length > 0) {
            // ⚠️ 요약 표시: 신청자 이름을 모두 나열하지 않고 유형별 개수만 표시.
            //    인원이 많아져도 셀이 깨지지 않으며, 클릭하면 상세 명단 모달이 뜬다.
            var groups = _summarizeApplicantsByType(applicants);
            var list = document.createElement("div");
            list.className = "admin-list";
            groups.forEach(function(g) {
                var item = document.createElement("div");
                item.className = "admin-item" + (g.cls ? " " + g.cls : "");
                item.innerText = g.label + " (" + g.items.length + ")";
                list.appendChild(item);
            });
            fragment.appendChild(list);
        }
        cell.appendChild(fragment);
    }
}

// ── 대시보드 통계 카드 실데이터 연결 ──────────────────────────────────────────
// 5개 카드: 전체 직원 / 월 휴무 제한 / 신청 기간 / 현재 지점 / 신청 상태
// 모두 이미 존재하는 설정값·세션 정보로 정확히 계산하며, 의미 없는
// 추측 수치(예: 이전의 "월 한도 약 N건 기준")는 전혀 사용하지 않는다.
function _shortMonthDay(val) {
    if (!val) return null;
    var d = (typeof val === "number") ? new Date(val) : new Date(val);
    if (isNaN(d.getTime())) return null;
    var pad = function(n) { return (n < 10 ? "0" : "") + n; };
    return pad(d.getMonth() + 1) + "-" + pad(d.getDate());
}

function updateDashboardStatCards() {
    // 1) 전체 직원
    var elEmployees = document.getElementById("statEmployees");
    if (elEmployees) elEmployees.innerText = (deptEmployees || []).length;

    // 2) 월 휴무 제한 (직원 1인당 월 최대 휴무 신청 횟수 — 설정 페이지의 값과 동일)
    var elMonthlyLimit = document.getElementById("statMonthlyLimit");
    if (elMonthlyLimit) {
        var globalUserMax = getFirebaseItem("rq_config_global_user_max", "4");
        elMonthlyLimit.innerText = globalUserMax + "회";
    }

    // 3) 신청 기간 (오픈 ~ 마감, 설정되지 않은 쪽은 생략)
    var elPeriod = document.getElementById("statPeriod");
    var openAtRaw  = getFirebaseItem("rq_allowed_start_datetime", null);
    var closeAtRaw = getFirebaseItem("rq_allowed_end_datetime", null);
    var openShort  = _shortMonthDay(openAtRaw);
    var closeShort = _shortMonthDay(closeAtRaw);
    if (elPeriod) {
        if (openShort && closeShort) elPeriod.innerText = openShort + " ~ " + closeShort;
        else if (openShort) elPeriod.innerText = openShort + " ~";
        else if (closeShort) elPeriod.innerText = "~ " + closeShort;
        else elPeriod.innerText = "설정 안 됨";
    }

    // 4) 현재 지점
    var elDept = document.getElementById("statDept");
    if (elDept) elDept.innerText = currentDept || "—";

    // 5) 신청 상태: 신청 가능 / 신청 마감 / 신청 예정 (색상으로만 구분)
    var elStatus = document.getElementById("statApplyStatus");
    if (elStatus) {
        var now = Date.now();
        var openTs  = openAtRaw  ? new Date(openAtRaw).getTime()  : null;
        var closeTs = closeAtRaw ? new Date(closeAtRaw).getTime() : null;
        var statusText, statusClass;

        if (closeTs && now > closeTs) {
            statusText = "신청 마감"; statusClass = "status-closed";
        } else if (openTs && now < openTs) {
            statusText = "신청 예정"; statusClass = "status-upcoming";
        } else {
            statusText = "신청 가능"; statusClass = "status-open";
        }
        elStatus.innerText = statusText;
        elStatus.className = "stat-value stat-value-sm " + statusClass;
    }
}

window.saveDateTimeConfig = saveDateTimeConfig;
window.saveEndDateTimeConfig = saveEndDateTimeConfig;
window.setUserRequestLimit = setUserRequestLimit;
