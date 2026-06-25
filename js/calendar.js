        function generateCalendarGrid() {
            var gridContainer = document.getElementById("mainCalendarGrid");
            if (!gridContainer) return;
            gridContainer.innerHTML = ""; 

            var daysHeader = [
                { txt: "일", cls: "days sun" }, { txt: "월", cls: "days" }, { txt: "화", cls: "days" },
                { txt: "수", cls: "days" }, { txt: "목", cls: "days" }, { txt: "금", cls: "days" }, { txt: "토", cls: "days sat" }
            ];
            daysHeader.forEach(function(h) {
                var hDiv = document.createElement("div");
                hDiv.className = h.cls;
                hDiv.innerText = h.txt;
                gridContainer.appendChild(hDiv);
            });

            var tm = getTargetYearMonth();
            var targetYearNum = parseInt(tm.year);
            var targetMonthNum = parseInt(tm.month);

            var firstDayInstance = new Date(targetYearNum, targetMonthNum - 1, 1);
            var startDayOfWeek = firstDayInstance.getDay(); 
            var totalDaysInMonth = new Date(targetYearNum, targetMonthNum, 0).getDate();

            for (var e = 0; e < startDayOfWeek; e++) {
                var emptyDiv = document.createElement("div");
                emptyDiv.className = "empty";
                gridContainer.appendChild(emptyDiv);
            }

            for (var d = 1; d <= totalDaysInMonth; d++) {
                var dateDiv = document.createElement("div");
                var currentDayInstance = new Date(targetYearNum, targetMonthNum - 1, d);
                var dayOfWeek = currentDayInstance.getDay();

                var classStr = "date";
                if (dayOfWeek === 0) classStr += " sun";
                if (dayOfWeek === 6) classStr += " sat";

                dateDiv.className = classStr;
                dateDiv.id = "d-" + d;
                (function(dayNum) {
                    dateDiv.onclick = function() { editDate(dayNum); };
                })(d);

                gridContainer.appendChild(dateDiv);
            }
        }

        function toggleSpecialDayBoard(event) {
            var board = document.getElementById("specialDayTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function toggleLimitListBoard(event) {
            var board = document.getElementById("limitListTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function updateLimitTooltipBoard() {
            var limitContainer = document.getElementById("limitListTooltipBoard");
            var specialContainer = document.getElementById("specialDayTooltipBoard");
            if (!limitContainer || !specialContainer) return;

            var limitedUsers = [];
            var specialDays = [];
            var tm = getTargetYearMonth();

            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith("rq_limit_")) {
                    limitedUsers.push({ name: key.replace("rq_limit_", ""), count: liveDBData[key] });
                } else if (key.startsWith("rq_special_limit_" + tm.fullStr + "_")) {
                    specialDays.push({ day: key.replace("rq_special_limit_" + tm.fullStr + "_", ""), count: liveDBData[key] });
                }
            });

            // 직원별 신청제한 팝업
            var limitHtml = "<strong style='color:#fff;font-size:13px;'>📊 직원별 개별 한도 현황</strong>"
                          + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
            if (limitedUsers.length === 0) {
                limitHtml += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(개별 제한 없음)</div>";
            } else {
                limitHtml += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
                limitedUsers.sort(function(a,b){ return a.name.localeCompare(b.name); }).forEach(function(item) {
                    limitHtml += "<span class='lim-badge'"
                               + " data-name='" + item.name + "'"
                               + " style='background:rgba(52,152,219,0.25);border:1px solid #3498db;border-radius:5px;"
                               + "padding:4px 8px;font-size:12px;color:#74b9ff;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                               + item.name + ": " + item.count + "개</span>";
                });
                limitHtml += "</div>";
            }
            limitContainer.innerHTML = limitHtml;
            limitContainer.oncontextmenu = function(e) {
                var badge = e.target.closest(".lim-badge");
                if (!badge) return;
                e.preventDefault();
                deleteUserLimitFromBoard(e, badge.getAttribute("data-name"));
            };

            // 특정일 제한 팝업
            var specialHtml = "<strong style='color:#fff;font-size:13px;'>🎯 당월 특정일 제한 현황</strong>"
                            + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
            if (specialDays.length === 0) {
                specialHtml += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(특정일 제한 없음)</div>";
            } else {
                specialHtml += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
                specialDays.sort(function(a,b){ return parseInt(a.day)-parseInt(b.day); }).forEach(function(item){
                    specialHtml += "<span class='sp-day-badge'"
                                 + " data-day='" + item.day + "'"
                                 + " style='background:rgba(52,152,219,0.25);border:1px solid #54a0ff;border-radius:5px;"
                                 + "padding:4px 8px;font-size:12px;color:#74b9ff;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                                 + item.day + "일: " + item.count + "명</span>";
                });
                specialHtml += "</div>";
            }
            specialContainer.innerHTML = specialHtml;
            specialContainer.oncontextmenu = function(e) {
                var badge = e.target.closest(".sp-day-badge");
                if (!badge) return;
                e.preventDefault();
                deleteSpecialDayFromBoard(e, badge.getAttribute("data-day"));
            };
        }

        function deleteSpecialDayFromBoard(event, day) {
            event.preventDefault();
            var tm = getTargetYearMonth();
            if (!confirm(parseInt(tm.month) + "월 " + day + "일 특정일 제한을 삭제하시겠습니까?")) return;
            setFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + day, null);
        }

        function deleteUserLimitFromBoard(event, name) {
            event.preventDefault();
            if (!confirm("[" + name + "] 직원의 개별 신청 제한을 삭제하시겠습니까?")) return;
            setFirebaseItem("rq_limit_" + name, null);
        }

        function refreshData() {
            // 슈퍼관리자는 달력 렌더링 불필요 - 패널만 표시
            if (isSuperAdmin) { showSuperAdminPanel(); return; }

            var toggleModeBtn = document.getElementById("toggleModeBtn");
            var userResetBtn = document.getElementById("userResetBtn");
            var resetBtn = document.getElementById("resetAllBtn");
            var resetConfigBtn = document.getElementById("resetConfigBtn");
            var adminConsole = document.getElementById("adminConsole");
            var tm = getTargetYearMonth(); 

            generateCalendarGrid();

            if (isAdmin) {
                if(document.getElementById("startDateTimeConfig")) {
                    document.getElementById("startDateTimeConfig").value = getFirebaseItem("rq_allowed_start_datetime", "");
                }
                if(document.getElementById("endDateTimeConfig")) {
                    document.getElementById("endDateTimeConfig").value = getFirebaseItem("rq_allowed_end_datetime", "");
                }

                if(document.getElementById("targetYear")) initYearMonthSelects(tm.year, tm.month);
                
                if(document.getElementById("dayMaxConfig")) document.getElementById("dayMaxConfig").value = getFirebaseItem("rq_config_day_max", "10");
                if(document.getElementById("globalUserMaxConfig")) document.getElementById("globalUserMaxConfig").value = getFirebaseItem("rq_config_global_user_max", "4");
                if(document.getElementById("annualUserMaxConfig")) document.getElementById("annualUserMaxConfig").value = getFirebaseItem("rq_config_annual_user_max", "15");

                if(document.getElementById("groupMaxConfigA")) document.getElementById("groupMaxConfigA").value = getFirebaseItem("rq_config_group_max_A", "2");
                if(document.getElementById("groupMaxConfigB")) document.getElementById("groupMaxConfigB").value = getFirebaseItem("rq_config_group_max_B", "2");
                if(document.getElementById("groupMaxConfigC")) document.getElementById("groupMaxConfigC").value = getFirebaseItem("rq_config_group_max_C", "2");
                if(document.getElementById("groupMaxConfigD")) document.getElementById("groupMaxConfigD").value = getFirebaseItem("rq_config_group_max_D", "2");
                if(document.getElementById("groupMaxConfigE")) document.getElementById("groupMaxConfigE").value = getFirebaseItem("rq_config_group_max_E", "2");

                var deptLabel = currentDept ? " [" + currentDept + "]" : "";
                document.getElementById("welcomeMessage").innerHTML = "👑 " + tm.label + deptLabel + " [관리자 모드]<br><span style=\"font-size:13px; color:#d9534f; font-weight:bold;\">날짜 클릭 시 특정 직원의 신청 내역 개별 삭제 가능</span>";
                if(toggleModeBtn) toggleModeBtn.style.display = "none";
                if(userResetBtn) userResetBtn.style.display = "none";
                if(resetBtn) resetBtn.style.display = "flex"; 
                if(resetConfigBtn) resetConfigBtn.style.display = "flex"; 
                if(adminConsole) adminConsole.style.display = "flex"; 
                loadAdminCalendarData();
                updateLimitTooltipBoard(); 
                drawAllowedUsersBoard(); 
                drawLiveGroupBoards();
                drawScheduleCodeBoard();
                drawScGroupLimitBoard();
                updateScGroupLimitCodeSelect();
                drawAnnualStatusBoard();
            } else {
                var savedConfig = getFirebaseItem("rq_allowed_start_datetime", null);
                var savedEndConfig = getFirebaseItem("rq_allowed_end_datetime", null);
                
                var noticeStr = "언제나 신청 가능";
                if (savedConfig && savedEndConfig) {
                    noticeStr = `${formatDateTimeString(savedConfig)} 부터 ~ ${formatDateTimeString(savedEndConfig)} 까지`;
                } else if (savedConfig) {
                    noticeStr = `${formatDateTimeString(savedConfig)} 부터 신청 가능`;
                } else if (savedEndConfig) {
                    noticeStr = `${formatDateTimeString(savedEndConfig)} 까지 신청 가능`;
                }
                
                var myCurrentCount = getMyTotalCount();
                var myAnnualCount = getMyAnnualCount();
                var customLimitStr = getFirebaseItem(`rq_limit_${currentUser}`, null);
                var globalUserMax = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
                var personalQuotaDisp = getAnnualQuota(currentUser);
                var annualMaxLimit = personalQuotaDisp !== null ? personalQuotaDisp : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
                var maxLimit = customLimitStr !== null ? parseInt(customLimitStr) : globalUserMax;
                
                if(toggleModeBtn) { toggleModeBtn.style.display = "flex"; }
                if(userResetBtn) userResetBtn.style.display = "flex";
                if(resetBtn) resetBtn.style.display = "none"; 
                if(resetConfigBtn) resetConfigBtn.style.display = "none"; 
                if(adminConsole) adminConsole.style.display = "none";

                // 스케줄 코드 버튼 표시/숨김 및 텍스트 갱신
                var scBtn = document.getElementById("scheduleCodeApplyBtn");
                var scList = getScheduleCodeList();
                if (scBtn) {
                    if (scList.length > 0) {
                        scBtn.style.display = "flex";
                        if (currentAppMode === "SCHEDULE_CODE") {
                            scBtn.innerText = currentScheduleCode;
                        } else {
                            scBtn.innerText = "근무";
                        }
                    } else {
                        scBtn.style.display = "none";
                    }
                }
                // 활성/비활성 버튼 색상 통일 적용
                if (toggleModeBtn) {
                    if (currentAppMode === "NORMAL")   toggleModeBtn.innerText = "휴무";
                    if (currentAppMode === "PETITION") toggleModeBtn.innerText = "청원";
                    if (currentAppMode === "ANNUAL")   toggleModeBtn.innerText = "연차";
                }
                setModeButtonStyles();

                // 스케줄 코드 제한 현황 설명란 추가
                var scInfoStr = "";
                if (scList.length > 0) {
                    var scInfoParts = scList.map(function(c) {
                        var myUsed = getMyScheduleCodeCount(c.name);
                        return `${c.name}: ${myUsed}/${c.limit}개`;
                    });
                    scInfoStr = `<br>🗓️ 스케줄코드 현황: ${scInfoParts.join(" | ")}`;
                }

                document.getElementById("welcomeMessage").innerHTML = `📅 ${tm.label}<br><span style="font-size:13px; color:#007bff; font-weight:bold;">[${currentUser}]님 로그인함 (날짜 클릭 시 즉시 휴무/청원/연차 신청/취소)<br>📊 나의 현황: 휴무 <mark style="background:#e6f2ff; color:#0056b3; font-weight:bold; padding:2px 4px; border-radius:3px;">${myCurrentCount} / ${maxLimit}</mark> | 연차 <mark style="background:#e6f4ea; color:#137333; font-weight:bold; padding:2px 4px; border-radius:3px;">${myAnnualCount} / ${annualMaxLimit}</mark> (※ 청원 무제한)${scInfoStr}<br>⏱️ 기간 : ${noticeStr}</span>`;

                loadUserCalendarData();
            }
        }

        function resetMyRequests() {
            if (isAdmin || isSuperAdmin) return;
            // 커스텀 선택 팝업 표시
            document.getElementById("resetChoiceModal").style.display = "flex";
        }

        function closeResetChoiceModal() {
            document.getElementById("resetChoiceModal").style.display = "none";
        }

        function executeResetChoice(mode) {
            closeResetChoiceModal();
            var tm = getTargetYearMonth();
            var deletedCount = 0;

            var rqPrefix = "rq_" + currentUser + "_" + tm.fullStr + "_";
            var scUserPattern = "_" + currentUser + "_" + tm.fullStr + "_";

            if (mode === "ALL") {
                // 휴무/청원 + 스케줄 코드 (연차 보호)
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith(rqPrefix) && !key.endsWith("_annual")) {
                        setFirebaseItem(key, null); deletedCount++;
                    }
                });
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith("sc_") && key.includes(scUserPattern)
                        && !key.startsWith("sc_glimit_")) {
                        setFirebaseItem(key, null); deletedCount++;
                    }
                });
                alert(deletedCount > 0 ? "✨ 휴무 + 스케줄 코드 초기화 완료. (연차 내역 보존)" : "ℹ️ 삭제할 내역이 없습니다.");

            } else if (mode === "SCHEDULE") {
                // 스케줄 코드만
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith("sc_") && key.includes(scUserPattern)
                        && !key.startsWith("sc_glimit_")) {
                        setFirebaseItem(key, null); deletedCount++;
                    }
                });
                alert(deletedCount > 0 ? "✨ 스케줄 코드 내역이 초기화되었습니다." : "ℹ️ 삭제할 스케줄 코드 내역이 없습니다.");

            } else if (mode === "HOLIDAY") {
                // 휴무/청원만 (연차 보호)
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith(rqPrefix) && !key.endsWith("_annual")) {
                        setFirebaseItem(key, null); deletedCount++;
                    }
                });
                alert(deletedCount > 0 ? "✨ 휴무/청원 내역이 초기화되었습니다. (연차 보존)" : "ℹ️ 삭제할 휴무 내역이 없습니다.");
            }
        }

        function closeCalendar() {
            // Firebase 리스너 전체 해제
            _deptListeners.forEach(function(item) {
                db.ref(item.path).off(item.event, item.fn);
            });
            _deptListeners = [];
            dbListener = null;
            modal.style.display = "none";
            document.getElementById("username").value = "";
            document.getElementById("password").value = "";
            if(document.getElementById("targetEmpName")) document.getElementById("targetEmpName").value = "";
            if(document.getElementById("limitEmpName")) document.getElementById("limitEmpName").value = "";
            if(document.getElementById("limitEmpCount")) document.getElementById("limitEmpCount").value = "";
            if(document.getElementById("groupTargetName")) document.getElementById("groupTargetName").value = "";
            if(document.getElementById("manageIdInput")) document.getElementById("manageIdInput").value = "";
            if(document.getElementById("specialDayInput")) document.getElementById("specialDayInput").value = "";
            if(document.getElementById("specialDayLimit")) document.getElementById("specialDayLimit").value = "";
            if(document.getElementById("annualUserMaxConfig")) document.getElementById("annualUserMaxConfig").value = "";
            if(document.getElementById("annualExcelUpload")) document.getElementById("annualExcelUpload").value = "";
            if(document.getElementById("groupMaxConfigD")) document.getElementById("groupMaxConfigD").value = "";
            if(document.getElementById("groupMaxConfigE")) document.getElementById("groupMaxConfigE").value = "";
            
            currentUser = "";
            currentDept = "";
            isAdmin = false;
            isSuperAdmin = false;
            _superResetTargetAdminId = "";
            // 슈퍼관리자 패널 및 팝업 숨김
            var sap = document.getElementById("superAdminPanel");
            if (sap) sap.style.display = "none";
            var srm = document.getElementById("superResetChoiceModal");
            if (srm) srm.style.display = "none";
            var grid = document.getElementById("mainCalendarGrid");
            if (grid) grid.style.display = "";
            currentAppMode = "NORMAL";
            currentScheduleCode = "";
            var btn = document.getElementById("toggleModeBtn");
            if (btn) { btn.innerText = "휴무"; }
            var scBtn = document.getElementById("scheduleCodeApplyBtn");
            if (scBtn) { scBtn.innerText = "근무"; scBtn.style.display = "none"; }
            setModeButtonStyles();
            document.getElementById("loginArea").style.display = "block";
        }

        function editDate(date) {
            var tm = getTargetYearMonth();
            if (isSuperAdmin) return; // 슈퍼관리자는 날짜 클릭 불가
            if (isAdmin) {
                manageAdminSelection(date);
                return;
            }

            var savedConfig = getFirebaseItem("rq_allowed_start_datetime", null);
            if (savedConfig) {
                var openTimestamp = new Date(savedConfig).getTime();
                var currentTimestamp = new Date().getTime();
                
                if (currentTimestamp < openTimestamp) {
                    alert(`❌ 신청 차단!\n현재는 신청 기간이 아닙니다.\n\n시스템 오픈 예정 일시:\n${formatDateTimeString(savedConfig)}`);
                    return;
                }
            }

            var savedEndConfig = getFirebaseItem("rq_allowed_end_datetime", null);
            if (savedEndConfig) {
                var closeTimestamp = new Date(savedEndConfig).getTime();
                var currentTimestamp = new Date().getTime();

                if (currentTimestamp > closeTimestamp) {
                    alert(`❌ 신청 마감!\n현재는 신청 기간이 종료되었습니다.\n\n시스템 마감 처리 일시:\n${formatDateTimeString(savedEndConfig)}`);
                    return;
                }
            }

            var dataKey = `rq_${currentUser}_${tm.fullStr}_${date}`;
            
            var existingNormalData = getFirebaseItem(dataKey, null);
            var existingPetitionData = getFirebaseItem(dataKey + "_petition", null);
            var existingAnnualData = getFirebaseItem(dataKey + "_annual", null);

            // 이미 그 날 스케줄 코드가 입력되어 있는지 확인
            var existingScCode = null;
            var scList = getScheduleCodeList();
            scList.forEach(function(c) {
                var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + date;
                if (liveDBData[scKey] !== undefined) existingScCode = c.name;
            });

            // 취소 처리 (이미 입력된 항목 클릭 시)
            if (existingNormalData !== null) {
                if (confirm(`${parseInt(tm.month)}월 ${date}일에 신청한 일반 휴무를 취소하시겠습니까?`)) {
                    setFirebaseItem(dataKey, null);
                    _adjustCounter(date, -1);
                }
                return;
            }
            if (existingPetitionData !== null) {
                if (confirm(`${parseInt(tm.month)}월 ${date}일에 신청한 청원 휴가를 취소하시겠습니까?`)) {
                    setFirebaseItem(dataKey + "_petition", null);
                }
                return;
            }
            if (existingAnnualData !== null) {
                if (confirm(`${parseInt(tm.month)}월 ${date}일에 신청한 연차를 취소하시겠습니까?`)) {
                    setFirebaseItem(dataKey + "_annual", null);
                }
                return;
            }
            if (existingScCode !== null) {
                if (confirm(`${parseInt(tm.month)}월 ${date}일에 입력된 스케줄 코드 [${existingScCode}]를 취소하시겠습니까?`)) {
                    setFirebaseItem("sc_" + existingScCode + "_" + currentUser + "_" + tm.fullStr + "_" + date, null);
                }
                return;
            }

            // 해당 날짜에 이미 다른 항목이 있으면 신규 입력 차단
            // (위에서 존재하는 항목은 모두 return 처리됐으므로 여기 오면 빈 날짜)

            if (currentAppMode === "SCHEDULE_CODE") {
                if (!currentScheduleCode) { alert("스케줄 코드가 선택되지 않았습니다."); return; }
                var scListForApply = getScheduleCodeList();
                var codeObj = scListForApply.find(function(c){ return c.name === currentScheduleCode; });
                if (!codeObj) { alert("선택된 코드를 찾을 수 없습니다."); return; }
                var scKey = "sc_" + currentScheduleCode + "_" + currentUser + "_" + tm.fullStr + "_" + date;
                var myUsed = getMyScheduleCodeCount(currentScheduleCode);
                if (myUsed >= codeObj.limit) {
                    alert("❌ 신청 불가! [" + currentScheduleCode + "] 코드 개인 제한(" + codeObj.limit + "개)을 초과하였습니다.");
                    return;
                }

                // 조별 일자 제한 체크
                var myGroupLetter = null;
                if (getLiveGroupList('A').includes(currentUser)) myGroupLetter = 'A';
                else if (getLiveGroupList('B').includes(currentUser)) myGroupLetter = 'B';
                else if (getLiveGroupList('C').includes(currentUser)) myGroupLetter = 'C';
                else if (getLiveGroupList('D').includes(currentUser)) myGroupLetter = 'D';
                else if (getLiveGroupList('E').includes(currentUser)) myGroupLetter = 'E';

                if (myGroupLetter !== null) {
                    var groupLimit = getScGroupLimit(currentScheduleCode, myGroupLetter);
                    if (groupLimit !== null) {
                        var groupArr = getLiveGroupList(myGroupLetter);
                        var groupUsed = getGroupScCodeCountByDate(groupArr, currentScheduleCode, date);
                        if (groupUsed >= groupLimit) {
                            alert("❌ 신청 불가! [" + currentScheduleCode + "] 코드는 " + myGroupLetter + "조에서 해당 일자에 최대 " + groupLimit + "명까지만 사용 가능합니다.\n(현재 " + groupUsed + "명 사용 중)");
                            return;
                        }
                    }
                }

                setFirebaseItem(scKey, new Date().getTime());
                return;
            }

            if (currentAppMode === "PETITION") {
                setFirebaseItem(dataKey + "_petition", new Date().getTime());
                return;
            }

            if (currentAppMode === "ANNUAL") {
                var myAnnualCount = getMyAnnualCount();
                // 개인 연차 할당량 우선, 없으면 글로벌 제한
                var personalQuota = getAnnualQuota(currentUser);
                var annualUserMax = personalQuota !== null ? personalQuota : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
                if (myAnnualCount >= annualUserMax) {
                    alert("❌ 신청 불가! 배정된 연차 개수(" + annualUserMax + "개)를 모두 소진하셨습니다.");
                    return;
                }
                setFirebaseItem(dataKey + "_annual", new Date().getTime());
                return;
            }

            var specialDayLimitVal = getFirebaseItem(`rq_special_limit_${tm.fullStr}_${date}`, null);
            var configDayMax = specialDayLimitVal !== null ? parseInt(specialDayLimitVal) : parseInt(getFirebaseItem("rq_config_day_max", "10"));
            
            var dayTotalCount = getDayTotalCount(date); 
            if (dayTotalCount >= configDayMax) {
                alert(`❌ 신청 불가! ${parseInt(tm.month)}월 ${date}일은 선착순 휴무 제한 한도(${configDayMax}명)가 완전히 마감되었습니다.`);
                return;
            }

            var myTotalCount = getMyTotalCount(); 
            var customLimitStr = getFirebaseItem(`rq_limit_${currentUser}`, null);
            var globalUserMax = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
            
            if (customLimitStr !== null) {
                var customLimit = parseInt(customLimitStr);
                if (myTotalCount >= customLimit) {
                    alert(`❌ 신청 불가!\n관리자 특별 설정에 의해 회원님은 이번 달 최대 [ ${customLimit}개 ]까지만 신청이 허용되어 있습니다.\n추가 조율이 필요한 경우 관리자에게 문의바랍니다.`);
                    return;
                }
            } else {
                if (myTotalCount >= globalUserMax) {
                    alert(`❌ 신청 불가! 이번 달 배정된 기본 휴무 신청 제한 개수 ${globalUserMax}개를 모두 소진하셨습니다.`);
                    return;
                }
            }

            var liveGroupA = getLiveGroupList('A');
            var liveGroupB = getLiveGroupList('B');
            var liveGroupC = getLiveGroupList('C');
            var liveGroupD = getLiveGroupList('D');
            var liveGroupE = getLiveGroupList('E');

            if (liveGroupA.includes(currentUser)) {
                var maxA = parseInt(getFirebaseItem("rq_config_group_max_A", "2"));
                var groupACount = getGroupCountByDate(liveGroupA, date);
                if (groupACount >= maxA) {
                    alert(`❌ 신청 불가! [그룹 제한] 당일 해당 조(A조)에서 이미 제한 개수(${maxA}명)가 마감되었습니다.`);
                    return;
                }
            }
            if (liveGroupB.includes(currentUser)) {
                var maxB = parseInt(getFirebaseItem("rq_config_group_max_B", "2"));
                var groupBCount = getGroupCountByDate(liveGroupB, date);
                if (groupBCount >= maxB) {
                    alert(`❌ 신청 불가! [그룹 제한] 당일 해당 조(B조)에서 이미 제한 개수(${maxB}명)가 마감되었습니다.`);
                    return;
                }
            }
            if (liveGroupC.includes(currentUser)) {
                var maxC = parseInt(getFirebaseItem("rq_config_group_max_C", "2"));
                var groupCCount = getGroupCountByDate(liveGroupC, date);
                if (groupCCount >= maxC) {
                    alert(`❌ 신청 불가! [그룹 제한] 당일 해당 조(C조)에서 이미 제한 개수(${maxC}명)가 마감되었습니다.`);
                    return;
                }
            }
            if (liveGroupD.includes(currentUser)) {
                var maxD = parseInt(getFirebaseItem("rq_config_group_max_D", "2"));
                var groupDCount = getGroupCountByDate(liveGroupD, date);
                if (groupDCount >= maxD) {
                    alert(`❌ 신청 불가! [그룹 제한] 당일 해당 조(D조)에서 이미 제한 개수(${maxD}명)가 마감되었습니다.`);
                    return;
                }
            }
            if (liveGroupE.includes(currentUser)) {
                var maxE = parseInt(getFirebaseItem("rq_config_group_max_E", "2"));
                var groupECount = getGroupCountByDate(liveGroupE, date);
                if (groupECount >= maxE) {
                    alert(`❌ 신청 불가! [그룹 제한] 당일 해당 조(E조)에서 이미 제한 개수(${maxE}명)가 마감되었습니다.`);
                    return;
                }
            }

            setFirebaseItem(dataKey, new Date().getTime());
            _adjustCounter(date, +1);
        }

        // ====== 날짜별 카운터 증감 (counters 경로) ======
        function _adjustCounter(date, delta) {
            if (!isSuperAdmin) return;
        }

        function getGroupCountByDate(groupArray, date) {
            var count = 0;
            var tm = getTargetYearMonth();
            groupArray.forEach(function(member) {
                if (liveDBData[`rq_${member}_${tm.fullStr}_${date}`]) {
                    count++;
                }
            });
            return count;
        }

        function manageAdminSelection(date) {
            var applicants = [];
            var tm = getTargetYearMonth();
            var targetSuffix = "_" + tm.fullStr + "_" + date;

            // 휴무 / 청원 / 연차 수집
            // 키 형태: rq_이름_YYYYMM_일 / rq_이름_YYYYMM_일_petition / rq_이름_YYYYMM_일_annual
            Object.keys(liveDBData).forEach(function(key) {
                if (!key.startsWith("rq_")) return;
                // 설정/메타 키 제외
                if (key.startsWith("rq_special_limit_") || key.startsWith("rq_limit_")
                    || key.startsWith("rq_config_") || key.startsWith("rq_allowed_")
                    || key.startsWith("rq_current_") || key.startsWith("rq_live_group_")) return;

                var empName, regTime;
                if (key.endsWith(targetSuffix + "_annual")) {
                    // annual 먼저 체크 (endsWith targetSuffix보다 긴 패턴 우선)
                    empName = key.slice(3, key.length - (targetSuffix + "_annual").length);
                    regTime = Number(liveDBData[key]) || 9999999999999;
                    if (empName) applicants.push({ key: key, name: empName + " (🟢연차)", time: regTime });
                } else if (key.endsWith(targetSuffix + "_petition")) {
                    empName = key.slice(3, key.length - (targetSuffix + "_petition").length);
                    regTime = Number(liveDBData[key]) || 9999999999999;
                    if (empName) applicants.push({ key: key, name: empName + " (⚠️청원)", time: regTime });
                } else if (key.endsWith(targetSuffix)) {
                    empName = key.slice(3, key.length - targetSuffix.length);
                    regTime = Number(liveDBData[key]) || 9999999999999;
                    if (empName) applicants.push({ key: key, name: empName + " (휴무)", time: regTime });
                }
            });

            // 스케줄 코드 수집 (키: sc_코드명_이름_YYYYMM_일)
            var scList = getScheduleCodeList();
            scList.forEach(function(codeObj) {
                var prefix = "sc_" + codeObj.name + "_";
                Object.keys(liveDBData).forEach(function(key) {
                    if (key.startsWith(prefix) && key.endsWith(targetSuffix)) {
                        // prefix 이후 ~ targetSuffix 이전 부분이 이름
                        var rest = key.slice(prefix.length); // "이름_YYYYMM_일"
                        // targetSuffix는 "_YYYYMM_일" 형태이므로 앞의 _ 포함
                        var empName = rest.slice(0, rest.length - targetSuffix.length);
                        if (empName === "") return; // 잘못된 키 스킵
                        var regTime = Number(liveDBData[key]) || 9999999999999;
                        applicants.push({ key: key, name: empName + " (" + codeObj.name + ")", time: regTime });
                    }
                });
            });

            if (applicants.length === 0) {
                alert(parseInt(tm.month) + "월 " + date + "일에는 신청된 내역이 없습니다.");
                return;
            }

            applicants.sort(function(a, b) { return a.time - b.time; });

            var message = "[관리자] " + parseInt(tm.month) + "월 " + date + "일 신청 명단입니다.\n삭제할 번호를 입력하세요 (취소는 '취소' 클릭)\n\n";
            applicants.forEach(function(item, index) {
                message += (index + 1) + ". " + item.name + "\n";
            });

            var selectIndexStr = prompt(message);
            if (selectIndexStr !== null) {
                var selectedIndex = parseInt(selectIndexStr.trim()) - 1;
                if (isNaN(selectedIndex) || selectedIndex < 0 || selectedIndex >= applicants.length) {
                    alert("❌ 번호를 잘못 입력하셨습니다.");
                    return;
                }
                var targetUser = applicants[selectedIndex];
                if (confirm("진짜로 [" + targetUser.name + "] 내역을 삭제하시겠습니까?")) {
                    setFirebaseItem(targetUser.key, null);
                    // 휴무(NORMAL)만 카운터 차감 (청원/연차는 카운터 미포함)
                    if (targetUser.type === "NORMAL") _adjustCounter(date, -1);
                    alert("삭제 완료.");
                }
            }
        }
        function getMyTotalCount() {
            var count = 0;
            var tm = getTargetYearMonth();
            var targetPrefix = `rq_${currentUser}_${tm.fullStr}_`;
            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith(targetPrefix) && !key.endsWith("_petition") && !key.endsWith("_annual")) {
                    count++;
                }
            });
            return count;
        }

        function getMyAnnualCount() {
            var count = 0;
            var tm = getTargetYearMonth();
            var targetPrefix = `rq_${currentUser}_${tm.fullStr}_`;
            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith(targetPrefix) && key.endsWith("_annual")) {
                    count++;
                }
            });
            return count;
        }

        // 관리자용: 해당 날짜 전체 신청 인원수 (청원/연차 포함)
        function getDayTotalCountAll(date) {
            var count = 0;
            var tm = getTargetYearMonth();
            var targetSuffix = `_${tm.fullStr}_${date}`;
            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith("rq_") && !key.startsWith("rq_special_limit_")
                    && !key.startsWith("rq_limit_") && !key.startsWith("rq_config_")
                    && !key.startsWith("rq_allowed_") && !key.startsWith("rq_current_")
                    && !key.startsWith("rq_live_group_")
                    && key.endsWith(targetSuffix)) {
                    count++;
                }
            });
            return count;
        }

        function getDayTotalCount(date) {
            // counters 캐시에서 읽기 → 전체 liveDBData 순회 불필요
            return _countersCache[String(date)] || 0;
        }

        function loadUserCalendarData() {
            var tm = getTargetYearMonth();
            var totalDaysInMonth = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
            var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));
            var scList = getScheduleCodeList();

            for (var d = 1; d <= totalDaysInMonth; d++) {
                var cell = document.getElementById("d-" + d);
                if(!cell) continue;
                cell.innerHTML = d;

                var specialDayLimitVal = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
                var dayMax = specialDayLimitVal !== null ? parseInt(specialDayLimitVal) : configDayMax;
                var total = _countersCache[String(d)] || 0;

                var badge = document.createElement("span");
                badge.className = "count-badge " + (total >= dayMax ? "badge-full" : "badge-safe");
                badge.innerText = total + "/" + dayMax + "명";
                cell.appendChild(badge);

                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d]) {
                    var n1 = document.createElement("div");
                    n1.className = "user-note"; n1.innerText = "휴무"; cell.appendChild(n1);
                }
                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d + "_petition"]) {
                    var n2 = document.createElement("div");
                    n2.className = "user-note petition"; n2.innerText = "청원"; cell.appendChild(n2);
                }
                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d + "_annual"]) {
                    var n3 = document.createElement("div");
                    n3.className = "user-note annual"; n3.innerText = "연차"; cell.appendChild(n3);
                }
                scList.forEach(function(c) {
                    var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + d;
                    if (liveDBData[scKey] !== undefined) {
                        var col = getScheduleCodeColor(c.name);
                        var scDiv = document.createElement("div");
                        scDiv.className = "user-note";
                        scDiv.style.backgroundColor = col.bg;
                        scDiv.style.border = "1px solid " + col.border;
                        scDiv.style.color = col.color;
                        scDiv.innerText = c.name;
                        cell.appendChild(scDiv);
                    }
                });
            }
        }

        function loadAdminCalendarData() {
            var tm = getTargetYearMonth();
            var targetSuffix = `_${tm.fullStr}_`;
            var totalDaysInMonth = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
            
            for (var d = 1; d <= totalDaysInMonth; d++) {
                var cell = document.getElementById("d-" + d);
                if(!cell) continue;
                cell.innerHTML = `<strong>${d}</strong>`;

                var specialDayLimitVal = getFirebaseItem(`rq_special_limit_${tm.fullStr}_${d}`, null);
                var currentMax = specialDayLimitVal !== null ? parseInt(specialDayLimitVal) : "기본";

                var total = getDayTotalCountAll(d); // 관리자는 청원/연차 포함 전체 카운트
                var badge = document.createElement("span");
                badge.className = "count-badge " + (specialDayLimitVal !== null ? "badge-full" : "badge-safe");
                badge.innerText = `총 ${total}명 / 한도:${currentMax}`;
                badge.style.fontSize = "10px";
                cell.appendChild(badge);

                var listContainer = document.createElement("div");
                listContainer.className = "admin-list";

                var dayApplicants = [];
                var daySuffix = targetSuffix + d;  // "_YYYYMM_" + d
                Object.keys(liveDBData).forEach(function(key) {
                    if (!key.startsWith("rq_") || key.startsWith("rq_special_limit_")
                        || key.startsWith("rq_limit_") || key.startsWith("rq_config_")
                        || key.startsWith("rq_allowed_") || key.startsWith("rq_current_")
                        || key.startsWith("rq_live_group_")) return;
                    if (!key.includes(targetSuffix)) return;

                    var empName, regTime;
                    if (key.endsWith(daySuffix + "_annual")) {
                        empName = key.slice(3, key.length - (daySuffix + "_annual").length);
                        regTime = Number(liveDBData[key]) || 9999999999999;
                        if (empName) dayApplicants.push({ name: empName, type: "ANNUAL", time: regTime });
                    } else if (key.endsWith(daySuffix + "_petition")) {
                        empName = key.slice(3, key.length - (daySuffix + "_petition").length);
                        regTime = Number(liveDBData[key]) || 9999999999999;
                        if (empName) dayApplicants.push({ name: empName, type: "PETITION", time: regTime });
                    } else if (key.endsWith(daySuffix)) {
                        empName = key.slice(3, key.length - daySuffix.length);
                        regTime = Number(liveDBData[key]) || 9999999999999;
                        if (empName) dayApplicants.push({ name: empName, type: "NORMAL", time: regTime });
                    }
                });

                dayApplicants.sort(function(a, b) { return a.time - b.time; });

                dayApplicants.forEach(function(user) {
                    var item = document.createElement("div");
                    if (user.type === "PETITION") {
                        item.className = "admin-item petition-item";
                        item.innerText = `${user.name}(청)`;
                    } else if (user.type === "ANNUAL") {
                        item.className = "admin-item annual-item";
                        item.innerText = `${user.name}(연)`;
                    } else {
                        item.className = "admin-item";
                        item.innerText = `${user.name}`;
                    }
                    listContainer.appendChild(item);
                });

                cell.appendChild(listContainer);

                // 스케줄 코드 관리자 표시 (고유 색상)
                var scList = getScheduleCodeList();
                scList.forEach(function(c) {
                    var col = getScheduleCodeColor(c.name);
                    var scApplicants = [];
                    var scPrefix = "sc_" + c.name + "_";
                    var scSuffix = "_" + tm.fullStr + "_" + d;
                    Object.keys(liveDBData).forEach(function(key) {
                        if (key.startsWith(scPrefix) && key.endsWith(scSuffix)) {
                            // sc_코드명_이름_YYYYMM_일 → 이름 정확 추출
                            var scEmpName = key.slice(scPrefix.length, key.length - scSuffix.length);
                            if (scEmpName) scApplicants.push(scEmpName);
                        }
                    });
                    if (scApplicants.length > 0) {
                        var scBadge = document.createElement("div");
                        scBadge.style.cssText = "font-size:10px; color:" + col.color + "; background:" + col.bg + "; border:1px solid " + col.border + "; border-radius:4px; padding:2px 4px; margin-top:2px; width:100%; box-sizing:border-box; font-weight:bold;";
                        scBadge.innerText = "[" + c.name + "] " + scApplicants.join(", ");
                        cell.appendChild(scBadge);
                    }
                });
            }
        }

        function setUserRequestLimit(isSet) {
            if (!isAdmin) return;
            var targetName = document.getElementById("limitEmpName").value.trim();

            if (targetName === "") {
                alert("직원의 이름을 입력해주세요.");
                return;
            }
            if (targetName === currentUser && isAdmin) {
                alert("관리자 계정은 제한 설정을 부여할 수 없습니다.");
                return;
            }
            if (!allowedUsers.includes(targetName)) {
                alert(`🛑 오류: '${targetName}' 직원은 명단에 등록되지 않은 이름입니다.`);
                return;
            }

            var limitKey = `rq_limit_${targetName}`;
            if (isSet) {
                var countInput = document.getElementById("limitEmpCount").value.trim();
                var countVal = parseInt(countInput);
                if (countInput === "" || isNaN(countVal) || countVal < 0) {
                    alert("❌ 올바른 제한 개수(0 이상의 숫자)를 입력해주세요. (0 입력 시 신청 원천 차단 효과)");
                    return;
                }
                setFirebaseItem(limitKey, countVal);
                alert(`📊 적용 완료.`);
            } else {
                setFirebaseItem(limitKey, null);
                alert(`✨ 초기화 완료.`);
            }
            document.getElementById("limitEmpName").value = "";
            document.getElementById("limitEmpCount").value = "";
        }

        function resetUserPassword() {
            if (!isAdmin) return;
            
            var targetName = document.getElementById("targetEmpName").value.trim();
            
            if (targetName === "") {
                alert("초기화할 직원의 이름을 입력해주세요.");
                return;
            }
            
            if (targetName === currentUser && isAdmin) {
                alert("관리자 계정은 자기 자신을 개별 초기화할 수 없습니다.");
                return;
            }
            
            if (!allowedUsers.includes(targetName)) {
                alert(`🛑 오류: '${targetName}' 직원은 등록 대상 명단에 없는 이름입니다.`);
                return;
            }
            
            var pwdKey = "user_pwd_" + targetName;
            var currentPwd = liveDBData[pwdKey];
            
            if (currentPwd === undefined) {
                alert(`ℹ️ '${targetName}' 직원은 아직 비밀번호를 등록하지 않은 상태(초기 세팅 전)입니다.`);
                return;
            }
            
            if (confirm(`진짜로 [${targetName}] 직원의 비밀번호를 초기 상태(세팅 전)로 되돌리시겠습니까?\n실행 후 해당 직원은 새 비밀번호로 다시 등록해야 접속할 수 있습니다.`)) {
                setFirebaseItem(pwdKey, null);
                alert(`✨ 초기화 완료.`);
                document.getElementById("targetEmpName").value = ""; 
            }
        }

        function saveDateTimeConfig() {
            if (!isAdmin) return;
            var inputVal = document.getElementById("startDateTimeConfig").value;
            if (inputVal === "") {
                alert("❌ 오픈 일시를 정확하게 선택해주세요.");
                return;
            }
            setFirebaseItem("rq_allowed_start_datetime", inputVal);
            alert("✨ 적용 완료.");
        }

        function saveEndDateTimeConfig() {
            if (!isAdmin) return;
            var inputVal = document.getElementById("endDateTimeConfig").value;
            if (inputVal === "") {
                alert("❌ 마감 일시를 정확하게 선택해주세요.");
                return;
            }
            setFirebaseItem("rq_allowed_end_datetime", inputVal);
            alert("✨ 적용 완료.");
        }

        function resetAllPasswords() {
            if (!isAdmin) return;

            if (confirm("💥 시스템에 등록된 '모든 직원'의 비밀번호를 초기화하시겠습니까?")) {
                if (confirm("🛑 최종 확인: 이 작업은 되돌릴 수 없습니다. 진행할까요?")) {
                    Object.keys(liveDBData).forEach(function(key) {
                        if (key.startsWith("user_pwd_") && key !== "user_pwd_" + currentUser) {
                            setFirebaseItem(key, null);
                        }
                    });
                    alert("✨ 전체 초기화 완료.");
                }
            }
        }

        function resetAllRequests() {
            if (!isAdmin) return;
            var tm = getTargetYearMonth();
            
            if (confirm("⚠️ 경고: 등록된 모든 직원의 [ " + tm.label + " ] 휴무/청원/연차/스케줄 코드 입력 내역을 전체 초기화 하시겠습니까?")) {
                if (confirm("🛑 데이터 유실 경고: 삭제된 내역은 절대로 복구할 수 없습니다. 정말로 진행하시겠습니까?")) {
                    var targetSuffix = "_" + tm.fullStr + "_";

                    Object.keys(liveDBData).forEach(function(key) {
                        // 휴무/청원 (연차_annual은 보호)
                        if (key.startsWith("rq_") && key.includes(targetSuffix)
                            && !key.startsWith("rq_special_limit_")
                            && !key.startsWith("rq_limit_")
                            && !key.startsWith("rq_config_")
                            && !key.startsWith("rq_allowed_")
                            && !key.startsWith("rq_current_")
                            && !key.startsWith("rq_live_group_")
                            && !key.endsWith("_annual")) {   // ← 연차 보호
                            setFirebaseItem(key, null);
                        }
                        // 스케줄 코드 (sc_코드명_이름_YYYYMM_일 형태)
                        if (key.startsWith("sc_") && key.includes(targetSuffix)
                            && !key.startsWith("sc_glimit_")) {
                            setFirebaseItem(key, null);
                        }
                    });
                    
                    alert("✨ 스케줄 전체 초기화 완료.\n(연차 내역 및 연차 할당량은 보존됩니다)");
                }
            }
        }

        function resetAllConfigurations() {
            if (!isAdmin) return;

            if (confirm("⚙️ 경고: 관리자 제어 환경 설정값만 초기 상태로 리셋하시겠습니까?\n\n✅ 유지되는 항목:\n- 직원 휴무/청원/연차 신청 내역\n- 스케줄 코드 입력 내역\n- 생성된 스케줄 코드 목록\n- 비밀번호 / ID 명단 / 그룹 편성\n\n🛑 초기화되는 항목:\n- 신청 년월 / 오픈·마감 일시\n- 일별·직원별·조별 신청 제한\n- 특정일 인원 제한\n- 스케줄 코드 조별 일자 제한")) {
                if (confirm("🛑 최종 확인: 진행할까요?")) {
                    
                    var keysToRemove = [
                        "rq_current_target_year_month",
                        "rq_allowed_start_datetime",
                        "rq_allowed_end_datetime",
                        "rq_config_day_max",
                        "rq_config_global_user_max",
                        "rq_config_annual_user_max",
                        "rq_config_group_max_A",
                        "rq_config_group_max_B",
                        "rq_config_group_max_C",
                        "rq_config_group_max_D",
                        "rq_config_group_max_E"
                    ];

                    keysToRemove.forEach(function(key) {
                        setFirebaseItem(key, null);
                    });

                    // 특정일 제한 / 직원별 제한 / 스케줄코드 조별 제한 삭제
                    Object.keys(liveDBData).forEach(function(key) {
                        if (key.startsWith("rq_special_limit_") || key.startsWith("rq_limit_") || key.startsWith("sc_glimit_")) {
                            setFirebaseItem(key, null);
                        }
                    });

                    alert("✨ 설정 전체 초기화 완료.\n(신청 내역 및 스케줄 코드 입력 데이터는 그대로 유지됩니다)");
                }
            }
        }

