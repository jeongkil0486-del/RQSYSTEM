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

/** 근무코드의 "직원 1명당 월간 최대 배정 횟수" 상한. scheduleCodes 배열의
 *  {name, limit}에서 codeName과 일치하는 항목을 찾아 limit을 반환한다.
 *
 *  ⚠️ "미설정"과 "명시적 0"을 절대 같은 값으로 뭉개면 안 된다(_groupCodeQuota와
 *  동일한 원칙) — hasOwnProperty로 필드 존재 여부를 먼저 확인해, 없으면 null
 *  (상한 없음), 있으면 그 숫자(0 포함, 0이면 그 코드로 단 한 번도 배정 불가)를
 *  반환한다. 코드 자체가 목록에 없으면(레거시 데이터 등) 상한 없음으로 취급한다
 *  — 이는 기존 스케줄 코드 신청 제한 기능(functions/src/index.js validateAndStageRequest의
 *  toIntOr(999, ...) fallback)과 동일한 방향의 안전한 기본값이며, 이 필드가
 *  원래부터 갖고 있던 "직원 직접 신청 가능 횟수" semantics는 이 함수가 전혀
 *  건드리지 않는다 — 동일한 저장값을 최종 자동스케줄의 hard cap으로도 재사용할 뿐이다. */
function _scheduleCodeMonthlyLimit(scheduleCodes, codeName) {
    var item = (scheduleCodes || []).filter(function (c) { return c && c.name === codeName; })[0];
    if (!item || !Object.prototype.hasOwnProperty.call(item, "limit") || item.limit == null) return null;
    var n = Number(item.limit);
    return Number.isFinite(n) ? n : null;
}

/** grid 전체(scope 제한 없음)에서 empKey의 codeName 근무 배정 횟수를 센다.
 *  requested/auto/override source를 구분하지 않고 최종 type==="schedule"만 카운트
 *  (normal/auto_off/annual/petition은 제외 — 스펙의 "count 대상" 원칙과 동일). */
function _employeeScheduleCodeCount(grid, empKey, codeName) {
    var days = grid[empKey] || {};
    var count = 0;
    Object.keys(days).forEach(function (d) {
        var e = days[d];
        if (e && e.type === "schedule" && e.scheduleCode === codeName) count++;
    });
    return count;
}

/** 전체 달 기준으로 모든 직원의 모든 근무코드 월간 상한 준수 여부를 재확인한다
 *  (_fullMonthStreakOk/_fullMonthCodeLinkOk와 동일한 "scope 밖까지 포함한 전체
 *  재검증" 패턴 — fallback backtracking의 leafOk에서 사용). */
function _fullMonthCodeLimitOk(grid, employees, scheduleCodes) {
    for (var i = 0; i < employees.length; i++) {
        var emp = employees[i];
        var days = grid[emp.uid] || {};
        var counts = {};
        Object.keys(days).forEach(function (d) {
            var e = days[d];
            if (e && e.type === "schedule" && e.scheduleCode) counts[e.scheduleCode] = (counts[e.scheduleCode] || 0) + 1;
        });
        var codeNames = Object.keys(counts);
        for (var j = 0; j < codeNames.length; j++) {
            var limit = _scheduleCodeMonthlyLimit(scheduleCodes, codeNames[j]);
            if (limit != null && counts[codeNames[j]] > limit) return false;
        }
    }
    return true;
}

/** 월 일반휴무 "최소 허용치"(hard floor). monthlyOffTarget(권장/soft)과 분리된
 *  개념 — autoConfig.monthlyOffMinimum이 명시적으로 설정돼 있으면 그 값(0 포함,
 *  hasOwnProperty로 미설정과 구분)을 쓰고, 없으면(레거시 config) monthlyOffTarget과
 *  동일하게 취급한다("target=minimum" ⇔ 기존 "정확히 target일" exact 정책과
 *  100% 동일하게 동작 — 기존 Production 데이터/동작을 갑자기 바꾸지 않는다).
 *  관리자가 신규 설정 화면에서 minimum을 명시적으로 저장한 달부터만 "target은
 *  권장, minimum은 hard" 정책이 활성화된다. */
function _monthlyOffMinimum(autoConfig) {
    var cfg = autoConfig || {};
    var target = Number(cfg.monthlyOffTarget || 0);
    if (!Object.prototype.hasOwnProperty.call(cfg, "monthlyOffMinimum") || cfg.monthlyOffMinimum == null) return target;
    var n = Number(cfg.monthlyOffMinimum);
    return Number.isFinite(n) ? n : target;
}

/** 전체 달 기준으로 모든 직원의 월 일반휴무가 minimum 이상인지 재확인한다
 *  (fallback backtracking의 leafOk에서 사용 — streak/codeLink/codeLimit과 동일한
 *  "scope 밖까지 포함한 전체 재검증" 패턴). */
function _fullMonthOffMinimumOk(grid, employees, totalDays, minimum) {
    for (var i = 0; i < employees.length; i++) {
        var emp = employees[i];
        var count = 0;
        var days = grid[emp.uid] || {};
        for (var d = 1; d <= totalDays; d++) {
            var e = days[String(d)];
            if (e && e.type === "normal") count++;
        }
        if (count < minimum) return false;
    }
    return true;
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
    var monthlyOffMinimum = _monthlyOffMinimum(autoConfig);
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
        if (!_fullMonthCodeLimitOk(grid, employees, scheduleCodes)) return false;
        if (!_fullMonthOffMinimumOk(grid, employees, totalDays, monthlyOffMinimum)) return false;
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

                // 월간 코드 상한 — fallback도 greedy와 동일한 hard constraint를 지킨다.
                // exact staffing을 맞추기 위해 이미 상한에 도달한 직원에게 억지로
                // 추가 배정하지 않는다(그 경우 이 후보는 그냥 건너뛰고 다음 candidateValue/
                // 다음 freeCell 조합을 계속 탐색 — infeasible이면 leafOk에서도 다시 걸러진다).
                var codeLimitFb = _scheduleCodeMonthlyLimit(scheduleCodes, candidate.scheduleCode);
                if (codeLimitFb != null && _employeeScheduleCodeCount(grid, fc.emp.uid, candidate.scheduleCode) >= codeLimitFb) continue;

                // 월 일반휴무 최소치(hard floor) — 오늘 근무를 배정하면 남은 날짜를
                // 전부 휴무로 줘도 minimum에 도달할 수 없는 직원은 후보에서 제외한다
                // (streak/codeLink pruning과 동일한 "필요조건 위반 시 즉시 제외" 패턴).
                if (monthlyOffCountFor(fc.emp.uid) + (totalDays - fc.day) < monthlyOffMinimum) continue;

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
// 3d) work_shortfall repair pass — greedy(±3일 국소 fallback으로도) 못 찾는,
//     수학적으로는 가능한 케이스를 위한 bounded 2차 탐색.
//
// ⚠️ 기존 fallback(_fallbackBacktrack)의 근본적 한계: 탐색 범위가 conflict
// 발생일 ±AUTO_SCHEDULE_FALLBACK_WINDOW(3)일로 좁혀져 있어 (a) "같은 날 안에서
// 코드를 서로 바꾸면 풀리는" 케이스는 우연히 window 안에 걸려야만 풀리고,
// (b) "월간 코드 상한 때문에 막힌 직원의 기존 배정을 다른 날짜/다른 직원에게
// 넘기면 풀리는" 케이스는 애초에 window 개념 자체가 안 맞아 절대 못 찾는다.
// 이 repair pass는 그 두 가지 구체적 케이스만 targeted로 추가 탐색한다 —
// 범용 solver가 아니라, "확실히 존재가 증명되는 augmenting chain"만 찾는다.
//
// 이동 가능한 셀: source가 "auto" 또는 "auto_off"인 셀만(fallback과 동일 원칙).
// requested/annual/petition/override는 이 함수가 존재를 확인하는 용도로만
// 읽고, 절대 쓰지 않는다.
// ═══════════════════════════════════════════════════════════════════════════
var AUTO_SCHEDULE_REPAIR_MAX_ITERATIONS = 4000; // 순수 "성공적으로 적용한 repair + 포기한 gap" 총 횟수 상한
var AUTO_SCHEDULE_REPAIR_TIME_BUDGET_MS = 3000;

/** 현재 grid 기준, 모든 (day, group, code) exact quota의 실제 부족분을 스캔한다
 *  — generateDraft의 greedy day-loop가 만드는 work_shortfall과 정확히 동일한
 *  {kind, day, group, scheduleCode, needed, available, message} shape로 반환한다. */
function _computeCodeGaps(grid, employeesByGroup, config, scheduleCodes, totalDays) {
    var gaps = [];
    var groupNames = Object.keys(employeesByGroup).sort();
    for (var day = 1; day <= totalDays; day++) {
        var dayStr = String(day);
        for (var gi = 0; gi < groupNames.length; gi++) {
            var group = groupNames[gi];
            var members = employeesByGroup[group] || [];
            for (var ci = 0; ci < scheduleCodes.length; ci++) {
                var codeName = scheduleCodes[ci].name;
                var quota = _groupCodeQuota(config, day, group, codeName);
                if (quota == null) continue;
                var available = 0;
                for (var mi = 0; mi < members.length; mi++) {
                    var e = (grid[members[mi].uid] || {})[dayStr];
                    if (e && e.type === "schedule" && e.scheduleCode === codeName) available++;
                }
                if (available < quota) {
                    gaps.push({
                        kind: "work_shortfall", day: day, group: group, scheduleCode: codeName,
                        needed: quota, available: available,
                        message: day + "일 " + group + "조 " + codeName + "근무 " + quota + "명 필요, 배정 가능 " + available + "명.",
                    });
                }
            }
        }
    }
    return gaps;
}

function _totalGapSeats(gaps) {
    var total = 0;
    for (var i = 0; i < gaps.length; i++) total += Math.max(0, gaps[i].needed - gaps[i].available);
    return total;
}

/** 특정 (uid, day, code) 배정이 (월간 코드 상한 / 연속근무 / 코드 연결 제한)을
 *  위반하지 않는지 확인한다. grid는 "이 배정을 시도하기 직전" 상태여야 한다
 *  (즉 uid의 day 셀은 이미 비워져 있어야 code count가 정확히 계산됨).
 *
 *  ⚠️ Codex High #1 수정: maxConsecutiveWork 검사를 "선택일 이전 streak만"
 *  보는 방식에서 findOverrideCandidates가 이미 쓰고 있는 것과 정확히 동일한
 *  _fullMonthStreakOk(전체 달 재검증, day를 포함해 그 이후 날짜까지 자연히
 *  커버됨 — "past+selected+future"를 별도로 조합할 필요 없이, 전체 달의 매
 *  날짜에서 streak를 다시 재는 것 자체가 forward-inclusive 검증이다)로
 *  교체한다. 새로운 streak 계산을 만들지 않고 기존 helper를 그대로 재사용 —
 *  전월 tail(prevTail)도 이 helper가 이미 포함해서 계산한다. */
function _repairCanAssignCode(grid, uid, day, code, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays) {
    var codeLimit = _scheduleCodeMonthlyLimit(scheduleCodes, code);
    if (codeLimit != null && _employeeScheduleCodeCount(grid, uid, code) >= codeLimit) return false;

    var maxConsecutiveWork = Number((autoConfig || {}).maxConsecutiveWork || 0);
    if (maxConsecutiveWork > 0) {
        var trialGrid = Object.assign({}, grid);
        trialGrid[uid] = Object.assign({}, grid[uid]);
        trialGrid[uid][String(day)] = { type: "schedule", scheduleCode: code, source: "auto" };
        if (!_fullMonthStreakOk(trialGrid, [{ uid: uid }], totalDays, prevTail, maxConsecutiveWork)) return false;
    }

    var codeLinkRestrictions = (autoConfig || {}).codeLinkRestrictions || [];
    var prevCode = _prevCodeAt(grid, uid, day, prevLastCode);
    if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, code)) return false;
    var nextEntry = (grid[uid] || {})[String(day + 1)];
    if (nextEntry && nextEntry.type === "schedule" && isCodeLinkForbidden(codeLinkRestrictions, code, nextEntry.scheduleCode)) return false;
    return true;
}

function _repairEmployeeOffCount(grid, uid) {
    var count = 0;
    var days = grid[uid] || {};
    Object.keys(days).forEach(function (d) { if (days[d].type === "normal") count++; });
    return count;
}

/** requested/annual/petition/override 등 절대 손대면 안 되는 고정 셀인지 여부.
 *  undefined(미배정)는 이동 가능(=repair가 직접 채울 수 있는) 대상으로 취급한다. */
function _repairIsFixedCell(entry) {
    return !!entry && entry.source !== "auto" && entry.source !== "auto_off";
}

function _cloneGridDeep(grid) {
    var out = {};
    Object.keys(grid).forEach(function (uid) { out[uid] = Object.assign({}, grid[uid]); });
    return out;
}

/**
 * target(day, group, code) 부족분 1석을 해소할 수 있는 augmenting chain을
 * deterministic하게 탐색한다. 찾으면 { grid: 새 grid(clone) }, 못 찾으면 null.
 *
 * Strategy A(같은 날 체인, 최대 2-step):
 *   후보 E가 그날 이미 다른 auto 코드(A)로 일하고 있다면, E를 target code로
 *   옮기고 그 빈자리(day, A)를 그날 auto_off인 다른 직원 F로 메운다. E가 그날
 *   auto_off/미배정이면 1-step으로 끝난다.
 *
 * Strategy B(월간 코드 relocation): target code의 월간 상한에 막힌 후보 X에
 *   대해, X가 이미 다른 날짜(day2)에 auto 소스로 그 코드를 갖고 있다면, day2의
 *   그 자리를 같은 조의 다른 직원 Y(그날 auto_off)에게 넘기고 X를 이 날(day)
 *   그 코드로 옮긴다 — X의 월간 총 코드 개수는 변하지 않는다(day2에서 1 감소,
 *   day에서 1 증가).
 */
function _repairFindChainFor(grid, target, employeesByGroup, groupByEmp, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays, monthlyOffMinimum, deadline) {
    var day = target.day, group = target.group, code = target.scheduleCode;
    var dayStr = String(day);
    var members = (employeesByGroup[group] || []).slice().sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });

    // ── Strategy A: 같은 날 1-step / 2-step 체인 ──────────────────────────────
    for (var ei = 0; ei < members.length; ei++) {
        if (Date.now() > deadline) return null;
        var E = members[ei];
        var entryE = (grid[E.uid] || {})[dayStr];
        if (entryE && entryE.type === "schedule" && entryE.scheduleCode === code) continue; // 이미 이 코드로 근무 중
        if (_repairIsFixedCell(entryE)) continue; // 신청/연차/청원/override는 절대 이동 금지

        if (!entryE || entryE.type === "normal") {
            // E는 그날 미배정이거나(unset) auto_off — 1-step으로 target code 배정 시도.
            if (entryE && entryE.source !== "auto_off") continue; // 이 분기는 unset 또는 auto_off만(다른 정상값은 위에서 이미 걸러짐)
            if (entryE) {
                var offAfter = _repairEmployeeOffCount(grid, E.uid) - 1;
                if (offAfter < monthlyOffMinimum) continue; // 최소 휴무 hard floor 위반 방지
            }
            var tempGrid1 = _cloneGridDeep(grid);
            if (!tempGrid1[E.uid]) tempGrid1[E.uid] = {};
            delete tempGrid1[E.uid][dayStr];
            if (!_repairCanAssignCode(tempGrid1, E.uid, day, code, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays)) continue;
            tempGrid1[E.uid][dayStr] = { type: "schedule", scheduleCode: code, source: "auto" };
            return { grid: tempGrid1 };
        }

        // entryE.type === "schedule" — E는 그날 다른 auto 코드(A)로 근무 중.
        var codeA = entryE.scheduleCode;
        var tempGridE = _cloneGridDeep(grid);
        if (!tempGridE[E.uid]) tempGridE[E.uid] = {};
        delete tempGridE[E.uid][dayStr];
        if (!_repairCanAssignCode(tempGridE, E.uid, day, code, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays)) continue;

        // E를 옮기면 (day, group, codeA)에 새 구멍이 생긴다 — 같은 날 auto_off인
        // 다른 직원 F로 그 구멍을 메울 수 있는지 확인.
        for (var fi = 0; fi < members.length; fi++) {
            if (Date.now() > deadline) return null;
            var F = members[fi];
            if (F.uid === E.uid) continue;
            var entryF = (grid[F.uid] || {})[dayStr];
            if (!entryF || entryF.type !== "normal" || entryF.source !== "auto_off") continue;
            var offAfterF = _repairEmployeeOffCount(grid, F.uid) - 1;
            if (offAfterF < monthlyOffMinimum) continue;

            var tempGrid2 = _cloneGridDeep(tempGridE);
            if (!tempGrid2[F.uid]) tempGrid2[F.uid] = {};
            delete tempGrid2[F.uid][dayStr];
            if (!_repairCanAssignCode(tempGrid2, F.uid, day, codeA, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays)) continue;

            tempGrid2[E.uid][dayStr] = { type: "schedule", scheduleCode: code, source: "auto" };
            tempGrid2[F.uid][dayStr] = { type: "schedule", scheduleCode: codeA, source: "auto" };
            return { grid: tempGrid2 };
        }
    }

    // ── Strategy B: 월간 코드 relocation(월 상한에 막힌 경우 전용) ──────────────
    var codeLimit = _scheduleCodeMonthlyLimit(scheduleCodes, code);
    if (codeLimit == null) return null; // 상한이 없으면 Strategy A가 이미 커버했을 것 — relocation 불필요
    for (var xi = 0; xi < members.length; xi++) {
        if (Date.now() > deadline) return null;
        var X = members[xi];
        var entryX = (grid[X.uid] || {})[dayStr];
        if (entryX && entryX.type === "schedule" && entryX.scheduleCode === code) continue;
        if (_repairIsFixedCell(entryX)) continue;
        if (entryX && entryX.type === "schedule") continue; // 다른 코드로 이미 근무 중이면 Strategy A 영역(여기선 skip)
        if (entryX && entryX.source !== "auto_off") continue;
        if (_employeeScheduleCodeCount(grid, X.uid, code) < codeLimit) continue; // 상한에 막힌 게 아니면 Strategy A가 이미 처리했을 것

        for (var d2 = 1; d2 <= totalDays; d2++) {
            if (d2 === day) continue;
            if (Date.now() > deadline) return null;
            var d2Str = String(d2);
            var entryX2 = (grid[X.uid] || {})[d2Str];
            if (!entryX2 || entryX2.type !== "schedule" || entryX2.scheduleCode !== code || entryX2.source !== "auto") continue;

            var groupX = groupByEmp[X.uid];
            var members2 = (employeesByGroup[groupX] || []).slice().sort(function (a, b) { return (a.sortOrder || 0) - (b.sortOrder || 0); });
            for (var yi = 0; yi < members2.length; yi++) {
                var Y = members2[yi];
                if (Y.uid === X.uid) continue;
                var entryY = (grid[Y.uid] || {})[d2Str];
                if (!entryY || entryY.type !== "normal" || entryY.source !== "auto_off") continue;
                if (_employeeScheduleCodeCount(grid, Y.uid, code) >= codeLimit) continue;
                var offAfterY = _repairEmployeeOffCount(grid, Y.uid) - 1;
                if (offAfterY < monthlyOffMinimum) continue;

                // X: d2의 code 자리를 비우고(→auto_off), day에 code로 배정.
                // Y: d2의 auto_off 자리를 code로 대신 채운다.
                var relocGrid = _cloneGridDeep(grid);
                if (!relocGrid[X.uid]) relocGrid[X.uid] = {};
                if (!relocGrid[Y.uid]) relocGrid[Y.uid] = {};
                delete relocGrid[X.uid][d2Str];
                delete relocGrid[X.uid][dayStr];
                delete relocGrid[Y.uid][d2Str];

                if (!_repairCanAssignCode(relocGrid, Y.uid, d2, code, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays)) continue;
                relocGrid[Y.uid][d2Str] = { type: "schedule", scheduleCode: code, source: "auto" };

                if (!_repairCanAssignCode(relocGrid, X.uid, day, code, config, scheduleCodes, autoConfig, prevTail, prevLastCode, totalDays)) continue;
                relocGrid[X.uid][dayStr] = { type: "schedule", scheduleCode: code, source: "auto" };
                relocGrid[X.uid][d2Str] = { type: "normal", source: "auto_off" };

                return { grid: relocGrid };
            }
        }
    }

    return null;
}

/**
 * generateDraft의 fallback 이후, 남은 work_shortfall을 대상으로 bounded
 * augmenting-chain 탐색을 반복한다. 매 성공 적용마다 전체 부족석 총량이
 * 실제로 감소했는지("net improvement") 재확인한 뒤에만 채택한다 — 단순히
 * 부족을 다른 자리로 옮기기만 하는 변경(27→27)은 채택하지 않는다.
 * 반환: { grid, appliedCount, iterations, timedOut }.
 */
function _repairWorkShortfalls(grid, employees, employeesByGroup, groupByEmp, config, scheduleCodes, autoConfig, totalDays, prevTail, prevLastCode, monthlyOffMinimum) {
    var startTime = Date.now();
    var deadline = startTime + AUTO_SCHEDULE_REPAIR_TIME_BUDGET_MS;
    var workingGrid = grid;
    var iterations = 0;
    var appliedCount = 0;
    var timedOut = false;
    var givenUp = {}; // "day|group|code" -> true(이번 grid 상태에서는 더 시도하지 않음)

    while (true) {
        if (Date.now() > deadline) { timedOut = true; break; }
        if (iterations > AUTO_SCHEDULE_REPAIR_MAX_ITERATIONS) { timedOut = true; break; }

        var gaps = _computeCodeGaps(workingGrid, employeesByGroup, config, scheduleCodes, totalDays);
        if (!gaps.length) break; // 전부 해소됨

        var beforeSeats = _totalGapSeats(gaps);
        var target = null;
        for (var i = 0; i < gaps.length; i++) {
            var key = gaps[i].day + "|" + gaps[i].group + "|" + gaps[i].scheduleCode;
            if (!givenUp[key]) { target = gaps[i]; break; }
        }
        if (!target) break; // 남은 모든 gap이 이미 "포기" 처리됨

        iterations++;
        var key2 = target.day + "|" + target.group + "|" + target.scheduleCode;
        var found = _repairFindChainFor(
            workingGrid, target, employeesByGroup, groupByEmp, config, scheduleCodes, autoConfig,
            prevTail, prevLastCode, totalDays, monthlyOffMinimum, deadline
        );

        if (!found) { givenUp[key2] = true; continue; }

        // ⚠️ commit-level 최종 안전장치(이중 방어, Codex High #1 수정의 일부) —
        // candidate-level guard(_repairCanAssignCode)를 이미 통과했더라도, chain
        // 전체를 실제로 채택하기 직전에 전체 달 기준으로 다시 한번 hard constraint
        // 전부를 재검증한다. revalidateDraft/leafOk가 최종 grid에 대해 쓰는 것과
        // 정확히 동일한 helper들을 재사용 — 새 검증 로직을 만들지 않는다.
        var maxConsecutiveWork = Number((autoConfig || {}).maxConsecutiveWork || 0);
        var codeLinkRestrictions = (autoConfig || {}).codeLinkRestrictions || [];
        var safe = _fullMonthStreakOk(found.grid, employees, totalDays, prevTail, maxConsecutiveWork)
            && _fullMonthCodeLinkOk(found.grid, employees, totalDays, codeLinkRestrictions, prevLastCode)
            && _fullMonthCodeLimitOk(found.grid, employees, scheduleCodes)
            && _fullMonthOffMinimumOk(found.grid, employees, totalDays, monthlyOffMinimum);
        if (!safe) { givenUp[key2] = true; continue; }

        var afterGaps = _computeCodeGaps(found.grid, employeesByGroup, config, scheduleCodes, totalDays);
        var afterSeats = _totalGapSeats(afterGaps);
        if (afterSeats < beforeSeats) {
            workingGrid = found.grid;
            appliedCount++;
            givenUp = {}; // grid가 바뀌었으니 이전에 포기했던 gap도 다시 시도할 가치가 있다
        } else {
            givenUp[key2] = true; // 순개선이 없으면(단순 이동) 채택하지 않는다
        }
    }

    return { grid: workingGrid, appliedCount: appliedCount, iterations: iterations, timedOut: timedOut };
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
// 3c) 편성 품질 최적화(soft quality) — 1일 고립근무 최소화 + A/P 편중 완화
// ═══════════════════════════════════════════════════════════════════════════
// ⚠️ hard-valid draft가 이미 만들어진 뒤에만 실행하는 "추가" 개선 pass다. 기존
// greedy/fallback/repair 구조를 대체하지 않고, source가 "auto"/"auto_off"인 두
// 칸(같은 날짜, 같은 조)의 배정을 서로 맞바꾸는 "same-day identity swap"만
// 수행한다 — 이 방식은 그 날짜/조의 코드별·휴무 정원(exact staffing)을 수학적으로
// 항상 그대로 유지하므로(합계가 아니라 "누가 그 자리를 갖는지"만 바뀜) 별도로
// 재검증할 필요가 없고, 오직 두 당사자의 개인별 hard constraint(연속근무/코드
// 연결제한/월간 코드 상한/월 최소휴무)만 swap 전후로 재확인하면 충분하다.
// requested/annual/petition/override 등 고정 셀은 절대 대상에 포함하지 않는다.

var AUTO_SCHEDULE_QUALITY_MAX_ITERATIONS = 400000;
var AUTO_SCHEDULE_QUALITY_MAX_PASSES = 6;
var AUTO_SCHEDULE_QUALITY_FAIRNESS_CODES = ["A", "P"];

/** day가 유효 범위 밖이면 빈 배열. 그 외에는 [day-1(있으면), day, day+1(있으면)]. */
function _isolatedWorkWindowDays(day, totalDays) {
    var days = [];
    if (day - 1 >= 1) days.push(day - 1);
    days.push(day);
    if (day + 1 <= totalDays) days.push(day + 1);
    return days;
}

/**
 * uid의 day가 "1일짜리 고립 근무"인지 판정한다. 근무(type==="schedule")이고
 * 앞뒤가 모두 비근무(휴무/연차/청원 등 type!=="schedule")면 고립.
 *
 * 월 경계: day=1의 "전날"은 이번 달 grid에 없으므로 previousMonthWorkTail(전월
 * 말일부터 이어지는 연속근무일수)로 판단한다 — 0보다 크면 전월에서 이어지는
 * 근무이므로 day1은 고립이 아니다. day=totalDays(월 마지막 날)의 "다음날"은
 * 다음 달 정보가 없어 알 수 없으므로, 다음 달을 임의로 추측하지 않되 "새로운
 * 1일 근무 섬을 만들지 않는" 쪽으로 보수적으로 처리한다 — 다음날을 비근무로
 * 간주해(즉 marginal하게 고립으로 셀 수 있는 방향으로) quality pass가 월말에
 * 새 1일 근무를 만드는 선택을 하지 않도록 유도한다.
 */
function _isIsolatedWorkDay(grid, uid, day, totalDays, prevTail) {
    if (day < 1 || day > totalDays) return false;
    var entry = (grid[uid] || {})[String(day)];
    if (!_isWorkEntry(entry)) return false;
    var prevNonWork = day === 1
        ? !(Number((prevTail || {})[uid] || 0) > 0)
        : !_isWorkEntry((grid[uid] || {})[String(day - 1)]);
    var nextNonWork = day === totalDays
        ? true
        : !_isWorkEntry((grid[uid] || {})[String(day + 1)]);
    return prevNonWork && nextNonWork;
}

/** employees 전체의 고립 근무일 총합/직원별 집계. */
function _countIsolatedWorkDays(grid, employees, totalDays, prevTail) {
    var byEmp = {}, total = 0;
    employees.forEach(function (emp) {
        var c = 0;
        for (var d = 1; d <= totalDays; d++) {
            if (_isIsolatedWorkDay(grid, emp.uid, d, totalDays, prevTail)) c++;
        }
        byEmp[emp.uid] = c;
        total += c;
    });
    return { total: total, byEmp: byEmp };
}

/** uid의 이번 달 근무 블록 길이 배열(예: [3,2,1,4]). 진단/Excel 참고용 pure helper. */
function _collectWorkBlocks(grid, uid, totalDays) {
    var blocks = [];
    var cur = 0;
    for (var d = 1; d <= totalDays; d++) {
        if (_isWorkEntry((grid[uid] || {})[String(d)])) {
            cur++;
        } else {
            if (cur > 0) blocks.push(cur);
            cur = 0;
        }
    }
    if (cur > 0) blocks.push(cur);
    return blocks;
}

/**
 * 조별 A/P 편중도를 계산한다. "그룹 평균에서 얼마나 벗어났는지"를 코드별로
 * 합산하는 raw-count 편차 방식을 쓴다(스펙이 제시한 두 방식 중 이 구조에서 더
 * 안정적인 쪽 — swap 한 번이 그룹 전체 합계(GA/GP)를 바꾸지 않으므로 그룹
 * 평균이 고정된 채로 두 당사자만의 편차 변화만 비교하면 되어 계산이 가볍고
 * 결정론적이다). L은 수요가 적고 hard cap이 낮아 분모에 섞지 않는다(스펙 명시).
 */
function _computeGroupCodeFairness(grid, employeesByGroup, codes) {
    codes = codes || AUTO_SCHEDULE_QUALITY_FAIRNESS_CODES;
    var result = { byGroup: {}, totalPenalty: 0 };
    Object.keys(employeesByGroup).forEach(function (group) {
        var members = employeesByGroup[group] || [];
        var counts = {};
        var groupTotals = {};
        codes.forEach(function (c) { groupTotals[c] = 0; });
        members.forEach(function (emp) {
            var c = {};
            codes.forEach(function (code) {
                var n = _employeeScheduleCodeCount(grid, emp.uid, code);
                c[code] = n;
                groupTotals[code] += n;
            });
            counts[emp.uid] = c;
        });
        var n = members.length || 1;
        var avg = {};
        codes.forEach(function (code) { avg[code] = groupTotals[code] / n; });
        var minMax = {};
        codes.forEach(function (code) {
            var vals = members.map(function (emp) { return counts[emp.uid][code]; });
            minMax[code] = vals.length ? { min: Math.min.apply(null, vals), max: Math.max.apply(null, vals) } : { min: 0, max: 0 };
        });
        var penaltyByEmp = {};
        var groupPenalty = 0;
        members.forEach(function (emp) {
            var p = 0;
            codes.forEach(function (code) { p += Math.abs(counts[emp.uid][code] - avg[code]); });
            penaltyByEmp[emp.uid] = p;
            groupPenalty += p;
        });
        result.byGroup[group] = { demand: groupTotals, avg: avg, counts: counts, penaltyByEmp: penaltyByEmp, groupPenalty: groupPenalty, minMax: minMax };
        result.totalPenalty += groupPenalty;
    });
    return result;
}

/**
 * hard-valid draft 위에서 same-day identity swap을 반복 적용해 1일 고립근무와
 * A/P 편중을 줄인다(우선순위: 고립근무 감소 > A/P fairness 개선 — 스펙 명시).
 * 매 swap 후보마다 두 당사자의 hard constraint를 재확인하고, 위반이 있으면
 * 즉시 원복한다. exact staffing/그룹·날짜 정원은 same-day swap 구조상 항상
 * 그대로 유지되므로 별도 재검증이 필요 없다(주석 상단 설명 참고).
 */
function _optimizeScheduleQuality(grid, employees, employeesByGroup, scheduleCodes, autoConfig, totalDays, prevTail, prevLastCode, monthlyOffMinimum) {
    var maxConsecutiveWork = Number((autoConfig || {}).maxConsecutiveWork || 0);
    var codeLinkRestrictions = (autoConfig || {}).codeLinkRestrictions || [];
    var codes = AUTO_SCHEDULE_QUALITY_FAIRNESS_CODES;

    var iterations = 0, swapsApplied = 0, timedOut = false;
    var before = {
        isolated: _countIsolatedWorkDays(grid, employees, totalDays, prevTail).total,
        fairness: _computeGroupCodeFairness(grid, employeesByGroup, codes).totalPenalty,
    };

    var groupNames = Object.keys(employeesByGroup).sort();

    outer:
    for (var pass = 0; pass < AUTO_SCHEDULE_QUALITY_MAX_PASSES; pass++) {
        var changedThisPass = false;
        for (var day = 1; day <= totalDays; day++) {
            var dayStr = String(day);
            for (var gi = 0; gi < groupNames.length; gi++) {
                var members = employeesByGroup[groupNames[gi]] || [];
                for (var i = 0; i < members.length; i++) {
                    for (var j = i + 1; j < members.length; j++) {
                        iterations++;
                        if (iterations > AUTO_SCHEDULE_QUALITY_MAX_ITERATIONS) { timedOut = true; break outer; }

                        var empA = members[i], empB = members[j];
                        var entryA = (grid[empA.uid] || {})[dayStr];
                        var entryB = (grid[empB.uid] || {})[dayStr];
                        if (!entryA || !entryB) continue;
                        if (_repairIsFixedCell(entryA) || _repairIsFixedCell(entryB)) continue;
                        if (entryA.type === entryB.type && entryA.scheduleCode === entryB.scheduleCode) continue;
                        // normal<->schedule 교차 swap은 두 당사자의 월 휴무 사용량을 서로 반대
                        // 방향으로 바꾼다(권장 target 균형을 흔들 수 있음) — 스펙 우선순위상
                        // 13(권장휴무)은 11(고립근무)/12(fairness)보다 낮으므로, 고립근무를
                        // "실제로 줄이는" 경우에만 이 비용을 지불한다. 순수 fairness 동률
                        // 개선을 위해 target 균형을 흔드는 것은 허용하지 않는다(같은 type끼리의
                        // schedule<->schedule 코드 교체는 휴무 사용량을 전혀 바꾸지 않으므로
                        // fairness 목적에는 그 경로만 쓴다).
                        var crossType = entryA.type !== entryB.type;

                        var window = _isolatedWorkWindowDays(day, totalDays);
                        var isoBefore = 0;
                        window.forEach(function (d) {
                            if (_isIsolatedWorkDay(grid, empA.uid, d, totalDays, prevTail)) isoBefore++;
                            if (_isIsolatedWorkDay(grid, empB.uid, d, totalDays, prevTail)) isoBefore++;
                        });

                        var origA = entryA, origB = entryB;
                        grid[empA.uid][dayStr] = origB;
                        grid[empB.uid][dayStr] = origA;

                        var hardOk = true;
                        if (maxConsecutiveWork > 0 && !_fullMonthStreakOk(grid, [empA, empB], totalDays, prevTail, maxConsecutiveWork)) hardOk = false;
                        if (hardOk && codeLinkRestrictions.length && !_fullMonthCodeLinkOk(grid, [empA, empB], totalDays, codeLinkRestrictions, prevLastCode)) hardOk = false;
                        if (hardOk) {
                            [empA, empB].some(function (emp) {
                                return scheduleCodes.some(function (codeItem) {
                                    var limit = _scheduleCodeMonthlyLimit(scheduleCodes, codeItem.name);
                                    if (limit == null) return false;
                                    if (_employeeScheduleCodeCount(grid, emp.uid, codeItem.name) > limit) { hardOk = false; return true; }
                                    return false;
                                });
                            });
                        }
                        if (hardOk && (_repairEmployeeOffCount(grid, empA.uid) < monthlyOffMinimum || _repairEmployeeOffCount(grid, empB.uid) < monthlyOffMinimum)) hardOk = false;

                        if (!hardOk) {
                            grid[empA.uid][dayStr] = origA;
                            grid[empB.uid][dayStr] = origB;
                            continue;
                        }

                        var isoAfter = 0;
                        window.forEach(function (d) {
                            if (_isIsolatedWorkDay(grid, empA.uid, d, totalDays, prevTail)) isoAfter++;
                            if (_isIsolatedWorkDay(grid, empB.uid, d, totalDays, prevTail)) isoAfter++;
                        });

                        var accept;
                        if (isoAfter < isoBefore) {
                            accept = true; // 고립근무 실제 감소 — normal<->schedule 비용을 지불할 가치가 있음
                        } else if (isoAfter > isoBefore) {
                            accept = false;
                        } else if (crossType) {
                            // 고립근무 변화 없음(동률) + 교차 타입 swap → 휴무 사용량만 흔들고
                            // 얻는 게 없으므로 거부(권장휴무 target 균형 보호, TEST 4/7 회귀 방지).
                            accept = false;
                        } else {
                            var groupPenaltyKey = groupNames[gi];
                            grid[empA.uid][dayStr] = origA; grid[empB.uid][dayStr] = origB;
                            var fBefore = _computeGroupCodeFairness(grid, employeesByGroup, codes).byGroup[groupPenaltyKey].groupPenalty;
                            grid[empA.uid][dayStr] = origB; grid[empB.uid][dayStr] = origA;
                            var fAfter = _computeGroupCodeFairness(grid, employeesByGroup, codes).byGroup[groupPenaltyKey].groupPenalty;
                            accept = fAfter < fBefore;
                        }

                        if (accept) {
                            swapsApplied++;
                            changedThisPass = true;
                        } else {
                            grid[empA.uid][dayStr] = origA;
                            grid[empB.uid][dayStr] = origB;
                        }
                    }
                }
            }
        }
        if (!changedThisPass) break;
    }

    var after = {
        isolated: _countIsolatedWorkDays(grid, employees, totalDays, prevTail).total,
        fairness: _computeGroupCodeFairness(grid, employeesByGroup, codes).totalPenalty,
    };
    return { grid: grid, swapsApplied: swapsApplied, iterations: iterations, timedOut: timedOut, before: before, after: after };
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
    var monthlyOffMinimum = _monthlyOffMinimum(autoConfig);
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

    // 월 누적 근무코드별 배정 횟수(직원별) — "직원 1명당 월간 코드별 최대 배정
    // 횟수" hard cap을 greedy가 실시간으로 지키기 위한 카운터. 고정 신청/override로
    // 이미 확정된 배정도 시작값에 포함한다(requested+auto를 합산해야 하므로).
    var monthlyCodeCount = {};
    employees.forEach(function (emp) { monthlyCodeCount[emp.uid] = {}; });
    employees.forEach(function (emp) {
        var days = grid[emp.uid] || {};
        Object.keys(days).forEach(function (day) {
            var e = days[day];
            if (e.type === "schedule" && e.scheduleCode) {
                monthlyCodeCount[emp.uid][e.scheduleCode] = (monthlyCodeCount[emp.uid][e.scheduleCode] || 0) + 1;
            }
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

                    var codeLimit = _scheduleCodeMonthlyLimit(scheduleCodes, codeName);
                    if (codeLimit != null && (monthlyCodeCount[emp.uid][codeName] || 0) >= codeLimit) continue; // 월간 코드 상한 도달 — 후보 제외

                    // 월 일반휴무 최소치(hard floor) — 오늘 근무를 배정하면 남은 날짜를
                    // 전부 휴무로 줘도 minimum(최소 허용 휴무)에 도달할 수 없는 직원은
                    // 후보에서 제외한다. target(권장)은 soft이므로 이 가드에는 쓰지
                    // 않는다 — offDeficit(target 기준) 정렬이 "이미 휴무를 많이 채운
                    // 사람 우선 근무"를 자연히 달성하므로, 이 가드는 그 위에 겹쳐지는
                    // 순수한 hard floor 안전장치일 뿐이다.
                    if ((monthlyOffCount[emp.uid] || 0) + (totalDays - day) < monthlyOffMinimum) continue;

                    var streak = consecutiveWorkStreakAt(grid, emp.uid, day - 1, prevTail[emp.uid]);
                    if (streak + 1 > maxConsecutiveWork && maxConsecutiveWork > 0) continue; // 이 코드로 배정하면 연속근무 초과

                    var prevCode = _prevCodeAt(grid, emp.uid, day, prevLastCode);
                    if (isCodeLinkForbidden(codeLinkRestrictions, prevCode, codeName)) continue;

                    ensureGridDay(emp.uid);
                    grid[emp.uid][dayStr] = { type: "schedule", scheduleCode: codeName, source: "auto" };
                    monthlyCodeCount[emp.uid][codeName] = (monthlyCodeCount[emp.uid][codeName] || 0) + 1;
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

    // ⚠️ work_shortfall repair pass — 기존 fallback(±3일 국소 window)이 놓치는,
    // "같은 날 코드 재배치" 또는 "월간 코드 relocation"으로 수학적으로 풀 수
    // 있는 남은 work_shortfall만 targeted로 추가 탐색한다(3d 섹션 참고). 반드시
    // "실제로 남은 work_shortfall이 있을 때만" 실행하고, 매 적용 전후로 전체
    // 부족석 총량이 실제 감소했는지 재확인한 뒤에만 채택한다(단순 이동 27→27은
    // 채택 안 함). requested/annual/petition/override는 절대 건드리지 않는다.
    var repair = { attempted: false, appliedCount: 0, iterations: 0, timedOut: false };
    var remainingShortfallsBeforeRepair = conflicts.filter(function (c) { return c.kind === "work_shortfall"; });
    if (remainingShortfallsBeforeRepair.length > 0) {
        repair.attempted = true;
        var repairResult = _repairWorkShortfalls(
            grid, employees, employeesByGroup, groupByEmp, config, scheduleCodes, autoConfig,
            totalDays, prevTail, prevLastCode, monthlyOffMinimum
        );
        repair.appliedCount = repairResult.appliedCount;
        repair.iterations = repairResult.iterations;
        repair.timedOut = repairResult.timedOut;
        if (repairResult.appliedCount > 0) {
            grid = repairResult.grid;
            // work_shortfall/no_valid_assignment는 grid 기준으로 완전히 다시 스캔한다
            // (repair가 두 종류 모두에 영향을 줄 수 있음 — 예: unset 셀을 직접 채우는
            // 경우도 있고, auto_off를 근무로 옮겨 no_valid_assignment 대상 자체가
            // 사라지는 경우도 있다). day_off_cap/group_off_cap은 repair가 휴무
            // 사용량을 늘리는 방향으로는 절대 움직이지 않으므로(auto_off→근무 전환만
            // 있고 근무→auto_off 전환은 없음) 재검증 없이 그대로 두어도 안전하다.
            conflicts = conflicts.filter(function (c) { return c.kind !== "work_shortfall" && c.kind !== "no_valid_assignment"; });
            conflicts = conflicts.concat(_computeCodeGaps(grid, employeesByGroup, config, scheduleCodes, totalDays));
            Object.keys(employeesByGroup).forEach(function (group) {
                (employeesByGroup[group] || []).forEach(function (m) {
                    for (var d = 1; d <= totalDays; d++) {
                        var e = (grid[m.uid] || {})[String(d)];
                        if (!e) conflicts.push({ kind: "no_valid_assignment", day: d, group: group, empKey: m.uid, empName: m.name, target: monthlyOffTarget, message: d + "일 " + group + "조 " + (m.name || m.uid) + " — 배정 없음." });
                    }
                });
            });
            monthlyOffCount = {};
            employees.forEach(function (emp) { monthlyOffCount[emp.uid] = 0; });
            employees.forEach(function (emp) {
                Object.keys(grid[emp.uid] || {}).forEach(function (d) {
                    if (grid[emp.uid][d].type === "normal") monthlyOffCount[emp.uid]++;
                });
            });
        }
    }

    // ⚠️ 직원별 월간 근무코드 상한 초과 검사 — greedy/fallback 모두 배정 시점에
    // 이미 상한을 넘지 않도록 후보에서 제외하지만(위 monthlyCodeCount 가드),
    // "신청(requested)/override만으로 이미 상한을 초과한" 경우는 auto-fill로
    // 해결할 수 없는 진짜 충돌이므로(신청 근무코드/override는 절대 임의로
    // 변경하지 않는다는 기존 정책과 동일) 여기서 최종 grid 기준으로 별도 검출한다.
    scheduleCodes.forEach(function (codeItem) {
        var codeLimitFinal = _scheduleCodeMonthlyLimit(scheduleCodes, codeItem.name);
        if (codeLimitFinal == null) return;
        employees.forEach(function (emp) {
            var count = _employeeScheduleCodeCount(grid, emp.uid, codeItem.name);
            if (count > codeLimitFinal) {
                conflicts.push({
                    kind: "schedule_code_monthly_limit",
                    empKey: emp.uid, empName: emp.name, scheduleCode: codeItem.name,
                    limit: codeLimitFinal, actual: count,
                    message: (emp.name || emp.uid) + " " + codeItem.name + "코드 월 제한(" + codeLimitFinal + "회)을 초과했습니다(현재 " + count + "회).",
                });
            }
        });
    });

    // ⚠️ 월말 사후 검증 — "권장 target(10) 미달"과 "최소 minimum(9) 미달"을 반드시
    // 분리한다. minimum 미달은 hard(확정 불가), target 미달은 soft warning(확정
    // 가능, 안내만) — target===minimum인 legacy config는 두 검사가 항상 동시에
    // 트리거되므로 기존 "정확히 target" exact 정책과 100% 동일하게 동작한다.
    // (그렇지 않으면 conflicts가 0인데 실제로는 minimum 미달인 채 ok:true를 반환하는
    // 조용한 버그가 된다 — 실제 fixture 테스트로 이 문제를 확인했다.)
    var warnings = [];
    employees.forEach(function (emp) {
        var count = monthlyOffCount[emp.uid];
        if (count < monthlyOffMinimum) {
            conflicts.push({
                kind: "monthly_off_minimum_shortfall",
                empKey: emp.uid, empName: emp.name,
                needed: monthlyOffMinimum, actual: count,
                message: (emp.name || emp.uid) + " 월 최소 일반휴무(" + monthlyOffMinimum + ")에 " + (monthlyOffMinimum - count) + "일 미달.",
            });
        } else if (count < monthlyOffTarget) {
            warnings.push({
                kind: "monthly_off_target_shortfall",
                empKey: emp.uid, empName: emp.name,
                needed: monthlyOffTarget, actual: count,
                message: (emp.name || emp.uid) + " 월 권장 일반휴무(" + monthlyOffTarget + ")에 " + (monthlyOffTarget - count) + "일 미달(최소 기준은 충족).",
            });
        }
    });

    // ⚠️ ok 판정은 집계 전 원본 conflicts 기준(집계는 표시 형태만 바꿀 뿐 위반
    // 존재 여부 자체는 절대 바꾸지 않는다 — 병합해도 원소가 하나도 사라지지 않으므로
    // 사실 conflicts.length===0 ⇔ 집계 후 길이===0 이지만, 의도를 명확히 하기 위해
    // 집계 전 값으로 명시적으로 판정한다). warnings는 절대 ok/conflicts에 영향을
    // 주지 않는다 — soft target 미달만으로는 확정을 막지 않는다.
    var ok = conflicts.length === 0;

    // ⚠️ 편성 품질 최적화(soft) — 실제 대구 QA에서는 bulk 조정 후에도
    // work_shortfall이 다수(약 22~25건) 남아 ok===true가 되는 경우가 드물다.
    // "완벽한 draft에서만 품질개선"으로 제한하면 실사용 환경에서 이 기능이
    // 사실상 전혀 실행되지 않으므로, "미충족 근무석/탐색 한계"류(=배정을 아직
    // 완료하지 못했을 뿐 이미 배정된 값을 위반한 게 아닌 conflict)만 남았다면
    // quality pass를 허용한다. 반대로 이미 확정된 셀이 실제로 hard invariant를
    // 위반한 상태(월 최소휴무 미달/코드 월 상한 초과 등)라면 quality가 그
    // 위반을 가리거나 더 악화시킬 위험이 있으므로 절대 실행하지 않는다.
    //
    // same-day identity swap은 그 날짜/조/코드의 슬롯 수를 그대로 유지하고,
    // 둘 다 이미 배정된(entry가 존재하는) auto/auto_off 셀끼리만 교환하므로
    // work_shortfall/no_valid_assignment/search_limit_exceeded처럼 "그 자리가
    // 아예 비어있는" shortage 위치는 swap 대상 자체가 될 수 없다(entryA/entryB
    // undefined면 스킵) — 따라서 이 gating만 바꿔도 shortage를 다른 위치로
    // 옮기거나 총량을 악화시킬 수 없다(구조적으로 안전).
    //
    // ⚠️ day_off_cap/group_off_cap은 shortage-like에서 제외한다 — 기존 시스템
    // semantics상 "특정일 전체 휴무 제한"/"조별 휴무 제한"은 관리자가 명시적으로
    // 설정한 HARD constraint이며(단순 배정 실패가 아니라 설정된 상한 자체를
    // 못 지킨 상태), quality pass가 이런 상태를 shortage-only로 오분류해 실행되면
    // 안 된다.
    //
    // ⚠️ iteration_limit도 제외한다 — 코드 확인 결과 이 kind는 greedy 메인 루프
    // 중간(반복 한도 초과)에 발생하는 완전히 별도의 early-return 경로에서만
    // push되며, 그 즉시 fallback/repair/최종검증을 전혀 거치지 않은 채 최소
    // 형태({ok,totalDays,grid,conflicts,monthlyOffCount})로 함수 자체가 끝나
    // 버린다(quality 게이팅 코드에 도달하기 전에 이미 return됨) — search가
    // 끝까지 진행된 뒤 "이 부분만 못 채웠다"는 의미인 search_limit_exceeded와
    // 달리, 입력 규모/무한루프 안전장치로 인한 "생성 자체가 중단된" 상태이므로
    // 이름만 보고 동일 취급하면 안 된다(실질적으로도 이 경로에서는 quality
    // 코드에 도달조차 하지 않아 현재는 항상 무해하지만, 향후 코드가 바뀌어도
    // 안전하도록 명시적으로 차단 목록에 둔다).
    var SHORTAGE_LIKE_CONFLICT_KINDS = {
        work_shortfall: 1, no_valid_assignment: 1, search_limit_exceeded: 1,
    };
    var hasBlockingHardConflict = conflicts.some(function (c) { return !SHORTAGE_LIKE_CONFLICT_KINDS[c.kind]; });
    var qualityEligible = !hasBlockingHardConflict;

    var quality = { attempted: false, swapsApplied: 0, iterations: 0, timedOut: false, isolatedBefore: null, isolatedAfter: null, fairnessBefore: null, fairnessAfter: null };
    if (qualityEligible) {
        quality.attempted = true;
        var qResult = _optimizeScheduleQuality(grid, employees, employeesByGroup, scheduleCodes, autoConfig, totalDays, prevTail, prevLastCode, monthlyOffMinimum);
        grid = qResult.grid;
        quality.swapsApplied = qResult.swapsApplied;
        quality.iterations = qResult.iterations;
        quality.timedOut = qResult.timedOut;
        quality.isolatedBefore = qResult.before.isolated;
        quality.isolatedAfter = qResult.after.isolated;
        quality.fairnessBefore = qResult.before.fairness;
        quality.fairnessAfter = qResult.after.fairness;

        if (qResult.swapsApplied > 0) {
            // quality swap이 normal<->schedule 전환을 포함할 수 있으므로 monthlyOffCount를
            // grid 기준으로 다시 집계한다(minimum은 swap 시점에 이미 개별 보장됨 — target
            // 권장 미달 warning만 최신 상태로 다시 계산).
            monthlyOffCount = {};
            employees.forEach(function (emp) { monthlyOffCount[emp.uid] = 0; });
            employees.forEach(function (emp) {
                Object.keys(grid[emp.uid] || {}).forEach(function (d) {
                    if (grid[emp.uid][d].type === "normal") monthlyOffCount[emp.uid]++;
                });
            });
            warnings = [];
            employees.forEach(function (emp) {
                var count = monthlyOffCount[emp.uid];
                if (count >= monthlyOffMinimum && count < monthlyOffTarget) {
                    warnings.push({
                        kind: "monthly_off_target_shortfall",
                        empKey: emp.uid, empName: emp.name,
                        needed: monthlyOffTarget, actual: count,
                        message: (emp.name || emp.uid) + " 월 권장 일반휴무(" + monthlyOffTarget + ")에 " + (monthlyOffTarget - count) + "일 미달(최소 기준은 충족).",
                    });
                }
            });
        }
    }

    return { ok: ok, totalDays: totalDays, grid: grid, conflicts: _aggregateConflicts(conflicts), warnings: warnings, monthlyOffCount: monthlyOffCount, greedyFailed: greedyFailed, fallback: fallback, repair: repair, quality: quality };
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
function findOverrideCandidates(draft, conflict, employees, groups, autoConfig, previousMonthWorkTail, previousMonthLastScheduleCode, scheduleCodes) {
    if (!conflict || conflict.kind !== "work_shortfall") return [];
    var day = conflict.day, group = conflict.group, codeName = conflict.scheduleCode;
    var dayStr = String(day);
    var maxConsecutiveWork = Number((autoConfig || {}).maxConsecutiveWork || 0);
    var codeLinkRestrictions = (autoConfig || {}).codeLinkRestrictions || [];
    var prevTail = previousMonthWorkTail || {};
    var prevLastCode = previousMonthLastScheduleCode || {};
    var codeLimit = _scheduleCodeMonthlyLimit(scheduleCodes, codeName);
    var monthlyOffMinimum = _monthlyOffMinimum(autoConfig);

    var groupByEmp = {};
    Object.keys(groups || {}).forEach(function (g) {
        (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; });
    });

    var candidates = [];
    _autoSortEmployees(employees || []).forEach(function (emp) {
        if (groupByEmp[emp.uid] !== group) return;
        var entry = (draft.grid[emp.uid] || {})[dayStr];
        if (!entry || entry.type !== "normal" || entry.source !== "requested") return; // 신청 normal만(연차/청원/이미 근무 제외)

        // 월간 코드 상한 — 이 직원이 이미 codeName 코드로 상한만큼 배정되어 있으면
        // (requested+auto+override 합산) 후보가 될 수 없다. 신청휴무 개별/일괄
        // 조정 둘 다 findOverrideCandidates를 그대로 재사용하므로 자연히 동일하게 적용된다.
        if (codeLimit != null && _employeeScheduleCodeCount(draft.grid, emp.uid, codeName) >= codeLimit) return;

        // 월 일반휴무 최소치(hard floor) — 이 override로 normal 1건이 근무로
        // 바뀌면 최악의 경우(다른 날짜로 재배치 불가) 이 직원의 월 일반휴무가
        // 정확히 1 감소한다. 그 결과가 minimum 미만이 되면 후보에서 제외한다.
        // 재배치가 실제로 성공하면 결과는 이보다 좋아질 뿐이므로, 이 worst-case
        // 가드만으로 "9→8은 후보 제외, 10→9(재배치 불가)는 허용"이 정확히 성립한다.
        //
        // ⚠️ 이 pre-filter는 target > minimum(실제 슬랙이 선언된 신규 정책)일 때만
        // 적용한다. minimum이 legacy fallback으로 target과 같아지는(=슬랙 0) 기존
        // exact 모드에서는 "현재 정확히 target인 사람"이 항상 worst-case에서 걸려
        // 100%의 후보가 차단되는 회귀가 생긴다 — 기존 exact 모드는 애초에 candidate
        // 단계에서 이런 pre-filter가 없었고, 재배치 성공 여부는 실제 적용 후
        // fresh generateDraft의 monthly_off_minimum_shortfall 최종 검증으로만
        // 판정되던 기존 동작을 그대로 보존한다(target=minimum ⇔ 기존 exact 정책과
        // 100% 동일 동작 유지 원칙).
        if (monthlyOffMinimum < Number((autoConfig || {}).monthlyOffTarget || 0) && (draft.monthlyOffCount[emp.uid] || 0) - 1 < monthlyOffMinimum) return;

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
// 5b) 신청휴무 일괄 자동조정 — "1건 선택 → 가상 적용 → fresh generateDraft →
//     fresh conflicts → 다음 conflict 선택" 을 반복하는 순수 계획(planning) 함수.
// ═══════════════════════════════════════════════════════════════════════════
var AUTO_SCHEDULE_BULK_MAX_ITERATIONS = 4000;   // "평가 시도" 총량 상한(후보 평가 1회당 1) — freeze 방지
var AUTO_SCHEDULE_BULK_TIME_BUDGET_MS = 8000;   // 벽시계 상한 — 두 상한 중 먼저 도달하는 쪽에서 중단
var AUTO_SCHEDULE_BULK_MAX_OVERRIDES_DEFAULT = 200; // plan에 담을 수 있는 override 최대 개수(안전판)

/** work_shortfall conflict들의 "부족 좌석 수" 총합(needed-available 합) — 이 값을
 *  최우선으로 줄이는 후보를 고른다. work_shortfall이 아닌 conflict는 집계하지 않는다. */
function _totalShortageSeats(draft) {
    var total = 0;
    (draft.conflicts || []).forEach(function (c) {
        if (c.kind === "work_shortfall" && c.needed != null && c.available != null) {
            total += Math.max(0, c.needed - c.available);
        }
    });
    return total;
}

/** work_shortfall/monthly_off_minimum_shortfall을 제외한 "새로 나타났거나 악화된"
 *  hard conflict 종류(day_off_cap/group_off_cap/no_valid_assignment/
 *  search_limit_exceeded/iteration_limit/schedule_code_monthly_limit) 개수 —
 *  2순위(새 hard conflict 최소화) 판정에 사용한다. */
function _otherHardConflictCount(draft) {
    var n = 0;
    (draft.conflicts || []).forEach(function (c) {
        if (c.kind !== "work_shortfall" && c.kind !== "monthly_off_minimum_shortfall") n++;
    });
    return n;
}

function _monthlyOffShortfallCount(draft) {
    var n = 0;
    (draft.conflicts || []).forEach(function (c) { if (c.kind === "monthly_off_minimum_shortfall") n++; });
    return n;
}

/** candidate 하나를 가상 적용한 tempDraft를 스펙의 6단계 우선순위로 채점한다.
 *  배열의 앞 원소일수록 우선순위가 높고, 모든 항목은 "작을수록 좋다". */
function _scoreBulkCandidate(tempDraft, candidateUid, monthlyOffTarget, bulkOverrideCountSoFar) {
    var ownOffCount = (tempDraft.monthlyOffCount && tempDraft.monthlyOffCount[candidateUid]) || 0;
    return [
        _totalShortageSeats(tempDraft),                          // 1순위: 부족 좌석 총량
        _otherHardConflictCount(tempDraft),                       // 2순위: 새 hard conflict 최소화
        ownOffCount === monthlyOffTarget ? 0 : 1,                 // 3순위: 해당 직원 월 휴무 목표 복구 여부
        _monthlyOffShortfallCount(tempDraft),                     // 4순위: 전체 월 휴무 부족 총량
        tempDraft.conflicts.length,                               // 5순위: 전체 hard conflict 개수
        (bulkOverrideCountSoFar[candidateUid] || 0),              // fairness: 이번 bulk 실행에서 이미 조정된 횟수
    ];
}

/** 점수 배열을 사전식으로 비교한다 — a가 더 좋으면(=더 작으면) 음수를 반환. */
function _compareBulkScores(a, b) {
    for (var i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) return a[i] - b[i];
    }
    return 0;
}

/**
 * planBulkOverrides(input, options) → {
 *   plan: [{uid, name, day, group, scheduleCode, originalType}],
 *   previewDraft, beforeSummary, afterSummary, unresolvedConflicts,
 *   stoppedReason, iterations, truncated
 * }
 *
 * ⚠️ 이 함수는 input을 전혀 변형하지 않고, 순수하게 "계획"만 계산한다 — 실제
 * live draft/forcedOverrides는 호출부가 plan을 받아본 뒤 명시적으로 적용해야
 * 바뀐다(이 함수 자체는 side effect가 없다). 이미 존재하는 input.forcedOverrides는
 * 그대로 시작점으로 유지되며 절대 제거/변경되지 않는다 — 이번 실행에서 새로
 * 결정한 override만 plan에 추가된다.
 *
 * 반복마다 findOverrideCandidates()(기존 manual 조정과 완전히 동일한 함수)로
 * 후보를 구하고, 후보별로 실제 generateDraft()를 다시 돌려(=가상 적용) 결과를
 * 평가한 뒤 가장 좋은 후보를 선택한다 — 절대 "현재 후보 목록의 첫 번째"를
 * 기계적으로 고르지 않는다. 개선되지 않는 후보(부족 좌석이 줄지 않고 전체 상태도
 * 나아지지 않는 경우)는 채택하지 않는다.
 */
function planBulkOverrides(input, options) {
    var opts = options || {};
    var maxIterations = opts.maxIterations || AUTO_SCHEDULE_BULK_MAX_ITERATIONS;
    var timeBudgetMs = opts.timeBudgetMs || AUTO_SCHEDULE_BULK_TIME_BUDGET_MS;

    var requestedNormalCount = 0;
    Object.keys(input.existingRequests || {}).forEach(function (uid) {
        Object.keys((input.existingRequests || {})[uid] || {}).forEach(function (day) {
            if ((input.existingRequests[uid][day] || {}).type === "normal") requestedNormalCount++;
        });
    });
    var maxBulkOverrides = opts.maxBulkOverrides || Math.min(AUTO_SCHEDULE_BULK_MAX_OVERRIDES_DEFAULT, requestedNormalCount);

    var monthlyOffTarget = Number((input.autoConfig || {}).monthlyOffTarget || 0);
    var monthlyOffMinimum = _monthlyOffMinimum(input.autoConfig);
    var startTime = Date.now();
    var iterations = 0;
    var truncated = false;

    // 기존에 이미 적용된 forcedOverrides(수동 조정분 포함)는 절대 건드리지 않고 그대로
    // 시작점으로 clone한다 — 이 함수가 새로 추가하는 것은 오직 신규 override뿐이다.
    var workingForcedOverrides = (input.forcedOverrides || []).map(function (o) { return Object.assign({}, o); });
    var existingKeySet = {};
    workingForcedOverrides.forEach(function (o) { existingKeySet[o.uid + "|" + o.day] = true; });

    var workingDraft = generateDraft(Object.assign({}, input, { forcedOverrides: workingForcedOverrides }));
    var beforeSummary = {
        shortageSeats: _totalShortageSeats(workingDraft),
        workShortfallCount: workingDraft.conflicts.filter(function (c) { return c.kind === "work_shortfall"; }).length,
        monthlyOffShortfallCount: _monthlyOffShortfallCount(workingDraft),
        totalConflicts: workingDraft.conflicts.length,
    };

    var plan = [];
    var bulkOverrideCountSoFar = {}; // uid -> 이번 bulk 실행에서 조정된 횟수(공정성 tie-break용)
    var stoppedReason = null;

    while (true) {
        // ⚠️ 종료 사유 우선순위: "성공(더 이상 work_shortfall 없음)"이 확정되면 그
        // 어떤 limit(시간/반복/개수)보다 항상 우선한다. 즉 fresh conflicts를 먼저
        // 확인해 이미 성공 상태인지부터 판정하고, 그 다음에만 limit을 검사한다 —
        // "마지막 허용 override가 마지막 shortage까지 정확히 해결"한 경우에도
        // max_overrides로 잘못 보고되던 결함(Codex Gate 21 #1)의 근본 수정.
        var shortfalls = workingDraft.conflicts.filter(function (c) { return c.kind === "work_shortfall"; });
        if (!shortfalls.length) { stoppedReason = "no_shortfall"; break; }

        if (Date.now() - startTime > timeBudgetMs) { stoppedReason = "time_limit"; truncated = true; break; }
        if (iterations > maxIterations) { stoppedReason = "iteration_limit"; truncated = true; break; }
        if (plan.length >= maxBulkOverrides) { stoppedReason = "max_overrides"; truncated = true; break; }

        // deterministic: 날짜 오름차순 → 조 → 근무코드명. "매번 fresh conflicts"를
        // 기준으로 매 반복마다 새로 정렬한다(stale 순서 재사용 금지).
        shortfalls = shortfalls.slice().sort(function (a, b) {
            if (a.day !== b.day) return a.day - b.day;
            if (a.group !== b.group) return String(a.group).localeCompare(String(b.group));
            return String(a.scheduleCode).localeCompare(String(b.scheduleCode));
        });

        var picked = null;
        var exhausted = false;
        for (var si = 0; si < shortfalls.length && !picked; si++) {
            var conflict = shortfalls[si];
            var candidates = findOverrideCandidates(
                workingDraft, conflict, input.employees, input.groups, input.autoConfig,
                input.previousMonthWorkTail, input.previousMonthLastScheduleCode,
                (input.config || {}).scheduleCodes
            ).filter(function (c) { return !existingKeySet[c.uid + "|" + conflict.day]; }); // 중복 방지(이미 계획/기존 override된 셀 제외)

            var best = null;
            var exhaustReason = null; // ⚠️ time/iteration 초과를 구분해서 기억한다 —
            // 이전에는 둘 다 truncated=true 하나로만 남기고 바깥에서 무조건
            // "iteration_limit"으로 오해석해(Codex Gate 21 #2) 실제로는 시간
            // 초과인데도 iteration_limit로 잘못 보고되는 결함이 있었다.
            for (var ci = 0; ci < candidates.length; ci++) {
                iterations++;
                if (Date.now() - startTime > timeBudgetMs) { exhausted = true; exhaustReason = "time_limit"; truncated = true; break; }
                if (iterations > maxIterations) { exhausted = true; exhaustReason = "iteration_limit"; truncated = true; break; }

                var cand = candidates[ci];
                var tempForced = workingForcedOverrides.concat([{
                    uid: cand.uid, day: conflict.day, scheduleCode: conflict.scheduleCode,
                    originalRequest: { type: "normal" },
                    override: { changedBy: null, changedAt: 0, reason: "auto_schedule_conflict" }, // 실제 적용 시 UI가 authoritative 값으로 재작성
                }]);
                var tempDraft = generateDraft(Object.assign({}, input, { forcedOverrides: tempForced }));

                // ⚠️ Production 실회귀 수정(대구 QA "김영훈 9→8") — work_shortfall이
                // 줄어든다는 이유만으로 minimum hard floor를 새로 깨거나 악화시키는
                // 후보를 채택하면 안 된다. workingDraft(이번 step 직전, 매 반복마다
                // fresh)와 비교해 "이번 step 때문에" 어떤 직원이든 minimum 미만으로
                // 새로 떨어지거나 더 나빠지면 그 후보 자체를 점수 계산 전에 제외한다
                // — 그래야 최선 후보 하나만 보고 포기하지 않고 다음으로 좋은(그러나
                // minimum은 지키는) 후보로 자연스럽게 넘어간다. 이 bulk 실행 시작
                // 전부터 이미 존재하던(bulk와 무관한) minimum 위반은 grandfather
                // 처리(그대로 둠) — work_shortfall 잔여분과 마찬가지로 이 함수가
                // 새로 만들지만 않으면 된다. monthlyOffCount는 generateDraft가
                // 매번 grid에서 새로 집계하는 fresh 값이라 stale cache 위험이 없다.
                var violatesMinimum = (input.employees || []).some(function (emp) {
                    var beforeCount = (workingDraft.monthlyOffCount && workingDraft.monthlyOffCount[emp.uid]) || 0;
                    var afterCount = (tempDraft.monthlyOffCount && tempDraft.monthlyOffCount[emp.uid]) || 0;
                    return afterCount < monthlyOffMinimum && afterCount < beforeCount;
                });
                if (violatesMinimum) continue;

                var score = _scoreBulkCandidate(tempDraft, cand.uid, monthlyOffTarget, bulkOverrideCountSoFar);

                if (!best || _compareBulkScores(score, best.score) < 0) {
                    best = { cand: cand, tempDraft: tempDraft, tempForced: tempForced, score: score };
                }
            }
            if (exhausted) { stoppedReason = exhaustReason; break; }
            if (!best) continue; // 이 conflict엔 유효 후보가 없음 — 다음 conflict 시도

            // "개선 없는 후보 적용 금지": 부족 좌석이 줄지 않고 전체 상태도 나아지지
            // 않으면 이 conflict는 이번 라운드에서 건너뛰고 다음 conflict를 시도한다.
            var beforeSeats = _totalShortageSeats(workingDraft);
            var afterSeats = _totalShortageSeats(best.tempDraft);
            var improved = afterSeats < beforeSeats || (afterSeats === beforeSeats && best.tempDraft.conflicts.length < workingDraft.conflicts.length);
            if (!improved) continue;

            picked = { conflict: conflict, cand: best.cand, tempDraft: best.tempDraft, tempForced: best.tempForced };
        }

        if (exhausted && !picked) break; // 반복/시간 상한 도달 — 지금까지의 plan으로 종료
        if (!picked) { stoppedReason = "no_improving_candidate"; break; }

        workingForcedOverrides = picked.tempForced;
        existingKeySet[picked.cand.uid + "|" + picked.conflict.day] = true;
        workingDraft = picked.tempDraft;
        bulkOverrideCountSoFar[picked.cand.uid] = (bulkOverrideCountSoFar[picked.cand.uid] || 0) + 1;
        plan.push({
            uid: picked.cand.uid,
            name: picked.cand.name || picked.cand.uid,
            day: picked.conflict.day,
            group: picked.conflict.group,
            scheduleCode: picked.conflict.scheduleCode,
            originalType: "normal",
        });
    }

    var afterSummary = {
        shortageSeats: _totalShortageSeats(workingDraft),
        workShortfallCount: workingDraft.conflicts.filter(function (c) { return c.kind === "work_shortfall"; }).length,
        monthlyOffShortfallCount: _monthlyOffShortfallCount(workingDraft),
        totalConflicts: workingDraft.conflicts.length,
    };

    return {
        plan: plan,
        previewDraft: workingDraft,
        beforeSummary: beforeSummary,
        afterSummary: afterSummary,
        unresolvedConflicts: workingDraft.conflicts,
        stoppedReason: stoppedReason || "no_shortfall",
        iterations: iterations,
        truncated: truncated,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 5c) 수학적 사전 feasibility 진단 — DB 쓰기 없는 순수 계산. work_shortfall을
//     "solver가 못 찾음"과 "설정상 애초에 불가능"으로 구분하기 위한 것이며,
//     generateDraft의 실제 배정 로직에는 전혀 관여하지 않는다(진단 전용).
// ═══════════════════════════════════════════════════════════════════════════

/**
 * draft.conflicts 중 kind==="work_shortfall"인 항목마다 진단 reason을 붙여
 * 반환한다: { day, group, scheduleCode, needed, available, reason, detail }.
 *
 * reason 값:
 *   TOTAL_MONTH_CAPACITY  — 월 전체 근무 필요총량이 전 직원 월간 최대 근무
 *                           가능량(휴무 minimum + 연차/청원 제외)을 초과.
 *   GROUP_MONTH_CAPACITY  — 해당 조의 월 근무 필요총량이 그 조가 공급 가능한
 *                           최대치를 초과.
 *   CODE_MONTH_CAPACITY   — 해당 조/코드의 월 필요총량이 그 코드의 월간 상한
 *                           (직원별 limit 합산, 이미 고정된 사용량 차감)을 초과.
 *   DAY_HARD_ABSENCE      — 해당 날짜/조에서 연차/청원으로 인한 hard 결원 때문에
 *                           그날 필요 근무 인원 자체를 채울 사람이 부족.
 *   SEARCH_LIMIT          — 위 총량 검사로는 불가능이 증명되지 않음(수학적
 *                           기본조건은 충족) — 즉 현재 탐색(fallback+repair)이
 *                           못 찾았을 뿐일 가능성. "설정상 불가능"이라고 단정하지
 *                           않는다.
 *
 * ⚠️ TOTAL/GROUP/CODE 총량 검사는 필요조건(총량이 부족하면 100% 불가능)이지
 * 충분조건은 아니다 — 총량이 맞아도 날짜별/코드별 조합(bipartite matching)이
 * 안 맞으면 실제로는 안 풀릴 수 있다. 그런 "총량은 맞는데 조합이 안 맞는" 경우는
 * 이 진단이 증명할 수 없으므로 SEARCH_LIMIT으로 정직하게 분류한다("탐색기가
 * 못 찾음"만으로 절대 "설정상 불가능"이라고 단정하지 않는다는 원칙과 동일).
 */
function analyzeScheduleFeasibility(input, draft) {
    var year = input.year, month = input.month;
    var totalDays = _asDaysInMonth(year, month);
    var employees = _autoSortEmployees(input.employees || []);
    var groups = input.groups || {};
    var config = input.config || {};
    var autoConfig = input.autoConfig || {};
    var monthlyOffMinimum = _monthlyOffMinimum(autoConfig);
    var scheduleCodes = Array.isArray(config.scheduleCodes) ? config.scheduleCodes : [];
    var existingRequests = input.existingRequests || {};

    var groupByEmp = {};
    Object.keys(groups).forEach(function (g) { (groups[g] || []).forEach(function (uid) { groupByEmp[uid] = g; }); });
    employees.forEach(function (emp) { if (!groupByEmp[emp.uid] && emp.group) groupByEmp[emp.uid] = emp.group; });
    var employeesByGroup = {};
    employees.forEach(function (emp) {
        var g = groupByEmp[emp.uid];
        if (!g) return;
        (employeesByGroup[g] = employeesByGroup[g] || []).push(emp);
    });

    // 직원별 hard 고정 부재(연차+청원) 일수 — requested 데이터에서 직접 집계
    // (draft.grid가 아니라 원 신청 기준 — annual/petition은 절대 변경되지 않으므로 동일하다).
    function hardAbsenceCount(uid) {
        var days = existingRequests[uid] || {};
        var n = 0;
        Object.keys(days).forEach(function (d) {
            var t = days[d] && days[d].type;
            if (t === "annual" || t === "petition") n++;
        });
        return n;
    }
    // 직원별 월 최대 근무 가능일수 = 총일수 - 최소휴무 - 연차/청원(hard 결원, 중복없이 차감)
    function employeeMaxWork(uid) {
        return Math.max(0, totalDays - monthlyOffMinimum - hardAbsenceCount(uid));
    }
    // 직원별 특정 코드의 월간 총 용량 = limit(원본, 0포함) 그대로.
    //
    // ⚠️ Codex High #2 수정: required(=codeRequiredByGroup, 아래에서 _groupCodeQuota
    // 총합으로 계산 — day/group/code당 "필요한 총 슬롯 수"이며 requested/override/auto
    // 등 실제로 누가 채우는지와 무관한, 이미 그 자체로 "전체 수요" 총량이다)와
    // capacity를 반드시 같은 기준(전체 vs 전체)으로 비교해야 한다. 이전 버전은
    // required는 전체 수요인데 capacity에서는 requested/override로 이미 고정된
    // 사용량을 또 빼서(remaining capacity) "전체 수요 vs 잔여 공급"을 비교하는
    // 이중 차감 버그가 있었다(예: limit3, requested L 1건, required L 3이면
    // capacity=3-1=2로 계산돼 3>2로 오탐— 실제로는 day1 requested L +
    // day2/day3 auto L 2건 = 정확히 3/3으로 완전히 feasible한데도 PROVEN
    // infeasible로 잘못 분류됐다). "전체 수요 vs 전체 capacity"(limit 총합,
    // Option A) 방식으로 통일해 이 이중계산을 제거한다 — requested/override로
    // 이미 채워진 슬롯은 required 쪽에 이미 포함돼 있으므로 capacity에서
    // 별도로 다시 빼면 안 된다. auto(재배치 가능)는 애초에 capacity 계산에
    // 전혀 관여하지 않는다(이 함수는 grid를 읽지 않고 limit만 본다).
    function employeeCodeCapacity(uid, codeName) {
        var limit = _scheduleCodeMonthlyLimit(scheduleCodes, codeName);
        return limit == null ? Infinity : limit;
    }

    var totalMaxWork = 0;
    employees.forEach(function (emp) { totalMaxWork += employeeMaxWork(emp.uid); });

    var totalRequiredWork = 0;
    var groupRequiredWork = {}, groupMaxWork = {};
    var codeRequiredByGroup = {}, codeCapacityByGroup = {};
    Object.keys(employeesByGroup).forEach(function (group) {
        groupRequiredWork[group] = 0;
        groupMaxWork[group] = (employeesByGroup[group] || []).reduce(function (acc, e) { return acc + employeeMaxWork(e.uid); }, 0);
        codeRequiredByGroup[group] = {};
        codeCapacityByGroup[group] = {};
        scheduleCodes.forEach(function (c) {
            codeCapacityByGroup[group][c.name] = (employeesByGroup[group] || []).reduce(function (acc, e) { return acc + employeeCodeCapacity(e.uid, c.name); }, 0);
            codeRequiredByGroup[group][c.name] = 0;
        });
    });

    var dayGroupRequired = {}; // "day|group" -> total required work that day
    var dayGroupHardAvailable = {}; // "day|group" -> hard-available headcount that day

    for (var day = 1; day <= totalDays; day++) {
        Object.keys(employeesByGroup).forEach(function (group) {
            var members = employeesByGroup[group] || [];
            var dayReq = 0;
            scheduleCodes.forEach(function (c) {
                var quota = _groupCodeQuota(config, day, group, c.name);
                if (quota == null) return;
                totalRequiredWork += quota;
                groupRequiredWork[group] += quota;
                codeRequiredByGroup[group][c.name] += quota;
                dayReq += quota;
            });
            dayGroupRequired[day + "|" + group] = dayReq;

            var hardAbsentToday = members.reduce(function (acc, e) {
                var entry = (existingRequests[e.uid] || {})[String(day)];
                var t = entry && entry.type;
                return acc + ((t === "annual" || t === "petition") ? 1 : 0);
            }, 0);
            dayGroupHardAvailable[day + "|" + group] = members.length - hardAbsentToday;
        });
    }

    var results = [];
    (draft.conflicts || []).forEach(function (c) {
        if (c.kind !== "work_shortfall" || c.day == null) return;
        var reason = "SEARCH_LIMIT";
        var detail = "총량 검사상 수학적 기본조건은 충족합니다 — 현재 탐색이 대체 배정을 찾지 못했을 뿐일 수 있습니다.";

        if (totalRequiredWork > totalMaxWork) {
            reason = "TOTAL_MONTH_CAPACITY";
            detail = "월 전체 필요근무(" + totalRequiredWork + ")가 전 직원 월간 최대 근무가능(" + totalMaxWork + ")을 초과합니다.";
        } else if (groupRequiredWork[c.group] > groupMaxWork[c.group]) {
            reason = "GROUP_MONTH_CAPACITY";
            detail = c.group + "조 월 필요근무(" + groupRequiredWork[c.group] + ")가 " + c.group + "조 월 최대 근무가능(" + groupMaxWork[c.group] + ")을 초과합니다.";
        } else if (codeRequiredByGroup[c.group] && codeRequiredByGroup[c.group][c.scheduleCode] > codeCapacityByGroup[c.group][c.scheduleCode]) {
            reason = "CODE_MONTH_CAPACITY";
            detail = c.group + "조 " + c.scheduleCode + "코드 월 필요총량(" + codeRequiredByGroup[c.group][c.scheduleCode] + ")이 월간 상한 기준 공급 가능량(" + codeCapacityByGroup[c.group][c.scheduleCode] + ")을 초과합니다.";
        } else {
            var dgKey = c.day + "|" + c.group;
            if (dayGroupRequired[dgKey] > dayGroupHardAvailable[dgKey]) {
                reason = "DAY_HARD_ABSENCE";
                detail = c.day + "일 " + c.group + "조 필요근무(" + dayGroupRequired[dgKey] + ")가 연차/청원 제외 가용 인원(" + dayGroupHardAvailable[dgKey] + ")을 초과합니다.";
            }
        }

        results.push({
            day: c.day, group: c.group, scheduleCode: c.scheduleCode,
            needed: c.needed, available: c.available,
            reason: reason, detail: detail,
        });
    });

    return {
        totalRequiredWork: totalRequiredWork, totalMaxWork: totalMaxWork,
        groupRequiredWork: groupRequiredWork, groupMaxWork: groupMaxWork,
        codeRequiredByGroup: codeRequiredByGroup, codeCapacityByGroup: codeCapacityByGroup,
        diagnostics: results,
    };
}

// ═══════════════════════════════════════════════════════════════════════════
// 6) 조건 재검사 (사용자 spec의 14개 항목)
// ═══════════════════════════════════════════════════════════════════════════

function revalidateDraft(draft, input) {
    var checks = [];
    var warnings = [];
    function push(name, ok, detail) { checks.push({ name: name, ok: !!ok, detail: detail || "" }); }

    var employees = input.employees || [];
    var groups = input.groups || {};
    var config = input.config || {};
    var autoConfig = input.autoConfig || {};
    var monthlyOffMinimum = _monthlyOffMinimum(autoConfig);
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

    // 5) 직원별 월 일반휴무 — 최소(hard)/권장(soft warning) 분리.
    var offMinimumViolations = [];
    var offTargetShortfalls = [];
    var monthlyOffTargetNum = Number(autoConfig.monthlyOffTarget || 0);
    employees.forEach(function (emp) {
        var count = 0;
        for (var d = 1; d <= totalDays; d++) {
            var e = (grid[emp.uid] || {})[String(d)];
            if (e && e.type === "normal") count++;
        }
        if (count < monthlyOffMinimum) {
            offMinimumViolations.push(emp.name + " " + count + "/" + monthlyOffMinimum);
        } else if (count < monthlyOffTargetNum) {
            offTargetShortfalls.push({ empKey: emp.uid, empName: emp.name, actual: count, needed: monthlyOffTargetNum });
        }
    });
    push("최소 월 일반휴무 준수", offMinimumViolations.length === 0, offMinimumViolations.join(", "));
    if (offTargetShortfalls.length) {
        warnings.push({
            kind: "monthly_off_target_shortfall_summary",
            employees: offTargetShortfalls,
            message: "권장 월 일반휴무(" + monthlyOffTargetNum + ") 미달: " + offTargetShortfalls.map(function (e) { return e.empName + " " + e.actual + "일"; }).join(", "),
        });
    }

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

    // 14) 월 최소 휴무 미달 없음 (5번과 동일 기준 재확인 — 실패 목록만 별도 표기)
    push("월 최소 일반휴무 미달 없음", offMinimumViolations.length === 0, offMinimumViolations.join(", "));

    // 15) 직원별 월 근무코드 제한 준수 — requested/auto/override 합산 최종 배정 기준.
    var codeLimitViolations = [];
    employees.forEach(function (emp) {
        var counts = {};
        for (var d5 = 1; d5 <= totalDays; d5++) {
            var e5 = (grid[emp.uid] || {})[String(d5)];
            if (e5 && e5.type === "schedule" && e5.scheduleCode) counts[e5.scheduleCode] = (counts[e5.scheduleCode] || 0) + 1;
        }
        Object.keys(counts).forEach(function (codeName) {
            var limit = _scheduleCodeMonthlyLimit(scheduleCodes, codeName);
            if (limit != null && counts[codeName] > limit) {
                codeLimitViolations.push(emp.name + " " + codeName + " " + counts[codeName] + "/" + limit);
            }
        });
    });
    push("직원별 월 근무코드 제한 준수", codeLimitViolations.length === 0, codeLimitViolations.join(", "));

    var allPassed = checks.every(function (c) { return c.ok; });
    return { passed: allPassed, checks: checks, warnings: warnings };
}

return {
    AUTO_SCHEDULE_MAX_ITERATIONS: AUTO_SCHEDULE_MAX_ITERATIONS,
    buildFixedGrid: buildFixedGrid,
    consecutiveWorkStreakAt: consecutiveWorkStreakAt,
    isCodeLinkForbidden: isCodeLinkForbidden,
    _prevCodeAt: _prevCodeAt,
    _groupCodeQuota: _groupCodeQuota,
    _scheduleCodeMonthlyLimit: _scheduleCodeMonthlyLimit,
    _employeeScheduleCodeCount: _employeeScheduleCodeCount,
    _monthlyOffMinimum: _monthlyOffMinimum,
    _aggregateConflicts: _aggregateConflicts,
    generateDraft: generateDraft,
    findOverrideCandidates: findOverrideCandidates,
    applyOverride: applyOverride,
    revalidateDraft: revalidateDraft,
    planBulkOverrides: planBulkOverrides,
    analyzeScheduleFeasibility: analyzeScheduleFeasibility,
    _autoSortEmployees: _autoSortEmployees,
    _fallbackBacktrack: _fallbackBacktrack,
    _repairWorkShortfalls: _repairWorkShortfalls,
    _computeCodeGaps: _computeCodeGaps,
    _isIsolatedWorkDay: _isIsolatedWorkDay,
    _countIsolatedWorkDays: _countIsolatedWorkDays,
    _collectWorkBlocks: _collectWorkBlocks,
    _computeGroupCodeFairness: _computeGroupCodeFairness,
    _optimizeScheduleQuality: _optimizeScheduleQuality,
    AUTO_SCHEDULE_QUALITY_MAX_ITERATIONS: AUTO_SCHEDULE_QUALITY_MAX_ITERATIONS,
    AUTO_SCHEDULE_QUALITY_MAX_PASSES: AUTO_SCHEDULE_QUALITY_MAX_PASSES,
    AUTO_SCHEDULE_FALLBACK_WINDOW: AUTO_SCHEDULE_FALLBACK_WINDOW,
    AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS: AUTO_SCHEDULE_FALLBACK_MAX_ITERATIONS,
    AUTO_SCHEDULE_BULK_MAX_ITERATIONS: AUTO_SCHEDULE_BULK_MAX_ITERATIONS,
    AUTO_SCHEDULE_BULK_TIME_BUDGET_MS: AUTO_SCHEDULE_BULK_TIME_BUDGET_MS,
    AUTO_SCHEDULE_REPAIR_MAX_ITERATIONS: AUTO_SCHEDULE_REPAIR_MAX_ITERATIONS,
    AUTO_SCHEDULE_REPAIR_TIME_BUDGET_MS: AUTO_SCHEDULE_REPAIR_TIME_BUDGET_MS,
};

})();

if (typeof module === "object" && module.exports) {
    module.exports = AutoScheduleEngine;
}
