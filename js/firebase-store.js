        function connectDeptDB(dept, onFirstLoad) {
            // 기존 리스너 전체 해제
            _deptListeners.forEach(function(item) {
                db.ref(item.path).off(item.event, item.fn);
            });
            _deptListeners = [];
            dbListener = dept;
            liveDBData = {};

            var basePath = "trinity_system/" + dept;

            // 1) 설정값 및 메타데이터 (변경 드문 경로) - 한 번만 읽기
            var metaKeys = [
                "allowed_users_list", "rq_current_target_year_month",
                "rq_allowed_start_datetime", "rq_allowed_end_datetime",
                "rq_config_day_max", "rq_config_global_user_max",
                "rq_config_annual_user_max",
                "rq_config_group_max_A", "rq_config_group_max_B",
                "rq_config_group_max_C", "rq_config_group_max_D",
                "rq_config_group_max_E",
                "schedule_codes_list"
            ];
            var metaLoaded = 0;
            metaKeys.forEach(function(key) {
                db.ref(basePath + "/" + key).once("value", function(snap) {
                    if (snap.val() !== null) liveDBData[key] = snap.val();
                    metaLoaded++;
                    if (metaLoaded === metaKeys.length) {
                        // allowed_users_list 파싱
                        var savedUsersStr = liveDBData["allowed_users_list"];
                        if (savedUsersStr !== undefined && savedUsersStr !== null) {
                            try { allowedUsers = JSON.parse(savedUsersStr); }
                            catch(e) { console.error("ID 명단 로드 오류"); }
                        } else {
                            allowedUsers = [];
                        }
                        // 2) 실시간 변경이 필요한 데이터만 child_changed 리스너로 구독
                        _subscribeRealtimeKeys(dept);
                        if (onFirstLoad) onFirstLoad();
                    }
                });
            });
        }

        // ====== counters: 날짜별 카운트 캐시 (실시간 구독 대상) ======
        var _countersCache = {}; // { "1": 3, "2": 0, ... }

        function _subscribeRealtimeKeys(dept) {
            var tm = getTargetYearMonth();
            var counterPath = "trinity_system/" + dept + "/counters/" + tm.fullStr;

            // counters 경로만 실시간 구독 → 변경 시 배지만 부분 업데이트
            var counterRef = db.ref(counterPath);
            var onCounterValue = counterRef.on("value", function(snap) {
                _countersCache = snap.val() || {};
                // 달력이 열려있을 때만 배지 갱신
                if (currentUser !== "" && !isAdmin && !isSuperAdmin) {
                    _updateAllBadges();
                } else if (currentUser !== "" && isAdmin) {
                    _throttledRefresh();
                }
            });
            _deptListeners.push({ path: counterPath, event: "value", fn: onCounterValue });

            // 내 신청 데이터만 별도 구독 (내 휴무/청원/연차/스케줄 표시용)
            var myDataPath = "trinity_system/" + dept;
            var myPrefix = "rq_" + currentUser + "_";

            var onMyChildAdded = db.ref(myDataPath).on("child_added", function(snap) {
                liveDBData[snap.key] = snap.val();
            });
            var onMyChildChanged = db.ref(myDataPath).on("child_changed", function(snap) {
                liveDBData[snap.key] = snap.val();
                // 내 데이터 변경 시 내 셀만 갱신
                if (snap.key.startsWith(myPrefix) || snap.key.startsWith("sc_")) {
                    if (currentUser !== "" && !isAdmin) _updateMyUserCells();
                }
            });
            var onMyChildRemoved = db.ref(myDataPath).on("child_removed", function(snap) {
                delete liveDBData[snap.key];
                if (snap.key.startsWith(myPrefix) || snap.key.startsWith("sc_")) {
                    if (currentUser !== "" && !isAdmin) _updateMyUserCells();
                }
            });

            _deptListeners.push({ path: myDataPath, event: "child_added",  fn: onMyChildAdded });
            _deptListeners.push({ path: myDataPath, event: "child_changed", fn: onMyChildChanged });
            _deptListeners.push({ path: myDataPath, event: "child_removed", fn: onMyChildRemoved });
        }

        // 빠른 연속 변경 시 refreshData 중복 호출 방지 (300ms 쓰로틀)
        var _refreshTimer = null;
        function _throttledRefresh() {
            if (_refreshTimer) clearTimeout(_refreshTimer);
            _refreshTimer = setTimeout(function() {
                _refreshTimer = null;
                refreshData();
            }, 300);
        }

        // ====== 배지만 부분 업데이트 (전체 리렌더 없이) ======
        function _updateAllBadges() {
            var tm = getTargetYearMonth();
            var totalDaysInMonth = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
            var configDayMax = parseInt(getFirebaseItem("rq_config_day_max", "10"));

            for (var d = 1; d <= totalDaysInMonth; d++) {
                var cell = document.getElementById("d-" + d);
                if (!cell) continue;

                var specialLimit = getFirebaseItem("rq_special_limit_" + tm.fullStr + "_" + d, null);
                var dayMax = specialLimit !== null ? parseInt(specialLimit) : configDayMax;
                var count = _countersCache[String(d)] || 0;

                var badge = cell.querySelector(".count-badge");
                if (badge) {
                    badge.className = "count-badge " + (count >= dayMax ? "badge-full" : "badge-safe");
                    badge.innerText = count + "/" + dayMax + "명";
                }
            }
        }

        // ====== 내 셀만 부분 업데이트 ======
        function _updateMyUserCells() {
            var tm = getTargetYearMonth();
            var totalDaysInMonth = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
            var scList = getScheduleCodeList();

            for (var d = 1; d <= totalDaysInMonth; d++) {
                var cell = document.getElementById("d-" + d);
                if (!cell) continue;

                // 내 신청 배지들만 제거 후 재생성
                var oldNotes = cell.querySelectorAll(".user-note");
                oldNotes.forEach(function(n) { n.remove(); });

                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d]) {
                    var n = document.createElement("div");
                    n.className = "user-note"; n.innerText = "휴무"; cell.appendChild(n);
                }
                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d + "_petition"]) {
                    var n = document.createElement("div");
                    n.className = "user-note petition"; n.innerText = "청원"; cell.appendChild(n);
                }
                if (liveDBData["rq_" + currentUser + "_" + tm.fullStr + "_" + d + "_annual"]) {
                    var n = document.createElement("div");
                    n.className = "user-note annual"; n.innerText = "연차"; cell.appendChild(n);
                }
                scList.forEach(function(c) {
                    var scKey = "sc_" + c.name + "_" + currentUser + "_" + tm.fullStr + "_" + d;
                    if (liveDBData[scKey] !== undefined) {
                        var col = getScheduleCodeColor(c.name);
                        var n = document.createElement("div");
                        n.className = "user-note";
                        n.style.backgroundColor = col.bg;
                        n.style.border = "1px solid " + col.border;
                        n.style.color = col.color;
                        n.innerText = c.name;
                        cell.appendChild(n);
                    }
                });
            }

            // 상단 현황 텍스트도 갱신
            var myCurrentCount = getMyTotalCount();
            var myAnnualCount = getMyAnnualCount();
            var customLimitStr = getFirebaseItem("rq_limit_" + currentUser, null);
            var globalUserMax = parseInt(getFirebaseItem("rq_config_global_user_max", "4"));
            var maxLimit = customLimitStr !== null ? parseInt(customLimitStr) : globalUserMax;
            var personalQuotaDisp = getAnnualQuota(currentUser);
            var annualMaxLimit = personalQuotaDisp !== null ? personalQuotaDisp : parseInt(getFirebaseItem("rq_config_annual_user_max", "15"));
            var wm = document.getElementById("welcomeMessage");
            if (wm) {
                var tm2 = getTargetYearMonth();
                var scInfoStr = "";
                var scList2 = getScheduleCodeList();
                if (scList2.length > 0) {
                    scInfoStr = "<br>🗓️ 스케줄코드 현황: " + scList2.map(function(c) {
                        return c.name + ": " + getMyScheduleCodeCount(c.name) + "/" + c.limit + "개";
                    }).join(" | ");
                }
                wm.innerHTML = "📅 " + tm2.label + "<br><span style='font-size:13px; color:#007bff; font-weight:bold;'>[" + currentUser + "]님 로그인함 (날짜 클릭 시 즉시 휴무/청원/연차 신청/취소)<br>📊 나의 현황: 휴무 <mark style='background:#e6f2ff; color:#0056b3; font-weight:bold; padding:2px 4px; border-radius:3px;'>" + myCurrentCount + " / " + maxLimit + "</mark> | 연차 <mark style='background:#e6f4ea; color:#137333; font-weight:bold; padding:2px 4px; border-radius:3px;'>" + myAnnualCount + " / " + annualMaxLimit + "</mark> (※ 청원 무제한)" + scInfoStr + "</span>";
            }
        }

        // 팝업 외부 클릭 시 닫기 핸들러 (ID, 그룹 두 가지 모두 처리)
        document.addEventListener("click", function(event) {
            var idBoard = document.getElementById("allowedUsersTooltipBoard");
            var idBtn = document.getElementById("idPopupTriggerBtn");
            if (idBoard && idBoard.classList.contains("active")) {
                if (!idBoard.contains(event.target) && event.target !== idBtn) {
                    idBoard.classList.remove("active");
                }
            }

            var grpBoard = document.getElementById("groupListTooltipBoard");
            var grpBtn = document.getElementById("groupPopupTriggerBtn");
            if (grpBoard && grpBoard.classList.contains("active")) {
                if (!grpBoard.contains(event.target) && event.target !== grpBtn) {
                    grpBoard.classList.remove("active");
                }
            }

            var scBoard = document.getElementById("scheduleCodeTooltipBoard");
            var scTrigger = document.getElementById("scheduleCodeListTrigger");
            if (scBoard && scBoard.classList.contains("active")) {
                if (!scBoard.contains(event.target) && event.target !== scTrigger) {
                    scBoard.classList.remove("active");
                }
            }

            var scGlBoard = document.getElementById("scGroupLimitTooltipBoard");
            var scGlTrigger = document.getElementById("scGroupLimitListTrigger");
            if (scGlBoard && scGlBoard.classList.contains("active")) {
                if (!scGlBoard.contains(event.target) && event.target !== scGlTrigger) {
                    scGlBoard.classList.remove("active");
                }
            }

            var annBoard = document.getElementById("annualStatusTooltipBoard");
            var annTrigger = document.getElementById("annualStatusTrigger");
            if (annBoard && annBoard.classList.contains("active")) {
                if (!annBoard.contains(event.target) && event.target !== annTrigger) {
                    annBoard.classList.remove("active");
                }
            }

            var spBoard = document.getElementById("specialDayTooltipBoard");
            var spTrigger = document.getElementById("specialDayTriggerBtn");
            if (spBoard && spBoard.classList.contains("active")) {
                if (!spBoard.contains(event.target) && event.target !== spTrigger) {
                    spBoard.classList.remove("active");
                }
            }

            var limBoard = document.getElementById("limitListTooltipBoard");
            var limTrigger = document.getElementById("limitListTriggerBtn");
            if (limBoard && limBoard.classList.contains("active")) {
                if (!limBoard.contains(event.target) && event.target !== limTrigger) {
                    limBoard.classList.remove("active");
                }
            }
        });

        function initYearMonthSelects(selectedYear, selectedMonth) {
            var yearSel = document.getElementById("targetYear");
            var monthSel = document.getElementById("targetMonth");
            if (!yearSel || !monthSel) return;

            var currentYear = new Date().getFullYear();
            yearSel.innerHTML = "";
            for (var y = currentYear - 1; y <= currentYear + 2; y++) {
                var opt = document.createElement("option");
                opt.value = y;
                opt.text = y + "년";
                if (String(y) === String(selectedYear)) opt.selected = true;
                yearSel.appendChild(opt);
            }

            monthSel.innerHTML = "";
            for (var m = 1; m <= 12; m++) {
                var mStr = String(m).padStart(2, "0");
                var mOpt = document.createElement("option");
                mOpt.value = mStr;
                mOpt.text = m + "월";
                if (mStr === String(selectedMonth)) mOpt.selected = true;
                monthSel.appendChild(mOpt);
            }
        }

        function getFirebaseItem(key, defaultValue) {
            return liveDBData[key] !== undefined ? liveDBData[key] : defaultValue;
        }

        function setFirebaseItem(key, value) {
            if (!currentDept) {
                console.error("setFirebaseItem 호출 오류: currentDept가 설정되지 않은 상태입니다. (key: " + key + ")");
                return;
            }
            // 로컬 캐시 즉시 반영 (child_changed 콜백 도착 전에 UI가 이미 최신 상태)
            if (value === null) {
                delete liveDBData[key];
            } else {
                liveDBData[key] = value;
            }
            var path = "trinity_system/" + currentDept + "/" + key;
            if (value === null) {
                db.ref(path).remove();
            } else {
                db.ref(path).set(value);
            }
        }
        
        // 🔹 ID 신청 클릭 토글
