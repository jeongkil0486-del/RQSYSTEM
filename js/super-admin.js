        // ====== 슈퍼 관리자 패널 ======
        function showSuperAdminPanel() {
            document.getElementById("welcomeMessage").innerHTML =
                "🔑 슈퍼 관리자 모드<br><span style='font-size:13px; color:#e53935; font-weight:bold;'>관리자 계정 비밀번호 초기화 전용</span>";

            var toggleModeBtn = document.getElementById("toggleModeBtn");
            var userResetBtn  = document.getElementById("userResetBtn");
            var resetBtn      = document.getElementById("resetAllBtn");
            var resetConfigBtn= document.getElementById("resetConfigBtn");
            var adminConsole  = document.getElementById("adminConsole");
            var scBtn         = document.getElementById("scheduleCodeApplyBtn");

            if(toggleModeBtn)  toggleModeBtn.style.display  = "none";
            if(userResetBtn)   userResetBtn.style.display   = "none";
            if(resetBtn)       resetBtn.style.display       = "none";
            if(resetConfigBtn) resetConfigBtn.style.display = "none";
            if(adminConsole)   adminConsole.style.display   = "none";
            if(scBtn)          scBtn.style.display          = "none";

            // 슈퍼관리자 전용 패널 표시
            document.getElementById("superAdminPanel").style.display = "flex";
            document.getElementById("mainCalendarGrid").style.display = "none";
            drawSuperAdminPanel();
        }

        function drawSuperAdminPanel() {
            var container = document.getElementById("superAdminPanelContent");
            if (!container) return;
            var adminList = Object.keys(ADMIN_ACCOUNTS);
            var loaded = 0;
            var passMap = {};
            container.innerHTML = "로딩중...";
            adminList.forEach(function(id) {
                db.ref("trinity_system/__admin_pass__/" + id).once("value", function(snap) {
                    passMap[id] = snap.val() !== null ? snap.val() : ADMIN_DEFAULT_PASS[id];
                    loaded++;
                    if (loaded === adminList.length) {
                        var html = "<table style='width:100%; border-collapse:collapse; font-size:13px;'>";
                        html += "<tr style='background:#f0f0f0;'><th style='padding:8px; border:1px solid #ddd; text-align:left;'>관리자 ID</th><th style='padding:8px; border:1px solid #ddd;'>지점</th><th style='padding:8px; border:1px solid #ddd;'>현재 비밀번호</th><th style='padding:8px; border:1px solid #ddd;'>초기화</th></tr>";
                        adminList.forEach(function(id) {
                            html += "<tr>";
                            html += "<td style='padding:8px; border:1px solid #ddd; font-weight:bold;'>" + id + "</td>";
                            html += "<td style='padding:8px; border:1px solid #ddd; text-align:center; color:#555;'>" + ADMIN_ACCOUNTS[id].label + "</td>";
                        html += "<td style='padding:8px; border:1px solid #ddd; text-align:center;'><code style='color:#999;'>보안상 비표시</code></td>";
                            html += "<td style='padding:8px; border:1px solid #ddd; text-align:center;'><button onclick=\"resetAdminPassword('" + id + "')\" style='background:#e53935; color:#fff; border:none; border-radius:5px; padding:5px 12px; cursor:pointer; font-weight:bold; font-size:12px;'>초기화</button></td>";
                            html += "</tr>";
                        });
                        html += "</table>";
                        container.innerHTML = html;
                    }
                });
            });

            // 섹션3: 지점별 직원 비밀번호 초기화 테이블
            drawSuperResetPanel();
        }

        function drawSuperResetPanel() {
            var container = document.getElementById("superResetPanelContent");
            if (!container) return;
            var adminList = Object.keys(ADMIN_ACCOUNTS);
            var html = "<table style='width:100%; border-collapse:collapse; font-size:13px;'>";
            html += "<tr style='background:#fff3e0;'><th style='padding:8px; border:1px solid #ddd; text-align:left;'>관리자 ID</th><th style='padding:8px; border:1px solid #ddd;'>지점</th><th style='padding:8px; border:1px solid #ddd;'>비밀번호 초기화</th></tr>";
            adminList.forEach(function(id) {
                html += "<tr>";
                html += "<td style='padding:8px; border:1px solid #ddd; font-weight:bold;'>" + id + "</td>";
                html += "<td style='padding:8px; border:1px solid #ddd; text-align:center; color:#555;'>" + ADMIN_ACCOUNTS[id].label + "</td>";
                html += "<td style='padding:8px; border:1px solid #ddd; text-align:center;'><button onclick=\"openSuperResetModal('" + id + "')\" style='background:#e67e22; color:#fff; border:none; border-radius:5px; padding:5px 12px; cursor:pointer; font-weight:bold; font-size:12px;'>초기화 선택</button></td>";
                html += "</tr>";
            });
            html += "</table>";
            container.innerHTML = html;
        }

        // 슈퍼관리자 초기화 팝업
        var _superResetTargetAdminId = "";
        function openSuperResetModal(adminId) {
            if (!isSuperAdmin) return;
            _superResetTargetAdminId = adminId;
            var info = ADMIN_ACCOUNTS[adminId];
            document.getElementById("superResetModalDeptLabel").innerText = info ? info.label + " 초기화 선택" : "초기화 선택";
            document.getElementById("superResetChoiceModal").style.display = "flex";
        }
        function closeSuperResetModal() {
            document.getElementById("superResetChoiceModal").style.display = "none";
            _superResetTargetAdminId = "";
        }
        function executeSuperReset(mode) {
            if (!isSuperAdmin || !_superResetTargetAdminId) return;
            var adminId = _superResetTargetAdminId;
            var dept = ADMIN_ACCOUNTS[adminId] ? ADMIN_ACCOUNTS[adminId].dept : null;
            if (!dept) { alert("지점 정보를 찾을 수 없습니다."); closeSuperResetModal(); return; }

            if (mode === "ADMIN") {
                if (!confirm("[" + adminId + "] 관리자 비밀번호를 초기값으로 초기화하시겠습니까?")) { closeSuperResetModal(); return; }
                db.ref("trinity_system/__admin_pass__/" + adminId).remove();
                alert("✨ [" + adminId + "] 관리자 비밀번호가 초기화되었습니다.\nFirebase DB에서 새 비밀번호를 직접 설정해주세요.\n경로: trinity_system/__admin_pass__/" + adminId);
                closeSuperResetModal();
                drawSuperAdminPanel();

            } else if (mode === "STAFF") {
                if (!confirm("[" + dept + "] 지점 전체 직원 비밀번호를 초기화하시겠습니까?\n직원들은 다음 로그인 시 새 비밀번호를 등록해야 합니다.")) { closeSuperResetModal(); return; }
                if (!confirm("🛑 최종 확인: [" + dept + "] 지점 직원 비밀번호를 전부 삭제합니다. 계속하시겠습니까?")) { closeSuperResetModal(); return; }
                db.ref("trinity_system/" + dept).once("value", function(snap) {
                    var data = snap.val() || {};
                    var count = 0;
                    Object.keys(data).forEach(function(key) {
                        if (key.startsWith("user_pwd_")) {
                            db.ref("trinity_system/" + dept + "/" + key).remove();
                            count++;
                        }
                    });
                    alert("✨ [" + dept + "] 지점 직원 비밀번호 " + count + "개가 초기화되었습니다.");
                    closeSuperResetModal();
                });
            }
        }

        // ====== 엑셀 업로드 - 지점별 직원 ID 일괄 등록 ======
        function uploadDeptExcel() {
            if (!isSuperAdmin) return;
            var dept = document.getElementById("superDeptSelect").value;
            var fileInput = document.getElementById("superExcelUpload");
            var msgEl = document.getElementById("uploadResultMsg");

            if (!dept) { msgEl.innerText = "❌ 지점을 선택해주세요."; msgEl.style.color="#e53935"; return; }
            if (!fileInput.files || fileInput.files.length === 0) { msgEl.innerText = "❌ 엑셀 파일을 선택해주세요."; msgEl.style.color="#e53935"; return; }

            var file = fileInput.files[0];
            var reader = new FileReader();
            msgEl.innerText = "⏳ 파일 읽는 중...";
            msgEl.style.color = "#1565c0";

            reader.onload = function(e) {
                try {
                    var data = new Uint8Array(e.target.result);
                    var workbook = XLSX.read(data, { type: "array" });
                    var sheet = workbook.Sheets[workbook.SheetNames[0]];
                    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });

                    // A열 값 추출 (1행 헤더 제외)
                    var names = [];
                    for (var i = 1; i < rows.length; i++) {
                        var val = rows[i][0];
                        if (val !== undefined && val !== null && String(val).trim() !== "") {
                            names.push(String(val).trim());
                        }
                    }
                    if (names.length === 0) { msgEl.innerText = "❌ A열에 유효한 이름이 없습니다."; msgEl.style.color="#e53935"; return; }

                    msgEl.innerText = "⏳ 전 지점 중복 검사 중... (" + names.length + "명)";

                    // 전 지점 명단 수집 후 중복 검사
                    var allDepts = ALL_DEPTS.length > 0 ? ALL_DEPTS : Object.keys(ADMIN_ACCOUNTS).map(function(id){ return ADMIN_ACCOUNTS[id].dept; }).filter(function(v,i,a){ return a.indexOf(v)===i; });
                    var loadedDepts = 0;
                    var existingAllNames = {}; // name -> dept

                    allDepts.forEach(function(d) {
                        db.ref("trinity_system/" + d + "/allowed_users_list").once("value", function(snap) {
                            var raw = snap.val();
                            if (raw) {
                                try {
                                    var list = typeof raw === "string" ? JSON.parse(raw) : raw;
                                    if (Array.isArray(list)) {
                                        list.forEach(function(n) { existingAllNames[n] = d; });
                                    }
                                } catch(e) {}
                            }
                            loadedDepts++;
                            if (loadedDepts === allDepts.length) {
                                // 관리자 ID도 중복불가
                                Object.keys(ADMIN_ACCOUNTS).forEach(function(aid) { existingAllNames[aid] = "__admin__"; });
                                existingAllNames[SUPER_ADMIN_ID] = "__super__";

                                var duplicates = [];
                                var toAdd = [];
                                names.forEach(function(name) {
                                    if (existingAllNames[name] !== undefined) {
                                        duplicates.push(name + "(" + existingAllNames[name] + ")");
                                    } else {
                                        toAdd.push(name);
                                    }
                                });

                                if (toAdd.length === 0) {
                                    msgEl.innerText = "❌ 추가할 수 있는 이름이 없습니다. 전부 중복: " + duplicates.join(", ");
                                    msgEl.style.color = "#e53935";
                                    return;
                                }

                                var confirmMsg = "[" + dept + "] 지점에 " + toAdd.length + "명을 등록합니다.\n\n등록: " + toAdd.join(", ");
                                if (duplicates.length > 0) confirmMsg += "\n\n⚠️ 중복으로 제외(" + duplicates.length + "명): " + duplicates.join(", ");
                                if (!confirm(confirmMsg)) { msgEl.innerText = "취소되었습니다."; msgEl.style.color="#888"; return; }

                                // 해당 지점 현재 명단 가져와서 합산 저장
                                db.ref("trinity_system/" + dept + "/allowed_users_list").once("value", function(snap2) {
                                    var current = [];
                                    var raw2 = snap2.val();
                                    if (raw2) { try { current = typeof raw2 === "string" ? JSON.parse(raw2) : raw2; } catch(e) {} }
                                    var merged = current.concat(toAdd);
                                    db.ref("trinity_system/" + dept + "/allowed_users_list").set(JSON.stringify(merged));
                                    msgEl.innerText = "✅ [" + dept + "] 지점에 " + toAdd.length + "명 등록 완료!" + (duplicates.length > 0 ? " (" + duplicates.length + "명 중복 제외)" : "");
                                    msgEl.style.color = "#2e7d32";
                                    fileInput.value = "";
                                });
                            }
                        });
                    });
                } catch(err) {
                    msgEl.innerText = "❌ 파일 파싱 오류: " + err.message;
                    msgEl.style.color = "#e53935";
                }
            };
            reader.readAsArrayBuffer(file);
        }

        // 엑셀 양식 다운로드
        function downloadExcelTemplate() {
            var ws = XLSX.utils.aoa_to_sheet([["이름"], ["홍길동"], ["김철수"]]);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "직원명단");
            XLSX.writeFile(wb, "직원ID_등록양식.xlsx");
        }

        function resetAdminPassword(adminId) {
            if (!isSuperAdmin) return;
            if (confirm("[" + adminId + "] 관리자 비밀번호를 삭제(초기화)하시겠습니까?\n\n⚠️ 초기화 후 해당 관리자는 Firebase DB에서 비밀번호를 새로 설정해야 합니다.\n경로: trinity_system/__admin_pass__/" + adminId)) {
                db.ref("trinity_system/__admin_pass__/" + adminId).remove();
                alert("✨ [" + adminId + "] 비밀번호가 초기화되었습니다.\nFirebase DB에서 새 비밀번호를 직접 설정해주세요.");
                drawSuperAdminPanel();
            }
        }

        // ====== 일반 관리자 비밀번호 변경 ======
        function changeMyAdminPassword() {
            if (!isAdmin) return;
            var newPass = document.getElementById("newAdminPassInput").value.trim();
            if (newPass === "") { alert("새 비밀번호를 입력해주세요."); return; }
            if (newPass.length < 4) { alert("비밀번호는 4자 이상 입력해주세요."); return; }
            if (confirm("관리자 비밀번호를 [" + newPass + "] 으로 변경하시겠습니까?")) {
                db.ref("trinity_system/__admin_pass__/" + currentUser).set(newPass);
                alert("✨ 비밀번호가 변경되었습니다. 다음 로그인부터 새 비밀번호를 사용하세요.");
                document.getElementById("newAdminPassInput").value = "";
            }
        }

