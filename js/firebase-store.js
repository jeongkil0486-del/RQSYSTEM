/**
 * firebase-store.js
 * RTDB read/subscription helpers for department-scoped state.
 */

var _countersCache = {};
var _deptConnectToken = 0;

function _rebuildEmployeeMaps(rows) {
    var sorted = (Array.isArray(rows) ? rows : []).filter(function(emp) {
        return !!(emp && emp.uid && String(emp.empNo || "").trim());
    });

    // 엑셀 업로드 순서(sortOrder) 우선 → 없으면 empNo 사전순 fallback
    // 기존 직원(sortOrder 없음)과 신규 직원(sortOrder 있음)이 섞인 경우:
    //   sortOrder 있는 직원 먼저(오름차순), sortOrder 없는 직원 뒤(empNo순)
    sorted.sort(function(a, b) {
        var aOrder = Number(a.sortOrder);
        var bOrder = Number(b.sortOrder);
        var aHas = Number.isFinite(aOrder);
        var bHas = Number.isFinite(bOrder);
        if (aHas && bHas && aOrder !== bOrder) return aOrder - bOrder;
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return String(a.empNo || "").localeCompare(String(b.empNo || ""), undefined, { numeric: true, sensitivity: "base" });
    });

    deptEmployees = sorted;
    employeeByUid = {};
    employeeByEmpNo = {};
    employeeByName = {};
    allowedUsers = [];

    deptEmployees.forEach(function(emp) {
        if (!emp || !emp.uid) return;
        var clean = {
            uid:       emp.uid,
            empNo:     emp.empNo || "",
            name:      emp.name || emp.empNo || emp.uid,
            role:      emp.role || "staff",
            sortOrder: (Number.isFinite(Number(emp.sortOrder)) ? Number(emp.sortOrder) : null)
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
    // ⚠️ 월/지점이 바뀌어 리스너가 재연결될 때마다, 이전 달 기준으로
    // 저장해 둔 비교용 캐시도 함께 리셋한다. 리셋하지 않으면 다른 달의
    // 카운터/신청 데이터와 새 달의 데이터를 잘못 비교해 일부 날짜가
    // 갱신되지 않거나 불필요하게 갱신되는 문제가 생길 수 있다.
    _prevCountersCache = null;
    _prevMyRequestSnapshot = null;
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

        // ⚠️ 변경된 날짜만 추려내기: 이전 myData 스냅샷과 새 myData 를
        // 비교해 '키가 새로 생겼는지/사라졌는지/내용(type, scheduleCode)이
        // 달라졌는지'를 모두 확인한다. 이렇게 하면 신규 신청·취소·타입
        // 변경을 전부 정확히 잡아내며, 여러 날짜가 동시에 바뀐 경우도
        // 자연스럽게 changedDays 에 모두 포함된다.
        var changedDays = null;  // null = 최초 호출(비교 불가) → 전체 갱신
        if (_prevMyRequestSnapshot !== null) {
            changedDays = [];
            var allDayKeys = {};
            Object.keys(_prevMyRequestSnapshot).forEach(function(k) { allDayKeys[k] = true; });
            Object.keys(myData).forEach(function(k) { allDayKeys[k] = true; });
            Object.keys(allDayKeys).forEach(function(day) {
                var oldReq = _prevMyRequestSnapshot[day];
                var newReq = myData[day];
                var oldSig = oldReq ? ((oldReq.type || "normal") + ":" + (oldReq.scheduleCode || "")) : null;
                var newSig = newReq ? ((newReq.type || "normal") + ":" + (newReq.scheduleCode || "")) : null;
                if (oldSig !== newSig) changedDays.push(day);
            });
        }
        // 다음 비교를 위해 현재 myData 를 그대로 스냅샷으로 저장
        _prevMyRequestSnapshot = myData;

        Object.keys(liveDBData).forEach(function(k) {
            if (k.startsWith("rq_" + currentUser + "_" + yyyymm)) delete liveDBData[k];
            if (k.startsWith("sc_") && k.indexOf("_" + currentUser + "_" + yyyymm + "_") >= 0) delete liveDBData[k];
        });
        _applyMyRequests(myData, yyyymm);
        if (currentUser && !isAdmin) _updateMyUserCells(changedDays);
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

// 이전 호출 시점의 _countersCache 스냅샷 — 최초 로딩 시에는 null 이라
// 전체 31칸을 갱신하고, 이후부터는 이 값과 비교해 바뀐 날짜만 추려낸다.
var _prevCountersCache = null;
// 이전 호출 시점의 myReqPath 스냅샷(원본 RTDB 객체) — 위와 동일한 목적으로
// _updateMyUserCells() 가 어떤 날짜만 다시 그려야 하는지 판단하는 데 사용.
var _prevMyRequestSnapshot = null;

function _updateAllBadges() {
    var tm = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"), 10);

    // 최초 호출(이전 캐시 없음) 또는 월이 바뀌어 totalDays 범위가 달라지는
    // 경우를 대비해, 비교 대상 날짜 목록을 결정한다.
    var daysToUpdate;
    if (_prevCountersCache === null) {
        // 최초 로딩: 기존처럼 전체 31칸 갱신
        daysToUpdate = [];
        for (var i = 1; i <= totalDays; i++) daysToUpdate.push(i);
    } else {
        // 이전 캐시와 비교해 실제로 카운트가 달라진 날짜만 추려낸다.
        // (여러 날짜가 동시에 바뀐 경우도 자연스럽게 모두 포함됨)
        var changedSet = {};
        for (var d1 = 1; d1 <= totalDays; d1++) {
            var key = String(d1);
            var oldVal = _prevCountersCache[key] || 0;
            var newVal = _countersCache[key] || 0;
            if (oldVal !== newVal) changedSet[d1] = true;
        }
        daysToUpdate = Object.keys(changedSet).map(function(k) { return parseInt(k, 10); });
    }

    daysToUpdate.forEach(function(d) {
        var cell = document.getElementById("d-" + d);
        if (!cell) return;

        var sp = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
        var max = sp !== null ? parseInt(sp, 10) : configDayMax;
        var count = _countersCache[String(d)] || 0;
        var badge = cell.querySelector(".count-badge");
        if (badge) {
            badge.className = "count-badge " + (count >= max ? "badge-full" : "badge-safe");
            badge.innerText = count + "/" + max;
        }
    });

    // 다음 비교를 위해 현재 값을 스냅샷으로 저장 (얕은 복사로 충분 —
    // _countersCache 는 { "1": n, "2": n, ... } 형태의 단순 숫자 맵)
    _prevCountersCache = {};
    for (var d2 = 1; d2 <= totalDays; d2++) {
        _prevCountersCache[String(d2)] = _countersCache[String(d2)] || 0;
    }
}

function _updateMyUserCells(changedDays) {
    var tm = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year, 10), parseInt(tm.month, 10), 0).getDate();
    var scList = getScheduleCodeList();
    var prefix = "rq_" + currentUser + "_" + tm.fullStr + "_";

    // changedDays 가 없으면(최초 로딩, 또는 호출부에서 비교 불가 판단)
    // 기존처럼 전체 31칸을 갱신한다. 있으면 그 날짜들만 다시 그린다.
    var daysToUpdate;
    if (!changedDays) {
        daysToUpdate = [];
        for (var i = 1; i <= totalDays; i++) daysToUpdate.push(String(i));
    } else {
        daysToUpdate = changedDays;
    }

    daysToUpdate.forEach(function(dayKey) {
        var d = dayKey;
        var cell = document.getElementById("d-" + d);
        if (!cell) return;
        var oldNotes = cell.querySelectorAll(".user-note:not(.processing), .user-note.optimistic");
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
    });
    // ⚠️ 달력 셀 배지뿐 아니라 상단 '나의 현황' 카운터(휴무/연차/근무코드)와
    // 기간 텍스트도 함께 갱신한다. 이 함수는 Firebase 실시간 리스너
    // (userRequests/{uid}/{yyyymm} 의 on("value")) 가 호출하는 경로라서,
    // 신청/취소가 RTDB 에 반영되는 즉시 자동으로 실행된다 — 누락되어
    // 있으면 셀 배지는 바뀌어도 상단 카운터는 그대로 남아있는 것처럼
    // 보이는 문제가 있었음. (카운터 자체는 날짜 1개만 바뀌어도 항상
    // 다시 계산해야 하므로 daysToUpdate 범위와 무관하게 매번 호출)
    if (!isAdmin && !isSuperAdmin && typeof _updateMyStatusSummary === "function") {
        _updateMyStatusSummary(tm);
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
