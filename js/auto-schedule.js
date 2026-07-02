/**
 * auto-schedule.js — 자동 월간 스케줄 기능 (2단계: 일별 필요인원 설정)
 *
 * ⚠️ 설계 원칙 (2단계 승인 사항)
 * 1. scheduleCodes[].limit 은 "직원 신청 제한" 용도로만 계속 사용한다.
 *    이 파일은 그 값을 읽거나 쓰지 않는다.
 * 2. 자동 스케줄 생성 시 기준이 될 인원 값은 오직 dailyRequirements 에만 저장한다.
 * 3. 기존 실시간 캐시 파이프라인(firebase-store.js 의 liveDBData/_applyCfgToLiveData)은
 *    건드리지 않는다. 이 화면은 필요한 시점에 db.ref(...).once("value") 로 직접
 *    필요한 값만 읽어오며, 기존 실시간 리스너 구조와 완전히 분리되어 동작한다.
 * 4. 저장은 기존 fn.saveDeptConfig 콜러블을 그대로 재사용한다 (Functions 미수정).
 *    saveDeptConfig 는 top-level 키 단위로 통째로 교체하므로, 저장 직전에 항상
 *    해당 월의 dailyRequirements 전체를 다시 읽어와 수정 중인 날짜만 갱신한 뒤
 *    전체 객체를 다시 보낸다 (다른 날짜 값이 사라지지 않도록).
 *
 * 저장 구조:
 *   departments/{deptId}/configs/{yyyymm}/dailyRequirements = {
 *     "1": {
 *       totalRequired: 18,
 *       byCode: { "코드명": n, ... },
 *       byGroupCode: { "A": { "코드명": n, ... }, "B": {...}, ... }
 *     },
 *     "2": { ... }
 *   }
 */

var AR_GROUPS = ["A", "B", "C", "D", "E"];

// ── 월 선택 select 초기화 (targetYear/targetMonth와 동일한 패턴, 독립적인 select) ──
function arInitYearMonthSelects() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
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

    // 기본값: 대시보드의 "현재 신청월"과 동일하게 시작 (원하면 바로 다른 달로 바꿀 수 있음)
    var tm = getTargetYearMonth();
    selY.value = tm.year;
    selM.value = tm.month;
}

function arGetSelectedYyyymm() {
    var selY = document.getElementById("arYear");
    var selM = document.getElementById("arMonth");
    if (!selY || !selM || !selY.value || !selM.value) return null;
    return selY.value + selM.value;
}

// ── 일 선택 select 초기화 (선택된 년월의 총 일수만큼) ──
function arRefreshDaySelectOptions() {
    var selD = document.getElementById("arDay");
    var yyyymm = arGetSelectedYyyymm();
    if (!selD || !yyyymm) return;

    var year  = parseInt(yyyymm.slice(0, 4), 10);
    var month = parseInt(yyyymm.slice(4, 6), 10);
    var totalDays = new Date(year, month, 0).getDate();

    var prevVal = selD.value;
    selD.innerHTML = "";
    for (var d = 1; d <= totalDays; d++) {
        var opt = document.createElement("option");
        opt.value = String(d);
        opt.text  = String(d) + "일";
        selD.appendChild(opt);
    }
    // 이전에 선택돼 있던 날짜가 새 월에도 존재하면 유지, 아니면 1일로
    selD.value = (prevVal && parseInt(prevVal, 10) <= totalDays) ? prevVal : "1";
}

// ── 특정 월의 config 전체를 직접 읽어옴 (기존 캐시 시스템 미사용) ──
function arFetchConfig(yyyymm) {
    return db.ref("departments/" + currentDept + "/configs/" + yyyymm).once("value")
        .then(function(snap) { return snap.val() || {}; });
}

// ── 활성 근무코드만 추출 (active===false 인 코드는 자동스케줄 대상에서 제외) ──
function arGetActiveCodesFrom(cfg) {
    var list = Array.isArray(cfg.scheduleCodes) ? cfg.scheduleCodes : [];
    return list.filter(function(c) { return c && c.active !== false; });
}

// ── 근무코드 × 조 테이블 렌더링 ──
function arRenderRequirementTable(activeCodes, dayData) {
    var container = document.getElementById("arRequirementTable");
    if (!container) return;

    if (activeCodes.length === 0) {
        container.innerHTML = "<div style='color:#aaa;font-style:italic;font-size:12px;padding:8px 0;'>"
            + "사용 중인 근무코드가 없습니다. 먼저 위 '근무코드 관리'에서 코드를 생성/활성화해주세요.</div>";
        return;
    }

    var byCode      = (dayData && dayData.byCode) || {};
    var byGroupCode = (dayData && dayData.byGroupCode) || {};

    var html = "<table class='ar-req-table' style='width:100%; border-collapse:collapse; font-size:12px;'>";
    html += "<tr>"
          + "<th style='text-align:left; padding:4px 6px; border-bottom:1px solid var(--border);'>근무코드</th>"
          + "<th style='padding:4px 6px; border-bottom:1px solid var(--border);'>코드별 필요</th>";
    AR_GROUPS.forEach(function(g) {
        html += "<th style='padding:4px 6px; border-bottom:1px solid var(--border);'>" + g + "조</th>";
    });
    html += "</tr>";

    activeCodes.forEach(function(c) {
        var label = c.displayName || c.name;
        var codeVal = (byCode[c.name] != null) ? byCode[c.name] : "";
        html += "<tr>"
              + "<td style='padding:4px 6px;'>" + label + "</td>"
              + "<td style='padding:4px 6px;'>"
              + "<input type='number' min='0' max='99' class='form-input small small-num-input ar-code-input' "
              + "data-code='" + c.name + "' value='" + codeVal + "' style='width:56px;'>"
              + "</td>";
        AR_GROUPS.forEach(function(g) {
            var gVal = (byGroupCode[g] && byGroupCode[g][c.name] != null) ? byGroupCode[g][c.name] : "";
            html += "<td style='padding:4px 6px;'>"
                  + "<input type='number' min='0' max='99' class='form-input small small-num-input ar-group-input' "
                  + "data-code='" + c.name + "' data-group='" + g + "' value='" + gVal + "' style='width:48px;'>"
                  + "</td>";
        });
        html += "</tr>";
    });
    html += "</table>";
    container.innerHTML = html;
}

// ── 선택된 년월/일의 데이터를 읽어와 폼에 채움 ──
function arLoadDayRequirement() {
    if (!isAdmin && !isSuperAdmin) return;
    var yyyymm = arGetSelectedYyyymm();
    var selD   = document.getElementById("arDay");
    var totalEl = document.getElementById("arTotalRequired");
    if (!yyyymm || !selD || !selD.value) return;
    var day = selD.value;

    var statusEl = document.getElementById("arLoadStatus");
    if (statusEl) statusEl.innerText = "불러오는 중...";

    arFetchConfig(yyyymm).then(function(cfg) {
        var activeCodes = arGetActiveCodesFrom(cfg);
        var dr = (cfg.dailyRequirements && cfg.dailyRequirements[day]) || null;

        if (totalEl) totalEl.value = (dr && dr.totalRequired != null) ? dr.totalRequired : "";
        arRenderRequirementTable(activeCodes, dr);
        if (statusEl) statusEl.innerText = "";
    }).catch(function(e) {
        if (statusEl) statusEl.innerText = "불러오기 실패: " + (e && e.message || e);
    });
}

// ── 현재 폼 값을 읽어 해당 날짜 데이터 객체로 조립 ──
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

// ── 저장: 해당 월 dailyRequirements 전체를 다시 읽어 병합 후 저장 ──
// (saveDeptConfig 는 top-level 키를 통째로 교체하므로, 다른 날짜 값이 사라지지
//  않도록 반드시 최신 전체 객체를 읽어와 이 날짜 항목만 갱신해서 다시 보낸다.)
function arSaveDayRequirement() {
    if (!isAdmin && !isSuperAdmin) return;
    var yyyymm = arGetSelectedYyyymm();
    var selD   = document.getElementById("arDay");
    if (!yyyymm || !selD || !selD.value) { alert("❌ 년/월/일을 선택해주세요."); return; }
    var day = selD.value;

    var newDayData = arCollectDayDataFromForm();

    arFetchConfig(yyyymm).then(function(cfg) {
        var fullDR = Object.assign({}, cfg.dailyRequirements || {});
        if (Object.keys(newDayData).length === 0) {
            delete fullDR[day]; // 전부 비워서 저장하면 해당 날짜 설정을 삭제
        } else {
            fullDR[day] = newDayData;
        }

        return fn.saveDeptConfig({
            deptId: currentDept,
            yyyymm: yyyymm,
            config: { dailyRequirements: fullDR }
        });
    }).then(function() {
        alert("✨ " + yyyymm.slice(0, 4) + "년 " + parseInt(yyyymm.slice(4, 6), 10) + "월 " + day + "일 필요인원 저장 완료.");
    }).catch(function(e) {
        alert(e && e.message || "저장 실패");
    });
}

// ── 설정 페이지 진입 시 초기화 (index.html의 showPage() 훅에서 호출) ──
function arInitDailyRequirementsUI() {
    if (!isAdmin && !isSuperAdmin) return;
    arInitYearMonthSelects();
    arRefreshDaySelectOptions();
    arLoadDayRequirement();
}

// ── 년/월 변경 시: 일 옵션 재계산 + 데이터 다시 로드 ──
function arOnMonthChange() {
    arRefreshDaySelectOptions();
    arLoadDayRequirement();
}
