/**
 * auto-schedule-ui.js — "자동 스케줄 관리" 카드/모달의 UI 배선.
 *
 * 이 파일은 기존 liveDBData / deptEmployees / adminViewCache / persistent groups
 * 등 기존 화면이 이미 사용 중인 데이터만 "읽어서" js/auto-schedule-engine.js가
 * 요구하는 input 형태로 변환하고, 결과(초안/충돌/조정후보/재검사)를 렌더링한다.
 *
 * ⚠️ 이 파일은 어떤 기존 데이터 경로(userRequests/adminView/requestsLedger)에도
 * 절대 쓰지 않는다. 유일한 쓰기는 새 자동 스케줄링 전용 설정 3종
 * (monthlyOffTarget/maxConsecutiveWork/codeLinkRestrictions)을 기존
 * saveDeptConfig 콜러블(이미 admin 권한 검증 + 임의 키 병합을 지원)로 저장하는 것뿐이며,
 * "스케줄 확정"은 이번 1차 구현에서 실제 Production write를 수행하지 않는다
 * (아래 confirmAutoSchedule 참고).
 *
 * previousMonthWorkTail(전월 말일부터 이어지는 연속근무) 소스: departments/{deptId}/
 * finalSchedules/{전월 yyyymm}만 authoritative source로 사용한다. adminView(직원이
 * "신청"한 데이터일 뿐 확정 스케줄이 아님)는 절대 이 계산에 사용하지 않는다.
 * 전월 finalSchedules가 아직 없으면(예: 이 기능을 처음 쓰는 달) tail은 0으로
 * 처리하고, "전월 확정 스케줄이 없어 월초 연속근무 검사는 이번 달 기준으로만
 * 수행됩니다" 경고를 화면과 조건검사결과 Excel 시트에 모두 노출한다.
 *
 * "스케줄 확정"은 실제로 functions.confirmAutoSchedule 콜러블을 호출해
 * departments/{deptId}/finalSchedules/{yyyymm}에 저장한다(서버가 assertAdmin +
 * 핵심 rule 재검증 + 원자적 트랜잭션으로 처리 — 이미 확정본이 있으면 overwrite하지
 * 않고 already-exists 에러를 반환한다). 이 파일 자체는 여전히 어떤 기존 데이터
 * 경로(userRequests/adminView/requestsLedger)에도 절대 쓰지 않는다.
 */

var _autoScheduleState = {
    draft: null,
    revalidation: null,
    input: null,
    previousMonthWorkTail: {},
    previousMonthLastScheduleCode: {},
    previousMonthTailLoaded: false,
    previousMonthTailWarning: "",
    existingFinalSchedule: null, // 이번 달 finalSchedules가 이미 존재하면 그 meta를 담는다
    existingFinalScheduleChecked: false,
    confirmedJustNow: false,
    forcedOverrides: [],      // 관리자가 이미 [적용]한 신청휴무 조정 누적 목록 — 재편성 때마다 고정 제약으로 재주입
    selectedCandidate: null,  // 후보 이름을 클릭해 "선택만" 한 상태(아직 draft에 반영 안 됨) — {conflictIndex,uid,name,day,group,scheduleCode,originalType}
    bulkCalculating: false,   // [신청휴무 일괄 자동조정] 계산 중(중복 클릭 방지 + "계산 중..." 표시)
    bulkPlan: null,           // AutoScheduleEngine.planBulkOverrides() 결과 — [일괄 적용] 전까지는 live draft에 전혀 반영되지 않는 순수 미리보기
    bulkPreviewActive: false, // true인 동안만 미리보기 패널을 표시
    shortageDiagnostic: null, // AutoScheduleEngine.summarizeShortageDiagnostics() 결과 캐시(렌더할 때마다 재계산 — draft/grid는 절대 건드리지 않는 순수 read-only 진단)
    ui: null,                 // 결과 팝업 접기/펼치기(accordion) 표시 상태 — 순수 UI 상태, solver/draft/revalidation 계산에는 전혀 관여하지 않는다. _freshAutoScheduleUiState() 참고.
};

/**
 * 결과 팝업의 모든 접기/펼치기 상태를 "전부 접힌" 초기값으로 되돌린다.
 * ⚠️ 이 객체는 순수 표시 상태(어떤 카드를 펼쳐서 보여줄지)만 담으며, 여기 담긴
 * 어떤 값도 solver/revalidation/diagnostic 계산 입력으로 쓰이지 않는다.
 * 새 draft가 생성되거나(재생성/override 적용/일괄 적용) shortageDiagnostic의
 * details 배열 인덱스가 바뀔 수 있는 시점마다 반드시 호출해, 이전 인덱스 기준으로
 * 열려 있던 날짜/직원 상세가 엉뚱한 항목을 가리키는 것을 방지한다.
 */
function _freshAutoScheduleUiState() {
    return {
        passOpen: false,      // "정상 조건 N개" accordion
        warnOpen: false,      // "권장휴무 미달 N명" accordion
        rawFailOpen: {},      // 실패 check 인덱스 → 원본 상세 문자열 펼침 여부
        groupOpen: {},        // 조 글자("A" 등) → 날짜별 표 펼침 여부
        dateOpen: {},         // shortageDiagnostic.details 인덱스 → 원인 상세 펼침 여부
        employeeOpen: {},     // shortageDiagnostic.details 인덱스 → 후보 직원 상세 펼침 여부
        capacityOpen: false,  // "월간 인력 여유 분석" accordion
        // ⚠️ Codex 회귀(override_workflow_test.js, cache-independent) — candidate
        // select 시점에 shortageDiagnostic 캐시가 아직 없을 수 있어(예: 직접 함수
        // 호출로 재검사 직후 첫 렌더 전) 배열 인덱스를 그 자리에서 못 찾을 수 있다.
        // 대신 group+day+scheduleCode로 만든 안정적인 UI-only key(_autoScheduleShortageKey
        // 참고 — solver semantics가 아니라 순수 UI 식별자)를 여기 잠깐 보관해 두면,
        // 다음 _renderShortageDiagnosticSection 호출(같은 렌더 사이클 안에서 바로
        // 이어짐)이 그 시점에 실제로 계산된 details 배열에서 이 key와 일치하는
        // 항목을 찾아 그때의 진짜 인덱스로 dateOpen을 연다. 해소되면 즉시 비운다.
        pendingOpenShortageKey: null,
    };
}

/** shortageDiagnostic.details 항목 하나(d)와 draft.conflicts의 work_shortfall
 *  conflict 하나는 둘 다 {group, day, scheduleCode}를 가진다 — 이 세 값으로 만든
 *  문자열이 "이 특정 부족"을 가리키는 안정적인 UI-only 식별자다(배열 인덱스와
 *  달리 diagnostic이 아직 계산 안 됐어도/재계산돼도 값이 변하지 않는다). solver가
 *  이 key를 계산하거나 참조하지 않으며, 여기서 만드는 값도 solver에 절대 전달되지
 *  않는다(순수 accordion 열림 상태 매칭용). */
function _autoScheduleShortageKey(obj) {
    if (!obj) return "";
    return String(obj.group) + "|" + String(obj.day) + "|" + String(obj.scheduleCode);
}

function _isAutoScheduleLocked() {
    return _autoScheduleState.confirmedJustNow || (_autoScheduleState.existingFinalScheduleChecked && !!_autoScheduleState.existingFinalSchedule);
}

// ── 입력 데이터 매핑 ──────────────────────────────────────────────────────────

function _autoScheduleGroupOfUid(uid) {
    var letters = ["A", "B", "C", "D", "E"];
    for (var i = 0; i < letters.length; i++) {
        var list = getLiveGroupList(letters[i]).map(_normalizeGroupToken);
        if (list.indexOf(uid) !== -1) return letters[i];
    }
    return null;
}

function _getAutoCodeLinkRestrictions() {
    var raw = liveDBData["_autoCodeLinkRestrictions"];
    if (!raw) return [];
    if (Array.isArray(raw)) return raw;
    try { return JSON.parse(raw); } catch (e) { return []; }
}

function _buildAutoScheduleInput() {
    var tm = getTargetYearMonth();
    var year = parseInt(tm.year, 10);
    var month = parseInt(tm.month, 10);

    var employees = deptEmployees
        .map(function (emp) {
            return {
                uid: emp.uid,
                empNo: emp.empNo,
                name: emp.name,
                sortOrder: emp.sortOrder != null ? emp.sortOrder : null,
                group: _autoScheduleGroupOfUid(emp.uid),
            };
        })
        .filter(function (e) { return !!e.group; }); // 미배정(POOL) 직원은 자동 스케줄링 대상에서 제외

    var groups = {};
    ["A", "B", "C", "D", "E"].forEach(function (g) {
        groups[g] = getLiveGroupList(g).map(_normalizeGroupToken).filter(function (t) { return !!t; });
    });

    var config = {
        dayMax: parseInt(getFirebaseItem("rq_config_day_max", "10"), 10),
        specialDayLimits: _buildSpecialDayLimitsFromLiveData(),
        groupDayLimits: _buildGroupDayLimitsFromLiveData(),
        groupDayLimitsEnabled: liveDBData["_groupDayLimitsEnabled"] === true,
        scGroupDayLimits: _buildScGroupDayLimitsFromLiveData(),
        scGroupDayLimitsEnabled: liveDBData["_scGroupDayLimitsEnabled"] === true,
        scGroupLimits: _buildScGroupLimitsFromLiveData(),
        scheduleCodes: getScheduleCodeList(),
    };
    ["A", "B", "C", "D", "E"].forEach(function (g) {
        var v = getFirebaseItem("rq_config_group_max_" + g, null);
        config["groupMax" + g] = v != null ? parseInt(v, 10) : null;
    });

    var monthlyOffTargetVal = parseInt(getFirebaseItem("rq_auto_monthly_off_target", "0"), 10) || 0;
    var monthlyOffMinimumRaw = getFirebaseItem("rq_auto_monthly_off_minimum", null);
    var autoConfig = {
        monthlyOffTarget: monthlyOffTargetVal,
        // 레거시 fallback: minimum이 저장된 적 없으면 target과 동일하게 취급
        // (AutoScheduleEngine._monthlyOffMinimum과 정확히 동일한 semantics).
        monthlyOffMinimum: monthlyOffMinimumRaw != null ? (parseInt(monthlyOffMinimumRaw, 10) || 0) : monthlyOffTargetVal,
        maxConsecutiveWork: parseInt(getFirebaseItem("rq_auto_max_consecutive_work", "0"), 10) || 0,
        codeLinkRestrictions: _getAutoCodeLinkRestrictions(),
    };

    var existingRequests = {};
    Object.keys(adminViewCache || {}).forEach(function (uid) {
        existingRequests[uid] = adminViewCache[uid];
    });

    return {
        year: year, month: month,
        employees: employees, groups: groups,
        config: config, autoConfig: autoConfig,
        existingRequests: existingRequests,
        previousMonthWorkTail: _autoScheduleState.previousMonthWorkTail || {},
        previousMonthLastScheduleCode: _autoScheduleState.previousMonthLastScheduleCode || {},
    };
}

function _prevYyyymm(y, m) {
    var py = (m === 1) ? (y - 1) : y;
    var pm = (m === 1) ? 12 : (m - 1);
    return { py: py, pm: pm, pyyyymm: String(py) + String(pm).padStart(2, "0") };
}

/** 전월 finalSchedules(확정 스케줄)에서만 (1) 말일부터의 연속근무일수와 (2) 전월
 *  마지막 근무코드를 계산한다. adminView(신청 데이터)는 authoritative source로
 *  절대 사용하지 않는다. 읽기 전용.
 *
 *  ⚠️ workTail과 lastScheduleCode는 서로 다른 정보다(둘 다 말일 데이터에서
 *  파생되지만 같은 조건으로 유추하면 안 된다) — 예: 8/30 근무·8/31 휴무면
 *  workTail=0이면서 lastScheduleCode도 null이어야 하고, 8/30 휴무·8/31 근무면
 *  workTail=1이면서 lastScheduleCode=그 코드여야 한다. lastScheduleCode는 오직
 *  "전월 마지막 달력 날짜(말일) 자체가 schedule일 때만" 그 코드를 쓴다 — 말일이
 *  근무가 아니면(정확히 그 즉시 streak walk가 끊기므로) null이 된다. 이는
 *  functions/src/confirmAutoSchedule.js의 prevLastCodeByUid 계산과 정확히
 *  동일한 semantics다(server/client parity). */
function _loadPreviousMonthWorkTail() {
    var tm = getTargetYearMonth();
    var y = parseInt(tm.year, 10), m = parseInt(tm.month, 10);
    var prev = _prevYyyymm(y, m);
    var path = "departments/" + currentDept + "/finalSchedules/" + prev.pyyyymm;

    return db.ref(path).once("value").then(function (snap) {
        var finalData = snap.val();
        if (!finalData || !finalData.employees) {
            _autoScheduleState.previousMonthWorkTail = {};
            _autoScheduleState.previousMonthLastScheduleCode = {};
            _autoScheduleState.previousMonthTailWarning = "전월(" + prev.pyyyymm + ") 확정 스케줄이 없어 월초 연속근무 검사는 이번 달 기준으로만 수행됩니다.";
            _autoScheduleState.previousMonthTailLoaded = true;
            return {};
        }
        var prevDays = new Date(prev.py, prev.pm, 0).getDate();
        var tail = {};
        var lastCode = {};
        Object.keys(finalData.employees).forEach(function (uid) {
            var days = (finalData.employees[uid] && finalData.employees[uid].days) || {};
            var streak = 0;
            for (var d = prevDays; d >= 1; d--) {
                var entry = days[String(d)];
                if (entry && entry.type === "schedule") {
                    streak++;
                    if (d === prevDays) lastCode[uid] = entry.scheduleCode; // 말일 자체가 근무일 때만 사용
                } else {
                    break;
                }
            }
            if (streak > 0) tail[uid] = streak;
        });
        _autoScheduleState.previousMonthWorkTail = tail;
        _autoScheduleState.previousMonthLastScheduleCode = lastCode;
        _autoScheduleState.previousMonthTailWarning = "";
        _autoScheduleState.previousMonthTailLoaded = true;
        return tail;
    }).catch(function () {
        _autoScheduleState.previousMonthWorkTail = {};
        _autoScheduleState.previousMonthLastScheduleCode = {};
        _autoScheduleState.previousMonthTailWarning = "전월 확정 스케줄을 불러오지 못해 월초 연속근무 검사는 이번 달 기준으로만 수행됩니다.";
        _autoScheduleState.previousMonthTailLoaded = true;
        return {};
    });
}

/** 이번 달 finalSchedules가 이미 존재하는지 확인한다(재확정/자동 overwrite 방지용, 읽기 전용). */
function _checkExistingFinalSchedule() {
    var tm = getTargetYearMonth();
    var path = "departments/" + currentDept + "/finalSchedules/" + tm.fullStr;
    return db.ref(path).once("value").then(function (snap) {
        _autoScheduleState.existingFinalSchedule = snap.val();
        _autoScheduleState.existingFinalScheduleChecked = true;
        return _autoScheduleState.existingFinalSchedule;
    }).catch(function () {
        _autoScheduleState.existingFinalSchedule = null;
        _autoScheduleState.existingFinalScheduleChecked = true;
        return null;
    });
}

// ── 설정 팝업 (월 총 휴무일수 / 최대 연속근무 / 근무코드 연결 제한) ───────────────

function openAutoScheduleSettingsModal() {
    if (!isAdmin && !isSuperAdmin) return;
    var elTarget = document.getElementById("autoScheduleMonthlyOffTarget");
    var elMinimum = document.getElementById("autoScheduleMonthlyOffMinimum");
    var elMaxConsec = document.getElementById("autoScheduleMaxConsecutive");
    if (elTarget) elTarget.value = getFirebaseItem("rq_auto_monthly_off_target", "");
    // 레거시 config(minimum 미설정)면 입력창은 target과 같은 값으로 채워 보여준다 —
    // 저장을 누르지 않는 한 실제 semantics는 여전히 "미설정=target과 동일" fallback을
    // 그대로 따르므로 화면 표시만을 위한 것이고, 데이터를 임의로 변경하지 않는다.
    if (elMinimum) {
        var rawMinimum = getFirebaseItem("rq_auto_monthly_off_minimum", null);
        elMinimum.value = rawMinimum != null ? rawMinimum : getFirebaseItem("rq_auto_monthly_off_target", "");
    }
    if (elMaxConsec) elMaxConsec.value = getFirebaseItem("rq_auto_max_consecutive_work", "");
    _renderAutoCodeLinkList();
    var el = document.getElementById("autoScheduleSettingsModal");
    if (el) el.style.display = "flex";
}

function closeAutoScheduleSettingsModal() {
    var el = document.getElementById("autoScheduleSettingsModal");
    if (el) el.style.display = "none";
}

function _renderAutoCodeLinkList() {
    var listEl = document.getElementById("autoCodeLinkList");
    var fromSel = document.getElementById("autoCodeLinkFrom");
    var toSel = document.getElementById("autoCodeLinkTo");
    if (!listEl) return;

    var codes = getScheduleCodeList().map(function (c) { return c.name; });
    if (fromSel && toSel) {
        var optHtml = codes.map(function (c) { return "<option value='" + _escapeHtml(c) + "'>" + _escapeHtml(c) + "</option>"; }).join("");
        fromSel.innerHTML = optHtml;
        toSel.innerHTML = optHtml;
    }

    var restrictions = _getAutoCodeLinkRestrictions();
    if (!restrictions.length) {
        listEl.innerHTML = "<span class='auto-schedule-codelink-empty'>설정된 연결 제한 없음</span>";
        return;
    }
    listEl.innerHTML = restrictions.map(function (r, idx) {
        return "<div class='auto-codelink-row' style='display:flex;align-items:center;gap:6px;margin-bottom:4px;'>"
            + "<span class='auto-schedule-codelink-row'>" + _escapeHtml(r.from) + " → " + _escapeHtml(r.to) + " 금지</span>"
            + "<button type='button' class='btn btn-secondary' style='padding:2px 8px;font-size:11px;' onclick='removeAutoCodeLinkRestriction(" + idx + ")'>삭제</button>"
            + "</div>";
    }).join("");
}

function addAutoCodeLinkRestriction() {
    var fromSel = document.getElementById("autoCodeLinkFrom");
    var toSel = document.getElementById("autoCodeLinkTo");
    var from = fromSel && fromSel.value;
    var to = toSel && toSel.value;
    if (!from || !to) { alert("코드를 선택해주세요."); return; }
    if (from === to) { alert("같은 코드끼리는 연결 제한을 설정할 수 없습니다."); return; }

    var restrictions = _getAutoCodeLinkRestrictions();
    var exists = restrictions.some(function (r) { return r.from === from && r.to === to; });
    if (exists) { alert("이미 등록된 연결 제한입니다."); return; }

    restrictions.push({ from: from, to: to });
    liveDBData["_autoCodeLinkRestrictions"] = restrictions; // 낙관적 반영, 저장은 [적용]에서 saveDeptConfig로
    _renderAutoCodeLinkList();
}

function removeAutoCodeLinkRestriction(index) {
    var restrictions = _getAutoCodeLinkRestrictions();
    restrictions.splice(index, 1);
    liveDBData["_autoCodeLinkRestrictions"] = restrictions;
    _renderAutoCodeLinkList();
}

function saveAutoScheduleSettings() {
    if (!isAdmin && !isSuperAdmin) return;
    var elTarget = document.getElementById("autoScheduleMonthlyOffTarget");
    var elMinimum = document.getElementById("autoScheduleMonthlyOffMinimum");
    var elMaxConsec = document.getElementById("autoScheduleMaxConsecutive");
    var target = parseInt((elTarget && elTarget.value) || "0", 10);
    var minimum = parseInt((elMinimum && elMinimum.value) || "0", 10);
    var maxConsec = parseInt((elMaxConsec && elMaxConsec.value) || "0", 10);

    if (isNaN(target) || target < 0) { alert("권장 월 휴무일수는 0 이상의 숫자여야 합니다."); return; }
    if (isNaN(minimum) || minimum < 0) { alert("최소 월 휴무일수는 0 이상의 숫자여야 합니다."); return; }
    if (target < minimum) { alert("권장 월 휴무일수는 최소 월 휴무일수보다 작을 수 없습니다."); return; }
    if (isNaN(maxConsec) || maxConsec < 1) { alert("최대 연속근무는 1 이상의 숫자여야 합니다."); return; }

    var codeLinkRestrictions = _getAutoCodeLinkRestrictions();

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: {
            monthlyOffTarget: target,
            monthlyOffMinimum: minimum,
            maxConsecutiveWork: maxConsec,
            codeLinkRestrictions: codeLinkRestrictions,
        },
    }).then(function () {
        liveDBData["rq_auto_monthly_off_target"] = target;
        liveDBData["rq_auto_monthly_off_minimum"] = minimum;
        liveDBData["rq_auto_max_consecutive_work"] = maxConsec;
        liveDBData["_autoCodeLinkRestrictions"] = codeLinkRestrictions;
        alert("자동 스케줄링 설정이 저장되었습니다.");
        closeAutoScheduleSettingsModal();
        _updateAutoScheduleCardSummary();
    }).catch(function (e) {
        alert((e && e.message) || "저장 실패");
    });
}

function _updateAutoScheduleCardSummary() {
    var el = document.getElementById("autoScheduleCardSummary");
    if (!el) return;
    var target = getFirebaseItem("rq_auto_monthly_off_target", null);
    var minimumRaw = getFirebaseItem("rq_auto_monthly_off_minimum", null);
    var minimum = minimumRaw != null ? minimumRaw : target; // 레거시 fallback = target(엔진과 동일 semantics)
    var maxConsec = getFirebaseItem("rq_auto_max_consecutive_work", null);
    if (target == null || maxConsec == null) {
        el.textContent = "설정 필요 (월 총 휴무일수 / 최대 연속근무)";
    } else {
        el.textContent = "월 휴무 권장 " + target + "일/최소 " + minimum + "일 · 최대 연속근무 " + maxConsec + "일";
    }
}

// ── 생성/미리보기 모달 ────────────────────────────────────────────────────────

function openAutoScheduleModal() {
    if (!isAdmin && !isSuperAdmin) return;
    _autoScheduleState.draft = null;
    _autoScheduleState.revalidation = null;
    _autoScheduleState.input = null;
    _autoScheduleState.confirmedJustNow = false;
    _autoScheduleState.existingFinalScheduleChecked = false;
    _autoScheduleState.previousMonthTailLoaded = false;
    _autoScheduleState.forcedOverrides = [];
    _autoScheduleState.selectedCandidate = null;
    _autoScheduleState.bulkCalculating = false;
    _autoScheduleState.bulkPlan = null;
    _autoScheduleState.bulkPreviewActive = false;
    _autoScheduleState.ui = _freshAutoScheduleUiState();
    var el = document.getElementById("autoScheduleModal");
    if (el) el.style.display = "flex";
    _renderAutoScheduleModal();
    Promise.all([_loadPreviousMonthWorkTail(), _checkExistingFinalSchedule()]).then(function () { _renderAutoScheduleModal(); });
}

function closeAutoScheduleModal() {
    var el = document.getElementById("autoScheduleModal");
    if (el) el.style.display = "none";
}

function generateAutoScheduleDraft() {
    if (!isAdmin && !isSuperAdmin) return;
    var target = getFirebaseItem("rq_auto_monthly_off_target", null);
    var maxConsec = getFirebaseItem("rq_auto_max_consecutive_work", null);
    if (target == null || maxConsec == null) {
        alert("먼저 [설정 관리]에서 월 총 휴무일수 / 최대 연속근무를 설정해주세요.");
        return;
    }
    if (_autoScheduleState.existingFinalSchedule) {
        var meta = _autoScheduleState.existingFinalSchedule.meta || {};
        var confirmedAtLabel = meta.confirmedAt ? new Date(meta.confirmedAt).toLocaleString() : "알 수 없음";
        if (!confirm("이미 확정된 스케줄이 있습니다(확정 시각: " + confirmedAtLabel + "). 새로 생성해도 기존 확정본은 자동으로 덮어쓰지 않습니다. 미리보기만 계속하시겠습니까?")) {
            return;
        }
    }
    // ⚠️ 다시 생성은 기존 forcedOverrides(수동/일괄 조정 내역)를 초기화하는 기존
    // Production semantics를 그대로 유지한다(재편성 알고리즘 자체는 이번 작업에서
    // 손대지 않음) — 다만 이미 초안이 있고 조정 내역이 존재하는 상태에서 실수로
    // 다시 누르면 그 내역을 잃을 수 있으므로, 그 경우에만 명시적으로 확인한다.
    if (_autoScheduleState.draft && _autoScheduleState.forcedOverrides && _autoScheduleState.forcedOverrides.length > 0) {
        if (!confirm("현재 조정 내역이 초기화됩니다. 다시 생성하시겠습니까?")) {
            return;
        }
    }
    var input = _buildAutoScheduleInput();
    _autoScheduleState.input = input;
    _autoScheduleState.forcedOverrides = []; // 새로 생성하면 이전 override 누적은 초기화
    _autoScheduleState.selectedCandidate = null;
    _autoScheduleState.bulkCalculating = false;
    _autoScheduleState.ui = _freshAutoScheduleUiState(); // 새 draft → shortageDiagnostic.details 인덱스가 바뀌므로 접기 상태 초기화
    _autoScheduleState.bulkPlan = null;
    _autoScheduleState.bulkPreviewActive = false;
    _autoScheduleState.draft = AutoScheduleEngine.generateDraft(input);
    _autoScheduleState.revalidation = null;
    _renderAutoScheduleModal();
}

/**
 * ⚠️ 문제2(적용 후 자동 재검사) — [조건 재검사] 버튼(revalidateAutoSchedule)과
 * 직접조정/일괄조정 적용 직후(confirmApplyAutoScheduleCandidate/
 * confirmBulkAutoAdjustment) 양쪽 모두 이 한 함수만 사용한다(중복 검증 로직을
 * 새로 만들지 않는다 — 기존 authoritative AutoScheduleEngine.revalidateDraft를
 * 정확히 동일한 인자로 재사용). draft/input이 없으면 아무 것도 하지 않는다.
 */
function _recomputeAutoScheduleRevalidation() {
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return;
    _autoScheduleState.revalidation = AutoScheduleEngine.revalidateDraft(_autoScheduleState.draft, _autoScheduleState.input);
}

function revalidateAutoSchedule() {
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return;
    _recomputeAutoScheduleRevalidation();
    _renderAutoScheduleModal();
}

function _autoScheduleCandidatesFor(conflictIndex) {
    var draft = _autoScheduleState.draft, input = _autoScheduleState.input;
    if (!draft || !input) return [];
    var conflict = draft.conflicts[conflictIndex];
    if (!conflict || conflict.kind !== "work_shortfall") return [];
    return AutoScheduleEngine.findOverrideCandidates(
        draft, conflict, input.employees, input.groups, input.autoConfig,
        input.previousMonthWorkTail, input.previousMonthLastScheduleCode,
        (input.config || {}).scheduleCodes
    );
}

function toggleAutoScheduleCandidates(conflictIndex) {
    var el = document.getElementById("autoScheduleCandidates_" + conflictIndex);
    if (!el) return;
    var show = el.style.display === "none";
    el.style.display = show ? "block" : "none";
    if (show) el.innerHTML = _renderCandidateListHtml(conflictIndex);
}

function _renderCandidateListHtml(conflictIndex) {
    var candidates = _autoScheduleCandidatesFor(conflictIndex);
    if (!candidates.length) {
        return "<div class='auto-schedule-candidate-empty'>조정 가능한 직원 없음</div>";
    }
    return candidates.map(function (c) {
        return "<button type='button' class='btn btn-secondary' style='margin:2px;font-size:11px;padding:3px 8px;' "
            + "onclick='selectAutoScheduleCandidate(" + conflictIndex + ", \"" + c.uid.replace(/"/g, "") + "\")'>"
            + _escapeHtml(c.name || c.uid) + "</button>";
    }).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// [부족 인원 상세 분석] — 조건 재검사 UI 개선(관리자 진단용, read-only)
//
// ⚠️ 이 섹션은 AutoScheduleEngine.summarizeShortageDiagnostics()(순수 진단
// 함수, solver 로직/draft/grid를 전혀 mutate하지 않음)의 결과를 그대로
// render만 한다 — 판정 로직을 이 파일에서 새로 구현하지 않는다(solver와 UI
// 판정이 어긋나는 구조를 피하기 위함). 여기서 만드는 어떤 클릭/토글도
// _autoScheduleState.draft/input을 바꾸지 않는다(순수 표시 상태 토글뿐 —
// _autoScheduleState.ui에만 기록된다).
//
// 정보 계층(요약 → 조별 → 날짜별 → 원인 → 직원)은 아래 순서로 구현한다:
//   _buildAutoScheduleHeroModel/_renderAutoScheduleHeroHtml       — 요약
//   _renderShortageDiagnosticSection → 조별 accordion             — 조
//   _renderAutoScheduleGroupDateTableHtml                         — 날짜
//   _renderAutoScheduleDateDetailHtml                             — 원인
//   _renderShortageEmployeeDetailHtml(toggleShortageEmployeeDetail) — 직원
// ═══════════════════════════════════════════════════════════════════════════
var AUTO_SCHEDULE_BLOCKER_LABEL = {
    CODE_CAP: "월 근무코드 상한",
    MIN_OFF: "최소휴무 9일 제한",
    MAX_CONSECUTIVE_WORK: "최대 연속근무 4일 제한",
    CODE_LINK: "근무코드 연결 제한(P→A)",
};

// ⚠️ enum 값(FULL/PARTIAL/NO_DIRECT_CANDIDATE) 자체는 그대로(계산 변경 없음),
// 사용자에게 노출하는 한국어 문구만 이번 작업에서 다듬었다(STEP18 요구 문구).
var AUTO_SCHEDULE_SHORTAGE_JUDGEMENT_LABEL = {
    FULL: "직접 조정 후보 기준 충족 가능",
    PARTIAL: "일부만 직접 조정 가능",
    NO_DIRECT_CANDIDATE: "현재 직접 조정 후보 없음",
};
var AUTO_SCHEDULE_SHORTAGE_JUDGEMENT_CLASS = {
    FULL: "auto-schedule-shortage-feasible",
    PARTIAL: "auto-schedule-shortage-partial",
    NO_DIRECT_CANDIDATE: "auto-schedule-shortage-infeasible",
};
// 조건 재검사 원본 raw 문자열(예: "A/P@6(0!=2)")을 만드는 check 이름 — 이 check만
// shortageDiagnostic 요약 수치("N개 항목 / 총 M석 부족")로 기본 화면에 노출하고,
// 원본 문자열은 접어서 숨긴다(STEP3). 문자열 자체는 engine.js가 그대로 생성한 것을
// 삭제 없이 접기 안에 그대로 보존한다.
var AUTO_SCHEDULE_QUOTA_CHECK_NAME = "날짜/조/근무코드 정원 정확히 충족";

/**
 * shortageDiagnostic.details를 조(group)별로 묶어 "조당 부족 석수" 배열을 만든다.
 * 실제 등장한 조만 포함하고(0석인 조는 만들지 않음), 등장 순서를 그대로 유지한다
 * (STEP2 "B조 shortage 0이면 표시하지 않는다"와 동일 기준). 순수 함수 — 어떤 상태도
 * 읽거나 바꾸지 않는다(테스트 용이성을 위해 shortageDiagnostic을 인자로 받는다).
 */
function _buildAutoScheduleGroupBreakdown(shortageDiagnostic) {
    if (!shortageDiagnostic || !shortageDiagnostic.details) return [];
    var order = [], seats = {};
    shortageDiagnostic.details.forEach(function (d) {
        var g = d.group || "미지정";
        if (!Object.prototype.hasOwnProperty.call(seats, g)) { seats[g] = 0; order.push(g); }
        seats[g] += d.gap || 0;
    });
    return order.filter(function (g) { return seats[g] > 0; }).map(function (g) { return { group: g, seats: seats[g] }; });
}

/**
 * Hero 요약 카드에 필요한 값만 뽑아낸 순수 데이터 모델. draft.ok(기존 authoritative
 * 확정 가능 여부 플래그)를 그대로 사용하고, 여기서 새로운 pass/fail 판정을
 * 만들지 않는다 — solver/revalidation 판정 로직 재구현 금지 원칙을 그대로 따른다.
 */
function _buildAutoScheduleHeroModel(draft, shortageDiagnostic) {
    var conflicts = (draft && draft.conflicts) || [];
    return {
        ok: !!(draft && draft.ok),
        totalGapSeats: shortageDiagnostic ? (shortageDiagnostic.totalGapSeats || 0) : 0,
        groupBreakdown: _buildAutoScheduleGroupBreakdown(shortageDiagnostic),
        workShortfallCount: conflicts.filter(function (c) { return c.kind === "work_shortfall"; }).length,
        conflictCount: conflicts.length,
    };
}

/** Hero 요약 카드 HTML(STEP2) — 항상 팝업 최상단에 1개만 표시된다. */
function _renderAutoScheduleHeroHtml(model, locked) {
    var html = "<div class='auto-schedule-result-hero " + (model.ok ? "is-ok" : "is-fail") + "'>";
    html += "<div class='auto-schedule-result-hero-title'>자동 스케줄 생성 결과</div>";
    if (model.ok) {
        html += "<div class='auto-schedule-result-hero-headline is-ok'>✅ 자동 스케줄 조건을 모두 충족했습니다.</div>";
    } else {
        html += "<div class='auto-schedule-result-hero-headline is-fail'>⚠ 확정할 수 없습니다</div>";
        if (model.totalGapSeats > 0) {
            html += "<div class='auto-schedule-result-hero-sub'>총 " + model.totalGapSeats + "석의 근무 인원이 부족합니다.</div>";
            if (model.groupBreakdown.length) {
                html += "<div class='auto-schedule-result-hero-groups'>" + model.groupBreakdown.map(function (g) {
                    return "<span class='auto-schedule-result-hero-group-chip'>" + _escapeHtml(String(g.group)) + (g.group === "미지정" ? "" : "조") + " " + g.seats + "석</span>";
                }).join("") + "</div>";
            }
        } else {
            html += "<div class='auto-schedule-result-hero-sub'>총 " + model.conflictCount + "건의 조건을 충족하지 못했습니다.</div>";
        }
    }
    html += "<div class='feature-card-action auto-schedule-result-hero-actions'>";
    if (!model.ok && model.workShortfallCount > 0 && !locked) {
        // ⚠️ Codex 회귀(bulk_ui_test.js) — 기존 문구 "신청휴무 일괄 자동조정"을
        // 그대로 복원한다(handler/기능은 startBulkAutoAdjustment() 그대로 무변경).
        html += "<button type='button' class='btn btn-primary-sm'" + (_autoScheduleState.bulkCalculating ? " disabled" : "")
            + " onclick='startBulkAutoAdjustment()'>" + (_autoScheduleState.bulkCalculating ? "계산 중..." : "신청휴무 일괄 자동조정") + "</button>";
    }
    // ⚠️ Codex 회귀(persistence_regenerate_test.js) — 기존 문구 "자동 스케줄 다시
    // 생성"을 그대로 복원한다(handler는 generateAutoScheduleDraft() 그대로 무변경).
    html += "<button type='button' class='btn btn-secondary' onclick='generateAutoScheduleDraft()'>자동 스케줄 다시 생성</button>";
    html += "</div></div>";
    return html;
}

/** 권장 월 일반휴무 미달 명단(STEP5) — draft.warnings/revalidation.warnings 둘 다 같은
 *  집합을 담고 있어(엔진 계산은 손대지 않음) 화면에는 하나만 고른다(STEP13 중복 제거):
 *  재검사를 이미 돌렸다면 그 결과(최신)를, 아니면 draft.warnings로 폴백한다. */
function _resolveAutoScheduleOffTargetShortfalls(draft, revalidation) {
    if (revalidation && revalidation.warnings && revalidation.warnings.length) {
        var w = revalidation.warnings.filter(function (x) { return x.kind === "monthly_off_target_shortfall_summary"; })[0];
        if (w) return w.employees || [];
    }
    return (draft && draft.warnings) || [];
}

/**
 * ⚠️ Codex 회귀(monthly_off_ui_test.js) — engine.js가 실제로 만들어 둔 aggregate
 * 문구("권장 월 일반휴무(10) 미달: 김아란 9일, 서한별 9일, ...")를 accordion을
 * 펼쳤을 때 손실 없이 보존한다. revalidation.warnings[...].message를 한 글자도
 * 재구성하지 않고 그대로 재사용한다(engine.js:3282-3286, kind
 * "monthly_off_target_shortfall_summary"). revalidation을 아직 돌리지 않아 이
 * aggregate 문구 자체가 존재하지 않는 경우에는 빈 문자열을 반환한다 — 이 함수가
 * 새로운 aggregate 문장을 스스로 조립하지는 않는다(엔진이 만들지 않은 문구를
 * UI가 새로 지어내지 않기 위함). 그 경우의 상세 내용은
 * _renderAutoScheduleWarningAccordionHtml이 draft.warnings의 개별 항목 자체가
 * 이미 갖고 있는 원문 .message(engine.js:2329, "이름 월 권장 일반휴무(N)에
 * M일 미달(최소 기준은 충족).")를 그대로 사용한다.
 */
function _resolveAutoScheduleOffTargetMessage(revalidation) {
    if (revalidation && revalidation.warnings && revalidation.warnings.length) {
        var w = revalidation.warnings.filter(function (x) { return x.kind === "monthly_off_target_shortfall_summary"; })[0];
        if (w && w.message) return w.message;
    }
    return "";
}

/** ⚠ 권장휴무 미달 accordion(STEP5) — 기본 접힘, 인원 수만 먼저 보여준다. */
function _renderAutoScheduleWarningAccordionHtml(draft, revalidation, ui) {
    var list = _resolveAutoScheduleOffTargetShortfalls(draft, revalidation);
    if (!list.length) return "";
    var minOffOk = true;
    if (revalidation) {
        var minCheck = revalidation.checks.filter(function (c) { return c.name === "최소 월 일반휴무 준수"; })[0];
        if (minCheck) minOffOk = minCheck.ok;
    }
    var open = !!ui.warnOpen;
    var html = "<div class='auto-schedule-warning'>";
    // ⚠️ Codex 회귀(monthly_off_ui_test.js) — 기본 접힘 summary 자체에 레거시 문구
    // "권장 월 일반휴무 미달(최소 기준은 충족, 확정 가능)"이 그대로 존재해야 한다
    // (HEAD 커밋본 js/auto-schedule-ui.js:879에서 확인한 원문, 새로 지어낸 문구
    // 아님). hidden span/주석 삽입이 아니라 실제 사용자가 보는 한 줄 요약에
    // 포함시켜 compact UI와 레거시 계약을 동시에 만족시킨다.
    html += "<div>⚠ 권장 월 일반휴무 미달(최소 기준은 충족, 확정 가능) · " + list.length + "명</div>";
    if (minOffOk) html += "<div class='auto-schedule-hint' style='margin:2px 0 0;'>최소 휴무 기준은 모두 충족했습니다.</div>";
    html += "<button type='button' class='auto-schedule-result-mini-toggle' aria-expanded='" + (open ? "true" : "false")
        + "' aria-controls='autoScheduleWarningList' onclick='toggleAutoScheduleWarningList()'>대상자 보기 " + (open ? "▲" : "▼") + "</button>";
    html += "<div id='autoScheduleWarningList'" + (open ? "" : " style='display:none;'") + " style='margin-top:4px;'>";
    if (open) {
        // ⚠️ 여기서 어떤 문구도 새로 조립하지 않는다 — 전부 engine.js가 이미 만들어
        // 둔 원문(message 필드)을 그대로 옮길 뿐이다(STEP1 "재구성 금지, 원문
        // 재사용" 요구). revalidation을 이미 돌렸다면 aggregate 원문 한 줄을 먼저
        // 보여주고(engine.js가 만든 정확한 문구), 그 아래 draft.warnings/
        // revalidation.employees 각 항목의 원문 message(있으면) 또는 최소한의
        // 이름+일수를 이어서 보여준다 — 요약 1회(펼치기 버튼 위) + 상세 1회
        // (여기)의 정상적인 계층 구성이지, 같은 문장을 두 번 반복하는 게 아니다.
        var aggMsg = _resolveAutoScheduleOffTargetMessage(revalidation);
        if (aggMsg) html += "<div>" + _escapeHtml(aggMsg) + "</div>";
        list.forEach(function (w) {
            var itemText = w.message ? w.message : ((w.empName || w.empKey || w.uid || "") + " " + w.actual + "일");
            html += "<div>" + (aggMsg ? "- " : "") + _escapeHtml(itemText) + "</div>";
        });
    }
    html += "</div></div>";
    return html;
}

/** work_shortfall이 아닌 나머지 conflict만 그대로 카드로 보여준다(STEP6 — 같은
 *  근무 인원 부족 정보를 상단에 카드로 반복하지 않고 Hero+조별 accordion으로만 표시). */
// ⚠️ 문제3(search_limit_exceeded 개발자 문구) — engine.js가 만드는 원문(kind:
// "search_limit_exceeded", message: "fallback 탐색이 시간/반복 한도 내에 대체
// 배정을 찾지 못했습니다(진짜 infeasible일 수도 있습니다).")은 그대로 두고(계산/
// data 무변경), UI에서만 이 kind를 사용자 친화 제목/설명으로 바꿔 보여준다.
// "탐색 시간/반복 한도 안에서 대체 배정을 찾지 못함"이라는 의미를 "해결
// 불가능/인력 부족 확정/절대 배정 불가"처럼 단정하지 않고 "자동으로 해결하지
// 못했습니다" 정도로만 표현한다(engine.js 원문의 의미 그대로, 더 강하게도
// 약하게도 바꾸지 않음).
var AUTO_SCHEDULE_SEARCH_LIMIT_TITLE = "일부 부족 항목 자동 조정 미완료";
var AUTO_SCHEDULE_SEARCH_LIMIT_DESC = "자동 재배정을 시도했지만 현재 조건에서 일부 부족 인원을 자동으로 해결하지 못했습니다. 자세한 부족 날짜와 원인은 아래 「부족 인원 상세 분석」에서 확인해 주세요.";

function _renderAutoScheduleOtherConflictsHtml(draft) {
    var others = (draft.conflicts || []).filter(function (c) { return c.kind !== "work_shortfall"; });
    if (!others.length) return "";
    // search_limit_exceeded는 여러 건이어도 빨간 카드를 반복하지 않고 요약 카드
    // 1개로 묶는다(건수는 잃지 않고 "N건"으로 표시) — 다른 kind는 기존과 동일하게
    // 카드별로 그대로 렌더(이번 작업 범위 밖, 대규모 번역 아님).
    var searchLimitCount = 0;
    var rest = [];
    others.forEach(function (c) {
        if (c.kind === "search_limit_exceeded") { searchLimitCount++; return; }
        rest.push(c);
    });

    var html = "<div class='auto-schedule-result-section-title'>기타 조건 미충족(" + others.length + "건)</div>";
    html += "<div class='auto-schedule-conflict-list'>";
    if (searchLimitCount > 0) {
        html += "<div class='auto-schedule-conflict-card'><strong>⚠ " + _escapeHtml(AUTO_SCHEDULE_SEARCH_LIMIT_TITLE) + "</strong>"
            + "<span class='auto-schedule-hint'> — " + searchLimitCount + "건</span>"
            + "<div class='auto-schedule-hint' style='margin-top:2px;'>" + _escapeHtml(AUTO_SCHEDULE_SEARCH_LIMIT_DESC) + "</div>"
            + "</div>";
    }
    rest.forEach(function (c) {
        var label = AUTO_SCHEDULE_CONFLICT_LABEL[c.kind] || c.kind;
        html += "<div class='auto-schedule-conflict-card'><strong>[" + _escapeHtml(label) + "]</strong> " + _escapeHtml(c.message || "") + "</div>";
    });
    html += "</div>";
    return html;
}

/** 조건 재검사 checks를 PASS accordion + 실패 항목(raw 문자열 축약)으로 렌더(STEP3, STEP4).
 *  checks.ok/이름/문자열 내용 자체는 전혀 새로 계산하지 않고 그대로 옮겨 담기만 한다. */
function _renderAutoScheduleCheckListHtml(revalidation, shortageDiagnostic, ui) {
    if (!revalidation) return "";
    var passChecks = revalidation.checks.filter(function (c) { return c.ok; });
    var html = "<div class='auto-schedule-revalidation-summary " + (revalidation.passed ? "is-pass" : "is-fail") + "'>"
        + (revalidation.passed ? "✅ " + revalidation.checks.length + "개 항목 전체 통과" : "⚠ 일부 항목 실패 — 확정 불가") + "</div>";

    revalidation.checks.forEach(function (check, globalIdx) {
        if (check.ok) return; // PASS는 아래 accordion에서 한 번만
        if (check.name === AUTO_SCHEDULE_QUOTA_CHECK_NAME && shortageDiagnostic) {
            // ⚠️ 문제1(raw shortage 문자열 노출) — "A/P@3(1!=2), ..." 같은 raw
            // diagnostic 문자열(check.detail)은 [부족 인원 상세 분석]에서 이미
            // 사람이 읽을 수 있는 조/날짜/근무코드별 표로 제공되므로 중복이다.
            // check.detail 값 자체(원본 데이터)는 revalidation 객체에 그대로
            // 남아 있다(계산/데이터는 무변경) — 여기서는 그 문자열을 HTML로
            // interpolate하지 않을 뿐이다(펼치기 버튼도 제거 — 펼쳐도 raw 문자열이
            // 안 나오면 버튼 자체가 의미 없으므로).
            html += "<div class='auto-schedule-check-fail-row'>❌ 근무 인원 정원 미충족"
                + "<span class='auto-schedule-hint'> — " + shortageDiagnostic.details.length + "개 항목 / 총 " + shortageDiagnostic.totalGapSeats + "석 부족</span>"
                + "<div class='auto-schedule-hint'>조·날짜별 부족 현황과 원인은 아래 「부족 인원 상세 분석」에서 확인할 수 있습니다.</div>"
                + "</div>";
            return;
        }
        var rawOpen2 = !!ui.rawFailOpen[globalIdx];
        var itemCount = (check.detail || "").split(",").map(function (s) { return s.trim(); }).filter(Boolean).length;
        html += "<div class='auto-schedule-check-fail-row'>❌ " + _escapeHtml(check.name)
            + (itemCount ? "<span class='auto-schedule-hint'> — " + itemCount + "개 항목</span>" : "")
            + (check.detail ? " <button type='button' class='auto-schedule-result-mini-toggle' aria-expanded='" + (rawOpen2 ? "true" : "false")
                + "' aria-controls='autoScheduleRawFail_" + globalIdx + "' onclick='toggleAutoScheduleRawFail(" + globalIdx + ")'>" + (rawOpen2 ? "숨기기" : "상세 보기") + "</button>" : "")
            + "</div>";
        if (check.detail) {
            html += "<div id='autoScheduleRawFail_" + globalIdx + "'" + (rawOpen2 ? "" : " style='display:none;'") + " class='auto-schedule-hint'>"
                + (rawOpen2 ? _escapeHtml(check.detail) : "") + "</div>";
        }
    });

    var passOpen = !!ui.passOpen;
    html += "<div class='auto-schedule-result-pass-summary'>✅ 정상 조건 " + passChecks.length + "개"
        + " <button type='button' class='auto-schedule-result-mini-toggle' aria-expanded='" + (passOpen ? "true" : "false")
        + "' aria-controls='autoSchedulePassList' onclick='toggleAutoSchedulePassList()'>정상 조건 보기 " + (passOpen ? "▲" : "▼") + "</button></div>";
    html += "<div id='autoSchedulePassList'" + (passOpen ? "" : " style='display:none;'") + " class='auto-schedule-check-list'>";
    if (passOpen) {
        passChecks.forEach(function (check) { html += "<div style='padding:2px 0;'>✅ " + _escapeHtml(check.name) + "</div>"; });
    }
    html += "</div>";
    return html;
}

/**
 * [조건 재검사] 결과 아래에 붙는 부족 인원 상세 분석 섹션 전체 HTML.
 * ⚠️ Codex 발견 결함 수정 이후: 여기서 쓰는 모든 seat 수치는 "실제
 * planBulkOverrides를 실행해 검증한 확정 해결 가능 좌석"이 아니라
 * "findOverrideCandidates 기준 개별 direct candidate가 존재하는 좌석"일
 * 뿐이다(여러 shortage에 동시에 override를 적용했을 때의 상호작용까지는
 * 검증하지 않음 — STEP4 결정에 따라 이 렌더링에서 planBulkOverrides를
 * 실행하지 않는다). 문구도 이 semantics를 넘어서는 표현을 쓰지 않는다.
 * 실제 최종 해결 가능 여부는 기존 [신청휴무 일괄 자동조정] 버튼
 * (planBulkOverrides) 실행 결과만을 authoritative source로 삼는다.
 *
 * ⚠️ helper feature-detect — 외부/테스트 환경에서 AutoScheduleEngine이
 * mock으로 교체되어 summarizeShortageDiagnostics가 없을 수 있다(신규
 * diagnostic API). 그런 환경에서도 기존 UI 흐름이 깨지지 않도록, helper가
 * 없으면 이 섹션 자체를 조용히 생략한다(기존 조건 재검사 checks/warnings
 * 렌더링에는 전혀 영향 없음).
 *
 * @param {object} [precomputedSummary] 이미 계산된 summarizeShortageDiagnostics()
 *   결과가 있으면 재계산 없이 그대로 재사용한다(호출자인 _renderAutoScheduleModal이
 *   Hero 요약에도 같은 값을 쓰기 위해 먼저 계산해 넘겨준다). 없으면 기존과 동일하게
 *   이 함수 안에서 직접 계산한다(단독 호출/테스트 호환).
 */
function _renderShortageDiagnosticSection(precomputedSummary) {
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return "";
    if (typeof AutoScheduleEngine.summarizeShortageDiagnostics !== "function") return "";
    var summary = precomputedSummary || AutoScheduleEngine.summarizeShortageDiagnostics(_autoScheduleState.input, _autoScheduleState.draft);
    _autoScheduleState.shortageDiagnostic = summary; // 아래 toggle 함수들이 재계산 없이 그대로 참조
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());

    // ⚠️ Codex 회귀(cache-independent candidate select) — selectAutoScheduleCandidate()가
    // 호출된 시점에 shortageDiagnostic 캐시가 아직 없어 인덱스를 못 찾았더라도
    // (_autoOpenAutoScheduleShortageFor), 여기서 방금 계산된(또는 재사용된) summary는
    // 항상 최신이므로 pendingOpenShortageKey를 여기서 반드시 다시 확인해 그 시점의
    // 진짜 인덱스로 dateOpen을 연다. solver를 다시 호출하지 않고, 이미 계산된
    // summary.details를 읽기만 한다(순수 UI 상태 매칭).
    if (ui.pendingOpenShortageKey && summary.details) {
        for (var pk = 0; pk < summary.details.length; pk++) {
            if (_autoScheduleShortageKey(summary.details[pk]) === ui.pendingOpenShortageKey) {
                ui.groupOpen[summary.details[pk].group || "미지정"] = true;
                ui.dateOpen[pk] = true;
                ui.pendingOpenShortageKey = null;
                break;
            }
        }
    }

    if (summary.totalGapSeats === 0) {
        return "<div class='auto-schedule-success-banner'>✅ 부족 인원 없음 — 모든 날짜/조/근무코드 정원이 실제로 충족되었습니다.</div>";
    }

    // 조별로 묶는다(STEP7) — 실제 등장한 조만, 등장 순서 그대로.
    var groupOrder = [], byGroup = {};
    summary.details.forEach(function (d, idx) {
        var g = d.group || "미지정";
        if (!byGroup[g]) { byGroup[g] = []; groupOrder.push(g); }
        byGroup[g].push({ d: d, idx: idx });
    });

    var html = "<div class='auto-schedule-result-section'>";
    html += "<div class='auto-schedule-result-section-title'>부족 인원 상세 분석</div>";
    html += "<div class='auto-schedule-result-group-list'>";
    groupOrder.forEach(function (g) {
        var rows = byGroup[g];
        var groupSeats = rows.reduce(function (acc, r) { return acc + (r.d.gap || 0); }, 0);
        var open = !!ui.groupOpen[g];
        var panelId = "autoScheduleGroupPanel_" + g;
        var btnId = "autoScheduleGroupBtn_" + g;
        html += "<div class='auto-schedule-result-group-row'>";
        html += "<button type='button' id='" + btnId + "' class='auto-schedule-result-group-toggle' aria-expanded='" + (open ? "true" : "false")
            + "' aria-controls='" + panelId + "' onclick='toggleAutoScheduleGroupShortage(\"" + String(g).replace(/"/g, "") + "\")'>"
            + "<span>" + _escapeHtml(String(g)) + (g === "미지정" ? "" : "조") + "</span>"
            + "<span>" + groupSeats + "석 부족</span>"
            + "<span class='auto-schedule-result-caret' aria-hidden='true'>" + (open ? "▾" : "▸") + "</span>"
            + "</button>";
        html += "<div id='" + panelId + "' role='region' aria-labelledby='" + btnId + "'" + (open ? "" : " style='display:none;'") + ">";
        if (open) html += _renderAutoScheduleGroupDateTableHtml(rows, ui);
        html += "</div></div>";
    });
    html += "</div>";
    html += _renderAutoScheduleCapacityAccordionHtml(summary, ui);
    html += "</div>";
    return html;
}

/** 조를 펼치면 나오는 날짜별 표(STEP8). 좁은 화면에서는 CSS가 카드형으로 전환한다. */
function _renderAutoScheduleGroupDateTableHtml(rows, ui) {
    var html = "<div class='auto-schedule-result-date-head' aria-hidden='true'>"
        + "<span>날짜</span><span>근무</span><span>배정/필요</span><span>부족</span></div>";
    rows.forEach(function (r) {
        var d = r.d, idx = r.idx;
        var open = !!ui.dateOpen[idx];
        var panelId = "autoScheduleDatePanel_" + idx;
        var btnId = "autoScheduleDateBtn_" + idx;
        html += "<button type='button' id='" + btnId + "' class='auto-schedule-result-date-row' aria-expanded='" + (open ? "true" : "false")
            + "' aria-controls='" + panelId + "' onclick='toggleAutoScheduleShortageDate(" + idx + ")'>"
            + "<span class='auto-schedule-result-date-cell' data-label='날짜'>" + _escapeHtml(String(d.day)) + "일</span>"
            + "<span class='auto-schedule-result-date-cell' data-label='근무'>" + _escapeHtml(d.scheduleCode || "") + "</span>"
            + "<span class='auto-schedule-result-date-cell' data-label='배정/필요'>" + d.available + "/" + d.needed + "</span>"
            + "<span class='auto-schedule-result-date-cell auto-schedule-result-date-gap' data-label='부족'>" + d.gap + "명</span>"
            + "</button>";
        html += "<div id='" + panelId + "' class='auto-schedule-result-date-detail' role='region' aria-labelledby='" + btnId + "'" + (open ? "" : " style='display:none;'") + ">";
        if (open) html += _renderAutoScheduleDateDetailHtml(d, idx, ui);
        html += "</div>";
    });
    return html;
}

/** draft.conflicts에서 이 shortage(day/group/scheduleCode)에 해당하는 work_shortfall
 *  conflict의 인덱스를 찾는다 — 기존 신청휴무 조정 후보 선택/적용 흐름
 *  (selectAutoScheduleCandidate/toggleAutoScheduleCandidates)을 그대로 재사용하기 위함
 *  (조정 로직 자체는 전혀 새로 만들지 않는다). */
function _findWorkShortfallConflictIndex(d) {
    var draft = _autoScheduleState.draft;
    if (!draft || !draft.conflicts) return -1;
    for (var i = 0; i < draft.conflicts.length; i++) {
        var c = draft.conflicts[i];
        if (c.kind === "work_shortfall" && c.day === d.day && c.group === d.group && c.scheduleCode === d.scheduleCode) return i;
    }
    return -1;
}

/**
 * 신청휴무 조정 "선택 미리보기" 카드 — selectedCandidate(sel) 하나만으로 완전히
 * 렌더된다(draft/conflicts/shortageDiagnostic을 전혀 필요로 하지 않는다). 두
 * 경로에서 재사용한다: (1) 정상적으로 부족 인원 상세 accordion이 렌더되는 동안
 * 그 날짜 detail 안에서(_renderAutoScheduleDateDetailHtml), (2) 아래
 * _renderAutoScheduleStandaloneCandidatePreviewHtml처럼 그 accordion 자체가 아직
 * 없는(revalidation===null) 상태에서 최상위에 바로. 어느 경로든 버튼
 * handler(cancelAutoScheduleCandidateSelection/confirmApplyAutoScheduleCandidate)는
 * 완전히 동일하다.
 */
function _renderAutoScheduleCandidatePreviewHtml(sel) {
    var origLabel = (typeof AUTO_SCHEDULE_CODE_LABEL !== "undefined" && AUTO_SCHEDULE_CODE_LABEL[sel.originalType]) || sel.originalType;
    return "<div class='auto-schedule-override-preview'>"
        + "<div class='auto-schedule-override-preview-title'>신청휴무 조정 미리보기</div>"
        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>이름</span>" + _escapeHtml(sel.name) + "</div>"
        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>날짜</span>" + sel.day + "일</div>"
        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>원 신청</span>" + _escapeHtml(origLabel) + "</div>"
        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>변경 후</span>" + _escapeHtml(sel.scheduleCode) + "근무</div>"
        + "<div class='feature-card-action' style='gap:8px;margin-top:8px;'>"
        + "<button type='button' class='btn btn-secondary' onclick='cancelAutoScheduleCandidateSelection()'>취소</button>"
        + "<button type='button' class='btn btn-primary-sm' onclick='confirmApplyAutoScheduleCandidate()'>적용</button>"
        + "</div></div>";
}

/**
 * ⚠️ Codex 회귀(override_workflow_test.js, revalidation=null + diagnostic
 * cache=null 케이스) — _renderShortageDiagnosticSection 전체가
 * `if (revalidation)`로 감싸여 있어(조건 재검사를 아직 한 번도 안 돌린 상태),
 * 그 안에 있는 날짜별 detail(및 그 안의 candidate preview)이 통째로 렌더되지
 * 않는다. candidate 선택→preview 즉시 노출 계약이 revalidation 존재 여부에
 * 종속되면 안 되므로, revalidation이 없고 selectedCandidate만 있는 경우
 * 최소한의 "조/날짜" 헤더 + 위 preview 카드를 진단 accordion과 무관하게 최상위에
 * 바로 렌더한다. solver/engine을 추가로 호출하지 않고 selectedCandidate 자체가
 * 이미 들고 있는 값(group/day/scheduleCode/name/originalType — 선택 시점에
 * conflict에서 그대로 복사해 둔 값)만 사용한다.
 */
function _renderAutoScheduleStandaloneCandidatePreviewHtml(sel) {
    var html = "<div class='auto-schedule-result-section'>";
    html += "<div class='auto-schedule-result-section-title'>"
        + (sel.group ? _escapeHtml(String(sel.group)) + "조 · " : "") + _escapeHtml(String(sel.day)) + "일 · " + _escapeHtml(sel.scheduleCode || "") + "</div>";
    html += _renderAutoScheduleCandidatePreviewHtml(sel);
    html += "</div>";
    return html;
}

/** 날짜 row를 펼치면 나오는 원인 상세(STEP9) — 필요/현재/부족, 직접 조정 후보,
 *  주요 제한, (있으면) 신청휴무 조정 후보 선택 UI, 최하위 직원별 상세 토글. */
function _renderAutoScheduleDateDetailHtml(d, idx, ui) {
    var s = d.summary;
    var locked = _isAutoScheduleLocked();
    var judgeClass = AUTO_SCHEDULE_SHORTAGE_JUDGEMENT_CLASS[d.classification] || "";
    var judgementText = AUTO_SCHEDULE_SHORTAGE_JUDGEMENT_LABEL[d.classification] || "";

    var html = "<div class='auto-schedule-result-date-detail-head'>"
        + (d.group ? _escapeHtml(String(d.group)) + "조 · " : "") + _escapeHtml(String(d.day)) + "일 · " + _escapeHtml(d.scheduleCode || "") + "</div>";
    html += "<div class='auto-schedule-result-kv'><span>필요인원</span><strong>" + d.needed + "명</strong></div>";
    html += "<div class='auto-schedule-result-kv'><span>현재배정</span><strong>" + d.available + "명</strong></div>";
    html += "<div class='auto-schedule-result-kv'><span>부족</span><strong>" + d.gap + "명</strong></div>";
    html += "<div class='auto-schedule-result-kv'><span>직접 조정 후보</span><strong>" + s.feasibleNow + "명</strong></div>";
    // STEP3(Codex 지적 사항) — PARTIAL/NO_DIRECT_CANDIDATE 판정 근거가 되는 두 수치
    // (직접 후보로 채울 수 있는 최대 / 잔여)를 gap과 함께 그대로 노출한다. 세 값
    // 모두 summarizeShortageDiagnostics()가 이미 계산해 둔 값을 그대로 표시할 뿐,
    // 여기서 새로 계산하지 않는다.
    html += "<div class='auto-schedule-result-kv'><span>직접 후보로 채울 수 있는 최대</span><strong>" + d.directCandidateSeats + "석</strong></div>";
    html += "<div class='auto-schedule-result-kv'><span>잔여</span><strong>" + d.remainingSeats + "석</strong></div>";
    if (judgementText) html += "<div class='" + judgeClass + "' style='margin:4px 0;'>" + _escapeHtml(judgementText) + "</div>";

    var blockerLines = [];
    if (s.blockers.codeLink) blockerLines.push(AUTO_SCHEDULE_BLOCKER_LABEL.CODE_LINK + " " + s.blockers.codeLink + "명");
    if (s.blockers.maxConsecutiveWork) blockerLines.push(AUTO_SCHEDULE_BLOCKER_LABEL.MAX_CONSECUTIVE_WORK + " " + s.blockers.maxConsecutiveWork + "명");
    if (s.blockers.minOff) blockerLines.push(AUTO_SCHEDULE_BLOCKER_LABEL.MIN_OFF + " " + s.blockers.minOff + "명");
    if (s.blockers.codeCap) blockerLines.push(AUTO_SCHEDULE_BLOCKER_LABEL.CODE_CAP + " " + s.blockers.codeCap + "명");
    if (blockerLines.length) {
        html += "<div class='auto-schedule-result-blocker-title'>주요 제한</div><ul class='auto-schedule-result-blocker-list'>"
            + blockerLines.map(function (t) { return "<li>" + _escapeHtml(t) + "</li>"; }).join("") + "</ul>";
    }

    var refLines = [];
    refLines.push("신청 일반휴무(검토 대상) " + s.requestedNormalOff + "명");
    if (s.annual) refLines.push("연차 " + s.annual + "명");
    if (s.petition) refLines.push("청원 " + s.petition + "명");
    if (s.otherFixed) refLines.push("기타 fixed/requested 제한 " + s.otherFixed + "명");
    html += "<div class='auto-schedule-result-blocker-title'>참고</div><ul class='auto-schedule-result-blocker-list'>"
        + refLines.map(function (t) { return "<li>" + _escapeHtml(t) + "</li>"; }).join("") + "</ul>";

    // ⚠️ Codex 독립검증 지적(Critical): 아래 안내 문구는 classification(FULL/
    // PARTIAL/NO_DIRECT_CANDIDATE — solver/diagnostic이 이미 계산해 둔 값, 여기서
    // 새로 판정하지 않음) 별로 완전히 분리한다. 이전에는 "d.remainingSeats > 0"
    // 하나의 조건으로만 안내를 내보내, 실제로는 직접 조정 후보가 존재하는 PARTIAL
    // 상태에서도 NO_DIRECT_CANDIDATE 전용 문구("...후보가 없습니다.")가 함께
    // 출력되어 두 문구가 서로 모순되는 버그가 있었다("직접 조정 후보 1명"이라고
    // 말해 놓고 바로 아래에서 "후보가 없습니다"라고 말하는 상황).
    // ⚠️ STEP4/STEP9 요구: "P→A 삭제"/"4일→5일"/"9일→8일" 같은 구체적 수치 조정
    // 권고는 어떤 classification에서도 하지 않는다 — 기본 해결책은 "필요 정원
    // 검토"/"근무 가능 인원 보강" 두 가지 일반 안내뿐이다(문구 조합만 다름).
    if (d.classification === "FULL") {
        html += "<div class='auto-schedule-hint'>현재 확인된 직접 조정 후보만으로 부족 인원을 채울 수 있습니다.</div>";
    } else if (d.classification === "PARTIAL") {
        // PARTIAL은 후보가 "일부" 존재하는 상태이므로 "후보가 없습니다" 문구를
        // 절대 쓰지 않는다(Codex 지적 사항의 핵심). 잔여분에 대해서만 일반 안내를
        // 한 문장에 담아 안내한다(운영 검토 불릿 목록은 NO_DIRECT_CANDIDATE 전용).
        html += "<div class='auto-schedule-hint'>현재 확인된 직접 조정 후보로 부족 인원 중 일부만 채울 수 있습니다.<br>"
            + "추가로 " + d.remainingSeats + "명의 근무 가능 인원 또는 필요 정원 검토가 필요합니다.</div>";
    } else if (d.classification === "NO_DIRECT_CANDIDATE") {
        // "직접 조정 후보가 없습니다" 의미의 문구는 이 상태에서만 허용된다.
        html += "<div class='auto-schedule-hint'>현재 조건을 유지하면 직접 조정 가능한 후보가 없습니다.</div>";
        html += "<div class='auto-schedule-result-blocker-title'>운영 검토</div><ul class='auto-schedule-result-blocker-list'>"
            + "<li>필요 정원 검토</li><li>해당 조 근무 가능 인원 보강</li></ul>";
    }

    if (!locked) {
        var conflictIndex = _findWorkShortfallConflictIndex(d);
        if (conflictIndex !== -1) {
            var sel = _autoScheduleState.selectedCandidate;
            if (sel && sel.conflictIndex === conflictIndex) {
                html += _renderAutoScheduleCandidatePreviewHtml(sel);
            } else {
                html += "<div><button type='button' class='btn btn-secondary' style='font-size:11px;padding:2px 8px;margin-top:6px;' onclick='toggleAutoScheduleCandidates(" + conflictIndex + ")'>신청휴무 조정 후보 보기</button>"
                    + "<div id='autoScheduleCandidates_" + conflictIndex + "' style='display:none;margin-top:4px;'></div></div>";
            }
        }
    }

    var empOpen = !!ui.employeeOpen[idx];
    html += "<div style='margin-top:8px;'><button type='button' class='auto-schedule-result-mini-toggle' aria-expanded='" + (empOpen ? "true" : "false")
        + "' aria-controls='autoScheduleShortageEmployee_" + idx + "' onclick='toggleShortageEmployeeDetail(" + idx + ")'>후보 직원 상세 보기 " + (empOpen ? "▲" : "▼") + "</button>"
        + "<div id='autoScheduleShortageEmployee_" + idx + "'" + (empOpen ? "" : " style='display:none;'") + ">"
        + (empOpen ? _renderShortageEmployeeDetailHtml(d) : "") + "</div></div>";

    return html;
}

/** 후보 직원 상세(STEP10 — 최하위, 기본 접힘). 직원 이름은 여기까지 펼쳐야만 보인다. */
function _renderShortageEmployeeDetailHtml(d) {
    var rows = (d.employeeDetail || []).filter(function (e) { return e.blocker; });
    if (!rows.length) return "<div class='auto-schedule-hint'>표시할 상세 blocker 없음</div>";
    return rows.map(function (e) {
        return "<div>" + _escapeHtml(e.name || e.uid) + " → " + (AUTO_SCHEDULE_BLOCKER_LABEL[e.blocker] || e.blocker) + "</div>";
    }).join("");
}

/** 월간 Capacity(feasibility analyzer) accordion — 날짜별 shortage와 섞지 않고
 *  별도로 분리한다(STEP11). groupCapacityWarnings 계산은 기존 그대로. */
function _renderAutoScheduleCapacityAccordionHtml(summary, ui) {
    if (!summary.groupCapacityWarnings || !summary.groupCapacityWarnings.length) return "";
    var open = !!ui.capacityOpen;
    var html = "<div class='auto-schedule-result-capacity'>";
    html += "<button type='button' class='auto-schedule-result-capacity-toggle' aria-expanded='" + (open ? "true" : "false")
        + "' aria-controls='autoScheduleCapacityPanel' onclick='toggleAutoScheduleCapacity()'>왜 계속 부족이 생기나요? " + (open ? "▲" : "▼") + "</button>";
    html += "<div id='autoScheduleCapacityPanel'" + (open ? "" : " style='display:none;'") + ">";
    if (open) {
        html += "<div class='auto-schedule-hint'>현재 신청휴무 및 운영 제한을 모두 유지할 경우 필요 근무량보다 최대 가용 근무량이 부족합니다.</div>";
        summary.groupCapacityWarnings.forEach(function (w) {
            html += "<div class='auto-schedule-result-kv'><span>" + _escapeHtml(String(w.group)) + "조</span><strong>" + w.requiredWork + " / " + w.maxWork + "</strong>"
                + "<span class='auto-schedule-result-date-gap'>부족 " + w.deficit + "석</span></div>";
        });
    }
    html += "</div></div>";
    return html;
}

/** 조 row 클릭(STEP7). */
function toggleAutoScheduleGroupShortage(group) {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.groupOpen[group] = !ui.groupOpen[group];
    _renderAutoScheduleModal();
}

/** 날짜 row 클릭(STEP8→STEP9). */
function toggleAutoScheduleShortageDate(idx) {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.dateOpen[idx] = !ui.dateOpen[idx];
    _renderAutoScheduleModal();
}

/** [후보 직원 상세 보기] 클릭(STEP10) — 직원별 blocker 목록을 펼친다(기본은 항상 접혀 있음). */
function toggleShortageEmployeeDetail(idx) {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.employeeOpen[idx] = !ui.employeeOpen[idx];
    _renderAutoScheduleModal();
}

/** [왜 계속 부족이 생기나요?] 클릭(STEP11). */
function toggleAutoScheduleCapacity() {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.capacityOpen = !ui.capacityOpen;
    _renderAutoScheduleModal();
}

/** [정상 조건 보기] 클릭(STEP4). */
function toggleAutoSchedulePassList() {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.passOpen = !ui.passOpen;
    _renderAutoScheduleModal();
}

/** [대상자 보기] 클릭(STEP5). */
function toggleAutoScheduleWarningList() {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.warnOpen = !ui.warnOpen;
    _renderAutoScheduleModal();
}

/** [부족 항목 보기]/[상세 보기] 클릭(STEP3) — 실패 check의 raw 문자열 펼침. */
function toggleAutoScheduleRawFail(checkIdx) {
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    ui.rawFailOpen[checkIdx] = !ui.rawFailOpen[checkIdx];
    _renderAutoScheduleModal();
}

/** 후보 이름 클릭 — "선택"만 한다. draft/engine은 전혀 건드리지 않는다(side effect 0). */
function selectAutoScheduleCandidate(conflictIndex, uid) {
    if (_isAutoScheduleLocked()) return;
    var draft = _autoScheduleState.draft;
    var conflict = draft && draft.conflicts[conflictIndex];
    if (!conflict || conflict.kind !== "work_shortfall") return;

    var candidates = _autoScheduleCandidatesFor(conflictIndex);
    var cand = candidates.filter(function (c) { return c.uid === uid; })[0];
    if (!cand) return;

    var dayStr = String(conflict.day);
    var entry = (draft.grid[uid] || {})[dayStr];
    _autoScheduleState.selectedCandidate = {
        conflictIndex: conflictIndex,
        uid: uid,
        name: cand.name || cand.uid,
        day: conflict.day,
        group: conflict.group,
        scheduleCode: conflict.scheduleCode,
        originalType: entry ? entry.type : "normal",
    };
    _autoOpenAutoScheduleShortageFor(conflict); // ⚠️ Codex 회귀(override_workflow_test.js) — 아래 함수 참고
    _renderAutoScheduleModal();
}

/**
 * ⚠️ Codex 회귀(override_workflow_test.js) — 기존 계약은 selectAutoScheduleCandidate()를
 * 호출하면(버튼 클릭이든 함수 직접 호출이든) preview가 "즉시" 화면에 보이는 것이었다.
 * 새 조/날짜 nested accordion 구조에서는 group/date가 닫혀 있으면 방금 만든
 * selectedCandidate가 실제로는 화면에 렌더되지 않는 DOM 안에 갇혀버려 계약이
 * 깨졌었다. 이 함수는 그 group/date accordion의 열림 상태만 강제로 켠다 — solver
 * state(draft/conflicts/forcedOverrides)는 전혀 건드리지 않는 순수 UI 상태 변경이다.
 * shortageDiagnostic은 draft가 있는 한 매 렌더마다 이미 계산되어 캐시되어 있으므로
 * (그룹/날짜 accordion이 닫혀 있어도 계산 자체는 항상 수행됨), 여기서 다시 solver를
 * 돌리거나 새로 계산하지 않고 그 캐시에서 인덱스만 찾는다.
 */
function _autoOpenAutoScheduleShortageFor(conflict) {
    if (!conflict) return;
    var ui = _autoScheduleState.ui || (_autoScheduleState.ui = _freshAutoScheduleUiState());
    var group = conflict.group || "미지정";
    ui.groupOpen[group] = true;
    // cache-independent(STEP3 OPTION A): 지금 당장 인덱스를 찾을 수 있으면 바로
    // 열어 두고, 그렇지 못하더라도(캐시가 아직 없어도) key를 남겨 둔다 —
    // _renderShortageDiagnosticSection이 곧이어 같은 렌더 사이클에서 diagnostic을
    // 새로 계산할 때 이 key를 반드시 재확인해서 그 시점의 실제 인덱스를 연다.
    var key = _autoScheduleShortageKey(conflict);
    ui.pendingOpenShortageKey = key;
    var diag = _autoScheduleState.shortageDiagnostic;
    if (diag && diag.details) {
        for (var i = 0; i < diag.details.length; i++) {
            if (_autoScheduleShortageKey(diag.details[i]) === key) { ui.dateOpen[i] = true; ui.pendingOpenShortageKey = null; break; }
        }
    }
}

/** [취소] — 선택 상태만 해제한다. draft/original request 변경 없음(side effect 0).
 *  STEP7/STEP8: 아직 해소되지 않은 pending shortage target(캐시가 없어 open을
 *  못 끝낸 경우)이 남아 있으면 함께 지워 다음 선택에 잘못 영향을 주지 않게 한다. */
function cancelAutoScheduleCandidateSelection() {
    _autoScheduleState.selectedCandidate = null;
    if (_autoScheduleState.ui) _autoScheduleState.ui.pendingOpenShortageKey = null;
    _renderAutoScheduleModal();
}

/** [적용] — 이 순간에만 실제로 override를 확정하고, forcedOverrides에 누적한 뒤
 *  월 전체를 처음부터 다시 생성(re-solve)한다. 한 칸만 patch하는 대신 엔진 전체를
 *  다시 돌려서, 잃어버린 일반휴무를 다른 날짜에 자동으로 재배치하고 conflict/재검사
 *  결과도 전부 새 draft 기준으로 갱신되게 한다. */
function confirmApplyAutoScheduleCandidate() {
    var sel = _autoScheduleState.selectedCandidate;
    if (!sel) return;
    if (_isAutoScheduleLocked()) return;
    if (!_autoScheduleState.input) return;

    var forcedOverrides = (_autoScheduleState.forcedOverrides || []).concat([{
        uid: sel.uid,
        day: sel.day,
        scheduleCode: sel.scheduleCode,
        originalRequest: { type: sel.originalType },
        override: { changedBy: currentUid, changedAt: Date.now(), reason: "auto_schedule_conflict" },
    }]);

    var input = Object.assign({}, _autoScheduleState.input, { forcedOverrides: forcedOverrides });
    _autoScheduleState.input = input;
    _autoScheduleState.forcedOverrides = forcedOverrides;
    _autoScheduleState.draft = AutoScheduleEngine.generateDraft(input); // 월 전체 재편성(re-solve)
    // ⚠️ 문제2 — 이전에는 revalidation을 null로만 남겨 두어 사용자가 [조건 재검사]를
    // 다시 눌러야 했다. 이제 fresh draft를 만든 직후 같은 렌더 사이클 안에서 바로
    // authoritative 재검사를 자동 실행한다(로직은 revalidateAutoSchedule과 완전히
    // 동일한 _recomputeAutoScheduleRevalidation 재사용 — 새 검증 로직 없음).
    _recomputeAutoScheduleRevalidation();
    _autoScheduleState.selectedCandidate = null;
    _autoScheduleState.ui = _freshAutoScheduleUiState(); // 새 draft → shortageDiagnostic.details 인덱스가 바뀌므로 접기 상태 초기화
    _renderAutoScheduleModal();
}

/** [신청휴무 일괄 자동조정] — "1건 선택 → 가상 적용 → fresh generateDraft → fresh
 *  conflicts → 다음 conflict 선택"을 반복하는 순수 계획(AutoScheduleEngine.planBulkOverrides)을
 *  호출한다. 계산 결과는 bulkPlan에만 저장하고, [일괄 적용]을 누르기 전까지 live
 *  draft/forcedOverrides/conflicts/revalidation은 절대 건드리지 않는다(side effect 0). */
function startBulkAutoAdjustment() {
    if (_isAutoScheduleLocked()) return;
    if (_autoScheduleState.bulkCalculating) return; // 중복 클릭 방지
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return;

    _autoScheduleState.bulkCalculating = true;
    _autoScheduleState.bulkPlan = null;
    _autoScheduleState.bulkPreviewActive = false;
    _renderAutoScheduleModal();

    // setTimeout으로 한 틱 양보해 "계산 중..." 표시가 실제로 먼저 그려지게 한다
    // (계산 자체는 동기 함수라 양보 없이 바로 호출하면 화면이 멈춘 것처럼 보인다).
    setTimeout(function () {
        try {
            var input = Object.assign({}, _autoScheduleState.input, { forcedOverrides: _autoScheduleState.forcedOverrides || [] });
            var result = AutoScheduleEngine.planBulkOverrides(input);
            _autoScheduleState.bulkPlan = result;
            _autoScheduleState.bulkPreviewActive = true;
        } catch (e) {
            _autoScheduleState.bulkPlan = null;
            _autoScheduleState.bulkPreviewActive = false;
            alert("자동조정 계산 중 오류가 발생했습니다.");
        } finally {
            _autoScheduleState.bulkCalculating = false;
            _renderAutoScheduleModal();
        }
    }, 10);
}

/** [취소] — 미리보기 상태만 지운다. draft/forcedOverrides/conflicts/revalidation은
 *  전혀 변경되지 않는다(side effect 0). */
function cancelBulkAutoAdjustment() {
    _autoScheduleState.bulkPlan = null;
    _autoScheduleState.bulkPreviewActive = false;
    _renderAutoScheduleModal();
}

/** [일괄 적용] — 기존 forcedOverrides + 이번 계획의 override들을 합친 뒤, 그 최종
 *  목록을 기준으로 fresh generateDraft를 다시 실행한다(미리보기 때 계산해둔
 *  previewDraft 객체를 그대로 live draft로 복사하지 않는다 — 기존 manual 적용과
 *  동일한 semantics를 보장하기 위함). */
function confirmBulkAutoAdjustment() {
    if (_isAutoScheduleLocked()) return;
    var bulkPlan = _autoScheduleState.bulkPlan;
    if (!bulkPlan || !bulkPlan.plan || !bulkPlan.plan.length) return;
    if (!_autoScheduleState.input) return;

    var newOverrides = bulkPlan.plan.map(function (item) {
        return {
            uid: item.uid,
            day: item.day,
            scheduleCode: item.scheduleCode,
            originalRequest: { type: item.originalType },
            override: { changedBy: currentUid, changedAt: Date.now(), reason: "auto_schedule_conflict" },
        };
    });

    var forcedOverrides = (_autoScheduleState.forcedOverrides || []).concat(newOverrides);
    var input = Object.assign({}, _autoScheduleState.input, { forcedOverrides: forcedOverrides });
    _autoScheduleState.input = input;
    _autoScheduleState.forcedOverrides = forcedOverrides;
    _autoScheduleState.draft = AutoScheduleEngine.generateDraft(input); // 월 전체 재편성(re-solve)
    // ⚠️ 문제2-B(일괄조정도 동일) — manual apply와 완전히 같은 helper 재사용.
    _recomputeAutoScheduleRevalidation();
    _autoScheduleState.selectedCandidate = null;
    _autoScheduleState.bulkPlan = null;
    _autoScheduleState.bulkPreviewActive = false;
    _autoScheduleState.ui = _freshAutoScheduleUiState(); // 새 draft → shortageDiagnostic.details 인덱스가 바뀌므로 접기 상태 초기화
    _renderAutoScheduleModal();
}

/** confirmAutoSchedule 콜러블에 보낼 employees 페이로드를 draft grid에서 조립한다.
 *  uid는 서버 검증/저장용 key로만 쓰이고, 화면(DOM)에는 displayName/group만 노출한다. */
function _buildConfirmSchedulePayload() {
    var draft = _autoScheduleState.draft, input = _autoScheduleState.input;
    if (!draft || !input) return null;

    var employees = {};
    input.employees.forEach(function (emp) {
        var days = draft.grid[emp.uid] || {};
        var sanitizedDays = {};
        Object.keys(days).forEach(function (day) {
            var entry = days[day];
            var out = { type: entry.type, source: entry.source === "requested" ? "requested" : (entry.source === "override" ? "override" : "auto") };
            if (entry.type === "schedule") out.scheduleCode = entry.scheduleCode;
            if (entry.source === "override") {
                out.originalRequest = entry.originalRequest ? { type: entry.originalRequest.type } : { type: "normal" };
                out.override = entry.override || { changedBy: currentUid, changedAt: Date.now(), reason: "auto_schedule_conflict" };
            }
            sanitizedDays[day] = out;
        });
        employees[emp.uid] = { displayName: emp.name || emp.empNo || emp.uid, group: emp.group || "", days: sanitizedDays };
    });

    return { deptId: currentDept, yyyymm: getTargetYearMonth().fullStr, employees: employees, engineVersion: "1.0.0", generatedAt: Date.now() };
}

function confirmAutoSchedule() {
    if (!_autoScheduleState.revalidation || !_autoScheduleState.revalidation.passed) {
        alert("[조건 재검사]를 통과해야 확정할 수 있습니다.");
        return;
    }
    if (_autoScheduleState.confirmedJustNow) return; // 중복 클릭 방지

    var payload = _buildConfirmSchedulePayload();
    if (!payload) { alert("확정할 초안이 없습니다."); return; }

    fn.confirmAutoSchedule(payload).then(function () {
        _autoScheduleState.confirmedJustNow = true;
        alert("스케줄이 확정되었습니다.");
        _checkExistingFinalSchedule().then(function () { _renderAutoScheduleModal(); });
    }).catch(function (e) {
        if (e && e.code === "already-exists") {
            alert("이미 확정된 스케줄이 있습니다.");
            _checkExistingFinalSchedule().then(function () { _renderAutoScheduleModal(); });
        } else {
            alert("확정 실패: " + ((e && e.message) || "알 수 없는 오류"));
        }
    });
}

function downloadAutoScheduleExcel() {
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return;
    var groupByEmp = {};
    _autoScheduleState.input.employees.forEach(function (e) { groupByEmp[e.uid] = e.group; });
    var revalidation = _autoScheduleState.revalidation || AutoScheduleEngine.revalidateDraft(_autoScheduleState.draft, _autoScheduleState.input);
    var tm = getTargetYearMonth();
    var meta = { yyyymm: tm.fullStr, previousMonthWarning: _autoScheduleState.previousMonthTailWarning || "" };
    var existing = _autoScheduleState.existingFinalSchedule;
    if (existing && existing.meta) {
        meta.confirmedAt = existing.meta.confirmedAt;
        meta.confirmedBy = existing.meta.confirmedBy;
    }
    var previousMonthWorkTail = _autoScheduleState.input.previousMonthWorkTail || {};
    exportAutoScheduleToExcel(_autoScheduleState.draft, _autoScheduleState.input.employees, groupByEmp, revalidation, "자동스케줄_" + tm.fullStr, meta, previousMonthWorkTail);
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────

var AUTO_SCHEDULE_CONFLICT_LABEL = {
    work_shortfall: "근무 인원 부족",
    no_valid_assignment: "배정 불가(월 휴무 목표 초과)",
    group_off_cap: "조별 휴무 정원 초과",
    day_off_cap: "특정일 휴무 정원 초과",
    monthly_off_minimum_shortfall: "월 최소 휴무일수 미달",
    schedule_code_monthly_limit: "월 근무코드 제한 초과",
};

function _renderBulkAutoAdjustmentHtml(workShortfallCount) {
    // ⚠️ 트리거 버튼([신청휴무 자동조정])은 Hero 요약 카드(_renderAutoScheduleHeroHtml)로
    // 이동했다(STEP2/STEP12 — Primary 액션은 팝업 최상단에 한 번만). 이 함수는 계산 중
    // 표시와 [일괄 적용] 미리보기 패널만 그대로 담당한다(계산/미리보기 로직 자체는 무변경).
    var html = "";
    if (workShortfallCount === 0) return html;

    if (_autoScheduleState.bulkCalculating) {
        html += "<div class='auto-schedule-loading'>일괄 자동조정 계산 중...</div>";
    }

    if (_autoScheduleState.bulkPreviewActive && _autoScheduleState.bulkPlan) {
        var bp = _autoScheduleState.bulkPlan;
        html += "<div class='auto-schedule-bulk-preview'>";
        html += "<div class='auto-schedule-bulk-preview-title'>신청휴무 일괄 자동조정 미리보기</div>";

        if (bp.truncated) {
            html += "<div class='auto-schedule-warning'>⚠ 자동조정 계산 한도에 도달했습니다. 지금까지 찾은 최선의 계획을 표시합니다.</div>";
        }

        if (!bp.plan.length) {
            html += "<div class='auto-schedule-bulk-empty'>자동으로 조정 가능한 항목이 없습니다.</div>";
        } else {
            html += "<div class='auto-schedule-bulk-preview-list'>";
            bp.plan.forEach(function (item) {
                var origLabel = (typeof AUTO_SCHEDULE_CODE_LABEL !== "undefined" && AUTO_SCHEDULE_CODE_LABEL[item.originalType]) || item.originalType;
                html += "<div class='auto-schedule-bulk-preview-item'>"
                    + _escapeHtml(item.name) + " · " + _escapeHtml(item.group || "") + "조 · " + item.day + "일 · "
                    + _escapeHtml(origLabel) + " → " + _escapeHtml(item.scheduleCode) + "근무"
                    + "</div>";
            });
            html += "</div>";
        }

        html += "<div class='auto-schedule-bulk-summary-row'>조정 예정: " + bp.plan.length + "건</div>";
        html += "<div class='auto-schedule-bulk-summary-row'>조정 전 근무 부족: " + bp.beforeSummary.shortageSeats + "자리 / 조정 후 예상: " + bp.afterSummary.shortageSeats + "자리</div>";
        html += "<div class='auto-schedule-bulk-summary-row'>월 휴무 부족: " + bp.afterSummary.monthlyOffShortfallCount + "건</div>";
        html += "<div class='auto-schedule-bulk-summary-row'>남은 전체 충돌: " + bp.afterSummary.totalConflicts + "건</div>";
        if (bp.plan.length && bp.afterSummary.totalConflicts > 0) {
            html += "<div class='auto-schedule-hint'>※ 자동으로 해결 가능한 항목까지만 조정했습니다. 나머지는 수동 조정이 필요합니다.</div>";
        }

        html += "<div class='feature-card-action' style='gap:8px;margin-top:8px;'>"
            + "<button type='button' class='btn btn-secondary' onclick='cancelBulkAutoAdjustment()'>취소</button>"
            + (bp.plan.length ? "<button type='button' class='btn btn-primary-sm' onclick='confirmBulkAutoAdjustment()'>일괄 적용</button>" : "")
            + "</div>";

        html += "</div>";
    }

    return html;
}

/**
 * 자동스케줄 결과 팝업 render. 정보 계층은 항상 다음 순서로 고정한다(이번 작업의
 * 핵심 요구사항 — 요약 → 조 → 날짜 → 원인 → 직원):
 *   1. Hero 요약(_renderAutoScheduleHeroHtml)
 *   2. (work_shortfall 있으면) 일괄 자동조정 계산중/미리보기
 *   3. 권장휴무 미달 accordion
 *   4. 기타(work_shortfall 아닌) 조건 미충족 카드
 *   5. 조건 재검사 / Excel 다운로드 버튼
 *   6. 조건 재검사 PASS accordion + 실패 항목(raw 축약)
 *   7. 부족 인원 상세 분석(조 → 날짜 → 원인 → 직원 accordion)
 *   8. 스케줄 확정 버튼
 * solver/revalidation/diagnostic 계산 자체는 이 함수 안에서 전혀 새로 하지 않고,
 * 기존 draft/revalidation/summarizeShortageDiagnostics 결과를 그대로 옮겨 배치만 한다.
 */
function _renderAutoScheduleModal() {
    var body = document.getElementById("autoScheduleModalBody");
    if (!body) return;
    var prevScrollTop = body.scrollTop; // accordion 토글마다 전체 재렌더되므로 스크롤 위치를 보존한다(정보 자체와 무관한 UX 보호)
    if (!_autoScheduleState.ui) _autoScheduleState.ui = _freshAutoScheduleUiState();
    var ui = _autoScheduleState.ui;

    var html = "";
    if (!_autoScheduleState.previousMonthTailLoaded) {
        html += "<div class='auto-schedule-loading'>전월 확정 스케줄 데이터를 불러오는 중...</div>";
    } else if (_autoScheduleState.previousMonthTailWarning) {
        html += "<div class='auto-schedule-warning'>⚠ " + _escapeHtml(_autoScheduleState.previousMonthTailWarning) + "</div>";
    } else {
        html += "<div class='auto-schedule-hint'>※ 전월 연속근무는 전월 확정 스케줄(finalSchedules) 기준으로 정확히 계산되었습니다.</div>";
    }

    if (_autoScheduleState.existingFinalScheduleChecked && _autoScheduleState.existingFinalSchedule) {
        var m = _autoScheduleState.existingFinalSchedule.meta || {};
        html += "<div class='auto-schedule-success-banner'>"
            + "✅ 이 달은 이미 확정된 스케줄이 있습니다"
            + (m.confirmedAt ? " (확정: " + _escapeHtml(new Date(m.confirmedAt).toLocaleString()) + ")" : "")
            + ". 재확정(덮어쓰기)은 지원하지 않습니다.</div>";
    }

    var locked = _isAutoScheduleLocked();
    var draft = _autoScheduleState.draft;

    if (!draft) {
        html += "<div class='feature-card-action' style='margin-bottom:10px;'>"
            + "<button class='btn btn-primary-sm' onclick='generateAutoScheduleDraft()'>자동 스케줄 생성</button>"
            + "</div>";
        html += "<div class='auto-schedule-hint'>아직 생성된 초안이 없습니다.</div>";
        body.innerHTML = html;
        return;
    }

    var shortageDiagnostic = null;
    if (typeof AutoScheduleEngine.summarizeShortageDiagnostics === "function") {
        shortageDiagnostic = AutoScheduleEngine.summarizeShortageDiagnostics(_autoScheduleState.input, draft);
        _autoScheduleState.shortageDiagnostic = shortageDiagnostic;
    }

    // 1) Hero 요약 — 팝업 최상단에 한 번만(STEP2/STEP6).
    var heroModel = _buildAutoScheduleHeroModel(draft, shortageDiagnostic);
    html += _renderAutoScheduleHeroHtml(heroModel, locked);

    // 2) 일괄 자동조정 계산중/미리보기(트리거 버튼은 Hero로 이동 완료).
    if (heroModel.workShortfallCount > 0 && !locked) {
        html += _renderBulkAutoAdjustmentHtml(heroModel.workShortfallCount);
    }

    // 3) 권장휴무 미달(STEP5) — draft.warnings/revalidation.warnings 중 하나만.
    html += _renderAutoScheduleWarningAccordionHtml(draft, _autoScheduleState.revalidation, ui);

    // 4) work_shortfall이 아닌 나머지 conflict만 카드로(STEP6).
    html += _renderAutoScheduleOtherConflictsHtml(draft);

    // 5) 조건 재검사 / Excel 다운로드(STEP12 — utility 버튼).
    html += "<div class='feature-card-action' style='gap:8px;margin:10px 0;'>"
        + "<button class='btn btn-secondary' onclick='revalidateAutoSchedule()'>조건 재검사</button>"
        + "<button class='btn btn-secondary' onclick='downloadAutoScheduleExcel()'>Excel 다운로드</button>"
        + "</div>";

    var revalidation = _autoScheduleState.revalidation;
    if (revalidation) {
        // 6) PASS accordion + 실패 항목(raw 축약) — STEP3/STEP4.
        html += _renderAutoScheduleCheckListHtml(revalidation, shortageDiagnostic, ui);
        // 7) 부족 인원 상세 분석: 조 → 날짜 → 원인 → 직원(STEP7~11). revalidation.passed/
        // checks 판정 자체에는 전혀 관여하지 않는 순수 진단 섹션(확정 버튼 gating도 기존 그대로).
        html += _renderShortageDiagnosticSection(shortageDiagnostic);
    } else if (_autoScheduleState.selectedCandidate && !locked) {
        // ⚠️ Codex 회귀(override_workflow_test.js) — 조건 재검사를 아직 한 번도
        // 안 돌려 위 accordion 자체가 없어도(revalidation===null), candidate가
        // 이미 선택된 상태라면 preview는 반드시 보여야 한다(select→preview 즉시
        // 노출 계약이 revalidation 존재 여부에 종속되면 안 됨). 진단 accordion과
        // 완전히 무관하게, selectedCandidate 자체의 값만으로 렌더한다.
        html += _renderAutoScheduleStandaloneCandidatePreviewHtml(_autoScheduleState.selectedCandidate);
    }

    // 8) 확정 버튼 — gating 조건은 기존 그대로(revalidation.passed && !locked)만 그대로 사용.
    html += "<div class='feature-card-action'>"
        + "<button class='btn btn-primary-sm'" + (revalidation && revalidation.passed && !locked ? "" : " disabled") + " onclick='confirmAutoSchedule()'>스케줄 확정</button>"
        + "</div>";

    body.innerHTML = html;
    body.scrollTop = prevScrollTop;
}

if (typeof module === "object" && module.exports) {
    module.exports = {
        _autoScheduleGroupOfUid: _autoScheduleGroupOfUid,
        _getAutoCodeLinkRestrictions: _getAutoCodeLinkRestrictions,
        // ── 이번 결과 팝업 정보구조 개편(요약/조/날짜/원인/직원 accordion)의 순수 함수만
        // 테스트용으로 노출한다. DOM(document)에 의존하는 render/toggle 함수는 내보내지
        // 않는다 — solver/revalidation/diagnostic 계산에는 전혀 관여하지 않는 순수
        // 데이터 가공 함수만 대상이다.
        _buildAutoScheduleGroupBreakdown: _buildAutoScheduleGroupBreakdown,
        _buildAutoScheduleHeroModel: _buildAutoScheduleHeroModel,
        _resolveAutoScheduleOffTargetShortfalls: _resolveAutoScheduleOffTargetShortfalls,
        _freshAutoScheduleUiState: _freshAutoScheduleUiState,
        _renderAutoScheduleCheckListHtml: _renderAutoScheduleCheckListHtml,
        // ⚠️ 아래 두 항목은 _autoScheduleState(모듈 전역)를 읽는 함수라 테스트에서
        // 그 상태를 채워 넣을 수 있는 통로가 필요해 내보낸다. 이 setter는 테스트
        // 전용이며 draft/input/ui 필드만 주입한다 — solver를 대신 실행하거나 어떤
        // 계산도 하지 않는다(순수 대입).
        _setAutoScheduleTestState: function (partial) {
            Object.keys(partial || {}).forEach(function (k) { _autoScheduleState[k] = partial[k]; });
        },
        _getAutoScheduleTestState: function () { return _autoScheduleState; },
        _renderShortageDiagnosticSection: _renderShortageDiagnosticSection,
        _resolveAutoScheduleOffTargetMessage: _resolveAutoScheduleOffTargetMessage,
        _renderAutoScheduleWarningAccordionHtml: _renderAutoScheduleWarningAccordionHtml,
        // ── candidate select → preview 즉시 노출 계약(override_workflow_test.js) 검증용.
        // 이 함수들은 draft/conflicts/forcedOverrides를 바꾸지 않는 한(적용 전까지는
        // 순수 선택/취소일 뿐) 그대로 노출해도 solver 계산에 관여하지 않는다.
        selectAutoScheduleCandidate: selectAutoScheduleCandidate,
        cancelAutoScheduleCandidateSelection: cancelAutoScheduleCandidateSelection,
        confirmApplyAutoScheduleCandidate: confirmApplyAutoScheduleCandidate,
        confirmBulkAutoAdjustment: confirmBulkAutoAdjustment,
        revalidateAutoSchedule: revalidateAutoSchedule,
        _recomputeAutoScheduleRevalidation: _recomputeAutoScheduleRevalidation,
        _renderAutoScheduleOtherConflictsHtml: _renderAutoScheduleOtherConflictsHtml,
        _autoOpenAutoScheduleShortageFor: _autoOpenAutoScheduleShortageFor,
        _autoScheduleShortageKey: _autoScheduleShortageKey,
        _renderAutoScheduleCandidatePreviewHtml: _renderAutoScheduleCandidatePreviewHtml,
        _renderAutoScheduleStandaloneCandidatePreviewHtml: _renderAutoScheduleStandaloneCandidatePreviewHtml,
        // _renderAutoScheduleModal 자체는 document.getElementById("autoScheduleModalBody")에
        // 의존하지만, revalidation/diagnostic 둘 다 없는 상태에서 candidate select→preview
        // 계약이 실제로 성립하는지는 이 함수 전체(그 안의 if/else 분기 포함)를 통해서만
        // 검증할 수 있어 내보낸다 — 테스트가 fake element를 document stub으로 준다.
        _renderAutoScheduleModal: _renderAutoScheduleModal,
    };
}
