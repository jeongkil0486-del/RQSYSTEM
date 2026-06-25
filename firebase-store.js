var _countersCache = {};
var _refreshTimer = null;
var _readOnlyAlertShown = false;

function getDefaultTargetYearMonthValue() {
    var now = new Date();
    var nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    return nextMonth.getFullYear() + "-" + String(nextMonth.getMonth() + 1).padStart(2, "0");
}

function toMonthKey(targetYearMonth) {
    return String(targetYearMonth || getDefaultTargetYearMonthValue()).replace("-", "");
}

function normalizeCounterValue(value) {
    var parsed = parseInt(value, 10);
    return isNaN(parsed) || parsed < 0 ? 0 : parsed;
}

function cloneJson(value) {
    if (value === undefined) return undefined;
    return JSON.parse(JSON.stringify(value));
}

function resetDeptCache() {
    liveDBData = {};
    allowedUsers = [];
    _countersCache = {};
}

function setLegacyConfigValue(key, value) {
    if (value === undefined) return;
    liveDBData[key] = value;
}

function setLegacyRequestValue(name, monthKey, day, request) {
    if (!name || !day || !request) return;

    if (request.request) {
        liveDBData["rq_" + name + "_" + monthKey + "_" + day] = request.requestAt || request.updatedAt || true;
    }
    if (request.petition) {
        liveDBData["rq_" + name + "_" + monthKey + "_" + day + "_petition"] = request.petitionAt || request.updatedAt || true;
    }
    if (request.annual) {
        liveDBData["rq_" + name + "_" + monthKey + "_" + day + "_annual"] = request.annualAt || request.updatedAt || true;
    }

    var scheduleCodes = request.scheduleCodes || {};
    Object.keys(scheduleCodes).forEach(function(codeName) {
        if (!scheduleCodes[codeName]) return;
        liveDBData["sc_" + codeName + "_" + name + "_" + monthKey + "_" + day] =
            request.scheduleCodeTimes && request.scheduleCodeTimes[codeName]
                ? request.scheduleCodeTimes[codeName]
                : request.updatedAt || true;
    });
}

function applyMonthConfigToLegacyCache(targetYearMonth, config) {
    var monthKey = toMonthKey(targetYearMonth);
    var groupMax = config.groupMax || {};
    var annualQuotas = config.annualQuotas || {};
    var specialLimits = config.specialLimits || {};
    var scheduleCodeGroupLimits = config.scheduleCodeGroupLimits || {};
    var liveGroups = config.liveGroups || {};

    setLegacyConfigValue("rq_current_target_year_month", targetYearMonth);
    setLegacyConfigValue("rq_allowed_start_datetime", config.allowedStartDatetime || "");
    setLegacyConfigValue("rq_allowed_end_datetime", config.allowedEndDatetime || "");
    setLegacyConfigValue("rq_config_day_max", config.dayMax != null ? config.dayMax : 10);
    setLegacyConfigValue("rq_config_global_user_max", config.globalUserMax != null ? config.globalUserMax : 4);
    setLegacyConfigValue("rq_config_annual_user_max", config.annualUserMax != null ? config.annualUserMax : 15);
    setLegacyConfigValue("rq_config_group_max_A", groupMax.A != null ? groupMax.A : 2);
    setLegacyConfigValue("rq_config_group_max_B", groupMax.B != null ? groupMax.B : 2);
    setLegacyConfigValue("rq_config_group_max_C", groupMax.C != null ? groupMax.C : 2);
    setLegacyConfigValue("rq_config_group_max_D", groupMax.D != null ? groupMax.D : 2);
    setLegacyConfigValue("rq_config_group_max_E", groupMax.E != null ? groupMax.E : 2);

    allowedUsers = Array.isArray(config.allowedUsers) ? config.allowedUsers.slice() : [];
    setLegacyConfigValue("allowed_users_list", JSON.stringify(allowedUsers));
    setLegacyConfigValue("schedule_codes_list", JSON.stringify(Array.isArray(config.scheduleCodes) ? config.scheduleCodes : []));

    ["A", "B", "C", "D", "E"].forEach(function(groupLetter) {
        setLegacyConfigValue("rq_live_group_" + groupLetter, JSON.stringify(Array.isArray(liveGroups[groupLetter]) ? liveGroups[groupLetter] : []));
    });

    Object.keys(annualQuotas).forEach(function(name) {
        setLegacyConfigValue("annual_quota_" + name, annualQuotas[name]);
    });

    Object.keys(specialLimits).forEach(function(day) {
        setLegacyConfigValue("rq_special_limit_" + monthKey + "_" + day, specialLimits[day]);
    });

    Object.keys(scheduleCodeGroupLimits).forEach(function(codeName) {
        var groups = scheduleCodeGroupLimits[codeName] || {};
        Object.keys(groups).forEach(function(groupLetter) {
            setLegacyConfigValue("sc_glimit_" + codeName + "_" + groupLetter, groups[groupLetter]);
        });
    });
}

function applyCountersToCache(counterData) {
    _countersCache = {};
    Object.keys(counterData || {}).forEach(function(day) {
        _countersCache[String(day)] = normalizeCounterValue(counterData[day]);
    });
}

function applyStaffRequestsToLegacyCache(monthKey, requestData) {
    Object.keys(requestData || {}).forEach(function(day) {
        var request = requestData[day];
        var name = request && (request.legacyName || request.name || currentUser);
        setLegacyRequestValue(name, monthKey, day, request);
    });
}

function applyAdminViewToLegacyCache(monthKey, adminData) {
    Object.keys(adminData || {}).forEach(function(uid) {
        var userDays = adminData[uid] || {};
        Object.keys(userDays).forEach(function(day) {
            var request = userDays[day];
            var name = request && (request.legacyName || request.name);
            setLegacyRequestValue(name, monthKey, day, request);
        });
    });
}

function resolveLoadStateMessage(kind, error) {
    if (kind === "migration_pending") return "데이터 이전 준비 중입니다.";
    if (error && error.code === "PERMISSION_DENIED") return "권한 설정 중입니다.";
    return "권한 설정 중입니다.";
}

function readSnapshot(path) {
    return db.ref(path).once("value").then(function(snap) {
        return snap.val();
    });
}

function hasAnyData(value) {
    if (value === null || value === undefined) return false;
    if (typeof value !== "object") return true;
    return Object.keys(value).length > 0;
}

function loadRoleBasedData() {
    if (!currentDept || !currentUid || isSuperAdmin) {
        return Promise.resolve();
    }

    var deptPath = "departments/" + currentDept;
    var currentTargetPath = deptPath + "/configs/currentTargetYearMonth";

    return readSnapshot(currentTargetPath).then(function(savedTargetYearMonth) {
        var targetYearMonth = savedTargetYearMonth || getDefaultTargetYearMonthValue();
        var monthKey = toMonthKey(targetYearMonth);
        var configPath = deptPath + "/configs/months/" + monthKey;
        var counterPath = deptPath + "/publicCounters/" + monthKey;
        var rolePath = isAdmin
            ? deptPath + "/adminView/" + monthKey
            : "userRequests/" + currentUid + "/" + monthKey;

        return Promise.all([
            Promise.resolve(targetYearMonth),
            readSnapshot(configPath),
            readSnapshot(counterPath),
            readSnapshot(rolePath)
        ]);
    }).then(function(results) {
        var targetYearMonth = results[0];
        var monthConfig = results[1];
        var counterData = results[2];
        var roleData = results[3];
        var monthKey = toMonthKey(targetYearMonth);

        resetDeptCache();

        if (!hasAnyData(monthConfig) && !hasAnyData(counterData) && !hasAnyData(roleData)) {
            var migrationPendingError = new Error("migration_pending");
            migrationPendingError.code = "migration_pending";
            throw migrationPendingError;
        }

        applyMonthConfigToLegacyCache(targetYearMonth, monthConfig || {});
        applyCountersToCache(counterData || {});

        if (isAdmin) {
            applyAdminViewToLegacyCache(monthKey, roleData || {});
        } else {
            applyStaffRequestsToLegacyCache(monthKey, roleData || {});
        }

        currentDeptAccessRestricted = false;
        currentDeptAccessErrorMessage = "";
    }).catch(function(error) {
        currentDeptAccessRestricted = true;
        currentDeptAccessErrorMessage = resolveLoadStateMessage(error && error.code, error);
        throw error;
    });
}

function connectDeptDB(dept, onFirstLoad, onAccessDenied) {
    currentDept = dept;
    return loadRoleBasedData().then(function() {
        if (typeof onFirstLoad === "function") onFirstLoad();
    }).catch(function(error) {
        if (typeof onAccessDenied === "function") onAccessDenied(error);
        throw error;
    });
}

function _throttledRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() {
        _refreshTimer = null;
        refreshData();
    }, 300);
}

function _updateAllBadges() {
    var tm = getTargetYearMonth();
    var totalDaysInMonth = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"), 10);

    for (var day = 1; day <= totalDaysInMonth; day++) {
        var cell = document.getElementById("d-" + day);
        if (!cell) continue;

        var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + day, null);
        var dayMax = specialLimit !== null ? parseInt(specialLimit, 10) : configDayMax;
        var count = _countersCache[String(day)] || 0;
        var badge = cell.querySelector(".count-badge");

        if (badge) {
            badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
            badge.innerText = count + "/" + dayMax + "명";
        }
    }
}

function _updateMyUserCells() {
    var tm = getTargetYearMonth();
    var totalDaysInMonth = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var scList = getScheduleCodeList();

    for (var day = 1; day <= totalDaysInMonth; day++) {
        var cell = document.getElementById("d-" + day);
        if (!cell) continue;

        var oldNotes = cell.querySelectorAll(".user-note");
        oldNotes.forEach(function(note) {
            note.remove();
        });

        if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + day]) {
            var normal = document.createElement("div");
            normal.className = "user-note";
            normal.innerText = "휴무";
            cell.appendChild(normal);
        }
        if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + day + "_petition"]) {
            var petition = document.createElement("div");
            petition.className = "user-note petition";
            petition.innerText = "청원";
            cell.appendChild(petition);
        }
        if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + day + "_annual"]) {
            var annual = document.createElement("div");
            annual.className = "user-note annual";
            annual.innerText = "연차";
            cell.appendChild(annual);
        }

        scList.forEach(function(code) {
            var scKey = "sc_" + code.name + "_" + currentUser + "_" + tm.fullStr + "_" + day;
            if (liveDBData[scKey] === undefined) return;

            var color = getScheduleCodeColor(code.name);
            var note = document.createElement("div");
            note.className = "user-note";
            note.style.backgroundColor = color.bg;
            note.style.border = "1px solid " + color.border;
            note.style.color = color.color;
            note.innerText = code.name;
            cell.appendChild(note);
        });
    }
}

document.addEventListener("click", function(event) {
    [
        ["allowedUsersTooltipBoard", "idPopupTriggerBtn"],
        ["groupListTooltipBoard", "groupPopupTriggerBtn"],
        ["scheduleCodeTooltipBoard", "scheduleCodeListTrigger"],
        ["scGroupLimitTooltipBoard", "scGroupLimitListTrigger"],
        ["annualStatusTooltipBoard", "annualStatusTrigger"],
        ["specialDayTooltipBoard", "specialDayTriggerBtn"],
        ["limitListTooltipBoard", "limitListTriggerBtn"]
    ].forEach(function(pair) {
        var board = document.getElementById(pair[0]);
        var trigger = document.getElementById(pair[1]);
        if (!board || !board.classList.contains("active")) return;
        if (!board.contains(event.target) && event.target !== trigger) {
            board.classList.remove("active");
        }
    });
});

function initYearMonthSelects(selectedYear, selectedMonth) {
    var yearSel = document.getElementById("targetYear");
    var monthSel = document.getElementById("targetMonth");
    if (!yearSel || !monthSel) return;

    var currentYear = new Date().getFullYear();
    yearSel.innerHTML = "";
    for (var year = currentYear - 1; year <= currentYear + 2; year++) {
        var yearOption = document.createElement("option");
        yearOption.value = year;
        yearOption.text = year + "년";
        if (String(year) === String(selectedYear)) yearOption.selected = true;
        yearSel.appendChild(yearOption);
    }

    monthSel.innerHTML = "";
    for (var month = 1; month <= 12; month++) {
        var monthValue = String(month).padStart(2, "0");
        var monthOption = document.createElement("option");
        monthOption.value = monthValue;
        monthOption.text = month + "월";
        if (monthValue === String(selectedMonth)) monthOption.selected = true;
        monthSel.appendChild(monthOption);
    }
}

function getFirebaseItem(key, defaultValue) {
    return liveDBData[key] !== undefined ? liveDBData[key] : defaultValue;
}

function setFirebaseItem() {
    if (_readOnlyAlertShown) return;
    _readOnlyAlertShown = true;
    alert("읽기 전용 단계입니다. 신청 저장과 설정 변경은 다음 단계 Cloud Functions로 옮길 예정입니다.");
}
