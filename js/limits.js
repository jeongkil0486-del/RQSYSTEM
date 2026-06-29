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
        year: parts[0],
        month: String(parts[1]).padStart(2, "0"),
        fullStr: parts[0] + String(parts[1]).padStart(2, "0"),
        label: parts[0] + "." + parseInt(parts[1], 10)
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
            yOpt.text = String(y);
            selY.appendChild(yOpt);
        }
    }
    if (selM.options.length === 0) {
        for (var m = 1; m <= 12; m++) {
            var mOpt = document.createElement("option");
            mOpt.value = String(m).padStart(2, "0");
            mOpt.text = String(m);
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

function saveYearMonthConfig() {
    if (!isAdmin && !isSuperAdmin) return;

    var y = document.getElementById("targetYear").value;
    var m = document.getElementById("targetMonth").value;
    if (!y || !m) return;

    var ym = y + "-" + m;
    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: y + m,
        config: { targetYearMonth: ym }
    }).then(function() {
        liveDBData["rq_current_target_year_month"] = ym;
        return _refreshAfterAdminConfigSave({ reconnect: true });
    }).then(function() {
        alert("Target year/month saved.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
    });
}

function saveDayMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("dayMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 1) {
        alert("Enter a number greater than or equal to 1.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { dayMax: val }
    }).then(function() {
        liveDBData["rq_config_day_max"] = val;
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        alert("Daily request limit saved.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
    });
}

function saveGlobalUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("globalUserMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 1) {
        alert("Enter a number greater than or equal to 1.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { globalUserMax: val }
    }).then(function() {
        liveDBData["rq_config_global_user_max"] = val;
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        alert("User request limit saved.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
    });
}

function saveAnnualUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;

    var val = parseInt((document.getElementById("annualUserMaxConfig") || {}).value || "", 10);
    if (isNaN(val) || val < 0) {
        alert("Enter a valid number.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: { annualUserMax: val }
    }).then(function() {
        liveDBData["rq_config_annual_user_max"] = val;
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        alert("Annual default quota saved.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
    });
}

function saveGroupMaxConstraints() {
    if (!isAdmin && !isSuperAdmin) return;

    var cfg = {};
    var ok = true;
    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var el = document.getElementById("groupMaxConfig" + group);
        var v = el ? parseInt(el.value, 10) : NaN;
        if (isNaN(v) || v < 1) ok = false;
        cfg["groupMax" + group] = v;
    });

    if (!ok) {
        alert("Each group limit must be 1 or more.");
        return;
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: cfg
    }).then(function() {
        Object.keys(cfg).forEach(function(key) {
            liveDBData["rq_config_" + key.replace("groupMax", "group_max_")] = cfg[key];
        });
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        alert("Group limits saved.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
    });
}

function setSpecialDayLimit(isSet) {
    if (!isAdmin && !isSuperAdmin) return;

    var dayInput = (document.getElementById("specialDayInput") || {}).value || "";
    var limitInput = (document.getElementById("specialDayLimit") || {}).value || "";
    var tm = getTargetYearMonth();
    var dayNum = parseInt(dayInput, 10);

    if (!dayInput || isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
        alert("Enter a day between 1 and 31.");
        return;
    }

    var limitValue = null;
    if (isSet) {
        limitValue = parseInt(limitInput, 10);
        if (isNaN(limitValue) || limitValue < 0) {
            alert("Enter a valid limit.");
            return;
        }
    }

    fn.setSpecialDayLimit({
        deptId: currentDept,
        yyyymm: tm.fullStr,
        day: dayNum,
        limit: limitValue
    }).then(function() {
        var key = "rq_special_limit_" + tm.fullStr + "_" + dayNum;
        if (limitValue === null) delete liveDBData[key];
        else liveDBData[key] = limitValue;

        document.getElementById("specialDayInput").value = "";
        document.getElementById("specialDayLimit").value = "";
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        alert(isSet ? "Special-day limit saved." : "Special-day limit removed.");
    }).catch(function(e) {
        alert((e && e.message) || "Save failed");
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
    var failedEmpNos = {};
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
        alert("Choose an Excel file first.");
        return;
    }

    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var wb = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
            var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
            var toUpload = [];
            var errors = [];

            for (var i = 1; i < rows.length; i++) {
                var empNo = rows[i][0] !== undefined ? String(rows[i][0]).trim() : "";
                var quota = rows[i][1] !== undefined ? parseInt(rows[i][1], 10) : NaN;
                if (!empNo) continue;
                if (isNaN(quota) || quota < 0) {
                    errors.push("row " + (i + 1) + ": invalid quota");
                    continue;
                }
                toUpload.push({ empNo: empNo, quota: quota });
            }

            if (toUpload.length === 0) {
                alert("No valid rows found.\n" + errors.join("\n"));
                return;
            }

            fn.uploadAnnualQuotas({
                deptId: currentDept,
                yyyymm: getTargetYearMonth().fullStr,
                rows: toUpload
            }).then(function(result) {
                var errs = (result.data && result.data.errors) || [];
                _syncAnnualQuotaLiveData(toUpload, errs);
                fi.value = "";
                return _refreshAfterAdminConfigSave();
            }).then(function() {
                drawAnnualStatusBoard();
                alert("Annual quota upload completed.");
            }).catch(function(e) {
                alert((e && e.message) || "Upload failed");
            });
        } catch (err) {
            alert("Excel parse failed: " + ((err && err.message) || err));
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

function toggleAnnualStatusBoard(event) {
    var board = document.getElementById("annualStatusTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

function drawAnnualStatusBoard() {
    var container = document.getElementById("annualStatusTooltipBoard");
    if (!container) return;

    var userLimits = liveDBData["_userLimits"] || {};
    var annualMax = parseInt(getFirebaseItem("rq_config_annual_user_max", "15"), 10);
    var html = "<strong style='color:#fff;font-size:13px;'>Annual quotas</strong>"
        + "<div style='font-size:11px;color:#bdc3c7;margin:4px 0 8px;'>quota / used / remaining</div>"
        + "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";

    var uidSet = {};
    deptEmployees.forEach(function(emp) { uidSet[emp.uid] = true; });
    Object.keys(userLimits).forEach(function(uid) { uidSet[uid] = true; });
    Object.keys(adminViewCache || {}).forEach(function(uid) { uidSet[uid] = true; });

    var hasAny = false;
    Object.keys(uidSet).forEach(function(uid) {
        var ul = userLimits[uid] || {};
        var quota = ul.annualQuota != null ? parseInt(ul.annualQuota, 10) : annualMax;
        var days = (adminViewCache && adminViewCache[uid]) || {};
        var used = 0;

        Object.keys(days).forEach(function(day) {
            if (days[day] && days[day].type === "annual") used++;
        });

        hasAny = true;
        var remain = quota - used;
        var emp = employeeByUid[uid] || {};
        var label = emp.name ? (emp.name + " (" + emp.empNo + ")") : ("uid:" + uid.slice(0, 6));
        var bgColor = remain <= 0 ? "rgba(229,57,53,0.25)" : remain <= 2 ? "rgba(245,127,23,0.25)" : "rgba(46,125,50,0.25)";
        var bdColor = remain <= 0 ? "#e53935" : remain <= 2 ? "#f57f17" : "#43a047";
        var txColor = remain <= 0 ? "#ff8a80" : remain <= 2 ? "#ffcc02" : "#a5d6a7";

        html += "<span style='background:" + bgColor + ";border:1px solid " + bdColor + ";border-radius:5px;"
            + "padding:4px 8px;font-size:12px;color:" + txColor + ";font-weight:bold;white-space:nowrap;'>"
            + label + " " + quota + "/" + used + "/" + remain + "</span>";
    });

    if (!hasAny) {
        html += "<span style='color:#aaa;font-style:italic;font-size:12px;'>No annual quota data</span>";
    }

    html += "</div>";
    container.innerHTML = html;
}

function deleteAnnualQuotaFromBoard(event, empNo) {
    event.preventDefault();
    if (!confirm("Remove annual quota for [" + empNo + "]?")) return;

    fn.setUserLimit({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        targetEmpNo: empNo,
        limitType: "annualQuota",
        count: null
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
        return _refreshAfterAdminConfigSave();
    }).then(function() {
        drawAnnualStatusBoard();
    }).catch(function(e) {
        alert((e && e.message) || "Delete failed");
    });
}

window.saveYearMonthConfig = saveYearMonthConfig;
window.saveDayMaxConstraint = saveDayMaxConstraint;
window.saveGlobalUserMaxConstraint = saveGlobalUserMaxConstraint;
window.saveAnnualUserMaxConstraint = saveAnnualUserMaxConstraint;
window.saveGroupMaxConstraints = saveGroupMaxConstraints;
window.setSpecialDayLimit = setSpecialDayLimit;
window.triggerAnnualUpload = triggerAnnualUpload;
window.downloadAnnualTemplate = downloadAnnualTemplate;
window.toggleAnnualStatusBoard = toggleAnnualStatusBoard;
