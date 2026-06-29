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
