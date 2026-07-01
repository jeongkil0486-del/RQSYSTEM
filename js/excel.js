/**
 * excel.js — 엑셀 업로드 / 다운로드
 *
 * 업로드: 필수 컬럼 [이름, 사번, 지점, 권한, 임시비밀번호]
 *         선택 컬럼: 이메일(recoveryEmail 로만 저장 — 화면 미노출)
 *
 * 모든 계정 생성은 fn.bulkCreateEmployees (Cloud Function) 을 통합니다.
 */

// ── 엑셀 내보내기 (관리자 — 현재 데이터 다운로드) ────────────────────────────
function exportToExcel() {
    if (!isAdmin && !isSuperAdmin) return;
    var tm        = getTargetYearMonth();
    var totalDays = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
    var suffix    = "_" + tm.fullStr + "_";
    var scList    = getScheduleCodeList();

    var headerRow = ["직원 이름"];
    for (var d = 1; d <= totalDays; d++) headerRow.push(d + "일");

    var excelData = [headerRow];
    deptEmployees.forEach(function(emp) {
        var userName = emp.name;
        var userRow = [userName];
        for (var d = 1; d <= totalDays; d++) {
            var pref = "rq_" + userName + suffix;
            if (liveDBData[pref + d] !== undefined)                    { userRow.push("휴"); continue; }
            if (liveDBData[pref + d + "_petition"] !== undefined)      { userRow.push("청"); continue; }
            if (liveDBData[pref + d + "_annual"] !== undefined)        { userRow.push("연"); continue; }
            var foundCode = "";
            for (var si = 0; si < scList.length; si++) {
                if (liveDBData["sc_" + scList[si].name + "_" + userName + suffix + d] !== undefined) {
                    foundCode = scList[si].name; break;
                }
            }
            userRow.push(foundCode);
        }
        excelData.push(userRow);
    });

    var ws = XLSX.utils.aoa_to_sheet(excelData);
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, tm.year + "년 " + parseInt(tm.month) + "월 마감");
    ws["!cols"] = [{ wch: 12 }].concat(Array(totalDays).fill({ wch: 8 }));
    XLSX.writeFile(wb, "Trinity_AirService_" + currentDept + "_" + tm.fullStr + ".xlsx");
}

// ── 엑셀 일괄 등록 ────────────────────────────────────────────────────────────
// 필수 컬럼: 이름 | 사번 | 지점 | 권한 | 임시비밀번호
// 선택 컬럼: 이메일  (recoveryEmail 로 저장 — 화면에 표시 X)

function handleBulkExcelUpload() {
    if (!isAdmin && !isSuperAdmin) return;
    var fileInput = document.getElementById("bulkEmpExcelUpload");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) {
        alert("엑셀 파일을 선택해주세요.");
        return;
    }
    var file = fileInput.files[0];
    var reader = new FileReader();

    reader.onload = function(e) {
        try {
            var wb   = XLSX.read(e.target.result, { type: "binary" });
            var ws   = wb.Sheets[wb.SheetNames[0]];
            var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

            if (rows.length < 2) { alert("데이터 행이 없습니다."); return; }

            var header = rows[0].map(function(h) { return String(h).trim(); });
            var colMap = {};
            var REQUIRED = ["이름", "사번", "지점", "권한", "임시비밀번호"];

            header.forEach(function(h, i) { colMap[h] = i; });

            var missing = REQUIRED.filter(function(r) { return colMap[r] === undefined; });
            if (missing.length > 0) {
                alert("필수 컬럼 누락: " + missing.join(", ") + "\n\n필수 컬럼: 이름 / 사번 / 지점 / 권한 / 임시비밀번호");
                return;
            }

            var employeeRows = [];
            for (var i = 1; i < rows.length; i++) {
                var row = rows[i];
                var name  = String(row[colMap["이름"]]  || "").trim();
                var empNo = String(row[colMap["사번"]]  || "").trim();
                var dept  = String(row[colMap["지점"]]  || "").trim();
                var role  = String(row[colMap["권한"]]  || "").trim();
                var pass  = String(row[colMap["임시비밀번호"]] || "").trim();

                if (!name || !empNo || !dept || !role || !pass) continue;

                var entry = {
                        name: name, empNo: empNo, deptId: dept, role: role, tempPassword: pass,
                        sortOrder: i   // 엑셀 A2=1, A3=2, A4=3 … 순서 그대로 보존
                    };

                if (colMap["이메일"] !== undefined) {
                    var recoveryEmail = String(row[colMap["이메일"]] || "").trim();
                    if (recoveryEmail) entry.recoveryEmail = recoveryEmail;
                }

                employeeRows.push(entry);
            }

            if (employeeRows.length === 0) { alert("유효한 데이터 행이 없습니다."); return; }

            if (!confirm(employeeRows.length + "명을 일괄 등록하시겠습니까?")) return;

            var authUser = auth && auth.currentUser ? auth.currentUser : null;
            console.log("bulkCreateEmployees currentUser:", authUser ? {
                uid: authUser.uid,
                email: authUser.email || null
            } : null);

            if (!authUser) {
                alert("로그인 세션이 없습니다. 다시 로그인 후 시도해주세요.");
                return;
            }

            authUser.getIdToken()
              .then(function(token) {
                  console.log("bulkCreateEmployees idToken issued:", !!token, token ? token.length : 0);
                  return fn.bulkCreateEmployees({ rows: employeeRows });
              })
              .then(function(result) {
                  var results  = result.data.results || [];
                  var success  = results.filter(function(r) { return r.ok; }).length;
                  var failures = results.filter(function(r) { return !r.ok; });

                  var msg = "✅ 성공: " + success + "명\n";
                  if (failures.length > 0) {
                      msg += "❌ 실패: " + failures.length + "명\n\n";
                      failures.slice(0, 10).forEach(function(f) {
                          msg += "  사번 " + f.empNo + ": " + f.error + "\n";
                      });
                      if (failures.length > 10) msg += "  ... 외 " + (failures.length - 10) + "건";
                  }
                  alert(msg);
                  if (fileInput) fileInput.value = "";
              })
              .catch(function(e) { alert(e.message || "일괄 등록 실패"); });

        } catch (err) {
            alert("파일 파싱 오류: " + (err.message || err));
        }
    };

    reader.readAsBinaryString(file);
}

// ── 연차 엑셀 업로드 (기존 기능 유지 — 서버 저장으로 전환 필요) ───────────────
// 현재는 알림만 표시. 연차 할당량 저장은 fn.setUserLimit 을 사용하세요.
function handleAnnualExcelUpload() {
    if (!isAdmin && !isSuperAdmin) return;
    alert("연차 할당량 엑셀 업로드 기능은 현재 Cloud Functions 연동 준비 중입니다.\n개인별 연차 한도는 관리자 콘솔 > 직원별 한도 설정 메뉴를 사용해주세요.");
}
