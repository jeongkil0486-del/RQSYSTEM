/**
 * super-admin.js
 * Super admin only panels and actions.
 */

function openSuperResetModal() {
    var modal = document.getElementById("superResetChoiceModal");
    if (modal) modal.style.display = "flex";
}

function executeSuperReset() {
    closeSuperResetModal();
}

function drawSuperResetPanel() {
    var container = document.getElementById("superResetPanelContent");
    if (!container) return;

    container.innerHTML = ""
        + "<div style='display:flex;flex-wrap:wrap;gap:10px;align-items:center;'>"
        + "<label style='font-weight:bold;min-width:92px;'>사번/관리자ID</label>"
        + "<input type='text' id='superResetEmpNo' placeholder='사번 또는 관리자ID' style='width:160px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<label style='font-weight:bold;min-width:72px;'>새 비밀번호</label>"
        + "<input type='password' id='superResetPassword' placeholder='6자 이상' style='width:150px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<button type='button' onclick='performSuperAdminPasswordReset()' style='background:#e65100;color:#fff;border:none;border-radius:6px;padding:9px 16px;font-weight:bold;cursor:pointer;'>비밀번호 초기화</button>"
        + "</div>"
        + "<div style='font-size:12px;color:#666;margin-top:10px;line-height:1.6;'>직원/관리자 계정 모두 초기화할 수 있습니다. 새 비밀번호는 6자 이상이어야 합니다.</div>";
}

function drawSuperDeletePanel() {
    var container = document.getElementById("superDeletePanelContent");
    if (!container) return;

    container.innerHTML = ""
        // ── 단건 삭제 (기존 기능 유지) ──
        + "<div style='margin-bottom:18px;'>"
        + "<div style='font-weight:bold;font-size:13px;margin-bottom:8px;color:#555;'>단건 삭제</div>"
        + "<div style='display:flex;flex-wrap:wrap;gap:10px;align-items:center;'>"
        + "<label style='font-weight:bold;min-width:92px;'>삭제할 사번</label>"
        + "<input type='text' id='superDeleteEmpNo' placeholder='사번 입력' style='width:160px;padding:8px;border:1px solid #ccc;border-radius:6px;'>"
        + "<button type='button' onclick='performSuperAdminDeleteEmployee()' style='background:#c62828;color:#fff;border:none;border-radius:6px;padding:9px 16px;font-weight:bold;cursor:pointer;'>직원 삭제</button>"
        + "</div>"
        + "<div style='font-size:12px;color:#888;margin-top:6px;'>SA001 및 관리자/슈퍼관리자 계정은 삭제할 수 없습니다.</div>"
        + "</div>"
        // ── 구분선 ──
        + "<hr style='border:none;border-top:1px solid #eee;margin:12px 0;'>"
        // ── 일괄 삭제 ──
        + "<div>"
        + "<div style='font-weight:bold;font-size:13px;margin-bottom:8px;color:#555;'>일괄 삭제 <span style=\"font-size:11px;font-weight:normal;color:#999;\">(엑셀 업로드)</span></div>"
        + "<div style='display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-bottom:10px;'>"
        + "<button type='button' onclick='downloadBulkDeleteTemplate()' style='background:#eff6ff;color:#1d4ed8;border:1px solid #bfdbfe;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:bold;cursor:pointer;'>📥 삭제 양식 다운로드</button>"
        + "<input type='file' id='bulkDeleteExcelInput' accept='.xlsx,.xls' style='display:none;' onchange='handleBulkDeleteExcelUpload()'>"
        + "<button type='button' onclick='document.getElementById(\"bulkDeleteExcelInput\").click()' style='background:#fef2f2;color:#c62828;border:1px solid #fca5a5;border-radius:6px;padding:8px 14px;font-size:12px;font-weight:bold;cursor:pointer;'>📤 삭제 목록 업로드</button>"
        + "</div>"
        + "<div style='font-size:12px;color:#888;margin-bottom:10px;line-height:1.5;'>"
        + "① 양식 다운로드 → ② 사번 입력 → ③ 업로드 → ④ 미리보기 확인 → ⑤ 최종 삭제 실행<br>"
        + "사번 열만 필수, 이름·지점은 참고용입니다. 관리자/슈퍼관리자 계정은 서버에서 자동 차단됩니다."
        + "</div>"
        + "<div id='bulkDeletePreview'></div>"
        + "</div>";
}

// ── 일괄삭제 엑셀 파싱 → 미리보기 표시 ────────────────────────────────────────
function handleBulkDeleteExcelUpload() {
    var fileInput = document.getElementById("bulkDeleteExcelInput");
    if (!fileInput || !fileInput.files || !fileInput.files[0]) return;
    var file = fileInput.files[0];
    var reader = new FileReader();

    reader.onload = function(e) {
        try {
            var wb   = XLSX.read(e.target.result, { type: "binary" });
            var ws   = wb.Sheets[wb.SheetNames[0]];
            var rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: "" });

            if (rows.length < 2) { alert("데이터 행이 없습니다."); return; }

            var header = rows[0].map(function(h) { return String(h).trim(); });
            var colEmpNo = header.indexOf("사번");
            var colName  = header.indexOf("이름(선택)");
            var colDept  = header.indexOf("지점(선택)");

            // "이름", "이름(선택)" 둘 다 허용
            if (colName < 0) colName = header.indexOf("이름");
            if (colDept < 0) colDept = header.indexOf("지점");

            if (colEmpNo < 0) {
                alert("'사번' 컬럼을 찾을 수 없습니다.\n다운로드한 양식을 사용해주세요.");
                return;
            }

            var parsed = [];
            var myEmpNo = currentProfile && currentProfile.empNo ? String(currentProfile.empNo).trim().toLowerCase() : "";

            for (var i = 1; i < rows.length; i++) {
                var row   = rows[i];
                var empNo = String(row[colEmpNo] || "").trim().toLowerCase();
                if (!empNo) continue;

                var name  = colName  >= 0 ? String(row[colName]  || "").trim() : "";
                var dept  = colDept  >= 0 ? String(row[colDept]  || "").trim() : "";

                // 클라이언트 사전 검증 (서버에서도 동일하게 강제됨)
                var canDelete = true;
                var reason = "";

                if (empNo === "sa001") {
                    canDelete = false; reason = "기본 슈퍼관리자 계정";
                } else if (myEmpNo && empNo === myEmpNo) {
                    canDelete = false; reason = "현재 로그인 계정";
                } else {
                    // 로컬 employeeByEmpNo에서 role 확인 (있는 경우)
                    var localEmp = employeeByEmpNo[empNo];
                    if (localEmp) {
                        var role = String(localEmp.role || "").toLowerCase();
                        if (role === "admin" || role === "super_admin") {
                            canDelete = false;
                            reason = "관리자 계정 삭제 불가 (role: " + role + ")";
                        }
                        // 이름/지점 정보를 DB 기준으로 보완
                        if (!name)  name  = localEmp.name  || "";
                        if (!dept)  dept  = localEmp.deptId || dept;
                    }
                }

                parsed.push({ empNo: empNo, name: name, deptId: dept, canDelete: canDelete, reason: reason });
            }

            if (parsed.length === 0) { alert("유효한 사번이 없습니다."); return; }

            _renderBulkDeletePreview(parsed);
        } catch (err) {
            alert("파일 파싱 오류: " + (err.message || err));
        }
    };
    reader.readAsBinaryString(file);
}

// ── 미리보기 렌더링 ────────────────────────────────────────────────────────────
function _renderBulkDeletePreview(parsed) {
    var preview = document.getElementById("bulkDeletePreview");
    if (!preview) return;

    var canDeleteList = parsed.filter(function(r) { return r.canDelete; });
    var blockedList   = parsed.filter(function(r) { return !r.canDelete; });

    var html = "<div style='background:#fff8f8;border:1px solid #fca5a5;border-radius:8px;padding:14px;'>"
             + "<div style='font-weight:bold;font-size:13px;color:#c62828;margin-bottom:10px;'>"
             + "⚠️ 삭제 미리보기 — 총 " + parsed.length + "건 (삭제 가능: " + canDeleteList.length + "건 / 차단: " + blockedList.length + "건)"
             + "</div>"
             + "<table style='width:100%;border-collapse:collapse;font-size:12px;'>"
             + "<thead><tr style='background:#fee2e2;'>"
             + "<th style='padding:6px 8px;text-align:left;border-bottom:1px solid #fca5a5;'>사번</th>"
             + "<th style='padding:6px 8px;text-align:left;border-bottom:1px solid #fca5a5;'>이름</th>"
             + "<th style='padding:6px 8px;text-align:left;border-bottom:1px solid #fca5a5;'>지점</th>"
             + "<th style='padding:6px 8px;text-align:left;border-bottom:1px solid #fca5a5;'>상태</th>"
             + "</tr></thead><tbody>";

    parsed.forEach(function(row) {
        var statusHtml = row.canDelete
            ? "<span style='color:#15803d;font-weight:bold;'>✅ 삭제 가능</span>"
            : "<span style='color:#c62828;font-weight:bold;'>🚫 차단 — " + row.reason + "</span>";
        var rowBg = row.canDelete ? "" : "background:#fff1f2;";
        html += "<tr style='" + rowBg + "'>"
              + "<td style='padding:5px 8px;border-bottom:1px solid #fee2e2;font-weight:bold;'>" + _esc(row.empNo) + "</td>"
              + "<td style='padding:5px 8px;border-bottom:1px solid #fee2e2;'>" + _esc(row.name || "—") + "</td>"
              + "<td style='padding:5px 8px;border-bottom:1px solid #fee2e2;'>" + _esc(row.deptId || "—") + "</td>"
              + "<td style='padding:5px 8px;border-bottom:1px solid #fee2e2;'>" + statusHtml + "</td>"
              + "</tr>";
    });

    html += "</tbody></table>";

    if (canDeleteList.length > 0) {
        html += "<div style='margin-top:12px;display:flex;justify-content:flex-end;'>"
              + "<button type='button' onclick='executeBulkDelete()' style='background:#c62828;color:#fff;border:none;border-radius:6px;padding:10px 22px;font-weight:bold;font-size:13px;cursor:pointer;'>🗑️ " + canDeleteList.length + "명 최종 삭제 실행</button>"
              + "</div>";
    } else {
        html += "<div style='margin-top:10px;color:#c62828;font-size:12px;'>삭제 가능한 계정이 없습니다. 목록을 확인해주세요.</div>";
    }

    html += "</div>";
    preview.innerHTML = html;

    // 미리보기 데이터 저장 (최종 실행 시 재사용)
    preview._bulkDeleteData = parsed;
}

// HTML 이스케이프 (XSS 방지)
function _esc(str) {
    return String(str || "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
}

// ── 최종 삭제 실행 ─────────────────────────────────────────────────────────────
function executeBulkDelete() {
    if (!isSuperAdmin) return;

    var preview = document.getElementById("bulkDeletePreview");
    if (!preview || !preview._bulkDeleteData) { alert("미리보기 데이터가 없습니다."); return; }

    var parsed = preview._bulkDeleteData;
    var canDeleteList = parsed.filter(function(r) { return r.canDelete; });

    if (canDeleteList.length === 0) { alert("삭제 가능한 계정이 없습니다."); return; }

    if (!confirm(canDeleteList.length + "명을 영구 삭제하시겠습니까?\n이 작업은 되돌릴 수 없습니다.\n\n삭제 대상:\n" +
        canDeleteList.slice(0, 10).map(function(r) { return "  " + r.empNo + (r.name ? " (" + r.name + ")" : ""); }).join("\n") +
        (canDeleteList.length > 10 ? "\n  ... 외 " + (canDeleteList.length - 10) + "명" : "")
    )) return;

    var empNos = canDeleteList.map(function(r) { return r.empNo; });

    fn.bulkDeleteEmployees({ empNos: empNos })
        .then(function(result) {
            var results  = (result.data && result.data.results) || [];
            var success  = results.filter(function(r) { return r.ok; });
            var failures = results.filter(function(r) { return !r.ok; });

            var msg = "✅ 삭제 완료: " + success.length + "명\n";
            if (failures.length > 0) {
                msg += "❌ 실패: " + failures.length + "명\n\n";
                failures.slice(0, 10).forEach(function(f) {
                    msg += "  사번 " + f.empNo + ": " + f.error + "\n";
                });
                if (failures.length > 10) msg += "  ... 외 " + (failures.length - 10) + "건";
            }
            alert(msg);

            // 로컬 상태 갱신 — 삭제된 직원 제거
            var deletedEmpNos = success.map(function(r) { return String(r.empNo || "").toLowerCase(); });
            deptEmployees = deptEmployees.filter(function(emp) {
                return deletedEmpNos.indexOf(String(emp.empNo || "").toLowerCase()) < 0;
            });
            employeeByUid = {};
            employeeByEmpNo = {};
            employeeByName = {};
            allowedUsers = [];
            deptEmployees.forEach(function(emp) {
                if (!emp || !emp.uid) return;
                employeeByUid[emp.uid] = emp;
                if (emp.empNo) employeeByEmpNo[String(emp.empNo).toLowerCase()] = emp;
                if (emp.name)  employeeByName[emp.name] = emp;
                allowedUsers.push(emp.name);
            });

            // 관련 UI 자동 갱신
            if (typeof drawAllowedUsersBoard   === "function") drawAllowedUsersBoard();
            if (typeof drawLiveGroupBoards      === "function") { groupBoardStateLoaded = false; drawLiveGroupBoards(); }
            if (typeof drawAnnualStatusBoard     === "function") drawAnnualStatusBoard();
            if (typeof drawSuperAdminPanel       === "function") drawSuperAdminPanel();

            // 미리보기 초기화 + 파일 input 초기화
            if (preview) { preview.innerHTML = ""; preview._bulkDeleteData = null; }
            var fileInput = document.getElementById("bulkDeleteExcelInput");
            if (fileInput) fileInput.value = "";
        })
        .catch(function(e) {
            alert((e && e.message) || "일괄 삭제 실패");
        });
}

function performSuperAdminPasswordReset() {
    if (!isSuperAdmin) return;

    var empNoEl = document.getElementById("superResetEmpNo");
    var passEl = document.getElementById("superResetPassword");
    var empNo = empNoEl ? empNoEl.value.trim() : "";
    var newPassword = passEl ? passEl.value.trim() : "";

    if (!empNo) {
        alert("사번 또는 관리자ID를 입력해주세요.");
        return;
    }
    if (newPassword.length < 6) {
        alert("새 비밀번호는 6자 이상이어야 합니다.");
        return;
    }

    fn.resetEmployeePassword({ empNo: empNo, newPassword: newPassword }).then(function() {
        alert("[" + empNo + "] 비밀번호가 초기화되었습니다.");
        if (empNoEl) empNoEl.value = "";
        if (passEl) passEl.value = "";
    }).catch(function(e) {
        alert((e && e.message) || "비밀번호 초기화 실패");
    });
}

function performSuperAdminDeleteEmployee() {
    if (!isSuperAdmin) return;

    var empNoEl = document.getElementById("superDeleteEmpNo");
    var empNo = empNoEl ? empNoEl.value.trim() : "";
    var myEmpNo = currentProfile && currentProfile.empNo ? String(currentProfile.empNo).trim().toLowerCase() : "";

    if (!empNo) {
        alert("삭제할 사번을 입력해주세요.");
        return;
    }
    if (empNo.trim().toLowerCase() === "sa001") {
        alert("기본 슈퍼관리자 계정은 삭제할 수 없습니다.");
        return;
    }
    if (myEmpNo && empNo.trim().toLowerCase() === myEmpNo) {
        alert("현재 로그인한 슈퍼관리자 본인은 삭제할 수 없습니다.");
        return;
    }
    if (!confirm("[" + empNo + "] 직원 계정을 삭제하시겠습니까?")) return;

    fn.deleteEmployee({ empNo: empNo }).then(function() {
        alert("직원 계정이 삭제되었습니다.");
        if (empNoEl) empNoEl.value = "";
        deptEmployees = deptEmployees.filter(function(emp) {
            return String(emp.empNo || "").trim().toLowerCase() !== empNo.trim().toLowerCase();
        });
        employeeByUid = {};
        employeeByEmpNo = {};
        employeeByName = {};
        allowedUsers = [];
        deptEmployees.forEach(function(emp) {
            if (!emp || !emp.uid) return;
            employeeByUid[emp.uid] = emp;
            if (emp.empNo) employeeByEmpNo[String(emp.empNo).toLowerCase()] = emp;
            if (emp.name) employeeByName[emp.name] = emp;
            allowedUsers.push(emp.name);
        });
        if (typeof drawAllowedUsersBoard === "function") drawAllowedUsersBoard();
        if (typeof drawLiveGroupBoards === "function") {
            groupBoardStateLoaded = false;
            drawLiveGroupBoards();
        }
        if (typeof drawAnnualStatusBoard === "function") drawAnnualStatusBoard();
        if (typeof drawSuperAdminPanel === "function") drawSuperAdminPanel();
    }).catch(function(e) {
        alert((e && e.message) || "직원 삭제 실패");
    });
}

function closeSuperResetModal() {
    var modal = document.getElementById("superResetChoiceModal");
    if (modal) modal.style.display = "none";
}
