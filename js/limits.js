        function formatDateTimeString(dateTimeStr) {
            if (!dateTimeStr) return "설정되지 않음";
            var d = new Date(dateTimeStr);
            if (isNaN(d.getTime())) return "설정되지 않음";
            return `${d.getFullYear()}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${d.getHours()}시 ${d.getMinutes()}분`;
        }

        function getTargetYearMonth() {
            // DB에 값이 없으면 현재 날짜 기준 다음달을 기본값으로 사용
            var now = new Date();
            var nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
            var defaultYM = nextMonth.getFullYear() + "-" + String(nextMonth.getMonth() + 1).padStart(2, "0");
            var savedYM = getFirebaseItem("rq_current_target_year_month", defaultYM);
            var parts = savedYM.split("-");
            return {
                year: parts[0],
                month: parts[1],
                fullStr: parts[0] + parts[1],
                label: parts[0] + "년 " + parseInt(parts[1]) + "월"
            };
        }

        function saveYearMonthConfig() {
            if (!isAdmin) return;
            var y = document.getElementById("targetYear").value;
            var m = document.getElementById("targetMonth").value;
            setFirebaseItem("rq_current_target_year_month", y + "-" + m);
            alert(`✨ 작업 대상 월이 [ ${y}년 ${parseInt(m)}월 ]로 정상 변경되었습니다.\n달력 형태와 요일 배치가 동적으로 재구조화됩니다.`);
        }

        function saveDayMaxConstraint() {
            if (!isAdmin) return;
            var dayMaxInput = document.getElementById("dayMaxConfig").value.trim();
            var dayMax = dayMaxInput === "" ? 10 : parseInt(dayMaxInput);
            
            if (isNaN(dayMax) || dayMax < 1) {
                alert("❌ 일별 한도 수치는 1명 이상의 올바른 값을 입력해주세요.");
                return;
            }
            
            setFirebaseItem("rq_config_day_max", dayMax);
            alert(`✨ 적용 완료: 이제 일별 전체 신청 한도가 [ 최대 ${dayMax}명 ]으로 제어됩니다.`);
        }

        function saveGlobalUserMaxConstraint() {
            if (!isAdmin) return;
            var globalMaxInput = document.getElementById("globalUserMaxConfig").value.trim();
            var globalMax = globalMaxInput === "" ? 4 : parseInt(globalMaxInput);
            
            if (isNaN(globalMax) || globalMax < 1) {
                alert("❌ 휴무 신청 한도는 최소 1개 이상 입력해주세요.");
                return;
            }
            
            setFirebaseItem("rq_config_global_user_max", globalMax);
            alert(`✨ 적용 완료: 이제 전 직원의 한 달 기본 휴무 신청 제한 개수가 [ 최대 ${globalMax}개 ]로 일괄 제한 제어됩니다.`);
        }

        function saveAnnualUserMaxConstraint() {
            if (!isAdmin) return;
            var annualMaxInput = document.getElementById("annualUserMaxConfig") ? document.getElementById("annualUserMaxConfig").value.trim() : "";
            var annualMax = annualMaxInput === "" ? 15 : parseInt(annualMaxInput);
            if (isNaN(annualMax) || annualMax < 0) { alert("❌ 연차 제한 개수는 올바른 값을 입력해주세요."); return; }
            setFirebaseItem("rq_config_annual_user_max", annualMax);
            alert(`✨ 적용 완료.`);
        }

        // ====== 직원별 연차 개수 업로드/관리 ======
        // DB 키: annual_quota_이름  (해당 월 연차 총 부여 개수)

        function getAnnualQuota(userName) {
            var val = getFirebaseItem("annual_quota_" + userName, null);
            return val !== null ? parseInt(val) : null;
        }

        // 파일선택 없이 버튼 클릭 → hidden input 트리거 → 선택 즉시 업로드
        function triggerAnnualUpload() {
            var fi = document.getElementById("annualExcelUpload");
            if (!fi) return;
            fi.onchange = function() {
                if (fi.files && fi.files.length > 0) uploadAnnualExcel();
            };
            fi.click();
        }

        function uploadAnnualExcel() {
            if (!isAdmin) return;
            var fileInput = document.getElementById("annualExcelUpload");
            if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
                alert("❌ 엑셀 파일을 선택해주세요."); return;
            }
            var file = fileInput.files[0];
            var reader = new FileReader();
            reader.onload = function(e) {
                try {
                    var data = new Uint8Array(e.target.result);
                    var workbook = XLSX.read(data, { type: "array" });
                    var sheet = workbook.Sheets[workbook.SheetNames[0]];
                    var rows = XLSX.utils.sheet_to_json(sheet, { header: 1 });
                    var toUpload = [];
                    var errors = [];
                    for (var i = 1; i < rows.length; i++) {
                        var uName = rows[i][0] !== undefined ? String(rows[i][0]).trim() : "";
                        var quota = rows[i][1] !== undefined ? parseInt(rows[i][1]) : NaN;
                        if (uName === "") continue;
                        if (isNaN(quota) || quota < 0) { errors.push((i+1) + "행 [" + uName + "]: 개수 오류"); continue; }
                        if (!allowedUsers.includes(uName)) { errors.push(uName + ": 명단에 없는 직원"); continue; }
                        toUpload.push({ name: uName, quota: quota });
                    }
                    if (toUpload.length === 0) {
                        alert("❌ 등록할 유효한 데이터가 없습니다.\n" + (errors.length > 0 ? errors.join("\n") : ""));
                        return;
                    }
                    var confirmMsg = toUpload.length + "명의 연차를 업로드합니다:\n" + toUpload.map(function(x){ return x.name + ": " + x.quota + "일"; }).join(", ");
                    if (errors.length > 0) confirmMsg += "\n\n⚠️ 제외(" + errors.length + "건):\n" + errors.join("\n");
                    if (!confirm(confirmMsg)) return;
                    toUpload.forEach(function(x) { setFirebaseItem("annual_quota_" + x.name, x.quota); });
                    alert("✨ " + toUpload.length + "명 연차 업로드 완료!");
                    fileInput.value = "";
                    drawAnnualStatusBoard();
                } catch(err) { alert("❌ 파일 오류: " + err.message); }
            };
            reader.readAsArrayBuffer(file);
        }

        function downloadAnnualTemplate() {
            var ws = XLSX.utils.aoa_to_sheet([["이름","연차개수"],["홍길동",15],["김철수",10]]);
            var wb = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(wb, ws, "연차업로드양식");
            XLSX.writeFile(wb, "연차업로드_양식.xlsx");
        }

        function toggleAnnualStatusBoard(event) {
            var board = document.getElementById("annualStatusTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function drawAnnualStatusBoard() {
            var container = document.getElementById("annualStatusTooltipBoard");
            if (!container) return;
            var tm = getTargetYearMonth();
            var html = "<strong style='color:#fff;font-size:13px;'>📊 직원별 연차 현황</strong>"
                     + "<div style='font-size:11px;color:#bdc3c7;margin:4px 0 8px;'>이름 &nbsp; 부여 / 사용 / 잔 &nbsp; (우클릭으로 삭제)</div>"
                     + "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
            var hasAny = false;
            allowedUsers.forEach(function(name) {
                var quota = getAnnualQuota(name);
                if (quota === null) return;
                hasAny = true;
                var used = 0;
                var prefix = "rq_" + name + "_" + tm.fullStr + "_";
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith(prefix) && key.endsWith("_annual")) used++;
                });
                var remain = quota - used;
                var bgColor = remain <= 0 ? "rgba(229,57,53,0.25)" : remain <= 2 ? "rgba(245,127,23,0.25)" : "rgba(46,125,50,0.25)";
                var bdColor = remain <= 0 ? "#e53935" : remain <= 2 ? "#f57f17" : "#43a047";
                var txColor = remain <= 0 ? "#ff8a80" : remain <= 2 ? "#ffcc02" : "#a5d6a7";
                html += "<span class='ann-quota-badge'"
                      + " data-name='" + name + "'"
                      + " style='background:" + bgColor + ";border:1px solid " + bdColor + ";border-radius:5px;"
                      + "padding:4px 8px;font-size:12px;color:" + txColor + ";font-weight:bold;white-space:nowrap;cursor:context-menu;'>"
                      + name + " " + quota + "/" + used + "/" + remain
                      + "</span>";
            });
            if (!hasAny) html += "<span style='color:#aaa;font-style:italic;font-size:12px;'>업로드된 연차 없음</span>";
            html += "</div>";
            container.innerHTML = html;
            container.oncontextmenu = function(e) {
                var badge = e.target.closest(".ann-quota-badge");
                if (!badge) return;
                e.preventDefault();
                deleteAnnualQuotaFromBoard(e, badge.getAttribute("data-name"));
            };
        }

        function deleteAnnualQuotaFromBoard(event, name) {
            event.preventDefault();
            if (!confirm("[" + name + "] 직원의 연차 할당량을 삭제하시겠습니까?")) return;
            setFirebaseItem("annual_quota_" + name, null);
            drawAnnualStatusBoard();
        }

        function setSpecialDayLimit(isSet) {
            if (!isAdmin) return;
            var dayInput = document.getElementById("specialDayInput").value.trim();
            var limitInput = document.getElementById("specialDayLimit").value.trim();
            var tm = getTargetYearMonth();

            var dayNum = parseInt(dayInput);
            if (dayInput === "" || isNaN(dayNum) || dayNum < 1 || dayNum > 31) {
                alert("❌ 올바른 날짜(1~31)를 입력해주세요.");
                return;
            }

            var storageKey = `rq_special_limit_${tm.fullStr}_${dayNum}`;

            if (isSet) {
                var limitNum = parseInt(limitInput);
                if (limitInput === "" || isNaN(limitNum) || limitNum < 0) {
                    alert("❌ 올바른 제한 인원수(0 이상의 숫자)를 입력해주세요.");
                    return;
                }
                setFirebaseItem(storageKey, limitNum);
                alert(`✨ [특정일 한도 적용]: ${parseInt(tm.month)}월 ${dayNum}일의 총 신청 인원이 [ ${limitNum}명 ]으로 설정되었습니다.`);
            } else {
                setFirebaseItem(storageKey, null);
                alert(`✨ [특정일 한도 해제]: ${parseInt(tm.month)}월 ${dayNum}일의 개별 인원 제한이 취소되어 기본 글로벌 선착순 규칙으로 돌아갑니다.`);
            }

            document.getElementById("specialDayInput").value = "";
            document.getElementById("specialDayLimit").value = "";
        }

        function saveGroupMaxConstraints() {
            if (!isAdmin) return;
            var maxAInput = document.getElementById("groupMaxConfigA").value.trim();
            var maxBInput = document.getElementById("groupMaxConfigB").value.trim();
            var maxCInput = document.getElementById("groupMaxConfigC").value.trim();
            var maxDInput = document.getElementById("groupMaxConfigD").value.trim();
            var maxEInput = document.getElementById("groupMaxConfigE").value.trim();
            
            var maxA = maxAInput === "" ? 2 : parseInt(maxAInput);
            var maxB = maxBInput === "" ? 2 : parseInt(maxBInput);
            var maxC = maxCInput === "" ? 2 : parseInt(maxCInput);
            var maxD = maxDInput === "" ? 2 : parseInt(maxDInput);
            var maxE = maxEInput === "" ? 2 : parseInt(maxEInput);
            
            if (isNaN(maxA) || maxA < 1 || isNaN(maxB) || maxB < 1 || isNaN(maxC) || maxC < 1 || isNaN(maxD) || maxD < 1 || isNaN(maxE) || maxE < 1) {
                alert("❌ 각 조별 한도 수치는 1명 이상의 올바른 값을 입력해주세요.");
                return;
            }
            
            setFirebaseItem("rq_config_group_max_A", maxA);
            setFirebaseItem("rq_config_group_max_B", maxB);
            setFirebaseItem("rq_config_group_max_C", maxC);
            setFirebaseItem("rq_config_group_max_D", maxD);
            setFirebaseItem("rq_config_group_max_E", maxE);
            alert(`✨ 조별 독립 한도 적용 완료!\n[ A조: 최대 ${maxA}명 ]\n[ B조: 최대 ${maxB}명 ]\n[ C조: 최대 ${maxC}명 ]\n[ D조: 최대 ${maxD}명 ]\n[ E조: 최대 ${maxE}명 ]`);
        }

