/**
 * firebase-store.js — RTDB 읽기 전용
 *
 * 읽기 경로: departments/{deptId}/configs/{yyyymm}  ← 정확한 yyyymm (상위 경로 X)
 *            departments/{deptId}/publicCounters/{yyyymm}
 *            departments/{deptId}/adminView/{yyyymm}
 *            userRequests/{uid}/{yyyymm}
 *
 * 모든 쓰기는 fn.xxx() (Cloud Function) 경유.
 */

var _countersCache = {};

function _rebuildEmployeeMaps(rows) {
    deptEmployees = Array.isArray(rows) ? rows.slice() : [];
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
            role: emp.role || "staff",
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

// ── 지점 DB 연결 ──────────────────────────────────────────────────────────────
function connectDeptDB(dept, onFirstLoad) {
    _deptListeners.forEach(function(item) {
        db.ref(item.path).off(item.event, item.fn);
    });
    _deptListeners = [];
    dbListener = dept;
    liveDBData = {};

    var tm      = getTargetYearMonth();
    var yyyymm  = tm.fullStr;

    // 정확한 yyyymm 경로만 읽기 — 상위 configs/ 전체를 읽지 않음
    var cfgPath     = "departments/" + dept + "/configs/" + yyyymm;
    var counterPath = "departments/" + dept + "/publicCounters/" + yyyymm;
    var myReqPath   = "userRequests/" + currentUid + "/" + yyyymm;
    var avPath      = "departments/" + dept + "/adminView/" + yyyymm;

    var total  = (isAdmin || isSuperAdmin) ? 5 : 3;
    var loaded = 0;

    function onLoaded() {
        loaded++;
        if (loaded >= total) {
            _subscribeRealtimeKeys(dept, yyyymm);
            if (onFirstLoad) onFirstLoad();
        }
    }

    // 1) configs/{yyyymm}
    db.ref(cfgPath).once("value", function(snap) {
        var cfg = snap.val() || {};
        _applyCfgToLiveData(cfg, yyyymm);
        onLoaded();
    });

    // 2) publicCounters/{yyyymm}
    db.ref(counterPath).once("value", function(snap) {
        _countersCache = snap.val() || {};
        onLoaded();
    });

    // 3) 내 신청 내역
    db.ref(myReqPath).once("value", function(snap) {
        _applyMyRequests(snap.val() || {}, yyyymm);
        onLoaded();
    });

    // 4) adminView (관리자/슈퍼관리자)
    if (isAdmin || isSuperAdmin) {
        loadDeptEmployees(dept).then(function() { onLoaded(); });
        db.ref(avPath).once("value", function(snap) {
            _applyAdminView(snap.val() || {}, yyyymm);
            onLoaded();
        });
    }
}

function _applyCfgToLiveData(cfg, yyyymm) {
    // 호환 키 매핑 (기존 calendar.js 가 getFirebaseItem 으로 읽는 키 이름)
    if (cfg.openAt         != null) liveDBData["rq_allowed_start_datetime"] = cfg.openAt;
    if (cfg.closeAt        != null) liveDBData["rq_allowed_end_datetime"]   = cfg.closeAt;
    if (cfg.dayMax         != null) liveDBData["rq_config_day_max"]         = cfg.dayMax;
    if (cfg.globalUserMax  != null) liveDBData["rq_config_global_user_max"] = cfg.globalUserMax;
    if (cfg.annualUserMax  != null) liveDBData["rq_config_annual_user_max"] = cfg.annualUserMax;
    if (cfg.targetYearMonth) liveDBData["rq_current_target_year_month"] = cfg.targetYearMonth;
    ["A","B","C","D","E"].forEach(function(g) {
        if (cfg["groupMax" + g] != null)
            liveDBData["rq_config_group_max_" + g] = cfg["groupMax" + g];
    });
    if (cfg.scheduleCodes)
        liveDBData["schedule_codes_list"] = cfg.scheduleCodes;
    if (cfg.specialDayLimits) {
        Object.keys(cfg.specialDayLimits).forEach(function(day) {
            liveDBData["rq_special_limit_" + yyyymm + "_" + day] = cfg.specialDayLimits[day];
        });
    }
    if (cfg.scGroupLimits) {
        Object.keys(cfg.scGroupLimits).forEach(function(key) {
            // key 형식: "코드명_조"  → sc_glimit_코드명_조
            liveDBData["sc_glimit_" + key] = cfg.scGroupLimits[key];
        });
    }
    if (cfg.groups) {
        ["A","B","C","D","E"].forEach(function(g) {
            if (cfg.groups[g]) liveDBData["rq_live_group_" + g] = cfg.groups[g];
        });
    }
    _applyUserLimitsToLiveData(cfg.userLimits || {});
}

function _applyMyRequests(myData, yyyymm) {
    Object.keys(myData).forEach(function(day) {
        var req = myData[day];
        if (!req) return;
        var prefix = "rq_" + currentUser + "_" + yyyymm + "_";
        if (req.type === "normal")   liveDBData[prefix + day]               = req.ts || 1;
        if (req.type === "petition") liveDBData[prefix + day + "_petition"] = req.ts || 1;
        if (req.type === "annual")   liveDBData[prefix + day + "_annual"]   = req.ts || 1;
        if (req.type === "schedule" && req.scheduleCode)
            liveDBData["sc_" + req.scheduleCode + "_" + currentUser + "_" + yyyymm + "_" + day] = req.ts || 1;
    });
}

function _applyAdminView(avData, yyyymm) {
    adminViewCache = avData || {};
    Object.keys(avData).forEach(function(uid) {
        var days = avData[uid] || {};
        Object.keys(days).forEach(function(day) {
            var req = days[day];
            if (!req) return;
            var name   = req.name || _employeeDisplayByUid(uid);
            var prefix = "rq_" + name + "_" + yyyymm + "_";
            if (req.type === "normal")   liveDBData[prefix + day]               = req.ts || 1;
            if (req.type === "petition") liveDBData[prefix + day + "_petition"] = req.ts || 1;
            if (req.type === "annual")   liveDBData[prefix + day + "_annual"]   = req.ts || 1;
            if (req.type === "schedule" && req.scheduleCode)
                liveDBData["sc_" + req.scheduleCode + "_" + name + "_" + yyyymm + "_" + day] = req.ts || 1;
        });
    });
}

// ── 실시간 구독 ───────────────────────────────────────────────────────────────
function _subscribeRealtimeKeys(dept, yyyymm) {
    // 카운터 실시간
    var counterPath = "departments/" + dept + "/publicCounters/" + yyyymm;
    var onCounter = db.ref(counterPath).on("value", function(snap) {
        _countersCache = snap.val() || {};
        if (currentUser && !isAdmin && !isSuperAdmin) {
            _updateAllBadges();
        } else if (currentUser && (isAdmin || isSuperAdmin)) {
            _throttledRefresh();
        }
    });
    _deptListeners.push({ path: counterPath, event: "value", fn: onCounter });

    // 내 신청 실시간
    var myReqPath = "userRequests/" + currentUid + "/" + yyyymm;
    var onMyValue = db.ref(myReqPath).on("value", function(snap) {
        // 기존 내 키 제거
        Object.keys(liveDBData).forEach(function(k) {
            if (k.startsWith("rq_" + currentUser + "_" + yyyymm)) delete liveDBData[k];
            if (k.startsWith("sc_") && k.indexOf("_" + currentUser + "_" + yyyymm + "_") >= 0)
                delete liveDBData[k];
        });
        _applyMyRequests(snap.val() || {}, yyyymm);
        if (currentUser && !isAdmin) _updateMyUserCells();
    });
    _deptListeners.push({ path: myReqPath, event: "value", fn: onMyValue });

    if (isAdmin || isSuperAdmin) {
        var avPath = "departments/" + dept + "/adminView/" + yyyymm;
        var onAdminView = db.ref(avPath).on("value", function(snap) {
            _clearAdminRequestLiveData(yyyymm);
            _applyAdminView(snap.val() || {}, yyyymm);
            if (currentUser) _throttledRefresh();
        });
        _deptListeners.push({ path: avPath, event: "value", fn: onAdminView });
    }
}

// ── 배지 업데이트 ─────────────────────────────────────────────────────────────
function _updateAllBadges() {
    var tm = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
    for (var d = 1; d <= totalDays; d++) {
        var cell  = document.getElementById("d-" + d);
        if (!cell) continue;
        var sp    = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var max   = sp !== null ? parseInt(sp) : configDayMax;
        var count = _countersCache[String(d)] || 0;
        var badge = cell.querySelector(".count-badge");
        if (badge) {
            badge.className = "count-badge " + (count >= max ? "badge-full" : "badge-safe");
            badge.innerText = count + "/" + max + "명";
        }
    }
}

function _updateMyUserCells() {
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var scList    = getScheduleCodeList();
    for (var d = 1; d <= totalDays; d++) {
        var cell = document.getElementById("d-" + d);
        if (!cell) continue;
        cell.querySelectorAll(".user-note").forEach(function(n) { n.remove(); });
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

var _refreshTimer = null;
function _throttledRefresh() {
    if (_refreshTimer) clearTimeout(_refreshTimer);
    _refreshTimer = setTimeout(function() { _refreshTimer = null; refreshData(); }, 300);
}

function getFirebaseItem(key, defaultVal) {
    var val = liveDBData[key];
    return (val !== undefined && val !== null) ? val : (defaultVal !== undefined ? defaultVal : null);
}

function connectDeptDBSafe(dept) {
    return new Promise(function(resolve, reject) {
        // 정확한 yyyymm 경로로 probe — 상위 경로 사용 안 함
        var tm   = getTargetYearMonth();
        var path = "departments/" + dept + "/configs/" + tm.fullStr;
        db.ref(path).once("value", function() {
            try { connectDeptDB(dept, function() { resolve(); }); }
            catch (e) { reject(e); }
        }, function(err) { reject(err); });
    });
}
