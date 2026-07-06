/**
 * auto-schedule.js
 * Auto-schedule daily requirements editor and draft generator.
 *
 * Scope:
 * - Keep all persistence in departments/{deptId}/configs/{yyyymm}/dailyRequirements
 * - Do not change Functions, saveDeptConfig, or shared request system logic
 * - Draft generation is UI-only and never saves to Firebase
 */

var arMonthState = {
    yyyymm: "",
    activeCodes: [],
    dailyRequirements: {},
    monthlyHolidayTarget: null,
    dailyHolidayCaps: {}
};

var arSelectedDays = [];
var arPageReady = false;
var arGroupLetters = ["A", "B", "C", "D", "E"];
var arLastClickedDayKey = "";
var arDraftState = null;

function arInitYearMonthSelects() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
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

    if (typeof getTargetYearMonth === "function") {
        var tm = getTargetYearMonth();
        selY.value = tm.year;
        selM.value = tm.month;
    }
}

function arGetSelectedYyyymm() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
    if (!selY || !selM) return "";

    var y = String(selY.value || "").trim();
    var m = String(selM.value || "").trim().padStart(2, "0");
    if (!y || !m) return "";

    return y + m;
}

function arGetMonthMeta(yyyymm) {
    var year = parseInt(String(yyyymm).slice(0, 4), 10);
    var month = parseInt(String(yyyymm).slice(4, 6), 10);
    var firstDay = new Date(year, month - 1, 1);

    return {
        year: year,
        month: month,
        startDow: firstDay.getDay(),
        totalDays: new Date(year, month, 0).getDate()
    };
}

function arGetConfigValue(key, fallback) {
    if (typeof getFirebaseItem === "function") return getFirebaseItem(key, fallback);
    if (typeof liveDBData === "object" && liveDBData && liveDBData[key] != null) return liveDBData[key];
    return fallback;
}

function arCountMonthSundays(yyyymm) {
    var meta = arGetMonthMeta(yyyymm);
    var total = 0;

    for (var day = 1; day <= meta.totalDays; day++) {
        if (new Date(meta.year, meta.month - 1, day).getDay() === 0) total += 1;
    }

    return total;
}

function arGetGroupLettersToRender() {
    return arGroupLetters.slice();
}

function arNormalizeByCodeMap(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(codeName) {
        var count = parseInt(source[codeName], 10);
        if (Number.isFinite(count) && count > 0) next[codeName] = count;
    });
    return next;
}

function arNormalizeByGroupCodeMap(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(groupLetter) {
        var codeMap = source[groupLetter];
        if (!codeMap || typeof codeMap !== "object") return;

        var normalizedCodeMap = arNormalizeByCodeMap(codeMap);
        if (Object.keys(normalizedCodeMap).length > 0) {
            next[groupLetter] = normalizedCodeMap;
        }
    });
    return next;
}

function arNormalizeDayData(raw) {
    if (!raw || typeof raw !== "object") return null;

    var total = raw.totalRequired;
    if (total == null) total = raw.totalNeeded;
    var totalRequired = parseInt(total, 10);
    if (!Number.isFinite(totalRequired) || totalRequired < 1) totalRequired = null;

    var codeSource = raw.byCode;
    if (!codeSource || typeof codeSource !== "object") codeSource = raw.codes;
    var byCode = arNormalizeByCodeMap(codeSource);
    var byGroupCode = arNormalizeByGroupCodeMap(raw.byGroupCode);

    if (totalRequired === null && Object.keys(byCode).length === 0 && Object.keys(byGroupCode).length === 0) {
        return null;
    }

    return {
        totalRequired: totalRequired,
        byCode: byCode,
        byGroupCode: byGroupCode
    };
}

function arCloneGroupCodeMap(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(groupLetter) {
        next[groupLetter] = Object.assign({}, source[groupLetter]);
    });
    return next;
}

function arCloneDailyRequirements(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(dayKey) {
        var normalized = arNormalizeDayData(source[dayKey]);
        if (!normalized) return;

        next[String(parseInt(dayKey, 10))] = {
            totalRequired: normalized.totalRequired,
            byCode: Object.assign({}, normalized.byCode),
            byGroupCode: arCloneGroupCodeMap(normalized.byGroupCode)
        };
    });
    return next;
}

function arCloneDailyHolidayCaps(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(dayKey) {
        var count = parseInt(source[dayKey], 10);
        if (Number.isFinite(count) && count > 0) {
            next[String(parseInt(dayKey, 10))] = count;
        }
    });
    return next;
}

function arGetDefaultMonthlyHolidayTarget(yyyymm) {
    var configured = parseInt(arGetConfigValue("rq_config_global_user_max", ""), 10);
    if (Number.isFinite(configured) && configured > 0) return configured;
    return arCountMonthSundays(yyyymm || arMonthState.yyyymm || arGetSelectedYyyymm());
}

function arGetMonthlyHolidayTargetValue() {
    var val = parseInt(arMonthState.monthlyHolidayTarget, 10);
    if (Number.isFinite(val) && val > 0) return val;
    return arGetDefaultMonthlyHolidayTarget(arMonthState.yyyymm);
}

function arGetDailyHolidayCap(dayKey) {
    var raw = arMonthState.dailyHolidayCaps[String(dayKey)];
    var val = parseInt(raw, 10);
    return Number.isFinite(val) && val > 0 ? val : null;
}

function arGetActiveCodesFromConfig(cfg) {
    var list = Array.isArray((cfg || {}).scheduleCodes) ? cfg.scheduleCodes : [];
    return list.filter(function(item) {
        return item && item.name && item.active !== false;
    });
}

function arFetchConfig(yyyymm) {
    if (!currentDept) return Promise.reject(new Error("지점 정보가 없습니다."));

    return db.ref("departments/" + currentDept + "/configs/" + yyyymm).once("value").then(function(snap) {
        return snap.val() || {};
    });
}

function arSetStatus(message, tone) {
    var el = document.getElementById("arLoadStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = tone === "error" ? "#dc2626" : tone === "success" ? "#059669" : "";
}

function arSetDraftStatus(message, tone) {
    var el = document.getElementById("arDraftStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = tone === "error" ? "#dc2626" : tone === "success" ? "#059669" : "";
}

function arUpdateSelectionCountLabel() {
    var label = document.getElementById("arSelectionCount");
    if (!label) return;
    label.textContent = "선택일 " + arSelectedDays.length + "개";
}

function arSyncHolidayConfigInputs() {
    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    if (monthTargetEl) monthTargetEl.value = arGetMonthlyHolidayTargetValue() || "";

    var dayCapEl = document.getElementById("arDailyHolidayCap");
    if (!dayCapEl) return;
    if (!arSelectedDays.length) {
        dayCapEl.value = "";
        return;
    }

    var firstCap = arGetDailyHolidayCap(arSelectedDays[0]);
    var same = arSelectedDays.every(function(dayKey) {
        return arGetDailyHolidayCap(dayKey) === firstCap;
    });
    dayCapEl.value = same && firstCap != null ? String(firstCap) : "";
}

function arEnsureDetailPanel() {
    var existing = document.getElementById("arDayDetailPanel");
    if (existing) return existing;

    var calendar = document.getElementById("arCalendarGrid");
    if (!calendar || !calendar.parentNode) return null;

    var panel = document.createElement("div");
    panel.id = "arDayDetailPanel";
    panel.className = "ar-day-detail-panel";
    panel.innerHTML =
        "<div class='ar-day-detail-title'>날짜 상세</div>" +
        "<div class='ar-day-detail-body'>달력에서 날짜를 클릭하면 상세가 여기에 표시됩니다.</div>";

    calendar.parentNode.insertBefore(panel, calendar.nextSibling);
    return panel;
}

function arEnsureDraftPanel() {
    var existing = document.getElementById("arDraftPanel");
    if (existing) return existing;

    var detailPanel = arEnsureDetailPanel();
    if (!detailPanel || !detailPanel.parentNode) return null;

    var panel = document.createElement("div");
    panel.id = "arDraftPanel";
    panel.className = "ar-draft-panel";
    panel.innerHTML = ""
        + "<div class='ar-draft-header'>"
        + "  <div>"
        + "    <div class='ar-draft-title'>자동배정 초안</div>"
        + "    <div class='ar-draft-desc'>고정 신청값은 잠그고, 빈칸에만 자동배정 초안을 생성합니다. 저장은 하지 않습니다.</div>"
        + "  </div>"
        + "  <div class='ar-draft-actions'>"
        + "    <button type='button' class='btn btn-primary-sm' id='arDraftGenerateBtn'>자동 휴무 초안 생성</button>"
        + "    <button type='button' class='btn btn-secondary' id='arDraftResetBtn'>초안 초기화</button>"
        + "  </div>"
        + "</div>"
        + "<div class='ar-draft-status-row'>"
        + "  <span id='arDraftStatus'></span>"
        + "</div>"
        + "<div id='arDraftConfigSummary' class='ar-draft-config-summary'></div>"
        + "<div class='ar-draft-legend'>"
        + "  <span class='ar-legend-chip ar-legend-fixed-off'>고정 신청값</span>"
        + "  <span class='ar-legend-chip ar-legend-fixed-work'>고정 근무값</span>"
        + "  <span class='ar-legend-chip ar-legend-auto'>자동배정값</span>"
        + "</div>"
        + "<div id='arDraftDaySummary' class='ar-draft-day-summary'></div>"
        + "<div class='ar-draft-layout'>"
        + "  <div class='ar-draft-grid-wrap'>"
        + "    <div id='arDraftGrid' class='ar-draft-grid-empty'>초안을 생성하면 직원별/날짜별 그리드가 여기에 표시됩니다.</div>"
        + "  </div>"
        + "  <div class='ar-draft-warning-wrap'>"
        + "    <div class='ar-draft-warning-title'>경고</div>"
        + "    <div id='arDraftWarnings' class='ar-draft-warning-empty'>아직 경고가 없습니다.</div>"
        + "  </div>"
        + "</div>";

    detailPanel.parentNode.insertBefore(panel, detailPanel.nextSibling);
    return panel;
}

function arWireButtonsOnce() {
    var applyBtn = document.getElementById("arApplyBtn");
    var clearBtn = document.getElementById("arClearBtn");
    var deleteBtn = document.getElementById("arDeleteBtn");
    var saveBtn = document.getElementById("arSaveBtn");
    var applyAllDaysBtn = document.getElementById("arApplyAllDaysBtn");
    var draftGenerateTopBtn = document.getElementById("arDraftGenerateTopBtn");
    var draftGenerateBtn = document.getElementById("arDraftGenerateBtn");
    var draftResetBtn = document.getElementById("arDraftResetBtn");

    if (applyBtn && !applyBtn.dataset.arWired) {
        applyBtn.addEventListener("click", arApplyToSelectedDays);
        applyBtn.dataset.arWired = "1";
    }
    if (clearBtn && !clearBtn.dataset.arWired) {
        clearBtn.addEventListener("click", arClearSelection);
        clearBtn.dataset.arWired = "1";
    }
    if (deleteBtn && !deleteBtn.dataset.arWired) {
        deleteBtn.addEventListener("click", arDeleteSelectedDaySettings);
        deleteBtn.dataset.arWired = "1";
    }
    if (saveBtn && !saveBtn.dataset.arWired) {
        saveBtn.addEventListener("click", arSaveWholeMonth);
        saveBtn.dataset.arWired = "1";
    }
    if (applyAllDaysBtn && !applyAllDaysBtn.dataset.arWired) {
        applyAllDaysBtn.addEventListener("click", arApplyHolidayCapToAllDays);
        applyAllDaysBtn.dataset.arWired = "1";
    }
    if (draftGenerateTopBtn && !draftGenerateTopBtn.dataset.arWired) {
        draftGenerateTopBtn.addEventListener("click", function() {
            console.log("[auto-schedule:draft] button clicked");
            arGenerateDraft();
        });
        draftGenerateTopBtn.dataset.arWired = "1";
    }
    if (draftGenerateBtn && !draftGenerateBtn.dataset.arWired) {
        draftGenerateBtn.addEventListener("click", function() {
            console.log("[auto-schedule:draft] button clicked");
            arGenerateDraft();
        });
        draftGenerateBtn.dataset.arWired = "1";
    }
    if (draftResetBtn && !draftResetBtn.dataset.arWired) {
        draftResetBtn.addEventListener("click", arResetDraftState);
        draftResetBtn.dataset.arWired = "1";
    }
}

function arRenderRequirementTable() {
    var container = document.getElementById("arRequirementTable");
    if (!container) return;

    var totalEl = document.getElementById("arTotalRequired");
    if (totalEl) totalEl.value = "";
    if (totalEl && totalEl.closest(".form-row")) totalEl.closest(".form-row").style.display = "none";
    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    if (monthTargetEl) monthTargetEl.value = arGetMonthlyHolidayTargetValue() || "";
    var dayCapEl = document.getElementById("arDailyHolidayCap");
    if (dayCapEl) dayCapEl.value = "";

    var helpHtml = "<div style='font-size:12px; line-height:1.55; color:var(--text-sub); margin-bottom:10px;'>"
        + "필요인원 설정에는 <strong>근무코드 관리에서 사용중(active=true)인 코드만</strong> 표시됩니다.<br>"
        + "예를 들어 근무코드 관리에서 <strong>오전 / 오후 / 종일</strong>을 생성하고 사용중으로 두면, 이 표에도 각각 한 줄씩 나타납니다.<br>"
        + "화면 표시는 코드명(name)보다 <strong>표시명(displayName)</strong>을 우선 사용합니다.<br>"
        + "조별 최소 필요인원은 <strong>dailyRequirements/{day}/byGroupCode</strong>에 함께 저장됩니다."
        + "</div>";

    if (!arMonthState.activeCodes.length) {
        container.innerHTML = helpHtml
            + "<div style='color:#94a3b8;font-size:12px;line-height:1.5;padding:8px 0;'>"
            + "등록된 사용중 근무코드가 없습니다. 먼저 근무코드 관리에서 오전/오후/종일 같은 코드를 생성한 뒤 다시 확인해주세요."
            + "</div>";
        return;
    }

    var activeCodeNames = arMonthState.activeCodes.map(function(code) {
        return code.displayName || code.name;
    }).join(", ");
    var groupLetters = arGetGroupLettersToRender();
    var html = helpHtml
        + "<div style='font-size:11px; color:var(--text-light); margin-bottom:8px;'>현재 표시 중인 근무코드: " + activeCodeNames + "</div>"
        + "<table class='ar-req-table' style='width:100%; border-collapse:collapse; font-size:12px;'>";

    html += "<tr>"
        + "<th style='text-align:left; padding:4px 6px; border-bottom:1px solid var(--border);'>근무코드</th>"
        + "<th style='text-align:center; padding:4px 6px; border-bottom:1px solid var(--border);'>전체</th>";

    groupLetters.forEach(function(groupLetter) {
        html += "<th style='text-align:center; padding:4px 6px; border-bottom:1px solid var(--border);'>" + groupLetter + "조</th>";
    });
    html += "</tr>";

    arMonthState.activeCodes.forEach(function(code) {
        var label = code.displayName || code.name;
        html += "<tr>";
        html += "<td style='padding:4px 6px;'>" + label + "</td>";
        html += "<td style='padding:4px 6px; text-align:center;'><input type='number' min='0' class='form-input small small-num-input ar-code-input' data-code='" + code.name + "' value='' style='width:56px; text-align:center;'></td>";
        groupLetters.forEach(function(groupLetter) {
            html += "<td style='padding:4px 6px; text-align:center;'><input type='number' min='0' class='form-input small small-num-input ar-group-input' data-code='" + code.name + "' data-group='" + groupLetter + "' value='' style='width:56px; text-align:center;'></td>";
        });
        html += "</tr>";
    });

    html += "</table>";
    container.innerHTML = html;
}

function arGetCodeLabel(codeName) {
    var match = arMonthState.activeCodes.find(function(item) {
        return item.name === codeName;
    });
    return match ? (match.displayName || match.name) : codeName;
}

function arGetCodeSummaryLine(dayData, codeName) {
    var codeCount = parseInt((dayData.byCode || {})[codeName], 10);
    if (!Number.isFinite(codeCount) || codeCount <= 0) return "";
    return arGetCodeLabel(codeName) + " " + codeCount;
}

function arGetCompactSummaryHtml(dayData) {
    if (!dayData) return "<span class='ar-day-empty-text'>미설정</span>";

    var lines = [];
    var codeParts = [];

    if (dayData.totalRequired != null) {
        lines.push("<span class='ar-day-total'>총 " + dayData.totalRequired + "명</span>");
    }

    Object.keys(dayData.byCode || {}).forEach(function(codeName) {
        var line = arGetCodeSummaryLine(dayData, codeName);
        if (line) codeParts.push(line);
    });

    if (codeParts.length > 0) {
        lines.push("<span class='ar-day-codes'>" + codeParts.join(" / ") + "</span>");
    }

    return lines.join("<br>");
}

function arGetDraftDayBadge(dayKey) {
    if (!arDraftState || !arDraftState.daySummaries || !arDraftState.daySummaries[dayKey]) return "";

    var summary = arDraftState.daySummaries[dayKey];
    if (summary.totalMissing > 0) {
        return "<div class='ar-draft-cell-badge ar-draft-cell-badge-short'>부족 " + summary.totalMissing + "</div>";
    }
    if (summary.warningCount > 0) {
        return "<div class='ar-draft-cell-badge ar-draft-cell-badge-warn'>경고 " + summary.warningCount + "</div>";
    }
    return "<div class='ar-draft-cell-badge ar-draft-cell-badge-ok'>충족</div>";
}

function arRenderCalendarGrid() {
    var container = document.getElementById("arCalendarGrid");
    if (!container || !arMonthState.yyyymm) return;

    var meta = arGetMonthMeta(arMonthState.yyyymm);
    container.innerHTML = "";

    var fragment = document.createDocumentFragment();
    var weekHeaders = [
        { txt: "일", cls: "days sun" },
        { txt: "월", cls: "days" },
        { txt: "화", cls: "days" },
        { txt: "수", cls: "days" },
        { txt: "목", cls: "days" },
        { txt: "금", cls: "days" },
        { txt: "토", cls: "days sat" }
    ];

    weekHeaders.forEach(function(item) {
        var hDiv = document.createElement("div");
        hDiv.className = item.cls;
        hDiv.innerText = item.txt;
        fragment.appendChild(hDiv);
    });

    for (var empty = 0; empty < meta.startDow; empty++) {
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty";
        fragment.appendChild(emptyDiv);
    }

    for (var day = 1; day <= meta.totalDays; day++) {
        var dow = new Date(meta.year, meta.month - 1, day).getDay();
        var dayKey = String(day);
        var dayData = arMonthState.dailyRequirements[dayKey];
        var isSelected = arSelectedDays.indexOf(dayKey) >= 0;
        var isDetailDay = arLastClickedDayKey === dayKey;

        var dateDiv = document.createElement("div");
        var className = "date";
        if (dow === 0) className += " sun";
        if (dow === 6) className += " sat";
        if (isSelected) className += " ar-selected";
        if (dayData) className += " ar-has-data";
        if (isDetailDay) className += " ar-detail-active";
        if (arDraftState && arDraftState.daySummaries && arDraftState.daySummaries[dayKey]) {
            var draftSummary = arDraftState.daySummaries[dayKey];
            if (draftSummary.totalMissing > 0) className += " ar-draft-shortage";
            else if (draftSummary.warningCount > 0) className += " ar-draft-warning";
            else className += " ar-draft-ok";
        }
        dateDiv.className = className;
        dateDiv.id = "ar-d-" + day;

        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = String(day);
        dateDiv.appendChild(numDiv);

        var summaryDiv = document.createElement("div");
        summaryDiv.className = "count-badge ar-day-summary";
        summaryDiv.innerHTML = arGetCompactSummaryHtml(dayData) + arGetDraftDayBadge(dayKey);
        dateDiv.appendChild(summaryDiv);

        (function(boundDayKey) {
            dateDiv.onclick = function() {
                arHandleDayClick(boundDayKey);
            };
        })(dayKey);

        fragment.appendChild(dateDiv);
    }

    container.appendChild(fragment);
}

function arHandleDayClick(dayKey) {
    arToggleDaySelect(dayKey);
    arLastClickedDayKey = String(dayKey);
    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
}

function arToggleDaySelect(day) {
    var dayKey = String(day);
    var idx = arSelectedDays.indexOf(dayKey);
    if (idx >= 0) arSelectedDays.splice(idx, 1);
    else arSelectedDays.push(dayKey);
    arUpdateSelectionCountLabel();
    arSyncHolidayConfigInputs();
}

function arClearSelection() {
    arSelectedDays = [];
    arRenderCalendarGrid();
    arUpdateSelectionCountLabel();
    arSyncHolidayConfigInputs();
    arSetStatus("선택한 날짜를 해제했습니다.", "success");
}

function arDeleteSelectedDaySettings() {
    if (!isAdmin && !isSuperAdmin) return;
    if (arSelectedDays.length === 0) {
        alert("먼저 날짜를 선택해주세요.");
        arSetStatus("선택된 날짜가 없습니다.", "error");
        return;
    }

    var selectedCount = arSelectedDays.length;
    if (!confirm("선택한 " + selectedCount + "개 날짜의 필요인원 설정을 삭제할까요?")) return;

    arSelectedDays.forEach(function(dayKey) {
        delete arMonthState.dailyRequirements[dayKey];
        delete arMonthState.dailyHolidayCaps[dayKey];
    });

    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
    arSyncHolidayConfigInputs();
    arSetStatus("선택한 날짜 설정을 삭제했습니다. 저장해야 최종 반영됩니다.", "success");
}

function arCollectDayDataFromForm() {
    var totalEl = document.getElementById("arTotalRequired");
    var totalRaw = totalEl ? String(totalEl.value || "").trim() : "";

    if (!totalRaw) {
        alert("전체 필요인원을 입력해주세요.");
        arSetStatus("전체 필요인원을 입력해야 적용할 수 있습니다.", "error");
        return null;
    }

    var totalRequired = parseInt(totalRaw, 10);
    if (!Number.isFinite(totalRequired) || totalRequired < 1) {
        alert("전체 필요인원은 1명 이상이어야 합니다.");
        arSetStatus("전체 필요인원은 1명 이상이어야 합니다.", "error");
        return null;
    }

    var byCode = {};
    document.querySelectorAll(".ar-code-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (Number.isFinite(count) && count > 0) byCode[code] = count;
    });

    var byGroupCode = {};
    document.querySelectorAll(".ar-group-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var groupLetter = input.getAttribute("data-group");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (!Number.isFinite(count) || count <= 0) return;

        if (!byGroupCode[groupLetter]) byGroupCode[groupLetter] = {};
        byGroupCode[groupLetter][code] = count;
    });

    return {
        totalRequired: totalRequired,
        byCode: byCode,
        byGroupCode: byGroupCode
    };
}

function arCollectDayDataFromForm() {
    var totalEl = document.getElementById("arTotalRequired");
    var totalRaw = totalEl ? String(totalEl.value || "").trim() : "";
    var dailyCapEl = document.getElementById("arDailyHolidayCap");
    var dailyCapRaw = dailyCapEl ? String(dailyCapEl.value || "").trim() : "";
    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    var monthTargetRaw = monthTargetEl ? String(monthTargetEl.value || "").trim() : "";

    var totalRequired = null;
    if (totalRaw) {
        totalRequired = parseInt(totalRaw, 10);
        if (!Number.isFinite(totalRequired) || totalRequired < 1) {
            alert("전체 필요인원은 1명 이상이어야 합니다.");
            arSetStatus("전체 필요인원을 확인해주세요.", "error");
            return null;
        }
    }

    var monthTarget = null;
    if (monthTargetRaw) {
        monthTarget = parseInt(monthTargetRaw, 10);
        if (!Number.isFinite(monthTarget) || monthTarget < 1) {
            alert("월 목표 휴무 개수는 1 이상이어야 합니다.");
            arSetStatus("월 목표 휴무 개수를 확인해주세요.", "error");
            return null;
        }
    }

    var dailyHolidayCap = null;
    if (dailyCapRaw) {
        dailyHolidayCap = parseInt(dailyCapRaw, 10);
        if (!Number.isFinite(dailyHolidayCap) || dailyHolidayCap < 1) {
            alert("일별 최대 휴무 개수는 1 이상이어야 합니다.");
            arSetStatus("일별 최대 휴무 개수를 확인해주세요.", "error");
            return null;
        }
    }

    var byCode = {};
    document.querySelectorAll(".ar-code-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (Number.isFinite(count) && count > 0) byCode[code] = count;
    });

    var byGroupCode = {};
    document.querySelectorAll(".ar-group-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var groupLetter = input.getAttribute("data-group");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (!Number.isFinite(count) || count <= 0) return;

        if (!byGroupCode[groupLetter]) byGroupCode[groupLetter] = {};
        byGroupCode[groupLetter][code] = count;
    });

    var hasRequirementInputs = totalRequired != null || Object.keys(byCode).length > 0 || Object.keys(byGroupCode).length > 0;
    if (!hasRequirementInputs && dailyHolidayCap == null && monthTarget == null) {
        alert("필요인원 또는 휴무 설정값을 입력해주세요.");
        arSetStatus("적용할 값이 없습니다.", "error");
        return null;
    }
    if (hasRequirementInputs && totalRequired == null) {
        alert("필요인원을 적용하려면 전체 필요인원을 입력해주세요.");
        arSetStatus("전체 필요인원이 있어야 필요인원 설정을 적용할 수 있습니다.", "error");
        return null;
    }

    return {
        monthlyHolidayTarget: monthTarget,
        dailyHolidayCap: dailyHolidayCap,
        requirementData: hasRequirementInputs ? {
            totalRequired: totalRequired,
            byCode: byCode,
            byGroupCode: byGroupCode
        } : null
    };
}

function arApplyToSelectedDays() {
    if (!isAdmin && !isSuperAdmin) return;
    if (arSelectedDays.length === 0) {
        alert("먼저 날짜를 선택해주세요.");
        arSetStatus("선택된 날짜가 없습니다.", "error");
        return;
    }

    var newDayData = arCollectDayDataFromForm();
    if (!newDayData) return;

    if (newDayData.monthlyHolidayTarget != null) {
        arMonthState.monthlyHolidayTarget = newDayData.monthlyHolidayTarget;
    }

    arSelectedDays.forEach(function(dayKey) {
        if (newDayData.requirementData) {
            arMonthState.dailyRequirements[dayKey] = {
                totalRequired: newDayData.requirementData.totalRequired,
                byCode: Object.assign({}, newDayData.requirementData.byCode),
                byGroupCode: arCloneGroupCodeMap(newDayData.requirementData.byGroupCode)
            };
        }
        if (newDayData.dailyHolidayCap != null) {
            arMonthState.dailyHolidayCaps[dayKey] = newDayData.dailyHolidayCap;
        }
    });

    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
    arSyncHolidayConfigInputs();
    arSetStatus(arSelectedDays.length + "개 날짜에 적용했습니다. 달력에서 바로 확인한 뒤 저장해주세요.", "success");
}

function arCollectDayDataFromForm() {
    var dailyCapEl = document.getElementById("arDailyHolidayCap");
    var dailyCapRaw = dailyCapEl ? String(dailyCapEl.value || "").trim() : "";
    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    var monthTargetRaw = monthTargetEl ? String(monthTargetEl.value || "").trim() : "";

    var monthTarget = null;
    if (monthTargetRaw) {
        monthTarget = parseInt(monthTargetRaw, 10);
        if (!Number.isFinite(monthTarget) || monthTarget < 1) {
            alert("월 목표 휴무 개수는 1 이상이어야 합니다.");
            arSetStatus("월 목표 휴무 개수를 확인해주세요.", "error");
            return null;
        }
    }

    var dailyHolidayCap = null;
    if (dailyCapRaw) {
        dailyHolidayCap = parseInt(dailyCapRaw, 10);
        if (!Number.isFinite(dailyHolidayCap) || dailyHolidayCap < 1) {
            alert("일별 최대 휴무 개수는 1 이상이어야 합니다.");
            arSetStatus("일별 최대 휴무 개수를 확인해주세요.", "error");
            return null;
        }
    }

    var byCode = {};
    document.querySelectorAll(".ar-code-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (Number.isFinite(count) && count > 0) byCode[code] = count;
    });

    var byGroupCode = {};
    document.querySelectorAll(".ar-group-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        var groupLetter = input.getAttribute("data-group");
        var raw = String(input.value || "").trim();
        if (!raw) return;

        var count = parseInt(raw, 10);
        if (!Number.isFinite(count) || count <= 0) return;

        if (!byGroupCode[groupLetter]) byGroupCode[groupLetter] = {};
        byGroupCode[groupLetter][code] = count;
    });

    var hasRequirementInputs = Object.keys(byCode).length > 0 || Object.keys(byGroupCode).length > 0;
    if (!hasRequirementInputs && dailyHolidayCap == null && monthTarget == null) {
        alert("휴무 설정값 또는 조별 최소 근무 인원을 입력해주세요.");
        arSetStatus("적용할 값이 없습니다.", "error");
        return null;
    }

    return {
        monthlyHolidayTarget: monthTarget,
        dailyHolidayCap: dailyHolidayCap,
        requirementData: hasRequirementInputs ? {
            totalRequired: null,
            byCode: byCode,
            byGroupCode: byGroupCode
        } : null
    };
}

function arApplyToSelectedDays() {
    if (!isAdmin && !isSuperAdmin) return;
    if (arSelectedDays.length === 0) {
        alert("먼저 날짜를 선택해주세요.");
        arSetStatus("선택된 날짜가 없습니다.", "error");
        return;
    }

    var newDayData = arCollectDayDataFromForm();
    if (!newDayData) return;

    if (newDayData.monthlyHolidayTarget != null) {
        arMonthState.monthlyHolidayTarget = newDayData.monthlyHolidayTarget;
    }

    arSelectedDays.forEach(function(dayKey) {
        if (newDayData.requirementData) {
            arMonthState.dailyRequirements[dayKey] = {
                totalRequired: null,
                byCode: Object.assign({}, newDayData.requirementData.byCode),
                byGroupCode: arCloneGroupCodeMap(newDayData.requirementData.byGroupCode)
            };
        }
        if (newDayData.dailyHolidayCap != null) {
            arMonthState.dailyHolidayCaps[String(dayKey)] = newDayData.dailyHolidayCap;
        }
    });

    console.log("[auto-schedule:draft] daily holiday caps after selected apply:", Object.assign({}, arMonthState.dailyHolidayCaps || {}));
    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
    arSyncHolidayConfigInputs();
    arSetStatus(arSelectedDays.length + "개 날짜에 적용했습니다. 달력과 상세에서 최대 휴무 개수를 확인해주세요.", "success");
}

function arApplyHolidayCapToAllDays() {
    if (!isAdmin && !isSuperAdmin) return;
    if (!arMonthState.yyyymm) return;

    var dayCapEl = document.getElementById("arDailyHolidayCap");
    var raw = dayCapEl ? String(dayCapEl.value || "").trim() : "";
    if (!raw) {
        alert("먼저 일별 최대 휴무 개수를 입력해주세요.");
        arSetStatus("일별 최대 휴무 개수를 입력해주세요.", "error");
        return;
    }

    var cap = parseInt(raw, 10);
    if (!Number.isFinite(cap) || cap < 1) {
        alert("일별 최대 휴무 개수는 1 이상이어야 합니다.");
        arSetStatus("일별 최대 휴무 개수를 확인해주세요.", "error");
        return;
    }

    var meta = arGetMonthMeta(arMonthState.yyyymm);
    for (var day = 1; day <= meta.totalDays; day++) {
        arMonthState.dailyHolidayCaps[String(day)] = cap;
    }

    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    if (monthTargetEl) {
        var monthTargetRaw = String(monthTargetEl.value || "").trim();
        if (monthTargetRaw) {
            var monthTarget = parseInt(monthTargetRaw, 10);
            if (Number.isFinite(monthTarget) && monthTarget > 0) {
                arMonthState.monthlyHolidayTarget = monthTarget;
            }
        }
    }

    console.log("[auto-schedule:draft] daily holiday caps after all-days apply:", Object.assign({}, arMonthState.dailyHolidayCaps || {}));
    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
    arSyncHolidayConfigInputs();
    arSetStatus("이번 달 전체 날짜에 최대 휴무 " + cap + "명을 적용했습니다.", "success");
}

function arSaveWholeMonth() {
    if (!isAdmin && !isSuperAdmin) return;
    if (!arMonthState.yyyymm) {
        alert("먼저 월을 선택해주세요.");
        return;
    }

    var payload = arCloneDailyRequirements(arMonthState.dailyRequirements);
    var saveBtn = document.getElementById("arSaveBtn");
    if (saveBtn) {
        saveBtn.disabled = true;
        saveBtn.textContent = "저장 중...";
    }

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: arMonthState.yyyymm,
        config: { dailyRequirements: payload }
    }).then(function() {
        arMonthState.dailyRequirements = payload;
        arSetStatus("저장이 완료되었습니다. dailyRequirements에 반영되었습니다.", "success");
        alert("이 월 전체 저장이 완료되었습니다.");
    }).catch(function(e) {
        console.error("[auto-schedule] save failed:", e);
        arSetStatus("저장에 실패했습니다.", "error");
        alert((e && e.message) || "저장 실패");
    }).finally(function() {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.textContent = "이 월 전체 저장";
        }
    });
}

function arGetVisibleDraftEmployees() {
    var list = typeof _getVisibleDeptEmployees === "function" ? _getVisibleDeptEmployees() : (Array.isArray(deptEmployees) ? deptEmployees : []);
    return list.filter(function(emp) {
        return !!(emp && emp.uid);
    });
}

function arBuildDraftGroupMap(employees) {
    var tokenToGroup = {};
    var uidToGroup = {};
    var empNoToGroup = {};

    arGetGroupLettersToRender().forEach(function(groupLetter) {
        var list = liveDBData["rq_live_group_" + groupLetter];
        if (!Array.isArray(list)) {
            try { list = JSON.parse(list || "[]"); } catch (e) { list = []; }
        }

        (list || []).forEach(function(token) {
            var raw = String(token || "").trim();
            if (!raw) return;
            tokenToGroup[raw] = groupLetter;
            tokenToGroup[raw.toLowerCase()] = groupLetter;
        });
    });

    employees.forEach(function(emp) {
        var uidKey = String(emp.uid || "").trim();
        var empNoKey = String(emp.empNo || "").trim();
        var group = tokenToGroup[uidKey] || tokenToGroup[uidKey.toLowerCase()] || tokenToGroup[empNoKey] || tokenToGroup[empNoKey.toLowerCase()] || "POOL";
        uidToGroup[uidKey] = group;
        if (empNoKey) empNoToGroup[empNoKey.toLowerCase()] = group;
    });

    return {
        uidToGroup: uidToGroup,
        empNoToGroup: empNoToGroup
    };
}

function arBuildDraftEmployees() {
    var employees = arGetVisibleDraftEmployees();
    var groupMap = arBuildDraftGroupMap(employees);

    return employees.map(function(emp) {
        var uidKey = String(emp.uid || "").trim();
        var empNoKey = String(emp.empNo || "").trim().toLowerCase();
        return {
            uid: uidKey,
            empNo: String(emp.empNo || ""),
            name: String(emp.name || emp.legacyName || uidKey),
            group: groupMap.uidToGroup[uidKey] || groupMap.empNoToGroup[empNoKey] || "POOL"
        };
    });
}

function arGetRequestLabelByType(type, scheduleCode) {
    if (type === "normal") return "휴무";
    if (type === "petition") return "청원";
    if (type === "annual") return "연차";
    if (type === "schedule") return arGetCodeLabel(scheduleCode);
    return type || "-";
}

function arIsOffEntry(entry) {
    return !!(entry && (entry.valueType === "normal" || entry.valueType === "petition" || entry.valueType === "annual"));
}

function arBuildHolidayPolicy(yyyymm, employees) {
    var sundayCount = arCountMonthSundays(yyyymm);
    var configuredGlobalTarget = parseInt(arGetConfigValue("rq_config_global_user_max", ""), 10);
    var monthTarget = arGetMonthlyHolidayTargetValue();
    var defaultTarget = Number.isFinite(monthTarget) && monthTarget > 0 ? monthTarget
        : (Number.isFinite(configuredGlobalTarget) && configuredGlobalTarget > 0 ? configuredGlobalTarget : sundayCount);
    var targetsByUid = {};

    employees.forEach(function(employee) {
        var customRaw = null;
        if (typeof liveDBData === "object" && liveDBData) {
            if (employee.uid && liveDBData["rq_limit_uid_" + employee.uid] != null) {
                customRaw = liveDBData["rq_limit_uid_" + employee.uid];
            } else if (employee.empNo) {
                var empNoKey = String(employee.empNo || "").trim().toLowerCase();
                if (liveDBData["rq_limit_emp_" + empNoKey] != null) customRaw = liveDBData["rq_limit_emp_" + empNoKey];
            }
        }

        var customTarget = parseInt(customRaw, 10);
        targetsByUid[employee.uid] = Number.isFinite(customTarget) && customTarget > 0 ? customTarget : defaultTarget;
    });

    return {
        sundayCount: sundayCount,
        monthInputTarget: Number.isFinite(monthTarget) && monthTarget > 0 ? monthTarget : null,
        configuredGlobalTarget: Number.isFinite(configuredGlobalTarget) && configuredGlobalTarget > 0 ? configuredGlobalTarget : null,
        defaultTarget: defaultTarget,
        targetsByUid: targetsByUid
    };
}

function arBuildFixedAssignments(yyyymm, employees) {
    var byDay = {};
    var byUser = {};
    var employeeUidSet = {};

    employees.forEach(function(emp) {
        employeeUidSet[emp.uid] = true;
        byUser[emp.uid] = {};
    });

    Object.keys(adminViewCache || {}).forEach(function(uid) {
        if (!employeeUidSet[uid]) return;

        var days = adminViewCache[uid] || {};
        Object.keys(days).forEach(function(dayKey) {
            var req = days[dayKey];
            if (!req || !req.type) return;

            var normalizedDayKey = String(parseInt(dayKey, 10));
            if (!byDay[normalizedDayKey]) byDay[normalizedDayKey] = {};

            var entry = {
                type: "fixed",
                valueType: req.type,
                code: req.type === "schedule" ? String(req.scheduleCode || "") : "",
                label: arGetRequestLabelByType(req.type, req.scheduleCode),
                source: req.type === "schedule" ? "fixed_work" : "fixed_request"
            };

            byDay[normalizedDayKey][uid] = entry;
            byUser[uid][normalizedDayKey] = entry;
        });
    });

    return {
        byDay: byDay,
        byUser: byUser
    };
}

function arCreateDraftState(yyyymm, employees, fixedAssignments) {
    var employeesByUid = {};
    var groupSizeMap = {};
    employees.forEach(function(emp) {
        employeesByUid[emp.uid] = emp;
        var groupLetter = emp.group || "POOL";
        groupSizeMap[groupLetter] = (groupSizeMap[groupLetter] || 0) + 1;
    });

    return {
        yyyymm: yyyymm,
        generatedAt: Date.now(),
        employees: employees,
        employeesByUid: employeesByUid,
        groupSizeMap: groupSizeMap,
        assignmentsByDay: fixedAssignments.byDay || {},
        assignmentsByUser: fixedAssignments.byUser || {},
        coverageByDay: {},
        daySummaries: {},
        holidayPolicy: arBuildHolidayPolicy(yyyymm, employees),
        holidaySummaryByUid: {},
        warnings: [],
        warningsByDay: {}
    };
}

function arEnsureDraftContainers(draftState, uid, dayKey) {
    if (!draftState.assignmentsByDay[dayKey]) draftState.assignmentsByDay[dayKey] = {};
    if (!draftState.assignmentsByUser[uid]) draftState.assignmentsByUser[uid] = {};
}

function arSetDraftAssignment(draftState, uid, dayKey, entry) {
    arEnsureDraftContainers(draftState, uid, dayKey);
    draftState.assignmentsByDay[dayKey][uid] = entry;
    draftState.assignmentsByUser[uid][dayKey] = entry;
}

function arGetDraftAssignment(draftState, uid, dayKey) {
    var userMap = draftState.assignmentsByUser[uid] || {};
    return userMap[dayKey] || null;
}

function arIsWorkEntry(entry) {
    return !!(entry && (entry.valueType === "schedule" || entry.valueType === "scheduleCode"));
}

function arGetEntryCode(entry) {
    return entry && entry.code ? entry.code : "";
}

function arCountAssignedOffDays(draftState, uid, mode) {
    var total = 0;

    Object.keys(draftState.assignmentsByUser[uid] || {}).forEach(function(dayKey) {
        var entry = draftState.assignmentsByUser[uid][dayKey];
        if (!arIsOffEntry(entry)) return;
        if (mode === "fixed" && entry.type !== "fixed") return;
        if (mode === "auto" && entry.source !== "auto_off") return;
        total += 1;
    });

    return total;
}

function arCountDayOffEntries(draftState, dayKey) {
    var total = 0;
    Object.keys(draftState.assignmentsByDay[dayKey] || {}).forEach(function(uid) {
        if (arIsOffEntry(draftState.assignmentsByDay[dayKey][uid])) total += 1;
    });
    return total;
}

function arGetRequiredWorkCount(requirement) {
    var byCodeTotal = 0;
    Object.keys((requirement || {}).byCode || {}).forEach(function(codeName) {
        byCodeTotal += parseInt(requirement.byCode[codeName], 10) || 0;
    });

    var totalRequired = parseInt((requirement || {}).totalRequired, 10);
    if (!Number.isFinite(totalRequired) || totalRequired < 0) totalRequired = 0;
    return Math.max(totalRequired, byCodeTotal);
}

function arCountDayAssignedEntries(draftState, dayKey) {
    return Object.keys(draftState.assignmentsByDay[dayKey] || {}).length;
}

function arCountDayAssignedEntriesForGroup(draftState, dayKey, groupLetter) {
    var total = 0;

    Object.keys(draftState.assignmentsByDay[dayKey] || {}).forEach(function(uid) {
        var employee = draftState.employeesByUid[uid] || {};
        if ((employee.group || "POOL") === groupLetter) total += 1;
    });

    return total;
}

function arGetRemainingGroupNeed(draftState, dayKey, groupLetter) {
    var requirement = (arMonthState.dailyRequirements || {})[dayKey];
    if (!requirement) return 0;

    var coverage = arCountDayCoverage(draftState, dayKey);
    var total = 0;

    Object.keys((requirement.byGroupCode || {})[groupLetter] || {}).forEach(function(codeName) {
        var target = parseInt(requirement.byGroupCode[groupLetter][codeName], 10) || 0;
        var filled = parseInt((((coverage.byGroupCodeFilled[groupLetter] || {})[codeName]) || 0), 10) || 0;
        if (filled < target) total += (target - filled);
    });

    return total;
}

function arEvaluateAutoOffDay(draftState, employee, dayKey) {
    if (arGetDraftAssignment(draftState, employee.uid, dayKey)) {
        return {
            allowed: false,
            reason: "fixed_exists",
            dayKey: dayKey
        };
    }

    var dayCap = arGetDailyHolidayCap(dayKey);
    if (dayCap != null) {
        var currentOffCount = arCountDayOffEntries(draftState, dayKey);
        if (currentOffCount >= dayCap) {
            return {
                allowed: false,
                reason: "day_off_limit",
                dayKey: dayKey,
                dailyHolidayCap: dayCap,
                currentOffCount: currentOffCount
            };
        }
    }

    var requirement = (arMonthState.dailyRequirements || {})[dayKey];
    if (!requirement) {
        return {
            allowed: true,
            reason: "",
            dayKey: dayKey,
            slack: draftState.employees.length - arCountDayAssignedEntries(draftState, dayKey),
            dailyHolidayCap: dayCap
        };
    }

    var coverage = arCountDayCoverage(draftState, dayKey);
    var currentWork = 0;
    Object.keys(coverage.byCodeFilled).forEach(function(codeName) {
        currentWork += parseInt(coverage.byCodeFilled[codeName], 10) || 0;
    });

    var requiredWork = arGetRequiredWorkCount(requirement);
    var remainingWorkNeed = Math.max(0, requiredWork - currentWork);
    var assignedCount = arCountDayAssignedEntries(draftState, dayKey);
    var remainingEmptyAfterOff = draftState.employees.length - (assignedCount + 1);
    if (remainingEmptyAfterOff < remainingWorkNeed) {
        return {
            allowed: false,
            reason: "day_off_limit",
            dayKey: dayKey,
            remainingWorkNeed: remainingWorkNeed,
            remainingEmptyAfterOff: remainingEmptyAfterOff
        };
    }

    var groupLetter = employee.group || "POOL";
    if (groupLetter !== "POOL") {
        var remainingGroupNeed = arGetRemainingGroupNeed(draftState, dayKey, groupLetter);
        if (remainingGroupNeed > 0) {
            var groupSize = draftState.groupSizeMap[groupLetter] || 0;
            var remainingGroupEmptyAfterOff = groupSize - (arCountDayAssignedEntriesForGroup(draftState, dayKey, groupLetter) + 1);
            if (remainingGroupEmptyAfterOff < remainingGroupNeed) {
                return {
                    allowed: false,
                    reason: "group_min_risk",
                    dayKey: dayKey,
                    groupLetter: groupLetter,
                    remainingGroupNeed: remainingGroupNeed,
                    remainingGroupEmptyAfterOff: remainingGroupEmptyAfterOff
                };
            }
        }
    }

    return {
        allowed: true,
        reason: "",
        dayKey: dayKey,
        slack: remainingEmptyAfterOff - remainingWorkNeed,
        dailyHolidayCap: dayCap
    };
}

function arBuildAutoOffDayCandidates(draftState, employee) {
    var meta = arGetMonthMeta(draftState.yyyymm);
    var candidates = [];

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var dayKey = String(dayNum);
        var evaluation = arEvaluateAutoOffDay(draftState, employee, dayKey);
        if (!evaluation.allowed) continue;

        var requirement = (arMonthState.dailyRequirements || {})[dayKey];
        var requiredWork = arGetRequiredWorkCount(requirement);
        var assignedCount = arCountDayAssignedEntries(draftState, dayKey);
        var slack = draftState.employees.length - assignedCount - requiredWork;
        var score = 0;

        if (new Date(meta.year, meta.month - 1, dayNum).getDay() === 0) score += 100;
        if (!requirement) score += 60;
        score += Math.max(0, slack) * 5;

        var groupLetter = employee.group || "POOL";
        if (groupLetter !== "POOL") {
            var remainingGroupNeed = arGetRemainingGroupNeed(draftState, dayKey, groupLetter);
            var groupSlack = (draftState.groupSizeMap[groupLetter] || 0) - arCountDayAssignedEntriesForGroup(draftState, dayKey, groupLetter) - remainingGroupNeed;
            score += Math.max(0, groupSlack) * 4;
        }

        candidates.push({
            dayKey: dayKey,
            score: score
        });
    }

    candidates.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return parseInt(a.dayKey, 10) - parseInt(b.dayKey, 10);
    });

    return candidates;
}

function arGetPreferredHolidayWarningInfo(draftState, employee) {
    var meta = arGetMonthMeta(draftState.yyyymm);
    var ranked = [];

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var dayKey = String(dayNum);
        if (arGetDraftAssignment(draftState, employee.uid, dayKey)) continue;

        var evaluation = arEvaluateAutoOffDay(draftState, employee, dayKey);
        if (evaluation.allowed || evaluation.reason === "fixed_exists") continue;

        var score = 0;
        if (new Date(meta.year, meta.month - 1, dayNum).getDay() === 0) score += 100;
        if (!(arMonthState.dailyRequirements || {})[dayKey]) score += 40;
        if (evaluation.reason === "group_min_risk") score += 20;

        ranked.push({
            dayKey: dayKey,
            score: score,
            reason: evaluation.reason,
            groupLetter: evaluation.groupLetter || ""
        });
    }

    ranked.sort(function(a, b) {
        if (b.score !== a.score) return b.score - a.score;
        return parseInt(a.dayKey, 10) - parseInt(b.dayKey, 10);
    });

    return ranked.length ? ranked[0] : null;
}

function arCountDayCoverage(draftState, dayKey) {
    var byCodeFilled = {};
    var byGroupCodeFilled = {};
    var assignments = draftState.assignmentsByDay[dayKey] || {};

    Object.keys(assignments).forEach(function(uid) {
        var entry = assignments[uid];
        if (!arIsWorkEntry(entry)) return;

        var codeName = arGetEntryCode(entry);
        if (!codeName) return;

        byCodeFilled[codeName] = (byCodeFilled[codeName] || 0) + 1;

        var emp = draftState.employeesByUid[uid] || {};
        var groupLetter = emp.group || "POOL";
        if (groupLetter !== "POOL") {
            if (!byGroupCodeFilled[groupLetter]) byGroupCodeFilled[groupLetter] = {};
            byGroupCodeFilled[groupLetter][codeName] = (byGroupCodeFilled[groupLetter][codeName] || 0) + 1;
        }
    });

    return {
        byCodeFilled: byCodeFilled,
        byGroupCodeFilled: byGroupCodeFilled
    };
}

function arInferCodeSlot(codeName) {
    var label = String(arGetCodeLabel(codeName) || codeName || "").toLowerCase();
    if (label.indexOf("오전") >= 0 || label.indexOf("morning") >= 0 || label === "am") return "morning";
    if (label.indexOf("오후") >= 0 || label.indexOf("afternoon") >= 0 || label === "pm") return "afternoon";
    if (label.indexOf("종일") >= 0 || label.indexOf("full") >= 0 || label.indexOf("day") >= 0) return "full";
    return "";
}

function arEstimateConsecutiveWorkdays(draftState, uid, dayNum) {
    var streak = 1;
    var prev = dayNum - 1;
    var next = dayNum + 1;
    var meta = arGetMonthMeta(draftState.yyyymm);

    while (prev >= 1) {
        var prevEntry = arGetDraftAssignment(draftState, uid, String(prev));
        if (!arIsWorkEntry(prevEntry)) break;
        streak += 1;
        prev -= 1;
    }

    while (next <= meta.totalDays) {
        var nextEntry = arGetDraftAssignment(draftState, uid, String(next));
        if (!arIsWorkEntry(nextEntry)) break;
        streak += 1;
        next += 1;
    }

    return streak;
}

function arGetPmToAmPenalty(draftState, uid, dayNum, codeName) {
    var penalty = 0;
    var slot = arInferCodeSlot(codeName);
    var prevEntry = arGetDraftAssignment(draftState, uid, String(dayNum - 1));
    var nextEntry = arGetDraftAssignment(draftState, uid, String(dayNum + 1));
    var prevSlot = arInferCodeSlot(arGetEntryCode(prevEntry));
    var nextSlot = arInferCodeSlot(arGetEntryCode(nextEntry));

    if (slot === "morning" && prevSlot === "afternoon") penalty += 40;
    if (slot === "afternoon" && nextSlot === "morning") penalty += 40;
    return penalty;
}

function arCountAssignedWorkdays(draftState, uid) {
    var total = 0;
    Object.keys(draftState.assignmentsByUser[uid] || {}).forEach(function(dayKey) {
        if (arIsWorkEntry(draftState.assignmentsByUser[uid][dayKey])) total += 1;
    });
    return total;
}

function arGetMaxWorkStreak(draftState, uid) {
    var meta = arGetMonthMeta(draftState.yyyymm);
    var best = 0;
    var current = 0;

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var entry = arGetDraftAssignment(draftState, uid, String(dayNum));
        if (arIsWorkEntry(entry)) {
            current += 1;
            if (current > best) best = current;
        } else {
            current = 0;
        }
    }

    return best;
}

function arBuildCandidateScore(draftState, employee, dayKey, codeName, groupLetter) {
    var score = 60;
    var dayNum = parseInt(dayKey, 10);
    var streak = arEstimateConsecutiveWorkdays(draftState, employee.uid, dayNum);
    var pmToAmPenalty = arGetPmToAmPenalty(draftState, employee.uid, dayNum, codeName);
    var assignedWorkdays = arCountAssignedWorkdays(draftState, employee.uid);

    if (groupLetter) score += 100;
    score += Math.max(0, 15 - assignedWorkdays);

    if (streak === 4) score -= 25;
    if (streak >= 5) score -= 80;
    score -= pmToAmPenalty;

    return {
        score: score,
        streak: streak,
        pmToAmPenalty: pmToAmPenalty
    };
}

function arFindBestCandidate(draftState, dayKey, codeName, groupLetter) {
    var best = null;

    draftState.employees.forEach(function(employee) {
        if (groupLetter && employee.group !== groupLetter) return;
        if (arGetDraftAssignment(draftState, employee.uid, dayKey)) return;

        var scoreMeta = arBuildCandidateScore(draftState, employee, dayKey, codeName, groupLetter);
        if (!best || scoreMeta.score > best.scoreMeta.score) {
            best = {
                employee: employee,
                scoreMeta: scoreMeta
            };
        }
    });

    return best;
}

function arApplyAutoAssignment(draftState, dayKey, employee, codeName, scoreMeta) {
    arSetDraftAssignment(draftState, employee.uid, dayKey, {
        type: "auto",
        valueType: "scheduleCode",
        code: codeName,
        label: arGetCodeLabel(codeName),
        source: "auto",
        scoreMeta: scoreMeta || {}
    });
}

function arApplyAutoOffAssignment(draftState, dayKey, employee) {
    arSetDraftAssignment(draftState, employee.uid, dayKey, {
        type: "auto",
        valueType: "normal",
        code: "",
        label: "휴무",
        source: "auto_off"
    });
}

function arAssignHolidayGuarantees(draftState) {
    var pending = draftState.employees.map(function(employee) {
        return {
            employee: employee,
            blockedInfo: null
        };
    });

    var madeProgress = true;

    pending.sort(function(a, b) {
        var targetA = draftState.holidayPolicy.targetsByUid[a.employee.uid] || 0;
        var targetB = draftState.holidayPolicy.targetsByUid[b.employee.uid] || 0;
        return targetB - targetA;
    });

    while (madeProgress) {
        madeProgress = false;

        pending.forEach(function(item) {
            var employee = item.employee;
            var target = draftState.holidayPolicy.targetsByUid[employee.uid] || 0;
            var currentOff = arCountAssignedOffDays(draftState, employee.uid);
            if (currentOff >= target) return;

            var candidates = arBuildAutoOffDayCandidates(draftState, employee);
            if (!candidates.length) {
                if (!item.blockedInfo) item.blockedInfo = arGetPreferredHolidayWarningInfo(draftState, employee);
                return;
            }

            arApplyAutoOffAssignment(draftState, candidates[0].dayKey, employee);
            madeProgress = true;
        });
    }

    pending.forEach(function(item) {
        var employee = item.employee;
        var target = draftState.holidayPolicy.targetsByUid[employee.uid] || 0;
        var fixedOff = arCountAssignedOffDays(draftState, employee.uid, "fixed");
        var autoOff = arCountAssignedOffDays(draftState, employee.uid, "auto");
        var shortage = Math.max(0, target - (fixedOff + autoOff));

        draftState.holidaySummaryByUid[employee.uid] = {
            target: target,
            fixedOff: fixedOff,
            autoOff: autoOff,
            shortage: shortage,
            warningDayKey: item.blockedInfo ? item.blockedInfo.dayKey : "",
            warningInfo: item.blockedInfo || null
        };
    });
}

function arGenerateAssignmentsForDay(draftState, dayKey, requirement) {
    var coverage = arCountDayCoverage(draftState, dayKey);
    var byGroupCode = requirement.byGroupCode || {};
    var byCode = requirement.byCode || {};

    arGetGroupLettersToRender().forEach(function(groupLetter) {
        Object.keys(byGroupCode[groupLetter] || {}).forEach(function(codeName) {
            var target = parseInt(byGroupCode[groupLetter][codeName], 10) || 0;
            var current = parseInt((((coverage.byGroupCodeFilled[groupLetter] || {})[codeName]) || 0), 10) || 0;
            while (current < target) {
                var candidate = arFindBestCandidate(draftState, dayKey, codeName, groupLetter);
                if (!candidate) break;
                arApplyAutoAssignment(draftState, dayKey, candidate.employee, codeName, candidate.scoreMeta);
                coverage = arCountDayCoverage(draftState, dayKey);
                current = parseInt((((coverage.byGroupCodeFilled[groupLetter] || {})[codeName]) || 0), 10) || 0;
            }
        });
    });

    Object.keys(byCode).forEach(function(codeName) {
        var target = parseInt(byCode[codeName], 10) || 0;
        var current = parseInt((coverage.byCodeFilled[codeName] || 0), 10) || 0;
        while (current < target) {
            var candidate = arFindBestCandidate(draftState, dayKey, codeName, "");
            if (!candidate) break;
            arApplyAutoAssignment(draftState, dayKey, candidate.employee, codeName, candidate.scoreMeta);
            coverage = arCountDayCoverage(draftState, dayKey);
            current = parseInt((coverage.byCodeFilled[codeName] || 0), 10) || 0;
        }
    });
}

function arAddDraftWarning(draftState, warning) {
    draftState.warnings.push(warning);
    var dayKey = warning.dayKey || "";
    if (!draftState.warningsByDay[dayKey]) draftState.warningsByDay[dayKey] = [];
    draftState.warningsByDay[dayKey].push(warning);
}

function arBuildShortageWarnings(draftState) {
    Object.keys(arMonthState.dailyRequirements || {}).forEach(function(dayKey) {
        var requirement = arMonthState.dailyRequirements[dayKey];
        if (!requirement) return;

        var coverage = arCountDayCoverage(draftState, dayKey);
        var totalFilled = 0;

        Object.keys(coverage.byCodeFilled).forEach(function(codeName) {
            totalFilled += parseInt(coverage.byCodeFilled[codeName], 10) || 0;
        });

        Object.keys(requirement.byCode || {}).forEach(function(codeName) {
            var targetCode = parseInt(requirement.byCode[codeName], 10) || 0;
            var filledCode = parseInt(coverage.byCodeFilled[codeName], 10) || 0;
            if (filledCode < targetCode) {
                arAddDraftWarning(draftState, {
                    kind: "code_shortage",
                    dayKey: dayKey,
                    codeName: codeName,
                    missing: targetCode - filledCode,
                    message: dayKey + "일 " + arGetCodeLabel(codeName) + " " + (targetCode - filledCode) + "명 부족"
                });
            }
        });

        arGetGroupLettersToRender().forEach(function(groupLetter) {
            Object.keys((requirement.byGroupCode || {})[groupLetter] || {}).forEach(function(codeName) {
                var targetGroup = parseInt(requirement.byGroupCode[groupLetter][codeName], 10) || 0;
                var filledGroup = parseInt((((coverage.byGroupCodeFilled[groupLetter] || {})[codeName]) || 0), 10) || 0;
                if (filledGroup < targetGroup) {
                    arAddDraftWarning(draftState, {
                        kind: "group_shortage",
                        dayKey: dayKey,
                        groupLetter: groupLetter,
                        codeName: codeName,
                        missing: targetGroup - filledGroup,
                        message: dayKey + "일 " + groupLetter + "조 " + arGetCodeLabel(codeName) + " " + (targetGroup - filledGroup) + "명 부족"
                    });
                }
            });
        });

        if (requirement.totalRequired != null && totalFilled < requirement.totalRequired) {
            arAddDraftWarning(draftState, {
                kind: "total_shortage",
                dayKey: dayKey,
                missing: requirement.totalRequired - totalFilled,
                message: dayKey + "일 전체 " + (requirement.totalRequired - totalFilled) + "명 부족"
            });
        }

        draftState.coverageByDay[dayKey] = coverage;
    });
}

function arBuildHolidayShortageWarnings(draftState) {
    var riskMap = {};

    draftState.employees.forEach(function(employee) {
        var summary = draftState.holidaySummaryByUid[employee.uid];
        if (!summary || summary.shortage <= 0) return;

        arAddDraftWarning(draftState, {
            kind: "holiday_shortage",
            dayKey: summary.warningDayKey || "",
            uid: employee.uid,
            employeeName: employee.name,
            missing: summary.shortage,
            message: employee.name + " 목표 휴무 " + summary.target + "일 중 " + summary.shortage + "일 부족"
        });

        var info = summary.warningInfo;
        if (!info || !info.dayKey) return;

        var riskKey = [info.reason, info.groupLetter || "", info.dayKey].join("|");
        if (riskMap[riskKey]) return;
        riskMap[riskKey] = true;

        if (info.reason === "group_min_risk") {
            arAddDraftWarning(draftState, {
                kind: "group_off_risk",
                dayKey: info.dayKey,
                groupLetter: info.groupLetter,
                message: info.groupLetter + "조 " + arMonthState.yyyymm.slice(4, 6) + "월 " + info.dayKey + "일: 조별 최소 근무 인원 부족 위험"
            });
            return;
        }

        if (info.reason === "day_off_limit") {
            arAddDraftWarning(draftState, {
                kind: "day_off_limit",
                dayKey: info.dayKey,
                message: arMonthState.yyyymm.slice(4, 6) + "월 " + info.dayKey + "일: 하루 최대 휴무 " + (info.dailyHolidayCap || "-") + "명 제한"
            });
        }
    });
}

function arBuildPatternWarnings(draftState) {
    var meta = arGetMonthMeta(draftState.yyyymm);

    draftState.employees.forEach(function(employee) {
        var streakStart = null;
        var streakCount = 0;

        for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
            var dayKey = String(dayNum);
            var entry = arGetDraftAssignment(draftState, employee.uid, dayKey);
            if (arIsWorkEntry(entry)) {
                if (streakStart === null) streakStart = dayNum;
                streakCount += 1;

                var prevEntry = arGetDraftAssignment(draftState, employee.uid, String(dayNum - 1));
                var prevSlot = arInferCodeSlot(arGetEntryCode(prevEntry));
                var curSlot = arInferCodeSlot(arGetEntryCode(entry));
                if (prevSlot === "afternoon" && curSlot === "morning") {
                    arAddDraftWarning(draftState, {
                        kind: "pm_to_am",
                        dayKey: dayKey,
                        uid: employee.uid,
                        employeeName: employee.name,
                        message: employee.name + " " + (dayNum - 1) + "일 오후 → " + dayNum + "일 오전 예외 배정"
                    });
                }
            } else if (streakCount > 0) {
                if (streakCount >= 5) {
                    arAddDraftWarning(draftState, {
                        kind: "consecutive_work",
                        dayKey: String(streakStart),
                        uid: employee.uid,
                        employeeName: employee.name,
                        streakStart: streakStart,
                        streakEnd: dayNum - 1,
                        streakCount: streakCount,
                        message: employee.name + " " + streakStart + "일~" + (dayNum - 1) + "일 " + streakCount + "일 연속근무"
                    });
                }
                streakStart = null;
                streakCount = 0;
            }
        }

        if (streakCount >= 5) {
            arAddDraftWarning(draftState, {
                kind: "consecutive_work",
                dayKey: String(streakStart),
                uid: employee.uid,
                employeeName: employee.name,
                streakStart: streakStart,
                streakEnd: meta.totalDays,
                streakCount: streakCount,
                message: employee.name + " " + streakStart + "일~" + meta.totalDays + "일 " + streakCount + "일 연속근무"
            });
        }
    });
}

function arBuildDaySummaries(draftState) {
    var meta = arGetMonthMeta(draftState.yyyymm);

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var dayKey = String(dayNum);
        var fixedOffCount = 0;
        var autoOffCount = 0;
        var fixedWorkCount = 0;

        Object.keys(draftState.assignmentsByDay[dayKey] || {}).forEach(function(uid) {
            var entry = draftState.assignmentsByDay[dayKey][uid];
            if (arIsOffEntry(entry)) {
                if (entry.type === "fixed") fixedOffCount += 1;
                else if (entry.source === "auto_off") autoOffCount += 1;
            } else if (arIsWorkEntry(entry)) {
                fixedWorkCount += 1;
            }
        });

        var warningCount = (draftState.warningsByDay[dayKey] || []).length;
        var holidayMissingCount = 0;
        var riskCount = 0;
        (draftState.warningsByDay[dayKey] || []).forEach(function(warning) {
            if (warning.kind === "holiday_shortage") holidayMissingCount += parseInt(warning.missing, 10) || 0;
            if (warning.kind === "group_off_risk" || warning.kind === "day_off_limit") riskCount += 1;
        });

        draftState.daySummaries[dayKey] = {
            fixedOffCount: fixedOffCount,
            autoOffCount: autoOffCount,
            totalOffCount: fixedOffCount + autoOffCount,
            fixedWorkCount: fixedWorkCount,
            holidayMissingCount: holidayMissingCount,
            riskCount: riskCount,
            warningCount: warningCount,
            totalMissing: 0,
            codeMissingCount: 0,
            groupMissingCount: 0
        };
    }
}

function arGetDraftCandidateCodeNames() {
    var nameSet = {};

    Object.keys(arMonthState.dailyRequirements || {}).forEach(function(dayKey) {
        var requirement = arMonthState.dailyRequirements[dayKey];
        if (!requirement) return;

        Object.keys(requirement.byCode || {}).forEach(function(codeName) {
            if ((parseInt(requirement.byCode[codeName], 10) || 0) > 0) nameSet[codeName] = true;
        });

        Object.keys(requirement.byGroupCode || {}).forEach(function(groupLetter) {
            Object.keys((requirement.byGroupCode || {})[groupLetter] || {}).forEach(function(codeName) {
                if ((parseInt(requirement.byGroupCode[groupLetter][codeName], 10) || 0) > 0) nameSet[codeName] = true;
            });
        });
    });

    return Object.keys(nameSet);
}

function arBuildDraftRequirementLogMap() {
    var logMap = {};

    Object.keys(arMonthState.dailyRequirements || {}).forEach(function(dayKey) {
        var requirement = arMonthState.dailyRequirements[dayKey];
        if (!requirement) return;

        logMap[dayKey] = {
            totalRequired: requirement.totalRequired,
            byCode: Object.assign({}, requirement.byCode || {}),
            byGroupCode: arCloneGroupCodeMap(requirement.byGroupCode || {})
        };
    });

    return logMap;
}

function arCollectDraftResultCounts(draftState) {
    var totalAssignedCells = 0;
    var fixedAssignedCells = 0;
    var autoAssignedCells = 0;
    var unassignedCellCount = 0;
    var groupShortageCount = 0;

    Object.keys(draftState.assignmentsByDay || {}).forEach(function(dayKey) {
        Object.keys(draftState.assignmentsByDay[dayKey] || {}).forEach(function(uid) {
            var entry = draftState.assignmentsByDay[dayKey][uid];
            if (!entry) return;

            totalAssignedCells += 1;
            if (entry.type === "fixed") fixedAssignedCells += 1;
            if (entry.type === "auto") autoAssignedCells += 1;
        });
    });

    Object.keys(draftState.daySummaries || {}).forEach(function(dayKey) {
        var summary = draftState.daySummaries[dayKey] || {};
        unassignedCellCount += parseInt(summary.holidayMissingCount, 10) || 0;
        groupShortageCount += parseInt(summary.riskCount, 10) || 0;
    });

    return {
        totalAssignedCells: totalAssignedCells,
        fixedAssignedCells: fixedAssignedCells,
        autoAssignedCells: autoAssignedCells,
        unassignedCellCount: unassignedCellCount,
        groupShortageCount: groupShortageCount
    };
}

function arRenderDraftDaySummary() {
    var container = document.getElementById("arDraftDaySummary");
    if (!container) return;

    if (!arDraftState) {
        container.innerHTML = "";
        return;
    }

    var meta = arGetMonthMeta(arDraftState.yyyymm);
    var html = "";

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var dayKey = String(dayNum);
        var summary = arDraftState.daySummaries[dayKey];
        if (!summary) continue;

        var cls = "ar-draft-day-chip";
        var text = dayNum + "일 충족";
        if (summary.totalMissing > 0) {
            cls += " is-short";
            text = dayNum + "일 전체 " + summary.totalMissing + " 부족";
        } else if (summary.groupMissingCount > 0 || summary.codeMissingCount > 0) {
            cls += " is-short";
            text = dayNum + "일 코드/조 부족";
        } else if (summary.warningCount > 0) {
            cls += " is-warn";
            text = dayNum + "일 경고 " + summary.warningCount;
        } else {
            cls += " is-ok";
        }

        html += "<button type='button' class='" + cls + "' data-day='" + dayKey + "'>" + text + "</button>";
    }

    container.innerHTML = html;
    container.querySelectorAll(".ar-draft-day-chip").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var dayKey = this.getAttribute("data-day");
            arLastClickedDayKey = String(dayKey);
            arRenderCalendarGrid();
            arRenderDayDetailPanel(dayKey);
        });
    });
}

function arGetGridCellText(entry) {
    if (!entry) return "-";
    if (entry.valueType === "normal") return "휴";
    if (entry.valueType === "petition") return "청";
    if (entry.valueType === "annual") return "연";
    return entry.label || arGetCodeLabel(entry.code);
}

function arGetGridCellClass(entry) {
    if (!entry) return "ar-draft-cell-empty";
    if (entry.type === "fixed" && entry.source === "fixed_request") return "ar-draft-cell-fixed-off";
    if (entry.type === "fixed" && entry.source === "fixed_work") return "ar-draft-cell-fixed-work";
    if (entry.type === "auto") return "ar-draft-cell-auto";
    return "ar-draft-cell-empty";
}

function arRenderDraftGrid() {
    var container = document.getElementById("arDraftGrid");
    if (!container) return;

    if (!arDraftState || !arDraftState.employees.length) {
        container.className = "ar-draft-grid-empty";
        container.innerHTML = "초안을 생성하면 직원별/날짜별 그리드가 여기에 표시됩니다.";
        return;
    }

    var meta = arGetMonthMeta(arDraftState.yyyymm);
    var html = "<div class='ar-draft-grid-scroll'><table class='ar-draft-table'><thead><tr>";
    html += "<th class='is-sticky'>직원</th>";
    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        html += "<th>" + dayNum + "</th>";
    }
    html += "</tr></thead><tbody>";

    arDraftState.employees.forEach(function(employee) {
        html += "<tr>";
        html += "<td class='is-sticky'><div class='ar-draft-emp-name'>" + employee.name + "</div><div class='ar-draft-emp-meta'>" + (employee.group === "POOL" ? "미배정" : employee.group + "조") + "</div></td>";
        for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
            var dayKey = String(dayNum);
            var entry = arGetDraftAssignment(arDraftState, employee.uid, dayKey);
            html += "<td class='" + arGetGridCellClass(entry) + "' title='" + arGetGridCellText(entry) + "'>" + arGetGridCellText(entry) + "</td>";
        }
        html += "</tr>";
    });

    html += "</tbody></table></div>";
    container.className = "ar-draft-grid";
    container.innerHTML = html;
}

function arRenderDraftWarnings() {
    var container = document.getElementById("arDraftWarnings");
    if (!container) return;

    if (!arDraftState || !arDraftState.warnings.length) {
        container.className = "ar-draft-warning-empty";
        container.innerHTML = "경고가 없습니다.";
        return;
    }

    var html = "<div class='ar-draft-warning-list'>";
    arDraftState.warnings.forEach(function(warning) {
        html += "<div class='ar-draft-warning-item'>";
        html += "<div class='ar-draft-warning-kind'>" + arGetWarningKindLabel(warning.kind) + "</div>";
        html += "<div class='ar-draft-warning-msg'>" + warning.message + "</div>";
        html += "</div>";
    });
    html += "</div>";

    container.className = "";
    container.innerHTML = html;
}

function arGetWarningKindLabel(kind) {
    if (kind === "total_shortage") return "전체 부족";
    if (kind === "code_shortage") return "코드별 부족";
    if (kind === "group_shortage") return "조별 부족";
    if (kind === "consecutive_work") return "연속근무";
    if (kind === "pm_to_am") return "오후→오전";
    return "경고";
}

function arRenderDraftDaySummary() {
    var container = document.getElementById("arDraftDaySummary");
    if (!container) return;

    if (!arDraftState) {
        container.innerHTML = "";
        return;
    }

    var meta = arGetMonthMeta(arDraftState.yyyymm);
    var html = "";

    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        var dayKey = String(dayNum);
        var summary = arDraftState.daySummaries[dayKey];
        if (!summary) continue;

        var cls = "ar-draft-day-chip";
        var text = dayNum + "일 휴무 " + (summary.totalOffCount || 0);
        if ((summary.holidayMissingCount || 0) > 0) {
            cls += " is-short";
            text = dayNum + "일 휴무 부족 " + summary.holidayMissingCount;
        } else if ((summary.riskCount || 0) > 0 || (summary.warningCount || 0) > 0) {
            cls += " is-warn";
            text = dayNum + "일 경고 " + summary.warningCount;
        } else {
            cls += " is-ok";
        }

        html += "<button type='button' class='" + cls + "' data-day='" + dayKey + "'>" + text + "</button>";
    }

    container.innerHTML = html;
    container.querySelectorAll(".ar-draft-day-chip").forEach(function(btn) {
        btn.addEventListener("click", function() {
            var dayKey = this.getAttribute("data-day");
            arLastClickedDayKey = String(dayKey);
            arRenderCalendarGrid();
            arRenderDayDetailPanel(dayKey);
        });
    });
}

function arGetHolidaySummaryLine(draftState, employee) {
    var summary = (draftState.holidaySummaryByUid || {})[employee.uid] || {};
    var groupLabel = employee.group === "POOL" ? "미배정" : employee.group + "조";
    var maxStreak = arGetMaxWorkStreak(draftState, employee.uid);

    return groupLabel
        + " | 목표 " + (summary.target || 0)
        + " | 고정 " + (summary.fixedOff || 0)
        + " | 자동 " + (summary.autoOff || 0)
        + " | 부족 " + (summary.shortage || 0)
        + " | 최대연속 " + maxStreak + "일";
}

function arGetGridCellText(entry) {
    if (!entry) return "-";
    if (entry.valueType === "normal") return "휴";
    if (entry.valueType === "petition") return "청";
    if (entry.valueType === "annual") return "연";
    return entry.label || arGetCodeLabel(entry.code);
}

function arRenderDraftGrid() {
    var container = document.getElementById("arDraftGrid");
    if (!container) return;

    if (!arDraftState || !arDraftState.employees.length) {
        container.className = "ar-draft-grid-empty";
        container.innerHTML = "휴무 초안을 생성하면 직원별/날짜별 결과가 여기에 표시됩니다.";
        return;
    }

    var meta = arGetMonthMeta(arDraftState.yyyymm);
    var html = "<div class='ar-draft-grid-scroll'><table class='ar-draft-table'><thead><tr>";
    html += "<th class='is-sticky'>직원</th>";
    for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
        html += "<th>" + dayNum + "</th>";
    }
    html += "</tr></thead><tbody>";

    arDraftState.employees.forEach(function(employee) {
        html += "<tr>";
        html += "<td class='is-sticky'><div class='ar-draft-emp-name'>" + employee.name + "</div><div class='ar-draft-emp-meta'>" + arGetHolidaySummaryLine(arDraftState, employee) + "</div></td>";
        for (var dayNum = 1; dayNum <= meta.totalDays; dayNum++) {
            var dayKey = String(dayNum);
            var entry = arGetDraftAssignment(arDraftState, employee.uid, dayKey);
            html += "<td class='" + arGetGridCellClass(entry) + "' title='" + arGetGridCellText(entry) + "'>" + arGetGridCellText(entry) + "</td>";
        }
        html += "</tr>";
    });

    html += "</tbody></table></div>";
    container.className = "ar-draft-grid";
    container.innerHTML = html;
}

function arGetWarningKindLabel(kind) {
    if (kind === "holiday_shortage") return "휴무 부족";
    if (kind === "group_off_risk") return "조별 최소인원 위험";
    if (kind === "day_off_limit") return "일별 휴무 상한";
    if (kind === "consecutive_work") return "연속근무";
    if (kind === "pm_to_am") return "오후→오전";
    return "경고";
}

function arRenderDraftConfigSummary() {
    var el = document.getElementById("arDraftConfigSummary");
    if (!el) return;

    var monthTarget = arGetMonthlyHolidayTargetValue();
    var capDays = Object.keys(arMonthState.dailyHolidayCaps || {}).length;
    var defaultCapText = capDays ? (capDays + "개 날짜 개별 제한") : "개별 제한 없음";

    if (!arDraftState) {
        el.innerHTML = "월 목표 휴무 " + monthTarget + "일 / 일별 최대 휴무 " + defaultCapText;
        return;
    }

    el.innerHTML = "월 목표 휴무 " + monthTarget + "일 / 일별 최대 휴무 " + defaultCapText + " / 직원별 개인 override 우선 적용";
}

function arRenderDraftUi() {
    arEnsureDraftPanel();
    arWireButtonsOnce();
    arRenderDraftConfigSummary();
    arRenderDraftDaySummary();
    arRenderDraftGrid();
    arRenderDraftWarnings();
}

function arResetDraftState() {
    arDraftState = null;
    arSetDraftStatus("초안을 초기화했습니다.", "success");
    arRenderCalendarGrid();
    arRenderDayDetailPanel(arLastClickedDayKey);
    arRenderDraftUi();
}

function arGenerateDraft() {
    console.log("[auto-schedule:draft] arGenerateDraft started");
    if (!isAdmin && !isSuperAdmin) return;
    if (!arMonthState.yyyymm) return;

    var monthTargetEl = document.getElementById("arMonthlyHolidayTarget");
    if (monthTargetEl) {
        var monthTargetRaw = String(monthTargetEl.value || "").trim();
        if (monthTargetRaw) {
            var monthTarget = parseInt(monthTargetRaw, 10);
            if (!Number.isFinite(monthTarget) || monthTarget < 1) {
                arSetDraftStatus("월 목표 휴무 개수를 확인해주세요.", "error");
                return;
            }
            arMonthState.monthlyHolidayTarget = monthTarget;
        }
    }

    var generateTopBtn = document.getElementById("arDraftGenerateTopBtn");
    var generateBtn = document.getElementById("arDraftGenerateBtn");
    if (generateTopBtn) {
        generateTopBtn.disabled = true;
        generateTopBtn.textContent = "휴무 초안 생성 중...";
    }
    if (generateBtn) {
        generateBtn.disabled = true;
        generateBtn.textContent = "휴무 초안 생성 중...";
    }

    arSetDraftStatus("고정 신청값과 월 휴무 목표를 불러와 자동 휴무 초안을 생성하는 중입니다...", "");

    Promise.resolve()
        .then(function() {
            return connectDeptDBSafe(currentDept, arMonthState.yyyymm);
        })
        .then(function() {
            var employees = arBuildDraftEmployees();
            if (!employees.length) throw new Error("초안 생성 대상 직원이 없습니다.");

            var loadedCodeList = (arMonthState.activeCodes || []).map(function(code) {
                return {
                    name: code.name,
                    displayName: code.displayName || "",
                    active: code.active !== false
                };
            });
            var requirementLogMap = arBuildDraftRequirementLogMap();

            console.log("[auto-schedule:draft] loaded schedule codes:", loadedCodeList);
            console.log("[auto-schedule:draft] employee count:", employees.length);
            console.log("[auto-schedule:draft] daily requirements:", requirementLogMap);
            console.log("[auto-schedule:draft] monthly holiday target:", arGetMonthlyHolidayTargetValue());
            console.log("[auto-schedule:draft] daily holiday caps:", Object.assign({}, arMonthState.dailyHolidayCaps || {}));

            var fixedAssignments = arBuildFixedAssignments(arMonthState.yyyymm, employees);
            var draftState = arCreateDraftState(arMonthState.yyyymm, employees, fixedAssignments);
            arAssignHolidayGuarantees(draftState);
            arBuildHolidayShortageWarnings(draftState);
            arBuildPatternWarnings(draftState);
            arBuildDaySummaries(draftState);

            var draftCounts = arCollectDraftResultCounts(draftState);
            console.log("[auto-schedule:draft] assigned cell counts:", draftCounts);
            console.log("[auto-schedule:draft] actual assigned cells:", draftCounts.autoAssignedCells);
            console.log("[auto-schedule:draft] unassigned cells:", draftCounts.unassignedCellCount);

            arDraftState = draftState;
            arRenderCalendarGrid();
            arRenderDayDetailPanel(arLastClickedDayKey);
            arRenderDraftUi();
            arSetDraftStatus("자동 휴무 초안 생성을 완료했습니다. 기존 신청값은 잠그고 부족한 휴무만 자동으로 배정했습니다.", "success");
        })
        .catch(function(error) {
            console.error("[auto-schedule] draft generation failed:", error);
            arSetDraftStatus((error && error.message) || "초안 생성에 실패했습니다.", "error");
        })
        .finally(function() {
            if (generateTopBtn) {
                generateTopBtn.disabled = false;
                generateTopBtn.textContent = "자동 휴무 초안 생성";
            }
            if (generateBtn) {
                generateBtn.disabled = false;
                generateBtn.textContent = "자동 휴무 초안 생성";
            }
        });
}

function arRenderDayDetailPanel(dayKey) {
    var panel = arEnsureDetailPanel();
    if (!panel) return;

    var title = "날짜 상세";
    if (arMonthState.yyyymm && dayKey) {
        title = arMonthState.yyyymm.slice(0, 4) + "." + arMonthState.yyyymm.slice(4, 6) + "." + String(dayKey).padStart(2, "0") + " 상세";
    }

    if (!dayKey) {
        panel.innerHTML = "<div class='ar-day-detail-title'>" + title + "</div><div class='ar-day-detail-body'>달력에서 날짜를 클릭하면 필요인원, 초안, 경고가 여기에 표시됩니다.</div>";
        return;
    }

    var requirement = arMonthState.dailyRequirements[dayKey];
    var html = "<div class='ar-day-detail-title'>" + title + "</div><div class='ar-day-detail-body'>";

    if (!requirement) {
        html += "<div class='ar-day-detail-empty'>이 날짜는 아직 필요인원 설정이 없습니다.</div>";
    } else {
        if (requirement.totalRequired != null) {
            html += "<div class='ar-day-detail-total'>총 " + requirement.totalRequired + "명</div>";
        }
        Object.keys(requirement.byCode || {}).forEach(function(codeName) {
            var codeCount = parseInt(requirement.byCode[codeName], 10);
            if (!Number.isFinite(codeCount) || codeCount <= 0) return;

            html += "<div class='ar-day-detail-code-block'>";
            html += "<div class='ar-day-detail-code-title'>" + arGetCodeLabel(codeName) + " " + codeCount + "명</div>";
            html += "<div class='ar-day-detail-code-groups'>" + arGetDetailGroupText(requirement, codeName) + "</div>";
            html += "</div>";
        });
    }

    if (arDraftState) {
        var assignments = arDraftState.assignmentsByDay[dayKey] || {};
        var fixedItems = [];
        var autoItems = [];

        Object.keys(assignments).forEach(function(uid) {
            var entry = assignments[uid];
            var emp = arDraftState.employeesByUid[uid] || {};
            var line = (emp.name || uid) + " - " + (entry.label || arGetCodeLabel(entry.code));
            if (entry.type === "fixed") fixedItems.push(line);
            else if (entry.type === "auto") autoItems.push(line);
        });

        var summary = (arDraftState.daySummaries || {})[dayKey];
        html += "<hr class='ar-day-detail-divider'>";
        html += "<div class='ar-day-detail-section-title'>초안 결과</div>";
        if (summary) {
            html += "<div class='ar-day-detail-draft-summary'>"
                + "채움 " + summary.totalFilled + " / 부족 " + summary.totalMissing
                + " / 코드부족 " + summary.codeMissingCount
                + " / 조부족 " + summary.groupMissingCount
                + "</div>";
        }
        html += "<div class='ar-day-detail-subtitle'>고정값</div>";
        html += fixedItems.length ? "<div class='ar-day-detail-list'>" + fixedItems.join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>고정값 없음</div>";
        html += "<div class='ar-day-detail-subtitle'>자동배정값</div>";
        html += autoItems.length ? "<div class='ar-day-detail-list'>" + autoItems.join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>자동배정 없음</div>";

        var warnings = (arDraftState.warningsByDay || {})[dayKey] || [];
        html += "<div class='ar-day-detail-subtitle'>경고</div>";
        html += warnings.length ? "<div class='ar-day-detail-list'>" + warnings.map(function(item) { return item.message; }).join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>경고 없음</div>";
    }

    html += "</div>";
    panel.innerHTML = html;
}

function arGetDetailGroupText(dayData, codeName) {
    var groupParts = [];

    arGetGroupLettersToRender().forEach(function(groupLetter) {
        var codeMap = (dayData.byGroupCode || {})[groupLetter];
        var count = parseInt((codeMap || {})[codeName], 10);
        if (Number.isFinite(count) && count > 0) {
            groupParts.push(groupLetter + " " + count + "명");
        }
    });

    return groupParts.length ? groupParts.join(" / ") : "조별 설정 없음";
}

function arRenderDayDetailPanel(dayKey) {
    var panel = arEnsureDetailPanel();
    if (!panel) return;

    var title = "날짜 상세";
    if (arMonthState.yyyymm && dayKey) {
        title = arMonthState.yyyymm.slice(0, 4) + "." + arMonthState.yyyymm.slice(4, 6) + "." + String(dayKey).padStart(2, "0") + " 상세";
    }

    if (!dayKey) {
        panel.innerHTML = "<div class='ar-day-detail-title'>" + title + "</div><div class='ar-day-detail-body'>달력에서 날짜를 클릭하면 필요인원, 휴무 초안, 경고를 여기에서 확인할 수 있습니다.</div>";
        return;
    }

    var requirement = arMonthState.dailyRequirements[dayKey];
    var dayCap = arGetDailyHolidayCap(dayKey);
    var html = "<div class='ar-day-detail-title'>" + title + "</div><div class='ar-day-detail-body'>";

    html += "<div class='ar-day-detail-draft-summary'>월 목표 휴무 " + arGetMonthlyHolidayTargetValue() + "일 / 이 날짜 최대 휴무 " + (dayCap != null ? dayCap + "명" : "제한 없음") + "</div>";

    if (!requirement) {
        html += "<div class='ar-day-detail-empty'>이 날짜에는 저장된 필요인원 설정이 없습니다.</div>";
    } else {
        if (requirement.totalRequired != null) {
            html += "<div class='ar-day-detail-total'>총 " + requirement.totalRequired + "명</div>";
        }
        Object.keys(requirement.byCode || {}).forEach(function(codeName) {
            var codeCount = parseInt(requirement.byCode[codeName], 10);
            if (!Number.isFinite(codeCount) || codeCount <= 0) return;

            html += "<div class='ar-day-detail-code-block'>";
            html += "<div class='ar-day-detail-code-title'>" + arGetCodeLabel(codeName) + " " + codeCount + "명</div>";
            html += "<div class='ar-day-detail-code-groups'>" + arGetDetailGroupText(requirement, codeName) + "</div>";
            html += "</div>";
        });
    }

    if (arDraftState) {
        var assignments = arDraftState.assignmentsByDay[dayKey] || {};
        var fixedItems = [];
        var autoItems = [];

        Object.keys(assignments).forEach(function(uid) {
            var entry = assignments[uid];
            var emp = arDraftState.employeesByUid[uid] || {};
            var line = (emp.name || uid) + " - " + (entry.label || arGetCodeLabel(entry.code));
            if (entry.type === "fixed") fixedItems.push(line);
            else if (entry.type === "auto") autoItems.push(line);
        });

        var summary = (arDraftState.daySummaries || {})[dayKey] || {};
        html += "<hr class='ar-day-detail-divider'>";
        html += "<div class='ar-day-detail-section-title'>휴무 초안 결과</div>";
        html += "<div class='ar-day-detail-draft-summary'>고정 휴무 " + (summary.fixedOffCount || 0) + " / 자동 휴무 " + (summary.autoOffCount || 0) + " / 경고 " + (summary.warningCount || 0) + "</div>";
        html += "<div class='ar-day-detail-subtitle'>고정값</div>";
        html += fixedItems.length ? "<div class='ar-day-detail-list'>" + fixedItems.join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>고정값 없음</div>";
        html += "<div class='ar-day-detail-subtitle'>자동 휴무</div>";
        html += autoItems.length ? "<div class='ar-day-detail-list'>" + autoItems.join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>자동 휴무 없음</div>";

        var warnings = (arDraftState.warningsByDay || {})[dayKey] || [];
        html += "<div class='ar-day-detail-subtitle'>경고</div>";
        html += warnings.length ? "<div class='ar-day-detail-list'>" + warnings.map(function(item) { return item.message; }).join("<br>") + "</div>" : "<div class='ar-day-detail-empty'>경고 없음</div>";
    }

    html += "</div>";
    panel.innerHTML = html;
}

function arLoadMonth() {
    if (!isAdmin && !isSuperAdmin) return;

    var yyyymm = arGetSelectedYyyymm();
    if (!yyyymm) return;

    arSetStatus("불러오는 중...", "");
    arFetchConfig(yyyymm).then(function(cfg) {
        arMonthState.yyyymm = yyyymm;
        arMonthState.activeCodes = arGetActiveCodesFromConfig(cfg);
        arMonthState.dailyRequirements = arCloneDailyRequirements(cfg.dailyRequirements || {});
        arMonthState.monthlyHolidayTarget = arGetDefaultMonthlyHolidayTarget(yyyymm);
        arMonthState.dailyHolidayCaps = {};
        arSelectedDays = [];
        arLastClickedDayKey = "";
        arDraftState = null;

        arEnsureDetailPanel();
        arEnsureDraftPanel();
        arRenderRequirementTable();
        arRenderCalendarGrid();
        arRenderDayDetailPanel("");
        arRenderDraftUi();
        arUpdateSelectionCountLabel();
        arSyncHolidayConfigInputs();
        arSetDraftStatus("", "");
        arSetStatus("", "");
    }).catch(function(e) {
        console.error("[auto-schedule] load failed:", e);
        arSetStatus("불러오기에 실패했습니다.", "error");
        var container = document.getElementById("arCalendarGrid");
        if (container) {
            container.innerHTML = "<div style='color:#dc2626;font-size:12px;padding:8px 0;'>월 설정을 불러오지 못했습니다.</div>";
        }
    });
}

function arOnMonthChange() {
    arLoadMonth();
}

function arInitAutoSchedulePage() {
    if (!isAdmin && !isSuperAdmin) return;

    arInitYearMonthSelects();
    arEnsureDetailPanel();
    arEnsureDraftPanel();
    arWireButtonsOnce();
    if (!arPageReady) arPageReady = true;
    arLoadMonth();
}
