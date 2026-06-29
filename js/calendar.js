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

    var daysHeader = [
        { txt: "일", cls: "days sun" }, { txt: "월", cls: "days" }, { txt: "화", cls: "days" },
        { txt: "수", cls: "days" }, { txt: "목", cls: "days" }, { txt: "금", cls: "days" }, { txt: "토", cls: "days sat" }
    ];
    daysHeader.forEach(function(h) {
        var hDiv = document.createElement("div");
        hDiv.className = h.cls;
        hDiv.innerText = h.txt;
        gridContainer.appendChild(hDiv);
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
        gridContainer.appendChild(emptyDiv);
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
        gridContainer.appendChild(dateDiv);
    }
}

function toggleSpecialDayBoard(event) {
    var board = document.getElementById("specialDayTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

function toggleLimitListBoard(event) {
    var board = document.getElementById("limitListTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
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
            limitedUsers.push({ uid: uid, empNo: emp.empNo || uid, name: emp.name || uid, count: liveDBData[key] });
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
        updateLimitTooltipBoard();
        drawAllowedUsersBoard();
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
            scInfoStr = "<br>🗓️ 스케줄코드 현황: " + scList.map(function(c) {
                return c.name + ": " + getMyScheduleCodeCount(c.name) + "/" + c.limit + "개";
            }).join(" | ");
        }

        document.getElementById("welcomeMessage").innerHTML =
            "📅 " + tm.label + "<br>" +
            "<span style='font-size:13px;color:#007bff;font-weight:bold;'>[" + currentUser + "]님 로그인함 (날짜 클릭 시 즉시 신청/취소)<br>" +
            "📊 나의 현황: 휴무 <mark style='background:#e6f2ff;color:#0056b3;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myCurrentCount + " / " + maxLimit + "</mark>" +
            " | 연차 <mark style='background:#e6f4ea;color:#137333;font-weight:bold;padding:2px 4px;border-radius:3px;'>" + myAnnualCount + " / " + annualMaxLimit + "</mark>" +
            " (※ 청원 무제한)" + scInfoStr + "<br>" +
            "⏱️ 기간 : " + noticeStr + "</span>";

        loadUserCalendarData();
    }
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
    closeResetChoiceModal();
    var tm      = getTargetYearMonth();
    var yyyymm  = tm.fullStr;
    var daysToCancel = [];

    // liveDBData 에서 내 신청 날짜 수집
    var prefix = "rq_" + currentUser + "_" + yyyymm + "_";
    Object.keys(liveDBData).forEach(function(key) {
        if (!key.startsWith(prefix)) return;
        var tail = key.replace(prefix, "");
        // day 추출 (tail = "5" or "5_petition" or "5_annual")
        var day = tail.split("_")[0];
        if (!day || isNaN(parseInt(day))) return;

        var type = "";
        if (tail.endsWith("_annual"))   type = "annual";
        else if (tail.endsWith("_petition")) type = "petition";
        else type = "normal";

        if (mode === "ALL"      && type !== "annual") daysToCancel.push({ day: day, type: type });
        if (mode === "HOLIDAY"  && (type === "normal" || type === "petition")) daysToCancel.push({ day: day, type: type });
        if (mode === "SCHEDULE") { /* 아래 sc_ 처리 */ }
    });

    // 스케줄 코드
    if (mode === "ALL" || mode === "SCHEDULE") {
        var scPattern = "_" + currentUser + "_" + yyyymm + "_";
        Object.keys(liveDBData).forEach(function(key) {
            if (key.startsWith("sc_") && !key.startsWith("sc_glimit_") && key.includes(scPattern)) {
                var parts = key.split("_");
                var day   = parts[parts.length - 1];
                if (day && !isNaN(parseInt(day)))
                    daysToCancel.push({ day: day, type: "schedule" });
            }
        });
    }

    if (daysToCancel.length === 0) {
        alert("ℹ️ 삭제할 내역이 없습니다.");
        return;
    }

    var promises = daysToCancel.map(function(item) {
        return fn.cancelRequest({ deptId: currentDept, yyyymm: yyyymm, day: item.day });
    });

    Promise.all(promises).then(function() {
        alert("✨ 초기화 완료 (" + daysToCancel.length + "건)");
        refreshData();
    }).catch(function(e) {
        alert(e.message || "일부 취소 실패, 새로고침 후 확인해주세요.");
        refreshData();
    });
}

// ── 날짜 클릭 (신청/취소) ─────────────────────────────────────────────────────
function editDate(date) {
    var tm = getTargetYearMonth();
    if (isSuperAdmin) return;
    if (isAdmin) { manageAdminSelection(date); return; }

    // 기간 검증 (클라이언트 사전 체크 — 서버에서도 재검증)
    var openAt  = getFirebaseItem("rq_allowed_start_datetime", null);
    var closeAt = getFirebaseItem("rq_allowed_end_datetime", null);
    var now     = Date.now();

    if (openAt && now < new Date(openAt).getTime()) {
        alert("❌ 신청 기간 전입니다.\n오픈: " + formatDateTimeString(openAt));
        return;
    }
    if (closeAt && now > new Date(closeAt).getTime()) {
        alert("❌ 신청 기간이 마감되었습니다.\n마감: " + formatDateTimeString(closeAt));
        return;
    }

    var prefix  = "rq_" + currentUser + "_" + tm.fullStr + "_";
    var dayStr  = String(date);

    var existingNormal   = getFirebaseItem(prefix + dayStr, null);
    var existingPetition = getFirebaseItem(prefix + dayStr + "_petition", null);
    var existingAnnual   = getFirebaseItem(prefix + dayStr + "_annual", null);

    var existingScCode = null;
    var scList = getScheduleCodeList();
    scList.forEach(function(c) {
        var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + dayStr;
        if (liveDBData[scKey] !== undefined) existingScCode = c.name;
    });

    // ── 취소 ────
    var cancelType = existingNormal !== null ? "normal"
                   : existingPetition !== null ? "petition"
                   : existingAnnual !== null ? "annual"
                   : existingScCode !== null ? "schedule"
                   : null;

    if (cancelType) {
        var label = { normal: "일반 휴무", petition: "청원 휴가", annual: "연차", schedule: "스케줄 코드 [" + existingScCode + "]" }[cancelType];
        if (!confirm(parseInt(tm.month) + "월 " + date + "일 " + label + "을(를) 취소하시겠습니까?")) return;

        console.log("cancelRequest day payload:", { rawDay: dayStr, normalizedDay: String(parseInt(dayStr, 10)) });
        fn.cancelRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr })
          .then(function() { refreshData(); })
          .catch(function(e) { alert(e.message || "취소 실패"); });
        return;
    }

    // ── 신청 ────
    if (currentAppMode === "SCHEDULE_CODE") {
        if (!currentScheduleCode) { alert("스케줄 코드가 선택되지 않았습니다."); return; }
        var codeObj = scList.find(function(c) { return c.name === currentScheduleCode; });
        if (!codeObj) { alert("선택된 코드를 찾을 수 없습니다."); return; }
        if (getMyScheduleCodeCount(currentScheduleCode) >= codeObj.limit) {
            alert("❌ [" + currentScheduleCode + "] 코드 개인 제한(" + codeObj.limit + "개) 초과");
            return;
        }
        fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "schedule", scheduleCode: currentScheduleCode })
          .then(function() { refreshData(); })
          .catch(function(e) { alert(e.message || "신청 실패"); });
        return;
    }

    if (currentAppMode === "PETITION") {
        fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "petition" })
          .then(function() { refreshData(); })
          .catch(function(e) { alert(e.message || "청원 신청 실패"); });
        return;
    }

    if (currentAppMode === "ANNUAL") {
        var myAnnualCount = getMyAnnualCount();
        var personalQuota = getAnnualQuota(currentUser);
        var annualMax     = personalQuota !== null ? personalQuota : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
        if (myAnnualCount >= annualMax) {
            alert("❌ 연차 한도(" + annualMax + "개) 초과");
            return;
        }
        fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "annual" })
          .then(function() { refreshData(); })
          .catch(function(e) { alert(e.message || "연차 신청 실패"); });
        return;
    }

    // 일반 휴무 — 클라이언트 사전 검증 (서버에서 원자적 최종 검증)
    var specialLimit   = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + dayStr, null);
    var configDayMax   = specialLimit !== null ? parseInt(specialLimit) : parseInt(getFirebaseItem("rq_config_day_max", "10"));
    var dayTotalCount  = getDayTotalCount(date);

    if (dayTotalCount >= configDayMax) {
        alert("❌ " + parseInt(tm.month) + "월 " + date + "일은 마감되었습니다. (" + configDayMax + "명 한도)");
        return;
    }

    var myTotalCount  = getMyTotalCount();
    var customLimit   = getFirebaseItem("rq_limit_uid_" + currentUid, null);
    var globalUserMax = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
    var myMax         = customLimit !== null ? parseInt(customLimit) : globalUserMax;

    if (myTotalCount >= myMax) {
        alert("❌ 이번 달 신청 한도(" + myMax + "개)를 모두 소진하셨습니다.");
        return;
    }

    // 조 제한 검증
    var groups = ["A","B","C","D","E"];
    for (var gi = 0; gi < groups.length; gi++) {
        var g    = groups[gi];
        var grp  = getLiveGroupList(g);
        if (!groupContainsCurrentUser(grp)) continue;
        var gMax = parseInt(getFirebaseItem("rq_config_group_max_" + g, "2"));
        if (getGroupCountByDate(grp, date) >= gMax) {
            alert("❌ " + g + "조 일자 제한(" + gMax + "명) 초과");
            return;
        }
    }

    fn.submitRequest({ deptId: currentDept, yyyymm: tm.fullStr, day: dayStr, type: "normal" })
      .then(function() { refreshData(); })
      .catch(function(e) { alert(e.message || "신청 실패"); });
}

// ── 관리자: 날짜 클릭 → 신청 삭제 ───────────────────────────────────────────
function manageAdminSelection(date) {
    if (!isAdmin && !isSuperAdmin) return;
    var tm = getTargetYearMonth();
    var applicants = [];

    Object.keys(liveDBData).forEach(function(key) {
        var suffix = "_" + tm.fullStr + "_" + date;
        if (!key.includes(suffix)) return;

        if (key.startsWith("rq_") && !key.startsWith("rq_config_") && !key.startsWith("rq_special_") && !key.startsWith("rq_limit_") && !key.startsWith("rq_allowed_") && !key.startsWith("rq_current_") && !key.startsWith("rq_live_")) {
            var empName = key.replace("rq_", "").replace(suffix, "");
            if (!empName) return;
            var type = key.endsWith("_annual") ? "연차" : key.endsWith("_petition") ? "청원" : "휴무";
            applicants.push({ key: key, name: empName + " (" + type + ")", empName: empName, day: String(date) });
        }
        if (key.startsWith("sc_") && !key.startsWith("sc_glimit_")) {
            var parts = key.split("_");
            var empName = parts.slice(2, parts.length - 2).join("_");
            applicants.push({ key: key, name: empName + " (" + parts[1] + ")", empName: empName, day: String(date) });
        }
    });

    if (applicants.length === 0) { alert(parseInt(tm.month) + "월 " + date + "일 신청 내역이 없습니다."); return; }

    var menuHtml = "<div style='font-size:14px;font-weight:bold;margin-bottom:8px;'>" + parseInt(tm.month) + "월 " + date + "일 신청 목록</div>";
    applicants.forEach(function(a, i) {
        menuHtml += "<div style='padding:6px 0;border-bottom:1px solid #eee;'>" + (i + 1) + ". " + a.name + "</div>";
    });
    menuHtml += "<div style='margin-top:10px;font-size:12px;color:#888;'>콘솔에서 삭제할 사번을 입력하거나 직원에게 직접 취소 요청하세요.</div>";
    alert(menuHtml);
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

// ── 연/월 설정 저장 ───────────────────────────────────────────────────────────
function saveYearMonthConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var y = document.getElementById("targetYear").value;
    var m = document.getElementById("targetMonth").value;
    if (!y || !m) return;

    fn.saveDeptConfig({ deptId: currentDept, yyyymm: y + (m.length === 1 ? "0" : "") + m, config: { targetYearMonth: y + m } })
      .then(function() { alert("년/월 설정 저장 완료. 새로고침하세요."); })
      .catch(function(e) { alert(e.message || "실패"); });
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

function loadUserCalendarData() {
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
    var scList    = getScheduleCodeList();

    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;

        var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var dayMax = specialLimit !== null ? parseInt(specialLimit) : configDayMax;
        var count  = _countersCache[String(d)] || 0;

        // 날짜 숫자
        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = d;
        cell.appendChild(numDiv);

        // 카운터 배지
        var badge = document.createElement("div");
        badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
        badge.innerText = count + "/" + dayMax + "명";
        cell.appendChild(badge);

        // 내 신청 배지
        var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
        if (liveDBData[prefix + d]) {
            var n = document.createElement("div"); n.className = "user-note"; n.innerText = "휴무"; cell.appendChild(n);
        }
        if (liveDBData[prefix + d + "_petition"]) {
            var n = document.createElement("div"); n.className = "user-note petition"; n.innerText = "청원"; cell.appendChild(n);
        }
        if (liveDBData[prefix + d + "_annual"]) {
            var n = document.createElement("div"); n.className = "user-note annual"; n.innerText = "연차"; cell.appendChild(n);
        }
        scList.forEach(function(c) {
            var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + d;
            if (liveDBData[scKey]) {
                var n = document.createElement("div"); n.className = "user-note schedule"; n.innerText = c.name; cell.appendChild(n);
            }
        });
    }
}

function loadAdminCalendarData() {
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
    var scList    = getScheduleCodeList();

    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;

        var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var dayMax = specialLimit !== null ? parseInt(specialLimit) : configDayMax;

        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = d;
        cell.appendChild(numDiv);

        var applicants = [];
        Object.keys(liveDBData).forEach(function(key) {
            var suffix = "_" + tm.fullStr + "_" + d;
            if (!key.includes(suffix)) return;
            if (key.startsWith("rq_") && !key.startsWith("rq_config_") && !key.startsWith("rq_special_") && !key.startsWith("rq_limit_") && !key.startsWith("rq_allowed_") && !key.startsWith("rq_current_") && !key.startsWith("rq_live_")) {
                var empName = key.replace("rq_", "").replace(suffix, "");
                if (!empName) return;
                var type = key.endsWith("_annual") ? "연차" : key.endsWith("_petition") ? "청원" : "휴무";
                applicants.push({ name: empName, type: type });
            }
            if (key.startsWith("sc_") && !key.startsWith("sc_glimit_")) {
                var parts   = key.split("_");
                var empName = parts.slice(2, parts.length - 2).join("_");
                applicants.push({ name: empName, type: parts[1] });
            }
        });

        var count  = _countersCache[String(d)] || 0;
        var badge  = document.createElement("div");
        badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
        badge.innerText = count + "/" + dayMax + "명";
        cell.appendChild(badge);

        applicants.forEach(function(a) {
            var n = document.createElement("div");
            n.className = "user-note";
            n.innerText = a.name + "(" + a.type + ")";
            cell.appendChild(n);
        });
    }
}
