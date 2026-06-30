/**
 * firebase-store.js
 * RTDB read/subscription helpers for department-scoped state.
 */

var _countersCache = {};
var _deptConnectToken = 0;

function _rebuildEmployeeMaps(rows) {
    deptEmployees = (Array.isArray(rows) ? rows : []).filter(function(emp) {
        return !!(emp && emp.uid && String(emp.empNo || "").trim());
    });
    employeeByUid = {};
    employeeByEmpNo = {};
    employeeByName = {};
    allowedUsers = [];

    deptEmployees.forEach(function(emp) {
        if (!emp || !emp.uid) return;
        var clean = {
            uid: emp.uid,
            empNo: emp.empNo || "",
            name: emp.name || emp.empNo || emp.uid,
            role: emp.role || "staff"
        };
        employeeByUid[clean.uid] = clean;
        if (clean.empNo) employeeByEmpNo[String(clean.empNo).toLowerCase()] = clean;
        if (clean.name) employeeByName[clean.name] = clean;
        allowedUsers.push(clean.name);
    });
}

function loadDeptEmployees(dept) {
    if (!isAdmin && !isSuperAdmin) {
        _rebuildEmployeeMaps([]);
        return Promise.resolve([]);
    }
    return fn.listDeptEmployees({ deptId: dept }).then(function(result) {
        var rows = (result.data && result.data.employees) || [];
        _rebuildEmployeeMaps(rows);
        _applyUserLimitsToLiveData(liveDBData["_userLimits"] || {});
        return rows;
    }).catch(function(err) {
        console.error("listDeptEmployees failed:", err && err.message);
        _rebuildEmployeeMaps([]);
        return [];
    });
}

function _employeeDisplayByUid(uid) {
    var emp = employeeByUid[uid];
    return emp ? emp.name : uid;
}

function _employeeEmpNoByUid(uid) {
    var emp = employeeByUid[uid];
    return emp ? emp.empNo : "";
}

function _resolveEmployeeToken(token) {
    var raw = String(token || "").trim();
    if (!raw) return null;
    if (employeeByUid[raw]) return employeeByUid[raw];
    return employeeByEmpNo[raw.toLowerCase()] || null;
}

function _clearAdminRequestLiveData(yyyymm) {
    Object.keys(liveDBData).forEach(function(k) {
        if (k.startsWith("rq_") && k.indexOf("_" + yyyymm + "_") >= 0) delete liveDBData[k];
        if (k.startsWith("sc_") && !k.startsWith("sc_glimit_") && k.indexOf("_" + yyyymm + "_") >= 0) delete liveDBData[k];
    });
}

function _applyUserLimitsToLiveData(userLimits) {
    Object.keys(liveDBData).forEach(function(k) {
        if (k.startsWith("rq_limit_uid_") || k.startsWith("rq_limit_emp_")) delete liveDBData[k];
    });
    liveDBData["_userLimits"] = userLimits || {};
    Object.keys(liveDBData["_userLimits"]).forEach(function(uid) {
        var ul = liveDBData["_userLimits"][uid] || {};
        if (ul.globalUserMax != null) {
            liveDBData["rq_limit_uid_" + uid] = ul.globalUserMax;
            var empNo = _employeeEmpNoByUid(uid);
            if (empNo) liveDBData["rq_limit_emp_" + empNo] = ul.globalUserMax;
        }
    });
}

function _clearConfigLiveData(yyyymm) {
    // rq_current_target_year_month는 여기서 삭제하지 않음
    // → cfg에 targetYearMonth가 있으면 _applyCfgToLiveData에서 덮어씀
    // → cfg에 없어도(새 달 등) 기존 값이 유지되어 달 이탈 방지
    Object.keys(liveDBData).forEach(function(k) {
        if (k === "rq_allowed_start_datetime" || k === "rq_allowed_end_datetime" || k === "schedule_codes_list" || k === "_userLimits") {
            delete liveDBData[k];
            return;
        }
        if (k.startsWith("rq_config_") || k.startsWith("rq_limit_uid_") || k.startsWith("rq_limit_emp_") || k.startsWith("sc_glimit_") || k.startsWith("rq_live_group_")) {
            delete liveDBData[k];
            return;
        }
        if (k.startsWith("rq_special_limit_" + yyyymm + "_")) delete liveDBData[k];
    });
    liveDBData["_userLimits"] = {};
}

function connectDeptDB(dept, onFirstLoad, overrideYyyymm) {
    var connectToken = ++_deptConnectToken;
    _deptListeners.forEach(function(item) {
        db.ref(item.path).off(item.event, item.fn);
    });
    _deptListeners = [];
    dbListener = dept;
    liveDBData = {};
    if (overrideYyyymm) {
        var oy = overrideYyyymm.slice(0, 4);
        var om = overrideYyyymm.slice(4, 6);
        liveDBData["rq_current_target_year_month"] = oy + "-" + om;
    }
    var tm = getTargetYearMonth();
    var yyyymm = overrideYyyymm || tm.fullStr;
    var cfgPath = "departments/" + dept + "/configs/" + yyyymm;
    var counterPath = "departments/" + dept + "/publicCounters/" + yyyymm;
    var myReqPath = "userRequests/" + currentUid + "/" + yyyymm;
    var avPath = "departments/" + dept + "/adminView/" + yyyymm;
    var initialState = {};
    var total = (isAdmin || isSuperAdmin) ? 5 : 3;
    var loaded = 0;
    function onLoaded() {
        if (connectToken !== _deptConnectToken) return;
        loaded++;
        if (loaded >= total) {
            _subscribeRealtimeKeys(dept, yyyymm, initialState, connectToken);
            if (onFirstLoad) onFirstLoad();
        }
    }
    db.ref(cfgPath).once("value", function(snap) {
        if (connectToken !== _deptConnectToken) return;
        var cfg = snap.val() || {};
        initialState.cfg = JSON.stringify(cfg);
        if (cfg.targetYearMonth && !overrideYyyymm) {
            var savedFull = String(cfg.targetYearMonth).replace("-", "");
            if (savedFull.length === 6 && savedFull !== yyyymm) {
                yyyymm = savedFull;
                liveDBData["rq_current_target_year_month"] = cfg.targetYearMonth;
            }
        }
        _applyCfgToLiveData(cfg, yyyymm);
        onLoaded();
    });
    db.ref(counterPath).once("value", function(snap) {
        if (connectToken !== _deptConnectToken) return;
        var counterData = snap.val() || {};
        initialState.counter = JSON.stringify(counterData);
        _countersCache = counterData;
        onLoaded();
    });
    db.ref(myReqPath).once("value", function(snap) {
        if (connectToken !== _deptConnectToken) return;
        var myData = snap.val() || {};
        initialState.myReq = JSON.stringify(myData);
        _applyMyRequests(myData, yyyymm);
        onLoaded();
    });
    if (isAdmin || isSuperAdmin) {
        loadDeptEmployees(dept).then(function() {
            if (connectToken !== _deptConnectToken) return;
            onLoaded();
        });
        db.ref(avPath).once("value", function(snap) {
            if (connectToken !== _deptConnectToken) return;
            var adminData = snap.val() || {};
            initialState.adminView = JSON.stringify(adminData);
            _applyAdminView(adminData, yyyymm);
            onLoaded();
        });
    }
}

function _applyCfgToLiveData(cfg, yyyymm) {
    if (cfg.openAt != null) liveDBData["rq_allowed_start_datetime"] = cfg.openAt;
    if (cfg.closeAt != null) liveDBData["rq_allowed_end_datetime"] = cfg.closeAt;
    if (cfg.dayMax != null) liveDBData["rq_config_day_max"] = cfg.dayMax;
    if (cfg.globalUserMax != null) liveDBData["rq_config_global_user_max"] = cfg.globalUserMax;
    if (cfg.annualUserMax != null) liveDBData["rq_config_annual_user_max"] = cfg.annualUserMax;
    if (cfg.targetYearMonth) liveDBData["rq_current_target_year_month"] = cfg.targetYearMonth;

    ["A", "B", "C", "D", "E"].forEach(function(group) {
        if (cfg["groupMax" + group] != null) {
            liveDBData["rq_config_group_max_" + group] = cfg["groupMax" + group];
        }
    });

    if (cfg.scheduleCodes) liveDBData["schedule_codes_list"] = cfg.scheduleCodes;

    if (cfg.specialDayLimits) {
        Object.keys(cfg.specialDayLimits).forEach(function(day) {
            liveDBData["rq_special_limit_" + yyyymm + "_" + day] = cfg.specialDayLimits[day];
        });
    }

    if (cfg.scGroupLimits) {
        Object.keys(cfg.scGroupLimits).forEach(function(key) {
            liveDBData["sc_glimit_" + key] = cfg.scGroupLimits[key];
        });
    }

    if (cfg.groups) {
        ["A", "B", "C", "D", "E"].forEach(function(group) {
            if (cfg.groups[group]) liveDBData["rq_live_group_" + group] = cfg.groups[group];
        });
    }

    _applyUserLimitsToLiveData(cfg.userLimits || {});
}

function _applyMyRequests(myData, yyyymm) {
    Object.keys(myData).forEach(function(day) {
        var req = myData[day];
        if (!req) return;
        var prefix = "rq_" + currentUser + "_" + yyyymm + "_";
        var t = req.type || "normal";
        if (t === "normal")   liveDBData[prefix + day] = req.ts || 1;
        else if (t === "petition") liveDBData[prefix + day + "_petition"] = req.ts || 1;
        else if (t === "annual")   liveDBData[prefix + day + "_annual"]   = req.ts || 1;
        else if (t === "schedule" && req.scheduleCode) {
            liveDBData["sc_" + req.scheduleCode + "_" + currentUser + "_" + yyyymm + "_" + day] = req.ts || 1;
        } else {
            // 알 수 없는 type: normal로 폴백하여 취소 가능하도록
            liveDBData[prefix + day] = req.ts || 1;
        }
    });
}

function _applyAdminView(avData, yyyymm) {
    adminViewCache = avData || {};
    Object.keys(avData).forEach(function(uid) {
        var days = avData[uid] || {};
        Object.keys(days).forEach(function(day) {
            var req = days[day];
            if (!req) return;
            var name = req.name || _employeeDisplayByUid(uid);
            var prefix = "rq_" + name + "_" + yyyymm + "_";
            if (req.type === "normal") liveDBData[prefix + day] = req.ts || 1;
            if (req.type === "petition") liveDBData[prefix + day + "_petition"] = req.ts || 1;
            if (req.type === "annual") liveDBData[prefix + day + "_annual"] = req.ts || 1;
            if (req.type === "schedule" && req.scheduleCode) {
                liveDBData["sc_" + req.scheduleCode + "_" + name + "_" + yyyymm + "_" + day] = req.ts || 1;
            }
        });
    });
}

function _subscribeRealtimeKeys(dept, yyyymm, initialState, connectToken) {
    function isDuplicateInitial(kind, value) {
        if (connectToken !== _deptConnectToken) return true;
        var serialized = JSON.stringify(value || {});
        if (initialState[kind] === serialized) {
            initialState[kind] = null;
            return true;
        }
        initialState[kind] = null;
        return false;
    }
    var cfgPath = "departments/" + dept + "/configs/" + yyyymm;
    var onCfgValue = db.ref(cfgPath).on("value", function(snap) {
        var cfg = snap.val() || {};
        if (isDuplicateInitial("cfg", cfg)) return;
        _clearConfigLiveData(yyyymm);
        _applyCfgToLiveData(cfg, yyyymm);
        if (currentUser) _throttledRefresh();
    });
    _deptListeners.push({ path: cfgPath, event: "value", fn: onCfgValue });
    var counterPath = "departments/" + dept + "/publicCounters/" + yyyymm;
    var onCounter = db.ref(counterPath).on("value", function(snap) {
        var counterData = snap.val() || {};
        if (isDuplicateInitial("counter", counterData)) return;
        _countersCache = counterData;
        if (currentUser && !isAdmin && !isSuperAdmin) _updateAllBadges();
        else if (currentUser && (isAdmin || isSuperAdmin)) _throttledRefresh();
    });
    _deptListeners.push({ path: counterPath, event: "value", fn: onCounter });
    var myReqPath = "userRequests/" + currentUid + "/" + yyyymm;
    var onMyValue = db.ref(myReqPath).on("value", function(snap) {
        var myData = snap.val() || {};
        if (isDuplicateInitial("myReq", myData)) return;
        Object.keys(liveDBData).forEach(function(k) {
            if (k.startsWith("rq_" + currentUser + "_" + yyyymm)) delete liveDBData[k];
            if (k.startsWith("sc_") && k.indexOf("_" + currentUser + "_" + yyyymm + "_") >= 0) delete liveDBData[k];
        });
        _applyMyRequests(myData, yyyymm);
        if (currentUser && !isAdmin) _updateMyUserCells();
    });
    _deptListeners.push({ path: myReqPath, event: "value", fn: onMyValue });
    if (isAdmin || isSuperAdmin) {
        var avPath = "departments/" + dept + "/adminView/" + yyyymm;
        var onAdminView = db.ref(avPath).on("value", function(snap) {
            var adminData = snap.val() || {};
            if (isDuplicateInitial("adminView", adminData)) return;
            _clearAdminRequestLiveData(yyyymm);
            _applyAdminView(adminData, yyyymm);
            if (currentUser) _throttledRefresh();
        });
        _deptListeners.push({ path: avPath, event: "value", fn: onAdminView });
    }
}

function _updateAllBadges() {
    var tm = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"), 10);

    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;

        var sp = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var max = sp !== null ? parseInt(sp, 10) : configDayMax;
        var count = _countersCache[String(d)] || 0;
        var badge = cell.querySelector(".count-badge");
        if (badge) {
            badge.className = "count-badge " + (count >= max ? "badge-full" : "badge-safe");
            badge.innerText = count + "/" + max;
        }
    }
}

function _updateMyUserCells() {
    var tm = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var scList = getScheduleCodeList();
    var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;
        var oldNotes = cell.querySelectorAll(".user-note:not(.processing)");
        oldNotes.forEach(function(node) { node.remove(); });
        var fragment = document.createDocumentFragment();
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
        scList.forEach(function(code) {
            var scKey = "sc_" + code.name + "_" + currentUser + "_" + tm.fullStr + "_" + d;
            if (liveDBData[scKey]) {
                var n4 = document.createElement("div");
                n4.className = "user-note schedule";
                n4.innerText = code.name;
                fragment.appendChild(n4);
            }
        });
        cell.appendChild(fragment);
    }
}

var _refreshTimer = null;
function _throttledRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() {
        _refreshTimer = null;
        refreshData();
    }, 300);
}

function getFirebaseItem(key, defaultVal) {
    var val = liveDBData[key];
    return (val !== undefined && val !== null) ? val : (defaultVal !== undefined ? defaultVal : null);
}

function connectDeptDBSafe(dept, overrideYyyymm) {
    return new Promise(function(resolve, reject) {
        // overrideYyyymm이 있으면 그 달 경로로, 없으면 현재 getTargetYearMonth() 사용
        var yyyymm = overrideYyyymm || getTargetYearMonth().fullStr;
        var path = "departments/" + dept + "/configs/" + yyyymm;
        db.ref(path).once("value", function() {
            try {
                connectDeptDB(dept, function() { resolve(); }, overrideYyyymm);
            } catch (e) {
                reject(e);
            }
        }, function(err) {
            reject(err);
        });
    });
}
