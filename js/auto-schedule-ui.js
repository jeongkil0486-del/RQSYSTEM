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
};

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

    var autoConfig = {
        monthlyOffTarget: parseInt(getFirebaseItem("rq_auto_monthly_off_target", "0"), 10) || 0,
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
    var elMaxConsec = document.getElementById("autoScheduleMaxConsecutive");
    if (elTarget) elTarget.value = getFirebaseItem("rq_auto_monthly_off_target", "");
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
    var elMaxConsec = document.getElementById("autoScheduleMaxConsecutive");
    var target = parseInt((elTarget && elTarget.value) || "0", 10);
    var maxConsec = parseInt((elMaxConsec && elMaxConsec.value) || "0", 10);

    if (isNaN(target) || target < 0) { alert("월 총 휴무일수는 0 이상의 숫자여야 합니다."); return; }
    if (isNaN(maxConsec) || maxConsec < 1) { alert("최대 연속근무는 1 이상의 숫자여야 합니다."); return; }

    var codeLinkRestrictions = _getAutoCodeLinkRestrictions();

    fn.saveDeptConfig({
        deptId: currentDept,
        yyyymm: getTargetYearMonth().fullStr,
        config: {
            monthlyOffTarget: target,
            maxConsecutiveWork: maxConsec,
            codeLinkRestrictions: codeLinkRestrictions,
        },
    }).then(function () {
        liveDBData["rq_auto_monthly_off_target"] = target;
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
    var maxConsec = getFirebaseItem("rq_auto_max_consecutive_work", null);
    if (target == null || maxConsec == null) {
        el.textContent = "설정 필요 (월 총 휴무일수 / 최대 연속근무)";
    } else {
        el.textContent = "월 휴무 " + target + "일 · 최대 연속근무 " + maxConsec + "일";
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
    var input = _buildAutoScheduleInput();
    _autoScheduleState.input = input;
    _autoScheduleState.forcedOverrides = []; // 새로 생성하면 이전 override 누적은 초기화
    _autoScheduleState.selectedCandidate = null;
    _autoScheduleState.draft = AutoScheduleEngine.generateDraft(input);
    _autoScheduleState.revalidation = null;
    _renderAutoScheduleModal();
}

function revalidateAutoSchedule() {
    if (!_autoScheduleState.draft || !_autoScheduleState.input) return;
    _autoScheduleState.revalidation = AutoScheduleEngine.revalidateDraft(_autoScheduleState.draft, _autoScheduleState.input);
    _renderAutoScheduleModal();
}

function _autoScheduleCandidatesFor(conflictIndex) {
    var draft = _autoScheduleState.draft, input = _autoScheduleState.input;
    if (!draft || !input) return [];
    var conflict = draft.conflicts[conflictIndex];
    if (!conflict || conflict.kind !== "work_shortfall") return [];
    return AutoScheduleEngine.findOverrideCandidates(
        draft, conflict, input.employees, input.groups, input.autoConfig,
        input.previousMonthWorkTail, input.previousMonthLastScheduleCode
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
    _renderAutoScheduleModal();
}

/** [취소] — 선택 상태만 해제한다. draft/original request 변경 없음(side effect 0). */
function cancelAutoScheduleCandidateSelection() {
    _autoScheduleState.selectedCandidate = null;
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
    _autoScheduleState.revalidation = null; // 이전 draft 기준 재검사 결과는 절대 재사용하지 않는다
    _autoScheduleState.selectedCandidate = null;
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
    exportAutoScheduleToExcel(_autoScheduleState.draft, _autoScheduleState.input.employees, groupByEmp, revalidation, "자동스케줄_" + tm.fullStr, meta);
}

// ── 렌더링 ────────────────────────────────────────────────────────────────────

var AUTO_SCHEDULE_CONFLICT_LABEL = {
    work_shortfall: "근무 인원 부족",
    no_valid_assignment: "배정 불가(월 휴무 목표 초과)",
    group_off_cap: "조별 휴무 정원 초과",
    day_off_cap: "특정일 휴무 정원 초과",
    monthly_off_shortfall: "월 총 휴무일수 미달",
};

function _renderAutoScheduleModal() {
    var body = document.getElementById("autoScheduleModalBody");
    if (!body) return;

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

    html += "<div class='feature-card-action' style='margin-bottom:10px;'>"
        + "<button class='btn btn-primary-sm' onclick='generateAutoScheduleDraft()'>자동 스케줄 생성</button>"
        + "</div>";

    var draft = _autoScheduleState.draft;
    if (!draft) {
        html += "<div class='auto-schedule-hint'>아직 생성된 초안이 없습니다.</div>";
        body.innerHTML = html;
        return;
    }

    if (draft.ok) {
        html += "<div class='auto-schedule-success-banner'>✅ 보호 모드(신청휴무 100% 유지)로 조건을 모두 만족하는 초안을 생성했습니다.</div>";
    } else {
        html += "<div class='auto-schedule-error-summary'>⚠ 신청휴무를 유지한 상태에서는 충족할 수 없는 조건이 " + draft.conflicts.length + "건 있습니다.</div>";
        html += "<div class='auto-schedule-conflict-list'>";
        var sel = _autoScheduleState.selectedCandidate;
        draft.conflicts.forEach(function (c, idx) {
            var label = AUTO_SCHEDULE_CONFLICT_LABEL[c.kind] || c.kind;
            var candidateArea = "";
            if (c.kind === "work_shortfall" && !locked) {
                if (sel && sel.conflictIndex === idx) {
                    var origLabel = (typeof AUTO_SCHEDULE_CODE_LABEL !== "undefined" && AUTO_SCHEDULE_CODE_LABEL[sel.originalType]) || sel.originalType;
                    candidateArea = "<div class='auto-schedule-override-preview'>"
                        + "<div class='auto-schedule-override-preview-title'>신청휴무 조정 미리보기</div>"
                        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>이름</span>" + _escapeHtml(sel.name) + "</div>"
                        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>날짜</span>" + sel.day + "일</div>"
                        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>원 신청</span>" + _escapeHtml(origLabel) + "</div>"
                        + "<div class='auto-schedule-override-preview-row'><span class='auto-schedule-override-preview-label'>변경 후</span>" + _escapeHtml(sel.scheduleCode) + "근무</div>"
                        + "<div class='feature-card-action' style='gap:8px;margin-top:8px;'>"
                        + "<button type='button' class='btn btn-secondary' onclick='cancelAutoScheduleCandidateSelection()'>취소</button>"
                        + "<button type='button' class='btn btn-primary-sm' onclick='confirmApplyAutoScheduleCandidate()'>적용</button>"
                        + "</div></div>";
                } else {
                    candidateArea = "<div><button type='button' class='btn btn-secondary' style='font-size:11px;padding:2px 8px;margin-top:4px;' onclick='toggleAutoScheduleCandidates(" + idx + ")'>신청휴무 조정 후보 보기</button>"
                        + "<div id='autoScheduleCandidates_" + idx + "' style='display:none;margin-top:4px;'></div></div>";
                }
            }
            html += "<div class='auto-schedule-conflict-card'>"
                + "<strong>[" + _escapeHtml(label) + "]</strong> " + _escapeHtml(c.message || "")
                + candidateArea
                + "</div>";
        });
        html += "</div>";
    }

    html += "<div class='feature-card-action' style='gap:8px;margin-bottom:10px;'>"
        + "<button class='btn btn-secondary' onclick='revalidateAutoSchedule()'>조건 재검사</button>"
        + "<button class='btn btn-primary-sm' onclick='downloadAutoScheduleExcel()'>Excel 다운로드</button>"
        + "</div>";

    var revalidation = _autoScheduleState.revalidation;
    if (revalidation) {
        html += "<div class='auto-schedule-revalidation-summary " + (revalidation.passed ? "is-pass" : "is-fail") + "'>"
            + (revalidation.passed ? "✅ 14개 항목 전체 통과" : "⚠ 일부 항목 실패 — 확정 불가") + "</div>";
        html += "<div class='auto-schedule-check-list'>";
        revalidation.checks.forEach(function (check) {
            html += "<div class='" + (check.ok ? "" : "auto-schedule-check-fail") + "' style='padding:2px 0;'>" + (check.ok ? "✅" : "❌") + " " + _escapeHtml(check.name)
                + (check.ok ? "" : " — " + _escapeHtml(check.detail || "")) + "</div>";
        });
        html += "</div>";
    }

    html += "<div class='feature-card-action'>"
        + "<button class='btn btn-primary-sm'" + (revalidation && revalidation.passed && !locked ? "" : " disabled") + " onclick='confirmAutoSchedule()'>스케줄 확정</button>"
        + "</div>";

    body.innerHTML = html;
}

if (typeof module === "object" && module.exports) {
    module.exports = { _autoScheduleGroupOfUid: _autoScheduleGroupOfUid, _getAutoCodeLinkRestrictions: _getAutoCodeLinkRestrictions };
}
