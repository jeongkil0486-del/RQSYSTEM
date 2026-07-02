/**
 * auto-schedule.js
 * Auto-schedule daily requirements editor.
 *
 * Scope for this step:
 * - Keep all persistence in departments/{deptId}/configs/{yyyymm}/dailyRequirements
 * - Do not change Functions, saveDeptConfig, or shared request system logic
 * - Make apply/save behavior visible immediately in the autoschedule calendar UI
 */

var arMonthState = {
    yyyymm: "",
    activeCodes: [],
    dailyRequirements: {}
};

var arSelectedDays = [];
var arPageReady = false;

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

function arNormalizeDayData(raw) {
    if (!raw || typeof raw !== "object") return null;

    var total = raw.totalRequired;
    if (total == null) total = raw.totalNeeded;
    var totalRequired = parseInt(total, 10);
    if (!Number.isFinite(totalRequired) || totalRequired < 1) totalRequired = null;

    var codeSource = raw.byCode;
    if (!codeSource || typeof codeSource !== "object") codeSource = raw.codes;
    var byCode = {};
    Object.keys(codeSource || {}).forEach(function(codeName) {
        var count = parseInt(codeSource[codeName], 10);
        if (Number.isFinite(count) && count > 0) byCode[codeName] = count;
    });

    if (totalRequired === null && Object.keys(byCode).length === 0) return null;
    return {
        totalRequired: totalRequired,
        byCode: byCode
    };
}

function arCloneDailyRequirements(source) {
    var next = {};
    Object.keys(source || {}).forEach(function(dayKey) {
        var normalized = arNormalizeDayData(source[dayKey]);
        if (!normalized) return;
        next[String(parseInt(dayKey, 10))] = {
            totalRequired: normalized.totalRequired,
            byCode: Object.assign({}, normalized.byCode)
        };
    });
    return next;
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

function arWireButtonsOnce() {
    var applyBtn = document.getElementById("arApplyBtn");
    var clearBtn = document.getElementById("arClearBtn");
    var saveBtn = document.getElementById("arSaveBtn");

    if (applyBtn && !applyBtn.dataset.arWired) {
        applyBtn.addEventListener("click", arApplyToSelectedDays);
        applyBtn.dataset.arWired = "1";
    }
    if (clearBtn && !clearBtn.dataset.arWired) {
        clearBtn.addEventListener("click", arClearSelection);
        clearBtn.dataset.arWired = "1";
    }
    if (saveBtn && !saveBtn.dataset.arWired) {
        saveBtn.addEventListener("click", arSaveWholeMonth);
        saveBtn.dataset.arWired = "1";
    }
}

function arSetStatus(message, tone) {
    var el = document.getElementById("arLoadStatus");
    if (!el) return;
    el.textContent = message || "";
    el.style.color = tone === "error" ? "#dc2626" : tone === "success" ? "#059669" : "";
}

function arUpdateSelectionCountLabel() {
    var label = document.getElementById("arSelectionCount");
    if (!label) return;
    label.textContent = "선택일 " + arSelectedDays.length + "일";
}

function arRenderRequirementTable() {
    var container = document.getElementById("arRequirementTable");
    if (!container) return;

    var totalEl = document.getElementById("arTotalRequired");
    if (totalEl) totalEl.value = "";

    if (!arMonthState.activeCodes.length) {
        container.innerHTML = "<div style='color:#94a3b8;font-size:12px;line-height:1.5;padding:8px 0;'>등록된 사용중 근무코드가 없습니다. 전체 필요인원만 먼저 적용할 수 있습니다.</div>";
        return;
    }

    var html = "<table class='ar-req-table' style='width:100%; border-collapse:collapse; font-size:12px;'>";
    html += "<tr>"
          + "<th style='text-align:left; padding:4px 6px; border-bottom:1px solid var(--border);'>근무코드</th>"
          + "<th style='text-align:center; padding:4px 6px; border-bottom:1px solid var(--border);'>필요인원</th>"
          + "</tr>";

    arMonthState.activeCodes.forEach(function(code) {
        var label = code.displayName || code.name;
        html += "<tr>"
             + "<td style='padding:4px 6px;'>" + label + "</td>"
             + "<td style='padding:4px 6px; text-align:center;'>"
             + "<input type='number' min='0' class='form-input small small-num-input ar-code-input' data-code='" + code.name + "' value='' style='width:56px; text-align:center;'>"
             + "</td>"
             + "</tr>";
    });

    html += "</table>";
    container.innerHTML = html;
}

function arGetCodeLabel(codeName) {
    var match = arMonthState.activeCodes.find(function(item) { return item.name === codeName; });
    return match ? (match.displayName || match.name) : codeName;
}

function arGetSummaryHtml(dayData) {
    if (!dayData) return "<span class='ar-day-empty-text'>미설정</span>";

    var lines = [];
    var codeKeys = Object.keys(dayData.byCode || {});
    if (dayData.totalRequired != null) {
        lines.push(codeKeys.length > 0 ? ("총" + dayData.totalRequired) : (dayData.totalRequired + "명"));
    }
    if (codeKeys.length > 0) {
        lines.push(codeKeys.map(function(codeName) {
            return arGetCodeLabel(codeName) + dayData.byCode[codeName];
        }).join(" "));
    }
    return lines.join("<br>");
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

        var dateDiv = document.createElement("div");
        var className = "date";
        if (dow === 0) className += " sun";
        if (dow === 6) className += " sat";
        if (isSelected) className += " ar-selected";
        if (dayData) className += " ar-has-data";
        dateDiv.className = className;
        dateDiv.id = "ar-d-" + day;

        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = String(day);
        dateDiv.appendChild(numDiv);

        var summaryDiv = document.createElement("div");
        summaryDiv.className = "count-badge ar-day-summary" + (dayData ? " badge-safe" : "");
        summaryDiv.innerHTML = arGetSummaryHtml(dayData);
        dateDiv.appendChild(summaryDiv);

        (function(boundDay) {
            dateDiv.onclick = function() { arToggleDaySelect(boundDay); };
        })(day);

        fragment.appendChild(dateDiv);
    }

    container.appendChild(fragment);
}

function arToggleDaySelect(day) {
    var dayKey = String(day);
    var idx = arSelectedDays.indexOf(dayKey);
    if (idx >= 0) arSelectedDays.splice(idx, 1);
    else arSelectedDays.push(dayKey);

    var cell = document.getElementById("ar-d-" + dayKey);
    if (cell) cell.classList.toggle("ar-selected", idx < 0);
    arUpdateSelectionCountLabel();
}

function arClearSelection() {
    arSelectedDays = [];
    document.querySelectorAll("#arCalendarGrid .date.ar-selected").forEach(function(el) {
        el.classList.remove("ar-selected");
    });
    arUpdateSelectionCountLabel();
    arSetStatus("선택된 날짜를 해제했습니다.", "success");
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

    return {
        totalRequired: totalRequired,
        byCode: byCode
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

    arSelectedDays.forEach(function(dayKey) {
        arMonthState.dailyRequirements[dayKey] = {
            totalRequired: newDayData.totalRequired,
            byCode: Object.assign({}, newDayData.byCode)
        };
    });

    arRenderCalendarGrid();
    arSetStatus(arSelectedDays.length + "개 날짜에 적용했습니다. 달력에서 바로 확인한 뒤 저장해주세요.", "success");
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

function arLoadMonth() {
    if (!isAdmin && !isSuperAdmin) return;
    var yyyymm = arGetSelectedYyyymm();
    if (!yyyymm) return;

    arSetStatus("불러오는 중...", "");
    arFetchConfig(yyyymm).then(function(cfg) {
        arMonthState.yyyymm = yyyymm;
        arMonthState.activeCodes = arGetActiveCodesFromConfig(cfg);
        arMonthState.dailyRequirements = arCloneDailyRequirements(cfg.dailyRequirements || {});
        arSelectedDays = [];

        arRenderRequirementTable();
        arRenderCalendarGrid();
        arUpdateSelectionCountLabel();
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
    arWireButtonsOnce();
    if (!arPageReady) arPageReady = true;
    arLoadMonth();
}
