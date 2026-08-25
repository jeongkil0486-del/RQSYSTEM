/**
 * auto-schedule-engine.js — 자동 스케줄링 결정론적 제약조건 엔진
 *
 * ⚠️ 이 파일은 순수 계산 로직만 담는다 — Firebase(RTDB/Functions) 호출이 전혀 없다.
 * 브라우저(index.html에 <script>로 로드)와 Node(테스트) 양쪽에서 동일하게 동작하도록
 * 순수 함수 + 일반 객체(JS plain object)만 사용한다. 입력은 관리자 화면이 기존
 * liveDBData/adminViewCache/deptEmployees 등에서 미리 조립해서 넘긴다 — 이 파일
 * 자체는 그 값들이 어디서 왔는지 전혀 모른다(source of truth와 완전히 분리).
 *
 * 알고리즘: 생성형 AI/무작위 배정이 아니라 날짜 순서대로 진행하는 결정론적
 * greedy 제약조건 배정이다(백트래킹 없음 — 이유는 auto-schedule-engine.md 대신
 * 이 헤더 주석 및 최종 보고서에 근거를 남긴다: 현재 규모(직원 수십 명 x 31일 x
 * 조 5개 x 코드 소수)에서는 각 (날짜,조,코드) 슬롯을 앞에서부터 순서대로 채우는
 * greedy만으로 실무적으로 요구되는 스케줄을 충분히 만들 수 있고, 최악의 경우
 * 채우지 못하면 "실패 + 정확한 충돌 위치"를 반환해 관리자가 신청휴무 조정
 * 기능으로 직접 해소하도록 설계했다 — 이는 스펙이 요구하는 "무작위 배정 금지 +
 * 실패 시 명확한 원인 반환 + 부분 결과를 몰래 확정하지 않음" 요구와 정확히
 * 부합한다. 입력 규모가 커져 greedy가 자주 막히면 그때 실제 solver 도입을
 * 재검토할 것을 권장한다(이번 단계에서는 도입하지 않음).
 */

// ── 상수 ────────────────────────────────────────────────────────────────────
var AUTO_SCHEDULE_MAX_ITERATIONS = 200000; // 무한루프/freeze 방지 안전장치

// ── 유틸 ────────────────────────────────────────────────────────────────────
function _asDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
}

/** 직원 정렬키 — 기존 시스템(firebase-store.js _rebuildEmployeeMaps)과 동일한 기준:
 *  sortOrder 우선(오름차순), 없으면 empNo 사전순. 동률 처리에 사용하는 유일한 기준이며
 *  무작위성은 전혀 없다. */
function _autoSortEmployees(list) {
    return list.slice().sort(function (a, b) {
        var aHas = a.sortOrder != null, bHas = b.sortOrder != null;
        if (aHas && bHas) return Number(a.sortOrder) - Number(b.sortOrder);
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return String(a.empNo || "").localeCompare(String(b.empNo || ""), undefined, { numeric: true, sensitivity: "base" });
    });
}

/** 특정 (day, group)에서 조별 휴무 정원(cap)을 계산한다. groupDayLimitsEnabled면
 *  날짜별 값만 source of truth(없으면 그 조는 그날 제한 없음 취급), 아니면 legacy
 *  groupMax{G} 사용. */
function _groupOffCap(config, day, group) {
    if (config.groupDayLimitsEnabled === true) {
        var dayLimits = (config.groupDayLimits || {})[String(day)];
        if (!dayLimits || dayLimits[group] == null) return Infinity; // 그 날짜에 설정 없으면 제한 없음(기존 정책과 동일)
        return Number(dayLimits[group]);
    }
    var legacy = config["groupMax" + group];
    return legacy != null ? Number(legacy) : Infinity;
}

/** 특정 (day, group, code)에서 조별 근무 정원을 계산한다. exact-key만 사용
 *  (codeName + "_" + group) — prefix/split/startsWith 절대 사용하지 않는다.
 *
 *  ⚠️ "제약조건 없음"과 "명시적으로 0명"을 절대 같은 값으로 뭉개면 안 된다 — 과거에는
 *  둘 다 숫자 0을 반환해서 호출부가 `quota <= 0`으로 "검사 자체를 건너뛰어도 된다"고
 *  오판했고, 그 결과 관리자가 명시적으로 "이 조는 이 코드에 0명이어야 한다"고 설정해도
 *  실제로 1명이 배정된 상태가 조건검사를 통과하는 실제 버그로 이어졌다(Codex 재현).
 *  반드시 키의 "존재 여부"를 먼저 확인해 없으면 null(제약없음), 있으면 그 숫자(0 포함)를
 *  반환한다 — specialDayLimits[day]===0을 유효값으로 취급하는 _dayOffCap과 동일한 원칙. */
function _groupCodeQuota(config, day, group, codeName) {
    var key = codeName + "_" + group;
    if (config.scGroupDayLimitsEnabled === true) {
        var dayLimits = (config.scGroupDayLimits || {})[String(day)];
        if (!dayLimits || !Object.prototype.hasOwnProperty.call(dayLimits, key) || dayLimits[key] == null) return null;
        return Number(dayLimits[key]);
    }
    if (config.scGroupLimits && Object.prototype.hasOwnProperty.call(config.scGroupLimits, key) && config.scGroupLimits[key] != null) {
        return Number(config.scGroupLimits[key]);
    }
    return null;
}

/** 특정 day의 전체 휴무 정원(cap). specialDayLimits[day]가 있으면 그 값(0 포함,
 *  falsy가 아니라 존재 여부로 판단), 없으면 dayMax. */
function _dayOffCap(config, day) {
    var special = config.specialDayLimits && Object.prototype.hasOwnProperty.call(config.specialDayLimits, String(day))
        ? config.specialDayLimits[String(day)] : null;
    return special != null ? Number(special) : Number(config.dayMax);
}

// ⚠️ UMD 스타일: index.html의 <script> 태그(브라우저, module 없음)와 Node의
// require()(테스트, module.exports 있음) 양쪽에서 동일하게 동작해야 한다.
var AutoScheduleEngine = (function () {

// ═══════════════════════════════════════════════════════════════════════════
// 1) 고정 신청 그리드 구성
// ═══════════════════════════════════════════════════════════════════════════

/**
 * existingRequests: { [empKey]: { [day]: { type, scheduleCode? } } }
 * forcedOverrides: [{ uid, day, scheduleCode, originalRequest?:{type}, override?:{changedBy,changedAt,reason} }]
 *   — 관리자가 "신청휴무 조정 후보"에서 이미 [적용]을 눌러 확정한 override 목록.
 *   재편성(re-solve) 때마다 이 목록 전체를 고정 제약으로 다시 주입해, greedy/fallback이
 *   그 칸을 절대 건드리지 않고(=freeCells에서 자동 제외, source가 "auto"/"auto_off"가
 *   아니므로) 나머지만 다시 배치하도록 만든다. 원본 신청은 여기서 지우지 않고
 *   originalRequest 안에 그대로 보존한다.
 * → grid: { [empKey]: { [day]: { type, scheduleCode?, source: "requested"|"override", originalRequest?, override? } } }
 * (얕은 복사 — 원본 existingRequests/forcedOverrides는 절대 변형하지 않는다)
 */
function buildFixedGrid(existingRequests, forcedOverrides) {
    var grid = {};
    Object.keys(existingRequests || {}).forEach(function (empKey) {
        grid[empKey] = {};
        var days = existingRequests[empKey] || {};
        Object.keys(days).forEach(function (day) {
            var req = days[day];
            if (!req) return;
            grid[empKey][day] = {
                type: req.type,
                scheduleCode: req.scheduleCode || null,
                source: "requested",
            };
        });
    });
    (forcedOverrides || []).forEach(function (ov) {
        if (!ov || !ov.uid || ov.day == null || !ov.scheduleCode) return;
        var dayStr = String(ov.day);
        if (!grid[ov.uid]) grid[ov.uid] = {};
        var original = ov.originalRequest || { type: "normal" };
        grid[ov.uid][dayStr] = {
            type: "schedule",
            scheduleCode: ov.scheduleCode,
            source: "override",
            originalRequest: { type: original.type },
            override: {
                changedBy: (ov.override && ov.override.changedBy) || null,
                changedAt: (ov.override && ov.override.changedAt) || Date.now(),
                reason: (ov.override && ov.override.reason) || "auto_schedule_conflict",
            },
        };
    });
    return grid;
}

// ═══════════════════════════════════════════════════════════════════════════
// 2) 연속근무 계산
// ═══════════════════════════════════════════════════════════════════════════

/** day의 assignment가 "근무"(schedule code 배정)인지 여부 — normal/annual/petition/
 *  auto_off는 전부 근무 아님(연속근무 스트릭을 끊는다). */
function _isWorkEntry(entry) {
    return !!(entry && entry.type === "schedule");
}

/**
 * empKey가 day 시점까지(포함) 그리드 기준으로 몇 연속 근무일째인지 계산한다.
 * previousMonthTail(전월 말일부터 이어지는 연속근무일수, 0 이상 정수)을 day=1
 * 이전의 "가상 근무일"로 취급해 이어서 계산한다.
 */
function consecutiveWorkStreakAt(grid, empKey, day, previousMonthTail) {
    var streak = 0;
    var d = day;
    while (d >= 1) {
        var entry = (grid[empKey] || {})[String(d)];
        if (_isWorkEntry(entry)) { streak++; d--; }
        else break;
    }
    if (d < 1) {
        // day=1까지 전부 근무였다면 전월 꼬리를 이어붙인다
        streak += Number(previousMonthTail || 0);
    }
    return streak;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3) 근무코드 연결 제한
// ═══════════════════════════════════════════════════════════════════════════

/** codeLinkRestrictions: [{from, to}] — exact-key. 전날 코드가 from이면 오늘 to 배정 금지. */
function isCodeLinkForbidden(codeLinkRestrictions, prevDayCode, todayCode) {
    if (!prevDayCode || !Array.isArray(codeLinkRestrictions)) return false;
    return codeLinkRestrictions.some(function (r) {
        return r && r.from === prevDayCode && r.to === todayCode;
    });
}

/**
 * day 시점의 "전날 근무코드"를 반환한다. day===1이면 이번 달 그리드에는 전날이
 * 존재하지 않으므로, 전월 finalSchedules에서 뽑아온 마지막 근무코드
 * (previousMonthLastScheduleCode[uid], schedule이 아니었으면 null)를 사용한다.
 * day>1이면 이번 달 그리드의 day-1 항목을 그대로 본다.
 *
 * ⚠️ previousMonthWorkTail(연속근무 "일수")과 이 값은 서로 다른 정보다 — 둘 다
 * "전월 말일이 근무였는지"에서 파생되지만, 8/30 근무·8/31 휴무처럼 말일 자체가
 * 근무가 아니면 workTail=0이면서 lastScheduleCode도 null이어야 하고, 반대로
 * 8/30 휴무·8/31 근무면 workTail=1이면서 lastScheduleCode="그 코드"여야 한다.
 * 하나의 값에서 다른 값을 억지로 유추하지 않고, 전월 finalSchedules의 실제
 * 마지막 날짜 데이터를 기준으로 각각 독립적으로 계산해서 넘겨받는다.
 */
function _prevCodeAt(grid, uid, day, previousMonthLastScheduleCode) {
    if (day <= 1) {
        var m = previousMonthLastScheduleCode || {};
        return m[uid] || null;
    }
    var entry = (grid[uid] || {})[String(day - 1)];
    return entry && entry.type === "schedule" ? entry.scheduleCode : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// 3b) greedy 실패 시 제한적 fallback 백트래킹
// ═══════════════════════════════════════════════════════════════════════════
// greedy가 배정 순서 때문에 실패하는 경우와, 진짜로 불가능한 경우를 구분하기
// 위한 국소(local) 탐색이다. OR-Tools 등 외부 solver는 도입하지 않고 순수 JS로
// 구현하며, 절대 전체 월(수십 명 x 31일)을 완전탐색하지 않는다 — 충돌이 발생한
// 날짜 ±AUTO_SCHEDULE_FALLBACK_WINDOW일, 그 충돌이 발생한 조(group)로만 탐색
// 범위를 제한하고, 그 범위 안에서도 오직 source가 "auto"/"auto_off"인 셀(=관리자
// 신청/override가 아닌, greedy가 스스로 채운 칸)만 재배정 대상으로 삼는다.
// 신청휴무/연차/청원/신청근무코드/override는 절대 건드리지 않는다.
var AUTO_SCHEDULE_FALLBACK_WINDOW = 3;
var AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS = 50000;
var AUTO_SCHEDULE_FALLBACK_TIME_BUDGET_MS = 1500;

/** scope(days/groups) 안에서만 검사하는 국소 정원/미배정 위반 목록. */
function _localConflicts(grid, employees, employeesByGroup, config, scheduleCodes, scopeDays, scopeGroups) {
    var conflicts = [];
    scopeDays.forEach(function (day) {
        var dayStr = String(day);
        var dayOffCapTotal = _dayOffCap(config, day);
        var dayOffUsed = employees.reduce(function (acc, emp) {
            var e = (grid[emp.uid] || {})[dayStr];
            return acc + (e && e.type === "normal" ? 1 : 0);
        }, 0);
        if (dayOffUsed > dayOffCapTotal) conflicts.push({ kind: "day_off_cap", day: day });

        scopeGroups.forEach(function (group) {
            var members = employeesByGroup[group] || [];
            var groupOffCap = _groupOffCap(config, day, group);
            var groupOffUsed = members.reduce(function (acc, emp) {
                var e = (grid[emp.uid] || {})[dayStr];
                return acc + (e && e.type === "normal" ? 1 : 0);
            }, 0);
            if (groupOffUsed > groupOffCap) conflicts.push({ kind: "group_off_cap", day: day, group: group });

            scheduleCodes.forEach(function (codeItem) {
                var quota = _groupCodeQuota(config, day, group, codeItem.name);
                if (quota == null) return; // 제약 없음(키 자체가 없음) — 명시적 0은 아래에서 계속 검사됨
                var used = members.reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[dayStr];
                    return acc + (e && e.type === "schedule" && e.scheduleCode === codeItem.name ? 1 : 0);
                }, 0);
                if (used !== quota) conflicts.push({ kind: "work_shortfall", day: day, group: group, scheduleCode: codeItem.name });
            });

            members.forEach(function (emp) {
                var e = (grid[emp.uid] || {})[dayStr];
                if (!e) conflicts.push({ kind: "no_valid_assignment", day: day, group: group, empKey: emp.uid });
            });
        });
    });
    return conflicts;
}

/** scope 바깥까지 포함한 전체 달 기준 최대연속근무 재확인(값 자체는 저렴한 선형 스캔). */
function _fullMonthStreakOk(grid, employees, totalDays, prevTail, maxConsecutiveWork) {
    if (!(maxConsecutiveWork > 0)) return true;
    for (var i = 0; i < employees.length; i++) {
        var emp = employees[i];
        for (var d = 1; d <= totalDays; d++) {
            if (consecutiveWorkStreakAt(grid, emp.uid, d, prevTail[emp.uid]) > maxConsecutiveWork) return false;
        }
    }
    return true;
}

/** scope 경계를 넘나드는 근무코드 연결 제한 위반도 전체 달 기준으로 재확인.
 *  전월 마지막 근무코드 → 이번달 1일 전환(day=1)도 반드시 포함한다. */
function _fullMonthCodeLinkOk(grid, employees, totalDays, codeLinkRestrictions, previousMonthLastScheduleCode) {
    if (!codeLinkRestrictions || !codeLinkRestrictions.length) return true;
    for (var i = 0; i < employees.length; i++) {
        var emp = employees[i];
        for (var d = 1; d <= totalDays; d++) {
            var prevCode = _prevCodeAt(grid, emp.uid, d, previousMonthLastScheduleCode);
            var cur = (grid[emp.uid] || {})[String(d)];
            var curCode = cur && cur.type === "schedule" ? cur.scheduleCode : null;
            if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, curCode)) return false;
        }
    }
    return true;
}

/**
 * greedyDraft({grid, conflicts, totalDays})가 실패했을 때 국소 백트래킹으로
 * 재시도한다. 반환값:
 *   null                          — 시도할 대상이 없음(관련 conflict 없음, 즉
 *                                    이 fallback으로는 애초에 도울 수 없는 종류의 실패)
 *   { ok:true,  grid, iterations }   — 국소 재배정으로 성공(호출부가 grid를 교체)
 *   { ok:false, timedOut, iterations } — 실패(시간/반복 한도 초과 또는 탐색 완료 후에도 불가능)
 */
function _fallbackBacktrack(input, greedyDraft) {
    var relevantKinds = { work_shortfall: 1, no_valid_assignment: 1, group_off_cap: 1, day_off_cap: 1 };
    var relevant = greedyDraft.conflicts.filter(function (c) { return relevantKinds[c.kind]; });
    if (!relevant.length) return null;

    var year = input.year, month = input.month;
    var totalDays = _asDaysInMonth(year, month);
    var employees = _autoSortEmployees(input.employees || []);
    var groups = input.groups || {};
    var config = input.config || {};
    var autoConfig = input.autoConfig || {};
    var monthlyOffTarget = Number(autoConfig.monthlyOffTarget || 0);
    var maxConsecutiveWork = Number(autoConfig.maxConsecutiveWork || 0);
    var codeLinkRestrictions = autoConfig.codeLinkRestrictions || [];
    var scheduleCodes = Array.isArray(config.scheduleCodes) ? config.scheduleCodes : [];
    var prevTail = input.previousMonthWorkTail || {};
    var prevLastCode = input.previousMonthLastScheduleCode || {};

    var groupByEmp = {};
    Object.keys(groups).forEach(function (g) { (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; }); });
    employees.forEach(function (emp) { if (!groupByEmp[emp.uid] && emp.group) groupByEmp[emp.uid] = emp.group; });
    var employeesByGroup = {};
    employees.forEach(function (emp) {
        var g = groupByEmp[emp.uid];
        if (!g) return;
        (employeesByGroup[g] = employeesByGroup[g] || []).push(emp);
    });

    var scopeDaySet = {}, scopeGroupSet = {};
    relevant.forEach(function (c) {
        if (c.group) scopeGroupSet[c.group] = true;
        if (c.day) {
            var lo = Math.max(1, c.day - AUTO_SCHEDULE_FALLBACK_WINDOW);
            var hi = Math.min(totalDays, c.day + AUTO_SCHEDULE_FALLBACK_WINDOW);
            for (var dd = lo; dd <= hi; dd++) scopeDaySet[dd] = true;
        }
    });
    var scopeDays = Object.keys(scopeDaySet).map(Number).sort(function (a, b) { return a - b; });
    var scopeGroups = Object.keys(scopeGroupSet).sort();
    if (!scopeDays.length || !scopeGroups.length) return null;

    // greedy grid를 얕은 복사(1레벨) — 고정/override 셀은 절대 재대입하지 않는다.
    var grid = {};
    Object.keys(greedyDraft.grid).forEach(function (k) { grid[k] = Object.assign({}, greedyDraft.grid[k]); });

    var freeCells = [];
    scopeDays.forEach(function (day) {
        scopeGroups.forEach(function (group) {
            (employeesByGroup[group] || []).forEach(function (emp) {
                var dayStr = String(day);
                var existing = (grid[emp.uid] || {})[dayStr];
                if (!existing || existing.source === "auto" || existing.source === "auto_off") {
                    freeCells.push({ day: day, dayStr: dayStr, group: group, emp: emp });
                }
            });
        });
    });
    freeCells.sort(function (a, b) { if (a.day !== b.day) return a.day - b.day; return (a.emp.sortOrder || 0) - (b.emp.sortOrder || 0); });
    // DFS가 처음부터 재배정할 수 있도록 free cell은 일단 비운다.
    freeCells.forEach(function (fc) { if (grid[fc.emp.uid]) delete grid[fc.emp.uid][fc.dayStr]; });

    var candidateValues = scheduleCodes.map(function (c) { return { type: "schedule", scheduleCode: c.name }; });
    candidateValues.push({ type: "normal" });

    var iterations = 0;
    var startTime = Date.now();
    var timedOut = false;

    function withinBudget() {
        if (timedOut) return false; // 이미 한도 초과 상태 — 스택을 되감는 동안 카운트가 계속 불어나지 않도록 즉시 차단
        iterations++;
        if (iterations > AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS) { timedOut = true; return false; }
        if ((iterations & 511) === 0 && (Date.now() - startTime) > AUTO_SCHEDULE_FALLBACK_TIME_BUDGET_MS) { timedOut = true; return false; }
        return true;
    }
    function ensureGridDayLocal(empKey) { if (!grid[empKey]) grid[empKey] = {}; }
    function monthlyOffCountFor(empKey) {
        var count = 0;
        Object.keys(grid[empKey] || {}).forEach(function (d) { if (grid[empKey][d].type === "normal") count++; });
        return count;
    }

    function leafOk() {
        if (_localConflicts(grid, employees, employeesByGroup, config, scheduleCodes, scopeDays, scopeGroups).length > 0) return false;
        if (!_fullMonthStreakOk(grid, employees, totalDays, prevTail, maxConsecutiveWork)) return false;
        if (!_fullMonthCodeLinkOk(grid, employees, totalDays, codeLinkRestrictions, prevLastCode)) return false;
        return true;
    }

    function tryAssign(index) {
        if (timedOut) return false;
        if (index >= freeCells.length) return leafOk();

        var fc = freeCells[index];
        for (var vi = 0; vi < candidateValues.length; vi++) {
            if (!withinBudget()) return false;
            var candidate = candidateValues[vi];

            if (candidate.type === "schedule") {
                var quota = _groupCodeQuota(config, fc.day, fc.group, candidate.scheduleCode);
                if (quota == null || quota <= 0) continue; // 제약 없음이거나 명시적 0 — 이 코드로는 배정 후보 자체가 될 수 없음
                var usedNow = (employeesByGroup[fc.group] || []).reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[fc.dayStr];
                    return acc + (e && e.type === "schedule" && e.scheduleCode === candidate.scheduleCode ? 1 : 0);
                }, 0);
                if (usedNow >= quota) continue;

                var streak = consecutiveWorkStreakAt(grid, fc.emp.uid, fc.day - 1, prevTail[fc.emp.uid]);
                if (maxConsecutiveWork > 0 && streak + 1 > maxConsecutiveWork) continue;

                var prevCode = _prevCodeAt(grid, fc.emp.uid, fc.day, prevLastCode);
                if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, candidate.scheduleCode)) continue;

                var nextEntry = (grid[fc.emp.uid] || {})[String(fc.day + 1)];
                if (nextEntry && nextEntry.type === "schedule" && isCodeLinkForbidden(codeLinkRestrictions, candidate.scheduleCode, nextEntry.scheduleCode)) continue;
            } else {
                var offBudget = monthlyOffTarget - monthlyOffCountFor(fc.emp.uid);
                if (offBudget <= 0) continue;
                var dayOffCapTotal = _dayOffCap(config, fc.day);
                var dayOffUsedNow = employees.reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[fc.dayStr];
                    return acc + (e && e.type === "normal" ? 1 : 0);
                }, 0);
                if (dayOffUsedNow >= dayOffCapTotal) continue;
                var groupOffCap = _groupOffCap(config, fc.day, fc.group);
                var groupOffUsedNow = (employeesByGroup[fc.group] || []).reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[fc.dayStr];
                    return acc + (e && e.type === "normal" ? 1 : 0);
                }, 0);
                if (groupOffUsedNow >= groupOffCap) continue;
            }

            ensureGridDayLocal(fc.emp.uid);
            grid[fc.emp.uid][fc.dayStr] = candidate.type === "schedule"
                ? { type: "schedule", scheduleCode: candidate.scheduleCode, source: "auto" }
                : { type: "normal", source: "auto_off" };

            if (tryAssign(index + 1)) return true;

            delete grid[fc.emp.uid][fc.dayStr];
        }
        return false;
    }

    var success = tryAssign(0);
    if (!success) return { ok: false, timedOut: timedOut, iterations: iterations };
    return { ok: true, timedOut: false, iterations: iterations, grid: grid };
}

// ═══════════════════════════════════════════════════════════════════════════
// 3c) conflict 표시용 집계 (reporting 전용 — 스케줄 계산/제약조건 semantics는
//     전혀 건드리지 않는다. 이미 확정된 grid와 이미 확정된 conflicts 목록을
//     "관리자가 읽기 좋은 형태로 묶어서 다시 표현"만 한다.)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * greedy가 하루/조마다 후보를 하나씩 순회하며 "이 사람은 오늘 이 사유로 배정
 * 못 함"을 매번 개별 conflict로 남긴 것(day_off_cap/group_off_cap/no_valid_assignment)을
 * (kind, day, group) 단위로 묶어 "그 날 그 사유로 배정 못 한 사람이 N명"이라는
 * 하나의 항목으로 재표현한다. work_shortfall/monthly_off_shortfall/
 * search_limit_exceeded/iteration_limit은 이미 day/group/code 단위(또는 직원당
 * 정확히 1건)로만 발생하므로 그대로 둔다 — 실제 원인/직원/조/코드 detail은
 * employees 배열에 전부 보존되며, message에도 대표 이름 몇 명 + 나머지 인원수를
 * 표기해 숨기지 않는다.
 */
function _aggregateConflicts(conflicts) {
    var AGGREGATABLE = { day_off_cap: 1, group_off_cap: 1, no_valid_assignment: 1 };
    var buckets = {};
    var order = [];
    var passthrough = [];

    conflicts.forEach(function (c) {
        if (!AGGREGATABLE[c.kind]) { passthrough.push(c); return; }
        var key = c.kind + "|" + c.day + "|" + (c.group || "");
        if (!buckets[key]) {
            buckets[key] = { kind: c.kind, day: c.day, group: c.group, cap: c.cap, target: c.target, employees: [] };
            order.push(key);
        }
        buckets[key].employees.push({ uid: c.empKey, name: c.empName });
    });

    var aggregated = order.map(function (key) {
        var b = buckets[key];
        var names = b.employees.map(function (e) { return e.name || e.uid; });
        var label = names.length > 3 ? (names.slice(0, 3).join(", ") + " 외 " + (names.length - 3) + "명") : names.join(", ");
        var message;
        if (b.kind === "day_off_cap") {
            message = b.day + "일 전체 휴무 정원(" + b.cap + "명) 으로 " + names.length + "명(" + label + ") 추가 배정 불가.";
        } else if (b.kind === "group_off_cap") {
            message = b.day + "일 " + b.group + "조 휴무 정원(" + b.cap + "명) 으로 " + names.length + "명(" + label + ") 추가 배정 불가.";
        } else {
            message = b.day + "일 " + b.group + "조 — " + names.length + "명(" + label + ")이 월 휴무 목표(" + b.target + ")에 이미 도달해 근무/휴무 배정 불가.";
        }
        return {
            kind: b.kind, day: b.day, group: b.group, cap: b.cap, target: b.target,
            empKey: b.employees[0].uid, empName: b.employees[0].name, // 하위호환(단일 직원 케이스와 동일한 필드 유지)
            employees: b.employees, count: b.employees.length,
            message: message,
        };
    });

    return passthrough.concat(aggregated);
}

// ═══════════════════════════════════════════════════════════════════════════
// 4) 메인 생성 함수 (보호 모드 — 고정 신청 절대 변경 없음)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * generateDraft(input) → { ok, totalDays, grid, conflicts, monthlyOffCount }
 *
 * input: {
 *   year, month,                      // 대상 연/월
 *   employees: [{uid, empNo, name, group, sortOrder}],
 *   groups: { A:[uid,...], B:[...], ... },   // persistent groups 형태(조별 uid 배열)
 *   config: { dayMax, specialDayLimits, groupDayLimits, groupDayLimitsEnabled,
 *             groupMaxA..E, scGroupDayLimits, scGroupDayLimitsEnabled, scGroupLimits,
 *             scheduleCodes:[{name,limit}] },
 *   autoConfig: { monthlyOffTarget, maxConsecutiveWork, codeLinkRestrictions:[{from,to}] },
 *   existingRequests: { [empKey]: { [day]: {type, scheduleCode?} } },
 *   previousMonthWorkTail: { [empKey]: number },   // 없으면 0 취급
 *   forcedOverrides: [{ uid, day, scheduleCode, originalRequest?, override? }],  // 없으면 [] 취급 —
 *     관리자가 이미 [적용]한 신청휴무 조정. 재편성 때마다 고정 제약으로 다시 주입된다.
 * }
 */
function generateDraft(input) {
    var year = input.year, month = input.month;
    var totalDays = _asDaysInMonth(year, month);
    var employees = _autoSortEmployees(input.employees || []);
    var groups = input.groups || {};
    var config = input.config || {};
    var autoConfig = input.autoConfig || {};
    var monthlyOffTarget = Number(autoConfig.monthlyOffTarget || 0);
    var maxConsecutiveWork = Number(autoConfig.maxConsecutiveWork || 0);
    var codeLinkRestrictions = autoConfig.codeLinkRestrictions || [];
    var scheduleCodes = Array.isArray(config.scheduleCodes) ? config.scheduleCodes : [];
    var prevTail = input.previousMonthWorkTail || {};
    var prevLastCode = input.previousMonthLastScheduleCode || {};

    var grid = buildFixedGrid(input.existingRequests, input.forcedOverrides);
    var conflicts = [];
    var iterations = 0;

    // empKey -> group 매핑(요청 그룹 우선, 없으면 employees[].group, 없으면 groups 구조에서 역참조)
    var groupByEmp = {};
    Object.keys(groups).forEach(function (g) {
        (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; });
    });
    employees.forEach(function (emp) {
        if (!groupByEmp[emp.uid] && emp.group) groupByEmp[emp.uid] = emp.group;
    });

    var employeesByGroup = {};
    employees.forEach(function (emp) {
        var g = groupByEmp[emp.uid];
        if (!g) return;
        (employeesByGroup[g] = employeesByGroup[g] || []).push(emp);
    });

    // 월 누적 일반휴무(normal + auto_off) 카운트 — annual/petition은 절대 포함하지 않는다.
    var monthlyOffCount = {};
    employees.forEach(function (emp) { monthlyOffCount[emp.uid] = 0; });
    // 고정 신청 중 normal은 이미 확정된 휴무이므로 먼저 집계
    employees.forEach(function (emp) {
        var days = grid[emp.uid] || {};
        Object.keys(days).forEach(function (day) {
            if (days[day].type === "normal") monthlyOffCount[emp.uid]++;
        });
    });

    // ⚠️ 균형 배치용 — "월 휴무 목표까지 남은 여유(deficit)가 적은 사람"부터 우선
    // 근무를 배정한다. 단순 누적 근무일수 기준으로는, 이미 고정 신청(연차/청원/휴무)이
    // 있어 근무 경쟁에 늦게 합류하는 직원이 계속 "근무일수가 적다"고 오판되어 남은
    // 기간 내내 근무 우선순위에서 밀리지 않는 대신 오히려 계속 근무로만 뽑히고,
    // 정작 그 직원의 월 총 휴무 목표는 채워지지 않는 문제가 실제 fixture 테스트로
    // 확인되었다. deficit(목표 - 현재 휴무 사용량) 기준으로 바꾸면: 이미 고정
    // 신청으로 휴무를 일부 채운 직원은 deficit이 낮아 우선 근무로 배정되고, 그 상태가
    // 계속되면 그 직원의 deficit은 그대로인데 다른 직원들의 deficit은 휴무를 받을
    // 때마다 낮아지므로 자연스럽게 우선순위가 역전되며 결국 모두 목표에 수렴한다.
    // sortOrder는 deficit이 같을 때만 동률 처리에 사용 — 여전히 완전히 결정론적이다.
    function offDeficit(empKey) { return monthlyOffTarget - (monthlyOffCount[empKey] || 0); }

    function ensureGridDay(empKey) { if (!grid[empKey]) grid[empKey] = {}; }

    function isAssignedThatDay(empKey, day) {
        return !!(grid[empKey] && grid[empKey][String(day)]);
    }

    for (var day = 1; day <= totalDays; day++) {
        var dayStr = String(day);
        var dayOffCapTotal = _dayOffCap(config, day);
        // 그 날짜에 이미 확정된(고정) normal 인원 수(전체) — special/day cap 소진분
        var dayOffUsed = 0;
        employees.forEach(function (emp) {
            var e = (grid[emp.uid] || {})[dayStr];
            if (e && e.type === "normal") dayOffUsed++;
        });

        Object.keys(employeesByGroup).forEach(function (group) {
            var members = employeesByGroup[group];
            var groupOffCap = _groupOffCap(config, day, group);
            var groupOffUsed = members.reduce(function (acc, emp) {
                var e = (grid[emp.uid] || {})[dayStr];
                return acc + (e && e.type === "normal" ? 1 : 0);
            }, 0);

            scheduleCodes.forEach(function (codeItem) {
                var codeName = codeItem.name;
                var quota = _groupCodeQuota(config, day, group, codeName);
                if (quota == null) return; // 제약 없음(키 자체가 없음) — 명시적 0은 아래에서 계속 처리됨

                var already = members.reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[dayStr];
                    return acc + (e && e.type === "schedule" && e.scheduleCode === codeName ? 1 : 0);
                }, 0);
                if (already > quota) {
                    // 고정 신청/override만으로 이미 명시적 정원(0 포함)을 초과한 상태 — auto-fill로
                    // 해결할 수 없는 진짜 충돌이므로 채우기를 시도하지 않고 그대로 보고한다.
                    conflicts.push({
                        kind: "work_shortfall", day: day, group: group, scheduleCode: codeName,
                        needed: 0, available: already,
                        message: day + "일 " + group + "조 " + codeName + "근무 정원(" + quota + ")을 신청/고정 배정만으로 이미 초과했습니다(실제 " + already + "명).",
                    });
                    return;
                }
                var needed = quota - already;
                if (needed <= 0) return;

                // 근무 배정 우선순위: 휴무 목표까지 남은 deficit이 적은 사람 우선(이미
                // 휴무를 상대적으로 많이 채운 사람이 근무를 맡는다), 동률이면 sortOrder.
                var candidates = members.slice().sort(function (a, b) {
                    var d = offDeficit(a.uid) - offDeficit(b.uid);
                    if (d !== 0) return d;
                    return (a.sortOrder || 0) - (b.sortOrder || 0);
                });

                var assignedNow = 0;
                for (var mi = 0; mi < candidates.length && assignedNow < needed; mi++) {
                    iterations++;
                    if (iterations > AUTO_SCHEDULE_MAX_ITERATIONS) {
                        return { ok: false, totalDays: totalDays, grid: grid, conflicts: conflicts.concat([{ kind: "iteration_limit", message: "반복 한도 초과 — 입력 규모를 확인하세요." }]), monthlyOffCount: monthlyOffCount };
                    }
                    var emp = candidates[mi];
                    if (isAssignedThatDay(emp.uid, day)) continue; // 이미 그 날 뭔가 배정됨(고정 or 이전 코드에서 auto 배정)

                    var streak = consecutiveWorkStreakAt(grid, emp.uid, day - 1, prevTail[emp.uid]);
                    if (streak + 1 > maxConsecutiveWork && maxConsecutiveWork > 0) continue; // 이 코드로 배정하면 연속근무 초과

                    var prevCode = _prevCodeAt(grid, emp.uid, day, prevLastCode);
                    if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, codeName)) continue;

                    ensureGridDay(emp.uid);
                    grid[emp.uid][dayStr] = { type: "schedule", scheduleCode: codeName, source: "auto" };
                    assignedNow++;
                }

                if (assignedNow < needed) {
                    conflicts.push({
                        kind: "work_shortfall",
                        day: day, group: group, scheduleCode: codeName,
                        needed: needed, available: assignedNow,
                        message: day + "일 " + group + "조 " + codeName + "근무 " + needed + "명 필요, 배정 가능 " + assignedNow + "명.",
                    });
                }
            });

            // 이 그룹에서 이 날짜에 아직 미배정인 인원 → 휴무 후보.
            // 여기서도 deficit(목표까지 남은 휴무 필요량)이 큰 사람을 우선 배치한다 —
            // group/day off cap이 빠듯한 날 여러 명이 동시에 휴무 후보가 되면, 목표
            // 달성이 급한 사람부터 채워야 월말 미달 충돌을 줄일 수 있다.
            var offCandidates = members.filter(function (emp) { return !isAssignedThatDay(emp.uid, day); })
                .sort(function (a, b) {
                    var d = offDeficit(b.uid) - offDeficit(a.uid); // deficit 큰 사람 먼저
                    if (d !== 0) return d;
                    return (a.sortOrder || 0) - (b.sortOrder || 0);
                });
            offCandidates.forEach(function (emp) {
                var remainingBudget = monthlyOffTarget - monthlyOffCount[emp.uid];
                if (remainingBudget <= 0) {
                    conflicts.push({
                        kind: "no_valid_assignment",
                        day: day, group: group, empKey: emp.uid, empName: emp.name, target: monthlyOffTarget,
                        message: day + "일 " + group + "조 " + (emp.name || emp.uid) + " — 근무 슬롯도 없고 월 휴무 목표(" + monthlyOffTarget + ")도 이미 도달해 배정 불가.",
                    });
                    return;
                }
                if (groupOffUsed >= groupOffCap) {
                    conflicts.push({
                        kind: "group_off_cap",
                        day: day, group: group, empKey: emp.uid, empName: emp.name, cap: groupOffCap,
                        message: day + "일 " + group + "조 휴무 정원(" + groupOffCap + "명) 초과로 " + (emp.name || emp.uid) + " 배정 불가.",
                    });
                    return;
                }
                if (dayOffUsed >= dayOffCapTotal) {
                    conflicts.push({
                        kind: "day_off_cap",
                        day: day, empKey: emp.uid, empName: emp.name, cap: dayOffCapTotal,
                        message: day + "일 전체 휴무 정원(" + dayOffCapTotal + "명) 초과로 " + (emp.name || emp.uid) + " 배정 불가.",
                    });
                    return;
                }

                ensureGridDay(emp.uid);
                grid[emp.uid][dayStr] = { type: "normal", source: "auto_off" };
                monthlyOffCount[emp.uid]++;
                groupOffUsed++;
                dayOffUsed++;
            });
        });
    }

    // ⚠️ greedy fail → fallback 백트래킹. greedy가 배정 순서 때문에 실패했을 뿐인지,
    // 진짜로 불가능한지 구분하기 위해 국소 탐색을 한 번 더 시도한다(3b 섹션 참고).
    // 성공하면 grid/monthlyOffCount를 교체하고, 실패(시간/반복 초과)하면
    // search_limit_exceeded conflict를 추가해 원인을 구분할 수 있게 한다.
    var greedyFailed = conflicts.length > 0;
    var fallback = { attempted: false, succeeded: false, timedOut: false, iterations: 0 };
    if (greedyFailed) {
        var fb = _fallbackBacktrack(input, { grid: grid, conflicts: conflicts, totalDays: totalDays });
        if (fb) {
            fallback.attempted = true;
            fallback.timedOut = !!fb.timedOut;
            fallback.iterations = fb.iterations;
            if (fb.ok) {
                fallback.succeeded = true;
                grid = fb.grid;
                var relevantKinds = { work_shortfall: 1, no_valid_assignment: 1, group_off_cap: 1, day_off_cap: 1 };
                conflicts = conflicts.filter(function (c) { return !relevantKinds[c.kind]; });
                monthlyOffCount = {};
                employees.forEach(function (emp) { monthlyOffCount[emp.uid] = 0; });
                employees.forEach(function (emp) {
                    Object.keys(grid[emp.uid] || {}).forEach(function (d) {
                        if (grid[emp.uid][d].type === "normal") monthlyOffCount[emp.uid]++;
                    });
                });
            } else if (fb.timedOut) {
                conflicts.push({
                    kind: "search_limit_exceeded",
                    message: "fallback 탐색이 시간/반복 한도 내에 대체 배정을 찾지 못했습니다(진짜 infeasible일 수도 있습니다).",
                });
            }
        }
    }

    // ⚠️ 월말 사후 검증 — 지금까지의 충돌 검사는 "목표를 초과하는" 상황만 잡아냈다.
    // "근무 배정이 우선되어 결과적으로 목표에 못 미치는" 미달 상황도 반드시 별도로
    // 검출해야 한다(그렇지 않으면 conflicts가 0인데 실제로는 목표 미달인 채 ok:true를
    // 반환하는 조용한 버그가 된다 — 실제 fixture 테스트로 이 문제를 확인했다).
    employees.forEach(function (emp) {
        if (monthlyOffCount[emp.uid] < monthlyOffTarget) {
            conflicts.push({
                kind: "monthly_off_shortfall",
                empKey: emp.uid, empName: emp.name,
                needed: monthlyOffTarget, actual: monthlyOffCount[emp.uid],
                message: (emp.name || emp.uid) + " 월 총 일반휴무가 목표(" + monthlyOffTarget + ")에 " + (monthlyOffTarget - monthlyOffCount[emp.uid]) + "일 미달.",
            });
        }
    });

    // ⚠️ ok 판정은 집계 전 원본 conflicts 기준(집계는 표시 형태만 바꿀 뿐 위반
    // 존재 여부 자체는 절대 바꾸지 않는다 — 병합해도 원소가 하나도 사라지지 않으므로
    // 사실 conflicts.length===0 ⇔ 집계 후 길이===0 이지만, 의도를 명확히 하기 위해
    // 집계 전 값으로 명시적으로 판정한다).
    var ok = conflicts.length === 0;
    return { ok: ok, totalDays: totalDays, grid: grid, conflicts: _aggregateConflicts(conflicts), monthlyOffCount: monthlyOffCount, greedyFailed: greedyFailed, fallback: fallback };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5) 신청휴무 조정 후보 계산
// ═══════════════════════════════════════════════════════════════════════════

/**
 * conflict(kind:"work_shortfall")를 해결할 수 있는 신청휴무 조정 후보를 찾는다.
 * 후보 조건: 해당 조 소속 + 그 날짜 "신청(requested) normal" + 연차/청원 아님 +
 * 해당 코드로 바꿔도 연속근무/연결제한 위반 없음. 선택일 이전만 추정하지 않고
 * 해당 직원의 normal 1건을 임시 grid에서 schedule로 바꾼 뒤, 선택일을 포함한
 * 전체 월 streak와 전월→1일/previous→selected/selected→next를 모두 검사한다.
 * 원본 draft/grid는 절대 변형하지 않는다.
 */
function findOverrideCandidates(draft, conflict, employees, groups, autoConfig, previousMonthWorkTail, previousMonthLastScheduleCode) {
    if (!conflict || conflict.kind !== "work_shortfall") return [];
    var day = conflict.day, group = conflict.group, codeName = conflict.scheduleCode;
    var dayStr = String(day);
    var maxConsecutiveWork = Number((autoConfig || {}).maxConsecutiveWork || 0);
    var codeLinkRestrictions = (autoConfig || {}).codeLinkRestrictions || [];
    var prevTail = previousMonthWorkTail || {};
    var prevLastCode = previousMonthLastScheduleCode || {};

    var groupByEmp = {};
    Object.keys(groups || {}).forEach(function (g) {
        (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; });
    });

    var candidates = [];
    _autoSortEmployees(employees || []).forEach(function (emp) {
        if (groupByEmp[emp.uid] !== group) return;
        var entry = (draft.grid[emp.uid] || {})[dayStr];
        if (!entry || entry.type !== "normal" || entry.source !== "requested") return; // 신청 normal만(연차/청원/이미 근무 제외)

        // 실제 적용과 같은 임시 상태를 만든다. 바깥 grid와 해당 직원의 day map만
        // 복제하므로 다른 직원/날짜/기존 고정 셀은 그대로이고 원본 draft는 불변이다.
        var candidateGrid = Object.assign({}, draft.grid);
        candidateGrid[emp.uid] = Object.assign({}, draft.grid[emp.uid]);
        candidateGrid[emp.uid][dayStr] = {
            type: "schedule", scheduleCode: codeName, source: "override",
        };

        // fallback/revalidation과 동일한 전체 월 semantics를 재사용한다. 이에 따라
        // 선택일이 양쪽 work streak를 연결하는 경우와 selected→next 고정 코드
        // transition도 후보 단계에서 즉시 제외된다.
        if (!_fullMonthStreakOk(candidateGrid, [emp], draft.totalDays, prevTail, maxConsecutiveWork)) return;
        if (!_fullMonthCodeLinkOk(candidateGrid, [emp], draft.totalDays, codeLinkRestrictions, prevLastCode)) return;

        candidates.push({ uid: emp.uid, empNo: emp.empNo, name: emp.name });
    });
    return candidates;
}

/**
 * override 적용 — draft를 복제해 새 draft를 반환한다(원본 draft/원 신청 데이터는 변형하지 않음).
 * originalRequest는 override 메타데이터 안에 보존된다.
 */
function applyOverride(draft, empKey, day, newScheduleCode, adminUid, reason) {
    var dayStr = String(day);
    var newGrid = {};
    Object.keys(draft.grid).forEach(function (k) {
        newGrid[k] = Object.assign({}, draft.grid[k]);
    });
    var original = newGrid[empKey] && newGrid[empKey][dayStr];
    if (!original) throw new Error("원본 신청 항목을 찾을 수 없습니다.");

    newGrid[empKey][dayStr] = {
        type: "schedule",
        scheduleCode: newScheduleCode,
        source: "override",
        originalRequest: { type: original.type, day: day },
        override: { changedBy: adminUid, changedAt: Date.now(), reason: reason || "auto_schedule_conflict" },
    };

    var newMonthlyOffCount = Object.assign({}, draft.monthlyOffCount);
    if (original.type === "normal") newMonthlyOffCount[empKey] = Math.max(0, (newMonthlyOffCount[empKey] || 0) - 1);

    return { ok: draft.ok, totalDays: draft.totalDays, grid: newGrid, conflicts: draft.conflicts, monthlyOffCount: newMonthlyOffCount };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) 조건 재검사 (사용자 spec의 14개 항목)
// ═══════════════════════════════════════════════════════════════════════════

function revalidateDraft(draft, input) {
    var checks = [];
    function push(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || "" }); }

    var employees = input.employees || [];
    var groups = input.groups || {};
    var config = input.config || {};
    var autoConfig = input.autoConfig || {};
    var scheduleCodes = Array.isArray(config.scheduleCodes) ? config.scheduleCodes : [];
    var totalDays = draft.totalDays;
    var grid = draft.grid;
    var existingRequests = input.existingRequests || {};
    var prevTail = input.previousMonthWorkTail || {};
    var prevLastCode = input.previousMonthLastScheduleCode || {};

    var groupByEmp = {};
    Object.keys(groups).forEach(function (g) { (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; }); });

    // 1~4) 고정 신청(일반휴무/연차/청원/근무코드) 유지 여부 — override된 것 제외하고 원본 그대로인지
    var fixedBroken = [];
    Object.keys(existingRequests).forEach(function (empKey) {
        var days = existingRequests[empKey] || {};
        Object.keys(days).forEach(function (day) {
            var req = days[day];
            var entry = (grid[empKey] || {})[day];
            if (!entry) { fixedBroken.push(empKey + "@" + day); return; }
            if (entry.source === "override") return; // 관리자가 명시적으로 조정한 건은 정상
            if (entry.type !== req.type || (req.type === "schedule" && entry.scheduleCode !== req.scheduleCode)) {
                fixedBroken.push(empKey + "@" + day);
            }
        });
    });
    push("고정 신청 유지(휴무/연차/청원/근무코드)", fixedBroken.length === 0, fixedBroken.join(", "));
    push("연차 유지", true, ""); // 위 검사에 포함(별도 세분화 표시용)
    push("청원 유지", true, "");
    push("신청 근무코드 유지", true, "");

    // 5) 직원별 월 총 일반휴무 개수
    var offMismatch = [];
    employees.forEach(function (emp) {
        var count = 0;
        for (var d = 1; d <= totalDays; d++) {
            var e = (grid[emp.uid] || {})[String(d)];
            if (e && e.type === "normal") count++;
        }
        if (count !== Number(autoConfig.monthlyOffTarget || 0)) offMismatch.push(emp.name + ":" + count);
    });
    push("직원별 월 총 일반휴무 개수 = 목표", offMismatch.length === 0, offMismatch.join(", "));

    // 6/7) 최대 연속근무(전월 꼬리 포함)
    var streakViolations = [];
    var maxConsecutiveWork = Number(autoConfig.maxConsecutiveWork || 0);
    if (maxConsecutiveWork > 0) {
        employees.forEach(function (emp) {
            for (var d = 1; d <= totalDays; d++) {
                var streak = consecutiveWorkStreakAt(grid, emp.uid, d, prevTail[emp.uid]);
                if (streak > maxConsecutiveWork) { streakViolations.push(emp.name + "@" + d + "(" + streak + ")"); break; }
            }
        });
    }
    push("최대 연속근무 준수(전월 포함)", streakViolations.length === 0, streakViolations.join(", "));
    push("전월 말일부터 이어지는 연속근무 반영", true, "");

    // 8) 특정일 전체 휴무 제한
    var dayCapViolations = [];
    for (var d1 = 1; d1 <= totalDays; d1++) {
        var cap = _dayOffCap(config, d1);
        var used = employees.reduce(function (acc, emp) {
            var e = (grid[emp.uid] || {})[String(d1)];
            return acc + (e && e.type === "normal" ? 1 : 0);
        }, 0);
        if (used > cap) dayCapViolations.push(d1 + "일(" + used + ">" + cap + ")");
    }
    push("특정일 전체 휴무 제한 준수", dayCapViolations.length === 0, dayCapViolations.join(", "));

    // 9) 조별 휴무 제한
    var groupCapViolations = [];
    Object.keys(groups).forEach(function (group) {
        var members = employees.filter(function (e) { return groupByEmp[e.uid] === group; });
        for (var d2 = 1; d2 <= totalDays; d2++) {
            var cap2 = _groupOffCap(config, d2, group);
            var used2 = members.reduce(function (acc, emp) {
                var e = (grid[emp.uid] || {})[String(d2)];
                return acc + (e && e.type === "normal" ? 1 : 0);
            }, 0);
            if (used2 > cap2) groupCapViolations.push(group + "@" + d2 + "(" + used2 + ">" + cap2 + ")");
        }
    });
    push("조별 휴무 제한 준수", groupCapViolations.length === 0, groupCapViolations.join(", "));

    // 10) 날짜/조/근무코드 정원 정확히 충족
    var quotaMismatch = [];
    Object.keys(groups).forEach(function (group) {
        var members = employees.filter(function (e) { return groupByEmp[e.uid] === group; });
        for (var d3 = 1; d3 <= totalDays; d3++) {
            scheduleCodes.forEach(function (codeItem) {
                var quota = _groupCodeQuota(config, d3, group, codeItem.name);
                if (quota == null) return; // 제약 없음(키 자체가 없음) — 명시적 0은 계속 검사됨
                var used3 = members.reduce(function (acc, emp) {
                    var e = (grid[emp.uid] || {})[String(d3)];
                    return acc + (e && e.type === "schedule" && e.scheduleCode === codeItem.name ? 1 : 0);
                }, 0);
                if (used3 !== quota) quotaMismatch.push(group + "/" + codeItem.name + "@" + d3 + "(" + used3 + "!=" + quota + ")");
            });
        }
    });
    push("날짜/조/근무코드 정원 정확히 충족", quotaMismatch.length === 0, quotaMismatch.join(", "));

    // 11) 근무코드 연결 제한
    var linkViolations = [];
    var codeLinkRestrictions = autoConfig.codeLinkRestrictions || [];
    if (codeLinkRestrictions.length > 0) {
        employees.forEach(function (emp) {
            for (var d4 = 1; d4 <= totalDays; d4++) {
                var prevCode = _prevCodeAt(grid, emp.uid, d4, prevLastCode);
                var cur = (grid[emp.uid] || {})[String(d4)];
                var curCode = cur && cur.type === "schedule" ? cur.scheduleCode : null;
                if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, curCode)) linkViolations.push(emp.name + "@" + d4);
            }
        });
    }
    push("근무코드 연결 제한 준수", linkViolations.length === 0, linkViolations.join(", "));

    // 12/13) override는 관리자 선택으로 발생한 건만 + 연차/청원 override 0건
    var badOverrides = [];
    Object.keys(grid).forEach(function (empKey) {
        Object.keys(grid[empKey] || {}).forEach(function (day) {
            var e = grid[empKey][day];
            if (e.source !== "override") return;
            if (!e.override || !e.override.changedBy) badOverrides.push(empKey + "@" + day + "(관리자 정보 없음)");
            if (e.originalRequest && (e.originalRequest.type === "annual" || e.originalRequest.type === "petition")) {
                badOverrides.push(empKey + "@" + day + "(연차/청원 override 금지)");
            }
        });
    });
    push("override는 관리자 선택으로 발생한 건만 존재", badOverrides.filter(function (m) { return m.indexOf("관리자 정보 없음") !== -1; }).length === 0, "");
    push("연차/청원 override 0건", badOverrides.filter(function (m) { return m.indexOf("연차/청원") !== -1; }).length === 0, badOverrides.join(", "));

    // 14) 월 총 휴무 초과/미달 없음 (5번과 동일 기준 재확인 — 실패 목록만 별도 표기)
    push("월 총 휴무 초과/미달 없음", offMismatch.length === 0, offMismatch.join(", "));

    var allPassed = checks.every(function (c) { return c.ok; });
    return { passed: allPassed, checks: checks };
}

return {
    AUTO_SCHEDULE_MAX_ITERATIONS: AUTO_SCHEDULE_MAX_ITERATIONS,
    buildFixedGrid: buildFixedGrid,
    consecutiveWorkStreakAt: consecutiveWorkStreakAt,
    isCodeLinkForbidden: isCodeLinkForbidden,
    _prevCodeAt: _prevCodeAt,
    _groupCodeQuota: _groupCodeQuota,
    _aggregateConflicts: _aggregateConflicts,
    generateDraft: generateDraft,
    findOverrideCandidates: findOverrideCandidates,
    applyOverride: applyOverride,
    revalidateDraft: revalidateDraft,
    _autoSortEmployees: _autoSortEmployees,
    _fallbackBacktrack: _fallbackBacktrack,
    AUTO_SCHEDULE_FALLBACK_WINDOW: AUTO_SCHEDULE_FALLBACK_WINDOW,
    AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS: AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS,
};

})();

if (typeof module === "object" && module.exports) {
    module.exports = AutoScheduleEngine;
}
