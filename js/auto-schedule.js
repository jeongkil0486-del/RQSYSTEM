/**
 * auto-schedule.js — 자동 월간 스케줄 기능 (3단계: 자동스케줄 메뉴 + 달력형 다중 선택)
 *
 * ⚠️ 설계 원칙
 * 1. scheduleCodes[].limit 은 "직원 신청 제한" 용도로만 계속 사용한다.
 *    이 파일은 그 값을 읽거나 쓰지 않는다.
 * 2. 자동 스케줄 생성 시 기준이 될 인원 값은 오직 dailyRequirements 에만 저장한다.
 *    저장 구조는 이전 단계와 동일하게 유지:
 *      departments/{deptId}/configs/{yyyymm}/dailyRequirements = {
 *        "1": { totalRequired, byCode: {코드명:n}, byGroupCode: {조:{코드명:n}} },
 *        ...
 *      }
 * 3. 기존 실시간 캐시 파이프라인(firebase-store.js)은 건드리지 않는다. 이 화면은
 *    필요한 시점에 db.ref(...).once("value") 로 직접 읽어오며, saveDeptConfig로만
 *    저장한다 (Functions 미수정/재배포 불필요).
 *
 * 4. 이번 단계의 핵심 변경: "날짜 1개 선택 → 즉시 저장" 방식은 저장 왕복이 많아
 *    느렸으므로, "월 전체를 메모리에 올려두고, 여러 날짜를 선택해 한 번에 값을
 *    적용한 뒤, 마지막에 그 달 전체를 1회 저장"하는 방식으로 변경했다.
 *      - arMonthState: 현재 선택된 월의 근무코드/조편성/dailyRequirements 전체를
 *        메모리에 들고 있는 작업본. 월을 불러올 때 서버 값으로 초기화된다.
 *      - [선택 날짜에 적용] 은 이 메모리(arMonthState)만 수정한다 (서버 호출 없음).
 *      - [이 월 전체 저장] 을 눌러야만 실제로 서버에 saveDeptConfig 1회 호출된다.
 *      - 따라서 페이지를 나가거나 새로고침하면 "저장"을 누르지 않은 변경은 사라진다.
 *
 * ⚠️ 알려진 제한사항: 같은 달을 두 관리자가 동시에 편집하면 나중에 저장한 쪽이
 *    이전 저장을 덮어쓸 수 있다 (이 앱 전체가 동시편집 충돌 처리를 하지 않는
 *    구조이므로 기존 동작과 동일한 전제).
 */

console.log("[auto-schedule.js] loaded");

var AR_ALL_GROUP_LETTERS = ["A", "B", "C", "D", "E"];

// 현재 월의 작업본 (서버 저장 전까지의 메모리 상태)
var arMonthState = {
    yyyymm: null,
    activeCodes: [],
    assignedGroups: [],
    dailyRequirements: {}   // { "1": {...}, "2": {...}, ... } — 서버와 동일한 구조
};

// 현재 달력에서 다중 선택된 날짜 집합 ("5": true 형태)
var arSelectedDays = {};

// ══════════════════════════════════════════════════════════════════════════
// 년/월 선택
// ══════════════════════════════════════════════════════════════════════════

function arInitYearMonthSelects() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
    if (!selY || !selM) { console.error("[auto-schedule] arYear/arMonth select를 찾을 수 없습니다."); return; }

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

    var tm = (typeof getTargetYearMonth === "function") ? getTargetYearMonth() : null;
    if (tm) {
        selY.value = tm.year;
        selM.value = tm.month;
    }
}

function arGetSelectedYyyymm() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
    if (!selY || !selM) return null;
    var y = selY.value || (selY.options[0] && selY.options[0].value);
    var m = selM.value || (selM.options[0] && selM.options[0].value);
    if (!y || !m) return null;
    return y + m;
}

// ══════════════════════════════════════════════════════════════════════════
// 서버 읽기 / 데이터 추출
// ══════════════════════════════════════════════════════════════════════════

function arFetchConfig(yyyymm) {
    if (!currentDept) return Promise.reject(new Error("소속 지점 정보가 없습니다. 다시 로그인해주세요."));
    return db.ref("departments/" + currentDept + "/configs/" + yyyymm).once("value")
        .then(function(snap) { return snap.val() || {}; });
}

function arGetActiveCodesFrom(cfg) {
    var list = Array.isArray((cfg || {}).scheduleCodes) ? cfg.scheduleCodes : [];
    return list.filter(function(c) { return c && c.active !== false; });
}

function arGetAssignedGroupsFrom(cfg) {
    var groups = (cfg || {}).groups || {};
    return AR_ALL_GROUP_LETTERS.filter(function(g) {
        return Array.isArray(groups[g]) && groups[g].length > 0;
    });
}

// ══════════════════════════════════════════════════════════════════════════
// 월 로드 (서버 → arMonthState) / 페이지 진입 초기화
// ══════════════════════════════════════════════════════════════════════════

function arInitAutoSchedulePage() {
    try {
        if (!isAdmin && !isSuperAdmin) return;
        arInitYearMonthSelects();
        arWireButtonsOnce();
        arLoadMonth();
    } catch (e) {
        console.error("[auto-schedule] arInitAutoSchedulePage 초기화 실패:", e);
        _arShowCalendarError("화면 초기화 중 오류가 발생했습니다. 새로고침 후 다시 시도해주세요.");
    }
}

// 버튼 3개를 addEventListener로 연결 (inline onclick 대신 — 페이지 재진입 시
// 여러 번 호출돼도 중복 연결되지 않도록 data-ar-wired 플래그로 1회만 연결)
function arWireButtonsOnce() {
    var applyBtn = document.getElementById("arApplyBtn");
    var clearBtn = document.getElementById("arClearBtn");
    var saveBtn  = document.getElementById("arSaveBtn");

    if (applyBtn && !applyBtn.dataset.arWired) {
        applyBtn.addEventListener("click", function() {
            console.log("[auto-schedule] arApplyBtn 클릭됨");
            arApplyToSelectedDays();
        });
        applyBtn.dataset.arWired = "1";
    }
    if (clearBtn && !clearBtn.dataset.arWired) {
        clearBtn.addEventListener("click", function() {
            console.log("[auto-schedule] arClearBtn 클릭됨");
            arClearSelection();
        });
        clearBtn.dataset.arWired = "1";
    }
    if (saveBtn && !saveBtn.dataset.arWired) {
        saveBtn.addEventListener("click", function() {
            console.log("[auto-schedule] arSaveBtn 클릭됨");
            arSaveWholeMonth();
        });
        saveBtn.dataset.arWired = "1";
    }

    if (!applyBtn || !clearBtn || !saveBtn) {
        console.error("[auto-schedule] 버튼 요소를 찾지 못함:", { applyBtn: !!applyBtn, clearBtn: !!clearBtn, saveBtn: !!saveBtn });
    }
}

function arOnMonthChange() {
    arLoadMonth();
}

function arLoadMonth() {
    if (!isAdmin && !isSuperAdmin) return;
    var yyyymm = arGetSelectedYyyymm();
    if (!yyyymm) { console.error("[auto-schedule] yyyymm을 확인할 수 없습니다."); return; }

    var statusEl = document.getElementById("arLoadStatus");
    if (statusEl) statusEl.innerText = "불러오는 중...";

    arFetchConfig(yyyymm).then(function(cfg) {
        arMonthState.yyyymm           = yyyymm;
        arMonthState.activeCodes      = arGetActiveCodesFrom(cfg);
        arMonthState.assignedGroups   = arGetAssignedGroupsFrom(cfg);
        arMonthState.dailyRequirements = Object.assign({}, cfg.dailyRequirements || {});
        arSelectedDays = {};

        arRenderCalendarGrid();
        arRenderPanelTable();
        arUpdateSelectionCountLabel();
        if (statusEl) statusEl.innerText = "";
    }).catch(function(e) {
        console.error("[auto-schedule] arLoadMonth 실패:", e);
        if (statusEl) statusEl.innerText = "";
        _arShowCalendarError("불러오기 실패: " + (e && e.message ? e.message : e));
    });
}

function _arShowCalendarError(message) {
    var container = document.getElementById("arCalendarGrid");
    if (container) {
        container.innerHTML = "<div style='color:#e53935;font-size:12px;padding:8px 0;'>⚠️ " + message + "</div>";
    }
}

// ══════════════════════════════════════════════════════════════════════════
// 달력 렌더링 (요일 정렬 — 기존 대시보드 달력과 동일한 .date/.date-num/.count-badge
// 클래스를 재사용해 시각적으로 통일. id는 "ar-d-N"으로 대시보드 달력(id="d-N")과
// 절대 충돌하지 않게 분리.)
// ══════════════════════════════════════════════════════════════════════════

function arRenderCalendarGrid() {
    var container = document.getElementById("arCalendarGrid");
    if (!container) return;
    var yyyymm = arMonthState.yyyymm;
    if (!yyyymm) return;

    var year  = parseInt(yyyymm.slice(0, 4), 10);
    var month = parseInt(yyyymm.slice(4, 6), 10);
    var firstDay  = new Date(year, month - 1, 1);
    var startDow  = firstDay.getDay();
    var totalDays = new Date(year, month, 0).getDate();

    container.innerHTML = "";
    var fragment = document.createDocumentFragment();

    var daysHeader = [
        { txt: "일", cls: "days sun" }, { txt: "월", cls: "days" }, { txt: "화", cls: "days" },
        { txt: "수", cls: "days" }, { txt: "목", cls: "days" }, { txt: "금", cls: "days" }, { txt: "토", cls: "days sat" }
    ];
    daysHeader.forEach(function(h) {
        var hDiv = document.createElement("div");
        hDiv.className = h.cls;
        hDiv.innerText = h.txt;
        fragment.appendChild(hDiv);
    });

    for (var e = 0; e < startDow; e++) {
        var emptyDiv = document.createElement("div");
        emptyDiv.className = "empty";
        fragment.appendChild(emptyDiv);
    }

    for (var d = 1; d <= totalDays; d++) {
        var dow = new Date(year, month - 1, d).getDay();
        var cls = "date";
        if (dow === 0) cls += " sun";
        if (dow === 6) cls += " sat";
        if (arSelectedDays[String(d)]) cls += " ar-selected";

        var dateDiv = document.createElement("div");
        dateDiv.className = cls;
        dateDiv.id = "ar-d-" + d;

        var numDiv = document.createElement("div");
        numDiv.className = "date-num";
        numDiv.innerText = String(d);
        dateDiv.appendChild(numDiv);

        var summaryDiv = document.createElement("div");
        var dr = arMonthState.dailyRequirements[String(d)];
        summaryDiv.className = (dr && dr.totalRequired != null) ? "count-badge badge-safe" : "count-badge";
        summaryDiv.innerText = (dr && dr.totalRequired != null) ? (dr.totalRequired + "명") : "미설정";
        dateDiv.appendChild(summaryDiv);

        (function(day) {
            dateDiv.onclick = function() { arToggleDaySelect(day); };
        })(d);

        fragment.appendChild(dateDiv);
    }
    container.appendChild(fragment);
}

function arToggleDaySelect(day) {
    var key = String(day);
    if (arSelectedDays[key]) delete arSelectedDays[key];
    else arSelectedDays[key] = true;
    console.log("[auto-schedule] arToggleDaySelect(" + key + ") → arSelectedDays =", JSON.stringify(arSelectedDays));

    var cell = document.getElementById("ar-d-" + day);
    if (cell) cell.classList.toggle("ar-selected", !!arSelectedDays[key]);
    arUpdateSelectionCountLabel();
}

function arClearSelection() {
    arSelectedDays = {};
    document.querySelectorAll("#arCalendarGrid .date.ar-selected").forEach(function(el) {
        el.classList.remove("ar-selected");
    });
    arUpdateSelectionCountLabel();
}

function arUpdateSelectionCountLabel() {
    var label = document.getElementById("arSelectionCount");
    if (label) label.innerText = "선택됨: " + Object.keys(arSelectedDays).length + "일";
}

// ══════════════════════════════════════════════════════════════════════════
// 입력 패널 (근무코드 × 조) — 특정 날짜 값이 아니라, 선택된 날짜들에
// "일괄 적용"할 값을 입력하는 템플릿. 월 로드 시 항상 빈 값으로 시작.
// ══════════════════════════════════════════════════════════════════════════

function arRenderPanelTable() {
    var container = document.getElementById("arRequirementTable");
    if (!container) return;

    var totalEl = document.getElementById("arTotalRequired");
    if (totalEl) totalEl.value = "";

    var activeCodes = arMonthState.activeCodes;
    var groups      = arMonthState.assignedGroups;

    if (!activeCodes || activeCodes.length === 0) {
        container.innerHTML = "<div style='color:#aaa;font-style:italic;font-size:12px;padding:8px 0;'>"
            + "사용 중인 근무코드가 없습니다. 위 '근무코드 관리'에서 코드를 생성하고 '사용함'으로 설정해주세요.</div>";
        return;
    }

    var groupNote = "";
    if (!groups || groups.length === 0) {
        groupNote = "<div style='color:#f0ad4e;font-size:11px;margin-bottom:6px;'>"
                  + "⚠️ 조편성 데이터가 없어 조별 필수인원은 입력할 수 없습니다. "
                  + "'직원관리 &gt; 조 편성'에서 조를 먼저 구성해주세요. (코드별 필요인원은 입력 가능합니다)</div>";
        groups = [];
    }

    var html = groupNote;
    html += "<table class='ar-req-table' style='width:100%; border-collapse:collapse; font-size:12px;'>";
    html += "<tr>"
          + "<th style='text-align:left; padding:4px 6px; border-bottom:1px solid var(--border);'>근무코드</th>"
          + "<th style='text-align:center; padding:4px 6px; border-bottom:1px solid var(--border);'>코드별 필요</th>";
    groups.forEach(function(g) {
        html += "<th style='text-align:center; padding:4px 6px; border-bottom:1px solid var(--border);'>" + g + "조</th>";
    });
    html += "</tr>";

    activeCodes.forEach(function(c) {
        var label = c.displayName || c.name;
        html += "<tr>"
              + "<td style='padding:4px 6px;'>" + label + "</td>"
              + "<td style='padding:4px 6px; text-align:center;'>"
              + "<input type='number' min='0' max='99' class='form-input small small-num-input ar-code-input' "
              + "data-code='" + c.name + "' value='' style='width:56px; text-align:center;'>"
              + "</td>";
        groups.forEach(function(g) {
            html += "<td style='padding:4px 6px; text-align:center;'>"
                  + "<input type='number' min='0' max='99' class='form-input small small-num-input ar-group-input' "
                  + "data-code='" + c.name + "' data-group='" + g + "' value='' style='width:48px; text-align:center;'>"
                  + "</td>";
        });
        html += "</tr>";
    });
    html += "</table>";
    container.innerHTML = html;
}

// 현재 입력 패널 값을 하나의 "날짜 데이터" 객체로 조립
function arCollectDayDataFromForm() {
    var totalEl = document.getElementById("arTotalRequired");
    var totalRequired = totalEl && totalEl.value !== "" ? parseInt(totalEl.value, 10) : null;

    var byCode = {};
    document.querySelectorAll(".ar-code-input").forEach(function(input) {
        var code = input.getAttribute("data-code");
        if (input.value !== "") byCode[code] = parseInt(input.value, 10);
    });

    var byGroupCode = {};
    document.querySelectorAll(".ar-group-input").forEach(function(input) {
        var code  = input.getAttribute("data-code");
        var group = input.getAttribute("data-group");
        if (input.value === "") return;
        if (!byGroupCode[group]) byGroupCode[group] = {};
        byGroupCode[group][code] = parseInt(input.value, 10);
    });

    var dayData = {};
    if (totalRequired != null && !isNaN(totalRequired)) dayData.totalRequired = totalRequired;
    if (Object.keys(byCode).length > 0) dayData.byCode = byCode;
    if (Object.keys(byGroupCode).length > 0) dayData.byGroupCode = byGroupCode;
    return dayData;
}

// ══════════════════════════════════════════════════════════════════════════
// 선택 날짜에 적용 (메모리만 수정, 서버 호출 없음) / 이 월 전체 저장
// ══════════════════════════════════════════════════════════════════════════

function arApplyToSelectedDays() {
    try {
        if (!isAdmin && !isSuperAdmin) return;
        var days = Object.keys(arSelectedDays);
        console.log("[auto-schedule] arApplyToSelectedDays 실행, 선택된 날짜:", days);
        if (days.length === 0) { alert("❌ 먼저 달력에서 날짜를 선택해주세요."); return; }

        var newDayData = arCollectDayDataFromForm();
        console.log("[auto-schedule] 적용할 값:", JSON.stringify(newDayData));
        if (Object.keys(newDayData).length === 0) {
            if (!confirm("입력한 값이 없습니다. 선택된 " + days.length + "일의 설정을 모두 삭제할까요?")) return;
        }

        days.forEach(function(day) {
            if (Object.keys(newDayData).length === 0) {
                delete arMonthState.dailyRequirements[day];
            } else {
                // 날짜마다 독립된 객체가 되도록 매번 새로 복사 (참조 공유로 인한 오염 방지)
                arMonthState.dailyRequirements[day] = JSON.parse(JSON.stringify(newDayData));
            }
        });

        arRenderCalendarGrid(); // 요약 갱신 (선택 표시도 그대로 유지됨)

        var statusEl = document.getElementById("arLoadStatus");
        if (statusEl) {
            statusEl.innerText = days.length + "일에 적용됨 (아직 저장 전)";
            setTimeout(function() { if (statusEl.innerText.indexOf("적용됨") >= 0) statusEl.innerText = ""; }, 2500);
        }
    } catch (e) {
        console.error("[auto-schedule] arApplyToSelectedDays 오류:", e);
        alert("적용 중 오류가 발생했습니다: " + (e && e.message ? e.message : e));
    }
}

function arSaveWholeMonth() {
    if (!isAdmin && !isSuperAdmin) return;
    var yyyymm = arMonthState.yyyymm;
    if (!yyyymm) { alert("❌ 먼저 월을 선택해주세요."); return; }

    var dayCount = Object.keys(arMonthState.dailyRequirements).length;
    if (!confirm(yyyymm.slice(0, 4) + "년 " + parseInt(yyyymm.slice(4, 6), 10) + "월 전체를 저장합니다. (설정된 날짜 " + dayCount + "일)\n계속하시겠습니까?")) return;

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: yyyymm,
        config: { dailyRequirements: arMonthState.dailyRequirements }
    }).then(function() {
        alert("✨ 저장 완료.");
    }).catch(function(e) {
        console.error("[auto-schedule] arSaveWholeMonth 실패:", e);
        alert(e && e.message ? e.message : "저장 실패");
    });
}
