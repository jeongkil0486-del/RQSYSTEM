function downloadExcelTemplate() {
    if (!isAdmin && !isSuperAdmin) return;

    var deptSelect = document.getElementById("superDeptSelect");
    var selectedDept = deptSelect ? String(deptSelect.value || "").trim() : "";
    var sampleDept = selectedDept || "CJJ";

    var rows = [
        ["이름", "사번", "지점", "권한", "임시비밀번호", "이메일"],
        ["홍길동", "1001", sampleDept, "staff", "Temp1234!", ""],
        ["관리자샘플", "9001", sampleDept, "admin", "Temp1234!", ""]
    ];

    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [
        { wch: 14 },
        { wch: 12 },
        { wch: 12 },
        { wch: 10 },
        { wch: 18 },
        { wch: 28 }
    ];

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "직원등록양식");
    XLSX.writeFile(wb, "Trinity_AirService_직원등록_양식.xlsx");
}

// ── 직원 일괄삭제 양식 엑셀 다운로드 ────────────────────────────────────────────
// 컬럼: 사번(필수) | 이름(선택) | 지점(선택)
// 사번 열만 채워서 업로드해도 삭제 처리됩니다.
function downloadBulkDeleteTemplate() {
    var rows = [
        ["사번", "이름(선택)", "지점(선택)"],
        ["100001", "홍길동", "서울"],
        ["100002", "김철수", "부산"]
    ];

    var ws = XLSX.utils.aoa_to_sheet(rows);
    ws["!cols"] = [{ wch: 14 }, { wch: 14 }, { wch: 14 }];

    // 헤더 행에 배경색 표시 (삭제 작업임을 인식)
    ws["A1"].s = { fill: { fgColor: { rgb: "FFCCCC" } }, font: { bold: true } };
    ws["B1"].s = { fill: { fgColor: { rgb: "FFCCCC" } }, font: { bold: true } };
    ws["C1"].s = { fill: { fgColor: { rgb: "FFCCCC" } }, font: { bold: true } };

    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "일괄삭제양식");
    XLSX.writeFile(wb, "Trinity_AirService_직원삭제_양식.xlsx");
}
