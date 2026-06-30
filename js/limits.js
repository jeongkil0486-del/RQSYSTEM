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
        alert("일별 신청 제한이 저장되었습니다.");
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

function saveGroupMaxConstraints() {
    if (!isAdmin && !isSuperAdmin) return;

    var cfg = {};
    var ok  = true;
    ["A", "B", "C", "D", "E"].forEach(function(group) {
        var el = document.getElementById("groupMaxConfig" + group);
        var v  = el ? parseInt(el.value, 10) : NaN;
        if (isNaN(v) || v < 1) ok = false;
        cfg["groupMax" + group] = v;
    });

    if (!ok) {
        alert("각 조 한도는 1 이상이어야 합니다.");
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
        refreshData();
        alert("조별 한도가 저장되었습니다.");
    }).catch(function(e) {
        alert((e && e.message) || "저장 실패");
    });
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
    var container = document.getElementById("annualStatusTooltipBoard");
    if (!container) return;

    // 검색 입력칸은 최초 1회만 생성하고, 이후에는 목록 부분만 다시 그린다.
    // (매번 전체를 다시 그리면 입력 중 포커스/커서가 끊기므로 분리)
    var listEl = document.getElementById("annualStatusTooltipBoardList");
    if (!listEl) {
        container.innerHTML =
            "<div class='emp-search-row'><input type='text' id='annualStatusSearchInput' class='form-input' placeholder='사번 또는 이름 검색' style='background:#fff;color:#222;'></div>" +
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
window.triggerAnnualUpload        = triggerAnnualUpload;
window.downloadAnnualTemplate     = downloadAnnualTemplate;
