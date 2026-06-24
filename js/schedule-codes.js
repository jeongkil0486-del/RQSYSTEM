        var currentScheduleCode = ""; // 현재 선택된 스케줄 코드

        function getScheduleCodeList() {
            var raw = getFirebaseItem("schedule_codes_list", null);
            if (!raw) return [];
            try { return typeof raw === "string" ? JSON.parse(raw) : raw; } catch(e) { return []; }
        }

        function createScheduleCode() {
            if (!isAdmin) return;
            var codeName = document.getElementById("scheduleCodeInput").value.trim();
            var limitVal = document.getElementById("scheduleCodeLimit").value.trim();
            if (codeName === "") { alert("❌ 코드명을 입력해주세요."); return; }
            var limitNum = limitVal === "" ? 999 : parseInt(limitVal);
            if (isNaN(limitNum) || limitNum < 1) { alert("❌ 제한 개수는 1 이상 입력해주세요."); return; }
            var list = getScheduleCodeList();
            if (list.find(function(c){ return c.name === codeName; })) {
                alert("이미 존재하는 코드명입니다."); return;
            }
            list.push({ name: codeName, limit: limitNum });
            setFirebaseItem("schedule_codes_list", JSON.stringify(list));
            document.getElementById("scheduleCodeInput").value = "";
            document.getElementById("scheduleCodeLimit").value = "";
            alert(`✨ 스케줄 코드 [${codeName}] 생성 완료. (제한: ${limitNum}개)`);
            drawScheduleCodeBoard();
        }

        function deleteScheduleCode() {
            if (!isAdmin) return;
            var codeName = document.getElementById("scheduleCodeInput").value.trim();
            if (codeName === "") { alert("삭제할 코드명을 입력해주세요."); return; }
            var list = getScheduleCodeList();
            var newList = list.filter(function(c){ return c.name !== codeName; });
            if (newList.length === list.length) { alert("해당 코드가 존재하지 않습니다."); return; }
            if (confirm(`[${codeName}] 코드를 삭제하시겠습니까?`)) {
                setFirebaseItem("schedule_codes_list", JSON.stringify(newList));
                document.getElementById("scheduleCodeInput").value = "";
                alert("🗑️ 삭제 완료.");
                drawScheduleCodeBoard();
            }
        }

        function toggleScheduleCodeBoard(event) {
            var board = document.getElementById("scheduleCodeTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function drawScheduleCodeBoard() {
            var container = document.getElementById("scheduleCodeTooltipBoard");
            if (!container) return;
            var list = getScheduleCodeList();
            var html = "<strong style='color:#fff;font-size:13px;'>🗓️ 스케줄 코드 목록</strong>"
                     + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 삭제</div>";
            if (list.length === 0) {
                html += "<div style='color:#bdc3c7;font-style:italic;font-size:12px;'>(생성된 코드 없음)</div>";
            } else {
                html += "<div style='display:flex;flex-wrap:wrap;gap:5px;'>";
                list.forEach(function(c) {
                    html += "<span class='sc-code-badge'"
                          + " data-code='" + c.name + "'"
                          + " style='background:rgba(233,30,140,0.3);color:#ff80b0;border:1px solid #e91e8c;"
                          + "border-radius:5px;padding:4px 10px;font-size:12px;font-weight:bold;white-space:nowrap;cursor:context-menu;'>"
                          + c.name + " <span style='color:#f8bbd0;font-weight:normal;pointer-events:none;'>제한 " + c.limit + "개</span></span>";
                });
                html += "</div>";
            }
            container.innerHTML = html;
            container.oncontextmenu = function(e) {
                var badge = e.target.closest(".sc-code-badge");
                if (!badge) return;
                e.preventDefault();
                deleteScheduleCodeFromBoard(e, badge.getAttribute("data-code"));
            };
            updateScGroupLimitCodeSelect();
        }

        function deleteScheduleCodeFromBoard(event, codeName) {
            event.preventDefault();
            if (!confirm("[" + codeName + "] 스케줄 코드를 삭제하시겠습니까?")) return;
            var list = getScheduleCodeList().filter(function(c){ return c.name !== codeName; });
            setFirebaseItem("schedule_codes_list", JSON.stringify(list));
            drawScheduleCodeBoard();
        }

        // ====== 스케줄 코드 조별 일자 제한 ======

        // 코드 선택 셀렉트 동기화
        function updateScGroupLimitCodeSelect() {
            var sel = document.getElementById("scGroupLimitCodeSelect");
            if (!sel) return;
            var list = getScheduleCodeList();
            var currentVal = sel.value;
            sel.innerHTML = '<option value="">코드 선택</option>';
            list.forEach(function(c) {
                var opt = document.createElement("option");
                opt.value = c.name;
                opt.innerText = c.name;
                sel.appendChild(opt);
            });
            if (currentVal) sel.value = currentVal;
        }

        // DB 키: sc_glimit_코드명_조(A/B/C/D/E)
        function getScGroupLimit(codeName, groupLetter) {
            var key = "sc_glimit_" + codeName + "_" + groupLetter;
            var val = getFirebaseItem(key, null);
            return val !== null ? parseInt(val) : null;
        }

        function saveScGroupLimit() {
            if (!isAdmin) return;
            var sel = document.getElementById("scGroupLimitCodeSelect");
            var codeName = sel ? sel.value.trim() : "";
            if (!codeName) { alert("❌ 코드를 선택해주세요."); return; }

            var vals = {
                A: document.getElementById("scGroupLimitA").value.trim(),
                B: document.getElementById("scGroupLimitB").value.trim(),
                C: document.getElementById("scGroupLimitC").value.trim(),
                D: document.getElementById("scGroupLimitD").value.trim(),
                E: document.getElementById("scGroupLimitE").value.trim()
            };

            var applied = [];
            var hasAny = false;
            var groups = ['A','B','C','D','E'];
            for (var gi = 0; gi < groups.length; gi++) {
                var g = groups[gi];
                if (vals[g] !== "") {
                    var num = parseInt(vals[g]);
                    if (isNaN(num) || num < 0) {
                        alert("❌ " + g + "조 값이 올바르지 않습니다. (0 이상 숫자)");
                        return;
                    }
                    applied.push({ g: g, num: num });
                    hasAny = true;
                }
            }

            if (!hasAny) { alert("❌ 최소 한 개 조의 제한 값을 입력해주세요."); return; }

            // 유효성 통과 후 일괄 저장
            for (var ai = 0; ai < applied.length; ai++) {
                setFirebaseItem("sc_glimit_" + codeName + "_" + applied[ai].g, applied[ai].num);
            }
            alert("✨ [" + codeName + "] 코드 조별 일자 제한 적용 완료!\n" + applied.map(function(x){ return x.g + "조: " + x.num + "명"; }).join(" | "));
            drawScGroupLimitBoard();
        }

        function clearScGroupLimit() {
            if (!isAdmin) return;
            var sel = document.getElementById("scGroupLimitCodeSelect");
            var codeName = sel ? sel.value.trim() : "";
            if (!codeName) { alert("❌ 코드를 선택해주세요."); return; }
            if (!confirm("[" + codeName + "] 코드의 전체 조별 일자 제한을 해제하시겠습니까?")) return;
            ['A','B','C','D','E'].forEach(function(g) {
                setFirebaseItem("sc_glimit_" + codeName + "_" + g, null);
            });
            // 입력창 초기화
            ['A','B','C','D','E'].forEach(function(g) {
                var el = document.getElementById("scGroupLimit" + g);
                if (el) el.value = "";
            });
            alert("✨ 해제 완료.");
            drawScGroupLimitBoard();
        }

        function toggleScGroupLimitBoard(event) {
            var board = document.getElementById("scGroupLimitTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function drawScGroupLimitBoard() {
            var container = document.getElementById("scGroupLimitTooltipBoard");
            if (!container) return;
            var list = getScheduleCodeList();
            var GROUP_LABELS = { A: "🔵A조", B: "🟣B조", C: "🟠C조", D: "🟢D조", E: "🔴E조" };
            var html = "<strong style='color:#fff;font-size:13px;'>🔢 코드별 조별 제한 현황</strong>"
                     + "<div style='font-size:10px;color:#bdc3c7;margin:3px 0 7px;'>우클릭으로 해당 조 제한 삭제</div>";
            if (list.length === 0) {
                html += "<div style='color:#aaa;font-style:italic;font-size:12px;'>(생성된 코드 없음)</div>";
            } else {
                html += "<div style='display:flex;flex-direction:column;gap:6px;'>";
                list.forEach(function(c) {
                    html += "<div style='display:flex;flex-wrap:wrap;align-items:center;gap:4px;'>";
                    html += "<span style='color:#ff80b0;font-weight:bold;font-size:13px;'>[" + c.name + "]</span> ";
                    var hasLimit = false;
                    ['A','B','C','D','E'].forEach(function(g) {
                        var v = getScGroupLimit(c.name, g);
                        if (v !== null) {
                            hasLimit = true;
                            html += "<span class='scgl-badge'"
                                  + " data-code='" + c.name + "'"
                                  + " data-group='" + g + "'"
                                  + " style='background:rgba(233,30,140,0.25);border:1px solid #e91e8c;border-radius:5px;"
                                  + "padding:3px 8px;font-size:12px;color:#f8bbd0;font-weight:bold;cursor:context-menu;white-space:nowrap;'>"
                                  + GROUP_LABELS[g] + ": " + v + "명</span>";
                        }
                    });
                    if (!hasLimit) {
                        html += "<span style='color:#aaa;font-size:11px;'>제한 없음</span>";
                    }
                    html += "</div>";
                });
                html += "</div>";
            }
            container.innerHTML = html;
            container.oncontextmenu = function(e) {
                var badge = e.target.closest(".scgl-badge");
                if (!badge) return;
                e.preventDefault();
                deleteScGroupLimitFromBoard(e, badge.getAttribute("data-code"), badge.getAttribute("data-group"));
            };
        }

        function deleteScGroupLimitFromBoard(event, codeName, groupLetter) {
            event.preventDefault();
            if (!confirm("[" + codeName + "] 코드의 " + groupLetter + "조 제한을 삭제하시겠습니까?")) return;
            setFirebaseItem("sc_glimit_" + codeName + "_" + groupLetter, null);
            drawScGroupLimitBoard();
        }

        // 해당 조에서 특정 코드를 특정 일자에 쓴 인원수 카운트
        function getGroupScCodeCountByDate(groupArray, codeName, date) {
            var count = 0;
            var tm = getTargetYearMonth();
            groupArray.forEach(function(member) {
                var scKey = "sc_" + codeName + "_" + member + "_" + tm.fullStr + "_" + date;
                if (liveDBData[scKey] !== undefined) count++;
            });
            return count;
        }

        // ====== 스케줄 코드 색상 팔레트 (코드명 → 고유 색상) ======
        var SC_COLOR_PALETTE = [
            { bg: "#f9a825", border: "#f57f17", color: "#333" },  // 노랑
            { bg: "#1565c0", border: "#0d47a1", color: "#fff" },  // 파랑
            { bg: "#2e7d32", border: "#1b5e20", color: "#fff" },  // 초록
            { bg: "#e91e8c", border: "#880e4f", color: "#fff" },  // 분홍
            { bg: "#6a1b9a", border: "#4a148c", color: "#fff" },  // 보라
            { bg: "#bf360c", border: "#870000", color: "#fff" },  // 다크레드
            { bg: "#00838f", border: "#004d56", color: "#fff" },  // 청록
            { bg: "#558b2f", border: "#33691e", color: "#fff" },  // 올리브
        ];
        var _scColorMap = {}; // 코드명 → 팔레트 인덱스 캐시
        var _scColorIdx = 0;

        function getScheduleCodeColor(codeName) {
            if (_scColorMap[codeName] === undefined) {
                _scColorMap[codeName] = _scColorIdx % SC_COLOR_PALETTE.length;
                _scColorIdx++;
            }
            return SC_COLOR_PALETTE[_scColorMap[codeName]];
        }

        // 스케줄 코드 모드 토글 (직원용) - 클릭마다 순차 전환 (휴무/청원/연차처럼)
        function toggleScheduleCodeMode() {
            var scBtn = document.getElementById("scheduleCodeApplyBtn");
            var fullList = getScheduleCodeList();

            // 사용 가능한 코드만 필터링 (내 잔여 개수 > 0)
            var availList = fullList.filter(function(c) {
                return getMyScheduleCodeCount(c.name) < c.limit;
            });

            if (availList.length === 0) {
                alert("사용 가능한 스케줄 코드가 없습니다.\n(모든 코드의 개인 제한 개수를 초과하였습니다.)");
                return;
            }

            if (currentAppMode !== "SCHEDULE_CODE") {
                // 처음 진입 → 첫 번째 사용 가능 코드
                currentAppMode = "SCHEDULE_CODE";
                currentScheduleCode = availList[0].name;
            } else {
                // 현재 코드의 availList 내 위치 찾기
                var curIdx = availList.findIndex(function(c){ return c.name === currentScheduleCode; });
                // 현재 코드가 availList에 없으면(소진됨) 0부터, 있으면 다음으로 순환
                var nextIdx = (curIdx + 1) % availList.length;
                currentScheduleCode = availList[nextIdx].name;
            }

            if (scBtn) scBtn.innerText = currentScheduleCode;
            setModeButtonStyles();
            refreshData();
        }

        function getScheduleCodeUsedCount(codeName) {
            var count = 0;
            var prefix = `sc_${codeName}_`;
            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith(prefix)) count++;
            });
            return count;
        }

        function getMyScheduleCodeCount(codeName) {
            var count = 0;
            var tm = getTargetYearMonth();
            var prefix = `sc_${codeName}_${currentUser}_${tm.fullStr}_`;
            Object.keys(liveDBData).forEach(function(key) {
                if (key.startsWith(prefix)) count++;
            });
            return count;
        }
