/**
 * limits.js — 설정 저장 함수 (Cloud Functions 경유)
 * setFirebaseItem 호출 없음.
 */

function formatDateTimeString(val) {
    if (!val) return "설정되지 않음";
    // val 이 timestamp(숫자)인 경우와 datetime-local 문자열 양쪽 지원
    var d = (typeof val === "number") ? new Date(val) : new Date(val);
    if (isNaN(d.getTime())) return "설정되지 않음";
    return d.getFullYear() + "년 " + (d.getMonth()+1) + "월 " + d.getDate() + "일 "
         + d.getHours() + "시 " + String(d.getMinutes()).padStart(2,"0") + "분";
}

function getTargetYearMonth() {
    var now       = new Date();
    var next      = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    var defaultYM = next.getFullYear() + "-" + String(next.getMonth() + 1).padStart(2, "0");
    var saved     = getFirebaseItem("rq_current_target_year_month", defaultYM);
    var parts     = String(saved).split("-");
    if (parts.length < 2) parts = defaultYM.split("-");
    return {
        year:    parts[0],
        month:   parts[1],
        fullStr: parts[0] + parts[1],
        label:   parts[0] + "년 " + parseInt(parts[1]) + "월"
    };
}

function initYearMonthSelects(year, month) {
    var selY = document.getElementById("targetYear");
    var selM = document.getElementById("targetMonth");
    if (!selY || !selM) return;
    if (selY.options.length === 0) {
        var curY = new Date().getFullYear();
        for (var y = curY - 1; y <= curY + 2; y++) {
            var opt = document.createElement("option");
            opt.value = y; opt.text = y + "년";
            selY.appendChild(opt);
        }
    }
    if (selM.options.length === 0) {
        for (var m = 1; m <= 12; m++) {
            var opt = document.createElement("option");
            opt.value = String(m).padStart(2,"0"); opt.text = m + "월";
            selM.appendChild(opt);
        }
    }
    selY.value = year;
    selM.value = String(month).padStart(2,"0");
}

// ── 신청 년/월 저장 ───────────────────────────────────────────────────────────
function saveYearMonthConfig() {
    if (!isAdmin && !isSuperAdmin) return;
    var y = document.getElementById("targetYear").value;
    var m = document.getElementById("targetMonth").value;
    if (!y || !m) return;
    var ym = y + "-" + m;
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: y + m, config: { targetYearMonth: ym } })
      .then(function() {
          liveDBData["rq_current_target_year_month"] = ym;
          alert("✨ " + y + "년 " + parseInt(m) + "월로 변경되었습니다. 새로고침하세요.");
      }).catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 일별 한도 ────────────────────────────────────────────────────────────────
function saveDayMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt((document.getElementById("dayMaxConfig") || {}).value || "");
    if (isNaN(val) || val < 1) { alert("❌ 1 이상의 숫자를 입력해주세요."); return; }
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { dayMax: val } })
      .then(function() { liveDBData["rq_config_day_max"] = val; alert("✨ 일별 한도 " + val + "명 적용 완료."); })
      .catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 개인 휴무 한도 ────────────────────────────────────────────────────────────
function saveGlobalUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt((document.getElementById("globalUserMaxConfig") || {}).value || "");
    if (isNaN(val) || val < 1) { alert("❌ 1 이상의 숫자를 입력해주세요."); return; }
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { globalUserMax: val } })
      .then(function() { liveDBData["rq_config_global_user_max"] = val; alert("✨ 적용 완료."); })
      .catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 연차 한도 ─────────────────────────────────────────────────────────────────
function saveAnnualUserMaxConstraint() {
    if (!isAdmin && !isSuperAdmin) return;
    var val = parseInt((document.getElementById("annualUserMaxConfig") || {}).value || "");
    if (isNaN(val) || val < 0) { alert("❌ 올바른 숫자를 입력해주세요."); return; }
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: { annualUserMax: val } })
      .then(function() { liveDBData["rq_config_annual_user_max"] = val; alert("✨ 적용 완료."); })
      .catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 조별 한도 ─────────────────────────────────────────────────────────────────
function saveGroupMaxConstraints() {
    if (!isAdmin && !isSuperAdmin) return;
    var cfg = {};
    var ok  = true;
    ["A","B","C","D","E"].forEach(function(g) {
        var el = document.getElementById("groupMaxConfig" + g);
        var v  = el ? parseInt(el.value) : NaN;
        if (isNaN(v) || v < 1) { ok = false; return; }
        cfg["groupMax" + g] = v;
    });
    if (!ok) { alert("❌ 각 조별 한도는 1 이상이어야 합니다."); return; }
    fn.saveDeptConfig({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, config: cfg })
      .then(function() {
          Object.keys(cfg).forEach(function(k) {
              liveDBData["rq_config_" + k.replace("groupMax","group_max_")] = cfg[k];
          });
          alert("✨ 조별 한도 적용 완료!");
      }).catch(function(e) { alert(e.message || "저장 실패"); });
}

// ── 특정일 한도 ───────────────────────────────────────────────────────────────
function setSpecialDayLimit(isSet) {
    if (!isAdmin && !isSuperAdmin) return;
    var dayInput   = (document.getElementById("specialDayInput") || {}).value || "";
    var limitInput = (document.getElementById("specialDayLimit") || {}).value || "";
    var tm         = getTargetYearMonth();
    var dayNum     = parseInt(dayInput);
    if (!dayInput || isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
        alert("❌ 올바른 날짜(1~31)를 입력해주세요."); return;
    }
    if (isSet) {
        var limitNum = parseInt(limitInput);
        if (isNaN(limitNum) || limitNum < 0) { alert("❌ 0 이상의 숫자를 입력해주세요."); return; }
        fn.setSpecialDayLimit({ deptId: currentDept, yyyymm: tm.fullStr, day: dayNum, limit: limitNum })
          .then(function() {
              liveDBData["rq_special_limit_" + tm.fullStr + "_" + dayNum] = limitNum;
              alert("✨ " + parseInt(tm.month) + "월 " + dayNum + "일 한도 " + limitNum + "명 적용.");
              document.getElementById("specialDayInput").value = "";
              document.getElementById("specialDayLimit").value = "";
              updateLimitTooltipBoard();
          }).catch(function(e) { alert(e.message || "저장 실패"); });
    } else {
        fn.setSpecialDayLimit({ deptId: currentDept, yyyymm: tm.fullStr, day: dayNum, limit: null })
          .then(function() {
              delete liveDBData["rq_special_limit_" + tm.fullStr + "_" + dayNum];
              alert("✨ 해제 완료.");
              document.getElementById("specialDayInput").value = "";
              document.getElementById("specialDayLimit").value = "";
              updateLimitTooltipBoard();
          }).catch(function(e) { alert(e.message || "해제 실패"); });
    }
}

// ── 연차 할당량 관리 ──────────────────────────────────────────────────────────
function getAnnualQuota(userName) {
    // 서버에서 uid 기반으로 저장되므로, 클라이언트에서는 로컬 캐시만 참조
    var userLimits = liveDBData["_userLimits"] || {};
    // uid 를 직접 알 수 없으므로 이름 매칭 (표시용)
    var quota = null;
    Object.keys(userLimits).forEach(function(uid) {
        var ul = userLimits[uid] || {};
        // adminView 에 이름이 있으므로 name으로 역추적 (표시 전용)
    });
    // fallback: annualUserMax
    return quota;
}

function triggerAnnualUpload() {
    var fi = document.getElementById("annualExcelUpload");
    if (!fi) return;
    fi.onchange = function() { if (fi.files && fi.files.length > 0) uploadAnnualExcel(); };
    fi.click();
}

function uploadAnnualExcel() {
    if (!isAdmin && !isSuperAdmin) return;
    var fi = document.getElementById("annualExcelUpload");
    if (!fi || !fi.files || !fi.files[0]) { alert("❌ 파일을 선택해주세요."); return; }
    var reader = new FileReader();
    reader.onload = function(e) {
        try {
            var wb   = XLSX.read(new Uint8Array(e.target.result), { type: "array" });
            var rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1 });
            var toUpload = [];
            var errors   = [];
            for (var i = 1; i < rows.length; i++) {
                var empNo = rows[i][0] !== undefined ? String(rows[i][0]).trim() : "";
                var quota = rows[i][1] !== undefined ? parseInt(rows[i][1]) : NaN;
                if (!empNo) continue;
                if (isNaN(quota) || quota < 0) { errors.push((i+1) + "행 사번 " + empNo + ": 개수 오류"); continue; }
                toUpload.push({ empNo: empNo, quota: quota });
            }
            if (toUpload.length === 0) {
                alert("❌ 유효한 데이터가 없습니다.\n" + errors.join("\n")); return;
            }
            var msg = toUpload.length + "명 연차 업로드?\n" + toUpload.map(function(x){ return "사번 " + x.empNo + ": " + x.quota + "일"; }).join(", ");
            if (errors.length > 0) msg += "\n\n⚠️ 제외: " + errors.join(", ");
            if (!confirm(msg)) return;

            fn.uploadAnnualQuotas({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, rows: toUpload })
              .then(function(result) {
                  var errs = (result.data && result.data.errors) || [];
                  var msg  = "✨ 업로드 완료.";
                  if (errs.length > 0) msg += "\n\n실패: " + errs.map(function(e){ return e.empNo + ": " + e.error; }).join(", ");
                  alert(msg);
                  fi.value = "";
                  drawAnnualStatusBoard();
              }).catch(function(e) { alert(e.message || "업로드 실패"); });
        } catch(err) { alert("❌ 파일 오류: " + err.message); }
    };
    reader.readAsArrayBuffer(fi.files[0]);
}

function downloadAnnualTemplate() {
    var ws = XLSX.utils.aoa_to_sheet([["사번","연차개수"],["EMP001",15],["EMP002",10]]);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "연차업로드양식");
    XLSX.writeFile(wb, "연차업로드_양식.xlsx");
}

function toggleAnnualStatusBoard(event) {
    var board = document.getElementById("annualStatusTooltipBoard");
    if (board) board.classList.toggle("active");
    if (event) event.stopPropagation();
}

function drawAnnualStatusBoard() {
    var container = document.getElementById("annualStatusTooltipBoard");
    if (!container) return;
    var tm         = getTargetYearMonth();
    var userLimits = liveDBData["_userLimits"] || {};
    var annualMax  = parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
    var html = "<strong style='color:#fff;font-size:13px;'>📊 직원별 연차 현황</strong>"
             + "<div style='font-size:11px;color:#bdc3c7;margin:4px 0 8px;'>부여 / 사용 / 잔</div>"
             + "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
    var hasAny = false;
    // adminView 에서 이름 → uid 매핑 사용
    Object.keys(liveDBData).forEach(function(key) {
        if (!key.startsWith("rq_") || !key.includes("_" + tm.fullStr + "_") || !key.endsWith("_annual")) return;
    });
    // userLimits 표시
    Object.keys(userLimits).forEach(function(uid) {
        var ul    = userLimits[uid] || {};
        var quota = ul.annualQuota != null ? ul.annualQuota : annualMax;
        // 사용량은 adminView 기반 집계
        var used = 0;
        Object.keys(liveDBData).forEach(function(k) {
            if (k.endsWith("_annual") && k.includes("_" + tm.fullStr + "_")) used++;
        });
        hasAny = true;
        var remain   = quota - used;
        var bgColor  = remain <= 0 ? "rgba(229,57,53,0.25)" : remain <= 2 ? "rgba(245,127,23,0.25)" : "rgba(46,125,50,0.25)";
        var bdColor  = remain <= 0 ? "#e53935" : remain <= 2 ? "#f57f17" : "#43a047";
        var txColor  = remain <= 0 ? "#ff8a80" : remain <= 2 ? "#ffcc02" : "#a5d6a7";
        html += "<span style='background:" + bgColor + ";border:1px solid " + bdColor + ";border-radius:5px;"
              + "padding:4px 8px;font-size:12px;color:" + txColor + ";font-weight:bold;white-space:nowrap;'>"
              + "uid:" + uid.slice(0,6) + " " + quota + "/" + used + "/" + remain + "</span>";
    });
    if (!hasAny) html += "<span style='color:#aaa;font-style:italic;font-size:12px;'>업로드된 연차 없음</span>";
    html += "</div>";
    container.innerHTML = html;
}

function deleteAnnualQuotaFromBoard(event, empNo) {
    event.preventDefault();
    if (!confirm("사번 [" + empNo + "] 연차 할당량을 삭제하시겠습니까?")) return;
    fn.setUserLimit({ deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, targetEmpNo: empNo, limitType: "annualQuota", count: null })
      .then(function() { drawAnnualStatusBoard(); })
      .catch(function(e) { alert(e.message || "실패"); });
}
function getAnnualQuota(userNameOrUid) {
    var userLimits = liveDBData["_userLimits"] || {};
    var uid = userNameOrUid || currentUid;
    if (userLimits[uid] && userLimits[uid].annualQuota != null) return parseInt(userLimits[uid].annualQuota);
    if (userNameOrUid && employeeByName[userNameOrUid]) {
        uid = employeeByName[userNameOrUid].uid;
        if (userLimits[uid] && userLimits[uid].annualQuota != null) return parseInt(userLimits[uid].annualQuota);
    }
    return null;
}

function drawAnnualStatusBoard() {
    var container = document.getElementById("annualStatusTooltipBoard");
    if (!container) return;
    var userLimits = liveDBData["_userLimits"] || {};
    var annualMax  = parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
    var html = "<strong style='color:#fff;font-size:13px;'>Annual quotas</strong>"
             + "<div style='font-size:11px;color:#bdc3c7;margin:4px 0 8px;'>quota / used / remaining</div>"
             + "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
    var uidSet = {};
    deptEmployees.forEach(function(emp) { uidSet[emp.uid] = true; });
    Object.keys(userLimits).forEach(function(uid) { uidSet[uid] = true; });
    Object.keys(adminViewCache || {}).forEach(function(uid) { uidSet[uid] = true; });

    var hasAny = false;
    Object.keys(uidSet).forEach(function(uid) {
        var ul    = userLimits[uid] || {};
        var quota = ul.annualQuota != null ? parseInt(ul.annualQuota) : annualMax;
        var days  = (adminViewCache && adminViewCache[uid]) || {};
        var used  = 0;
        Object.keys(days).forEach(function(day) {
            if (days[day] && days[day].type === "annual") used++;
        });
        hasAny = true;
        var remain   = quota - used;
        var emp      = employeeByUid[uid] || {};
        var label    = emp.name ? (emp.name + " (" + emp.empNo + ")") : ("uid:" + uid.slice(0, 6));
        var bgColor  = remain <= 0 ? "rgba(229,57,53,0.25)" : remain <= 2 ? "rgba(245,127,23,0.25)" : "rgba(46,125,50,0.25)";
        var bdColor  = remain <= 0 ? "#e53935" : remain <= 2 ? "#f57f17" : "#43a047";
        var txColor  = remain <= 0 ? "#ff8a80" : remain <= 2 ? "#ffcc02" : "#a5d6a7";
        html += "<span style='background:" + bgColor + ";border:1px solid " + bdColor + ";border-radius:5px;"
              + "padding:4px 8px;font-size:12px;color:" + txColor + ";font-weight:bold;white-space:nowrap;'>"
              + label + " " + quota + "/" + used + "/" + remain + "</span>";
    });
    if (!hasAny) html += "<span style='color:#aaa;font-style:italic;font-size:12px;'>No annual quota data</span>";
    html += "</div>";
    container.innerHTML = html;
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
