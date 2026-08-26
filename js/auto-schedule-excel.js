/**
 * auto-schedule-excel.js — 자동 스케줄링 결과를 Excel 3개 시트로 내보낸다.
 * 기존 vendored SheetJS(vendor/xlsx.full.min.js, XLSX 전역)만 사용 — 새 라이브러리 추가 없음.
 * js/excel.js의 exportToExcel() 과 동일한 API 사용 패턴(XLSX.utils.aoa_to_sheet,
 * book_new, book_append_sheet, writeFile)을 그대로 재사용한다.
 */

var AUTO_SCHEDULE_CODE_LABEL = { normal: "휴", annual: "연", petition: "청" };

/** 그리드 한 칸의 표시 문자열(월간스케줄 시트용). */
function _autoScheduleCellLabel(entry) {
    if (!entry) return "";
    if (entry.type === "schedule") return entry.scheduleCode || "";
    return AUTO_SCHEDULE_CODE_LABEL[entry.type] || "";
}

/**
 * exportAutoScheduleToExcel(draft, employees, groupByEmp, revalidation, filenamePrefix, meta, previousMonthWorkTail)
 * draft: auto-schedule-engine.generateDraft()의 결과 (grid/totalDays)
 * employees: [{uid, empNo, name, group?, sortOrder}]
 * groupByEmp: { [uid]: "A" } — 표시용 조 라벨(입력에 없으면 employee.group 사용)
 * revalidation: auto-schedule-engine.revalidateDraft()의 결과({passed, checks})
 * meta(선택): { confirmedAt, confirmedBy, yyyymm, previousMonthWarning } — 확정본이면
 *             월간스케줄 시트 상단에 확정일시/확정자/대상월을 추가로 표시한다(기존
 *             컬럼 구조는 그대로 유지 — 헤더 행 "위에" 정보 행만 덧붙인다).
 * previousMonthWorkTail(선택): { [uid]: number } — 편성 품질(1일 고립근무) 계산 시
 *             day1의 "전날" 판정에 사용(엔진의 isolated work 정의와 동일 semantics).
 *             없으면 0(전월 정보 없음)으로 취급.
 */
function exportAutoScheduleToExcel(draft, employees, groupByEmp, revalidation, filenamePrefix, meta, previousMonthWorkTail) {
    var totalDays = draft.totalDays;
    var grid = draft.grid;
    groupByEmp = groupByEmp || {};
    previousMonthWorkTail = previousMonthWorkTail || {};
    // 편성 품질 진단(A/P/L 횟수, 1일 고립근무수)은 UI/revalidate와 동일한 엔진
    // helper(AutoScheduleEngine._isIsolatedWorkDay)를 그대로 재사용한다 — Excel이
    // 별도 판정 기준을 만들면 카운트가 어긋날 수 있으므로(과거 legacy-type
    // undercount 조사에서 확인한 "predicate 불일치" 문제를 반복하지 않기 위함).
    var Engine = (typeof AutoScheduleEngine !== "undefined") ? AutoScheduleEngine : null;

    // ── Sheet 1: 월간스케줄 ──────────────────────────────────────────────────
    var header1 = ["이름", "조"];
    for (var d = 1; d <= totalDays; d++) header1.push(String(d));
    header1.push("휴무수", "연차", "청원", "A횟수", "P횟수", "L횟수", "1일근무수");

    var rows1 = [];
    if (meta && (meta.confirmedAt || meta.confirmedBy || meta.yyyymm)) {
        rows1.push(["대상월", meta.yyyymm || ""]);
        rows1.push(["확정일시", meta.confirmedAt ? new Date(meta.confirmedAt).toLocaleString() : ""]);
        rows1.push(["확정자", meta.confirmedBy || ""]);
        rows1.push([]);
    }
    rows1.push(header1);
    employees.forEach(function (emp) {
        var row = [emp.name || emp.empNo || emp.uid, groupByEmp[emp.uid] || emp.group || ""];
        var offCount = 0, annualCount = 0, petitionCount = 0, aCount = 0, pCount = 0, lCount = 0, isolatedCount = 0;
        for (var day = 1; day <= totalDays; day++) {
            var entry = (grid[emp.uid] || {})[String(day)];
            row.push(_autoScheduleCellLabel(entry));
            if (entry) {
                if (entry.type === "normal") offCount++;
                else if (entry.type === "annual") annualCount++;
                else if (entry.type === "petition") petitionCount++;
                else if (entry.type === "schedule") {
                    if (entry.scheduleCode === "A") aCount++;
                    else if (entry.scheduleCode === "P") pCount++;
                    else if (entry.scheduleCode === "L") lCount++;
                }
            }
            if (Engine && Engine._isIsolatedWorkDay(grid, emp.uid, day, totalDays, previousMonthWorkTail)) isolatedCount++;
        }
        row.push(offCount, annualCount, petitionCount, aCount, pCount, lCount, isolatedCount);
        rows1.push(row);
    });

    var ws1 = XLSX.utils.aoa_to_sheet(rows1);
    ws1["!cols"] = [{ wch: 12 }, { wch: 6 }]
        .concat(Array(totalDays).fill({ wch: 5 }))
        .concat([{ wch: 8 }, { wch: 6 }, { wch: 6 }, { wch: 7 }, { wch: 7 }, { wch: 7 }, { wch: 9 }]);

    // ── Sheet 2: 조정내역 ────────────────────────────────────────────────────
    var rows2 = [["이름", "조", "날짜", "원 신청", "최종 배정", "조정 사유"]];
    var empByUid = {};
    employees.forEach(function (emp) { empByUid[emp.uid] = emp; });
    Object.keys(grid).forEach(function (uid) {
        var emp = empByUid[uid] || { name: uid };
        Object.keys(grid[uid]).forEach(function (day) {
            var entry = grid[uid][day];
            if (entry.source !== "override") return;
            var originalLabel = AUTO_SCHEDULE_CODE_LABEL[entry.originalRequest && entry.originalRequest.type] || (entry.originalRequest && entry.originalRequest.type) || "";
            rows2.push([
                emp.name || emp.empNo || uid,
                groupByEmp[uid] || emp.group || "",
                Number(day),
                originalLabel,
                entry.scheduleCode || AUTO_SCHEDULE_CODE_LABEL[entry.type] || entry.type,
                (entry.override && entry.override.reason) || "",
            ]);
        });
    });
    var ws2 = XLSX.utils.aoa_to_sheet(rows2);
    ws2["!cols"] = [{ wch: 12 }, { wch: 6 }, { wch: 6 }, { wch: 10 }, { wch: 10 }, { wch: 22 }];

    // ── Sheet 3: 조건검사결과 ────────────────────────────────────────────────
    var rows3 = [["검사항목", "결과", "비고"]];
    (revalidation && revalidation.checks ? revalidation.checks : []).forEach(function (check) {
        rows3.push([check.name, check.ok ? "정상" : "실패", check.ok ? "" : check.detail]);
    });
    // 권장 월 일반휴무 미달은 hard FAIL이 아니라 "참고"(soft warning) — 최소 휴무만
    // 충족하면 확정 가능한 상태이므로 "실패"로 표시하지 않는다.
    (revalidation && revalidation.warnings ? revalidation.warnings : []).forEach(function (w) {
        rows3.push(["권장 월 일반휴무 달성 현황", "참고", w.message || ""]);
    });
    if (meta && meta.previousMonthWarning) {
        rows3.push(["전월 연속근무 데이터", "참고", meta.previousMonthWarning]);
    }
    var ws3 = XLSX.utils.aoa_to_sheet(rows3);
    ws3["!cols"] = [{ wch: 30 }, { wch: 8 }, { wch: 50 }];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws1, "월간스케줄");
    XLSX.utils.book_append_sheet(wb, ws2, "조정내역");
    XLSX.utils.book_append_sheet(wb, ws3, "조건검사결과");

    XLSX.writeFile(wb, (filenamePrefix || "자동스케줄") + ".xlsx");
}

if (typeof module === "object" && module.exports) {
    module.exports = { exportAutoScheduleToExcel: exportAutoScheduleToExcel, _autoScheduleCellLabel: _autoScheduleCellLabel };
}
