        function toggleAllowedUsersBoard(event) {
            var board = document.getElementById("allowedUsersTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        // 🔹 그룹 관리 클릭 토글
        function toggleGroupBoard(event) {
            var board = document.getElementById("groupListTooltipBoard");
            if (board) board.classList.toggle("active");
            if (event) event.stopPropagation();
        }

        function addAllowedUser() {
            if (!isAdmin) return;
            var newName = document.getElementById("manageIdInput").value.trim();
            if (newName === "") {
                alert("추가할 직원의 이름을 입력해주세요.");
                return;
            }

            // 관리자 계정 ID와 중복 불가
            if (Object.keys(ADMIN_ACCOUNTS).includes(newName) || newName === SUPER_ADMIN_ID) {
                alert("🛑 오류: 관리자 계정 ID와 동일한 이름은 직원 ID로 등록할 수 없습니다.");
                return;
            }

            // 현재 부서 중복 체크
            if (allowedUsers.includes(newName)) {
                alert("이미 현재 지점에 등록되어 있는 ID입니다.");
                return;
            }

            // 전 지점 중복 체크 (비동기)
            var allDepts = ALL_DEPTS.length > 0 ? ALL_DEPTS : Object.keys(ADMIN_ACCOUNTS).map(function(id){ return ADMIN_ACCOUNTS[id].dept; }).filter(function(v,i,a){ return a.indexOf(v)===i; });
            var otherDepts = allDepts.filter(function(d){ return d !== currentDept; });
            var checkedCount = 0;
            var duplicateDept = null;

            if (otherDepts.length === 0) {
                // 다른 부서 없으면 바로 등록
                doAddUser(newName);
                return;
            }

            otherDepts.forEach(function(dept) {
                db.ref("trinity_system/" + dept + "/allowed_users_list").once("value", function(snap) {
                    checkedCount++;
                    var raw = snap.val();
                    if (raw && duplicateDept === null) {
                        try {
                            var list = typeof raw === "string" ? JSON.parse(raw) : raw;
                            if (Array.isArray(list) && list.includes(newName)) {
                                duplicateDept = dept;
                            }
                        } catch(e) {}
                    }
                    if (checkedCount === otherDepts.length) {
                        if (duplicateDept !== null) {
                            alert("🛑 중복 오류: [" + newName + "] 은(는) 이미 [" + duplicateDept + "] 지점에 등록된 ID입니다.\n전 지점 통틀어 동일한 이름은 사용할 수 없습니다.");
                            return;
                        }
                        doAddUser(newName);
                    }
                });
            });
        }

        function doAddUser(newName) {
            allowedUsers.push(newName);
            setFirebaseItem("allowed_users_list", JSON.stringify(allowedUsers));
            alert("✨ [" + newName + "] ID가 정상적으로 등록(생성)되었습니다.");
            document.getElementById("manageIdInput").value = "";
            drawAllowedUsersBoard();
            drawLiveGroupBoards();
        }

        function removeAllowedUser() {
            if (!isAdmin) return;
            var targetName = document.getElementById("manageIdInput").value.trim();
            if (targetName === "") {
                alert("삭제할 직원의 이름을 입력해주세요.");
                return;
            }
            if (!allowedUsers.includes(targetName)) {
                alert("현재 명단에 등록되어 있지 않은 ID입니다.");
                return;
            }
            if (confirm(`진짜로 [${targetName}] ID를 로그인 허용 명단에서 삭제하시겠습니까?`)) {
                allowedUsers = allowedUsers.filter(function(n) { return n !== targetName; });
                setFirebaseItem("allowed_users_list", JSON.stringify(allowedUsers));
                
                // 삭제된 ID는 모든 조 편성에서도 자동 제거
                ['A','B','C','D','E'].forEach(letter => {
                    let grp = getLiveGroupList(letter);
                    if(grp.includes(targetName)) {
                        setFirebaseItem(`rq_live_group_${letter}`, grp.filter(n => n !== targetName));
                    }
                });

                alert(`🗑️ [${targetName}] ID가 명단에서 삭제되었습니다.`);
                document.getElementById("manageIdInput").value = "";
                drawAllowedUsersBoard();
                drawLiveGroupBoards();
            }
        }

        function deleteAllowedUserFromBoard(event, name) {
            event.preventDefault();
            if (!confirm("[" + name + "] ID를 명단에서 삭제하시겠습니까?")) return;
            allowedUsers = allowedUsers.filter(function(n){ return n !== name; });
            setFirebaseItem("allowed_users_list", JSON.stringify(allowedUsers));
            ['A','B','C','D','E'].forEach(function(letter) {
                var grp = getLiveGroupList(letter);
                if (grp.includes(name)) {
                    setFirebaseItem("rq_live_group_" + letter, grp.filter(function(n){ return n !== name; }));
                }
            });
            drawAllowedUsersBoard();
            drawLiveGroupBoards();
        }
        
        // 🔄 ID 드래그 보드
        function drawAllowedUsersBoard() {
            var container = document.getElementById("allowedUsersTooltipBoard");
            if (!container) return;
            
            var html = `<strong>👥 전체 접속 허용 ID 목록 (${allowedUsers.length}명)</strong>
                        <div style="font-size:10px; color:#bdc3c7; margin-bottom:8px;">(마우스로 끌어서 순서를 변경하세요. 설정된 순서는 엑셀 다운로드 시 적용됩니다.)</div>
                        <div id="sortable-id-list" style="display: flex; flex-wrap: wrap; gap: 6px;">`;
            
            if (allowedUsers.length === 0) {
                html += `<span style="color:#aaa; font-style:italic;">(등록된 ID가 없습니다)</span>`;
            } else {
                allowedUsers.forEach(function(n, index) { 
                    html += `<span class="tooltip-badge draggable-badge" draggable="true" data-index="${index}" data-name="${n}">${n}</span>`; 
                });
            }
            html += `</div>`;
            container.innerHTML = html;

            var listContainer = document.getElementById("sortable-id-list");
            if (listContainer) {
                // 우클릭 삭제 이벤트 위임
                listContainer.addEventListener("contextmenu", function(e) {
                    var badge = e.target.closest(".draggable-badge");
                    if (!badge) return;
                    e.preventDefault();
                    e.stopPropagation();
                    var name = badge.getAttribute("data-name");
                    if (name) deleteAllowedUserFromBoard(e, name);
                });

                var dragSrcEl = null;
                var items = listContainer.querySelectorAll('.draggable-badge');

                items.forEach(function(item) {
                    item.addEventListener('dragstart', function(e) {
                        dragSrcEl = this;
                        e.dataTransfer.effectAllowed = 'move';
                        e.dataTransfer.setData('text/html', this.innerHTML);
                        this.classList.add('dragging');
                    });
                    item.addEventListener('dragover', function(e) {
                        e.preventDefault();
                        e.dataTransfer.dropEffect = 'move';
                        return false;
                    });
                    item.addEventListener('dragenter', function(e) {
                        if (this !== dragSrcEl) this.classList.add('drag-over');
                    });
                    item.addEventListener('dragleave', function(e) {
                        this.classList.remove('drag-over');
                    });
                    item.addEventListener('drop', function(e) {
                        e.stopPropagation();
                        this.classList.remove('drag-over');
                        if (dragSrcEl !== this) {
                            var fromIndex = parseInt(dragSrcEl.getAttribute('data-index'));
                            var toIndex = parseInt(this.getAttribute('data-index'));
                            var movedItem = allowedUsers.splice(fromIndex, 1)[0];
                            allowedUsers.splice(toIndex, 0, movedItem);
                            setFirebaseItem("allowed_users_list", JSON.stringify(allowedUsers));
                            drawAllowedUsersBoard();
                            drawLiveGroupBoards(); // 갱신 시 그룹보드 내의 미편성 리스트도 싱크 맞추기
                        }
                        return false;
                    });
                    item.addEventListener('dragend', function(e) {
                        this.classList.remove('dragging');
                        items.forEach(i => i.classList.remove('drag-over'));
                    });
                });
            }
        }

        function getLiveGroupList(groupLetter) {
            var savedData = getFirebaseItem(`rq_live_group_${groupLetter}`, null);
            if (savedData !== null) {
                return typeof savedData === "string" ? JSON.parse(savedData) : savedData;
            }
            var defaultArr = [];
            if (groupLetter === 'A') defaultArr = defaultGroupA;
            else if (groupLetter === 'B') defaultArr = defaultGroupB;
            else if (groupLetter === 'C') defaultArr = defaultGroupC;
            else if (groupLetter === 'D') defaultArr = defaultGroupD;
            else if (groupLetter === 'E') defaultArr = defaultGroupE;
            
            setFirebaseItem(`rq_live_group_${groupLetter}`, defaultArr);
            return defaultArr;
        }

        // 🔄 그룹 드래그 보드 렌더링
        function drawLiveGroupBoards() {
            var container = document.getElementById("groupListTooltipBoard");
            if (!container) return;
            
            var listA = getLiveGroupList('A');
            var listB = getLiveGroupList('B');
            var listC = getLiveGroupList('C');
            var listD = getLiveGroupList('D');
            var listE = getLiveGroupList('E');

            var allAssigned = [].concat(listA, listB, listC, listD, listE);
            // allowedUsers 순서를 기준으로 미편성 인원 추출 (ID정렬 순서 존중)
            var unassigned = allowedUsers.filter(function(u) { return !allAssigned.includes(u); });

            var html = `<strong>👥 그룹 관리 (마우스 드래그로 조 편성)</strong>
                        <div style="font-size:10px; color:#bdc3c7; margin-bottom:8px;">(미편성이나 다른 조에 있는 직원을 원하는 조로 드래그 앤 드롭 하세요)</div>
                        <div style="display:flex; flex-direction:column; gap:8px;">`;
            
            // 공통 렌더링 함수 (테두리를 진하게 설정)
            function makeZone(title, list, color, targetCode, bgColor) {
                var zoneHtml = `<div class="group-drop-zone" data-target="${targetCode}" style="border:1px dashed ${color}; padding:6px; border-radius:6px; min-height:28px; background:rgba(0,0,0,0.2);">`;
                zoneHtml += `<span style="color:${color}; font-weight:bold; margin-right:5px; font-size:12px;">${title} : </span>`;
                if (list.length === 0) zoneHtml += `<span style="color:#888; font-size:11px; font-style:italic;">(비어 있음)</span>`;
                else {
                    list.forEach(function(n) {
                        zoneHtml += `<span class="tooltip-badge draggable-group-badge" draggable="true" data-name="${n}" data-source="${targetCode}" style="background:${bgColor}; color:${color}; border:1px solid ${color}; margin-right:3px; margin-bottom:3px;">${n}</span>`;
                    });
                }
                zoneHtml += `</div>`;
                return zoneHtml;
            }

            html += makeZone("🔵 A조", listA, "#3498db", "A", "rgba(52,152,219,0.15)");
            html += makeZone("🟣 B조", listB, "#9b59b6", "B", "rgba(155,89,182,0.15)");
            html += makeZone("🟠 C조", listC, "#e67e22", "C", "rgba(230,126,34,0.15)");
            html += makeZone("🟢 D조", listD, "#1abc9c", "D", "rgba(26,188,156,0.15)");
            html += makeZone("🔴 E조", listE, "#e84393", "E", "rgba(232,67,147,0.15)"); // 마젠타 계열
            
            html += `<hr style="border-color:#566573; margin: 4px 0;">`;
            html += makeZone("⚪ 미편성", unassigned, "#bdc3c7", "UNASSIGNED", "rgba(189,195,199,0.15)");

            html += `</div>`;
            container.innerHTML = html;

            attachGroupDragEvents();
        }

        // 그룹 드래그 앤 드롭 이벤트 핸들러
        function attachGroupDragEvents() {
            var badges = document.querySelectorAll('.draggable-group-badge');
            var zones = document.querySelectorAll('.group-drop-zone');

            badges.forEach(function(badge) {
                badge.addEventListener('dragstart', function(e) {
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', this.dataset.name);
                    this.classList.add('dragging');
                });
                badge.addEventListener('dragend', function(e) {
                    this.classList.remove('dragging');
                    zones.forEach(z => z.classList.remove('drag-over'));
                });
            });

            zones.forEach(function(zone) {
                zone.addEventListener('dragover', function(e) {
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    this.classList.add('drag-over');
                    return false;
                });
                zone.addEventListener('dragleave', function(e) {
                    this.classList.remove('drag-over');
                });
                zone.addEventListener('drop', function(e) {
                    e.stopPropagation();
                    this.classList.remove('drag-over');
                    var userName = e.dataTransfer.getData('text/plain');
                    var targetZone = this.dataset.target;
                    
                    if (userName) {
                        moveUserToGroup(userName, targetZone);
                    }
                    return false;
                });
            });
        }

        function moveUserToGroup(userName, targetZone) {
            // 모든 조에서 해당 직원을 먼저 추출 (배열 필터링)
            var listA = getLiveGroupList('A').filter(n => n !== userName);
            var listB = getLiveGroupList('B').filter(n => n !== userName);
            var listC = getLiveGroupList('C').filter(n => n !== userName);
            var listD = getLiveGroupList('D').filter(n => n !== userName);
            var listE = getLiveGroupList('E').filter(n => n !== userName);

            // 타겟 그룹에 추가 ('UNASSIGNED'인 경우는 아무 곳에도 넣지 않음)
            if(targetZone === 'A') listA.push(userName);
            if(targetZone === 'B') listB.push(userName);
            if(targetZone === 'C') listC.push(userName);
            if(targetZone === 'D') listD.push(userName);
            if(targetZone === 'E') listE.push(userName);

            // DB에 일괄 저장
            setFirebaseItem('rq_live_group_A', listA);
            setFirebaseItem('rq_live_group_B', listB);
            setFirebaseItem('rq_live_group_C', listC);
            setFirebaseItem('rq_live_group_D', listD);
            setFirebaseItem('rq_live_group_E', listE);
            
            // 즉시 화면 반영
            drawLiveGroupBoards();
        }

        // 버튼 활성/비활성 스타일 헬퍼
        function setModeButtonStyles() {
            var btn = document.getElementById("toggleModeBtn");
            var scBtn = document.getElementById("scheduleCodeApplyBtn");
            var isScMode = (currentAppMode === "SCHEDULE_CODE");

            // 휴무/청원/연차 버튼
            if (btn) {
                if (!isScMode) {
                    // 활성: 노란 배경 + 빨간 테두리
                    btn.style.backgroundColor = "#ffd600";
                    btn.style.color = "#222";
                    btn.style.border = "2px solid #e53935";
                } else {
                    // 비활성: 회색
                    btn.style.backgroundColor = "#868e96";
                    btn.style.color = "#fff";
                    btn.style.border = "2px solid transparent";
                }
            }
            // 스케줄 코드 버튼
            if (scBtn) {
                if (isScMode) {
                    scBtn.style.backgroundColor = "#ffd600";
                    scBtn.style.color = "#222";
                    scBtn.style.border = "2px solid #e53935";
                } else {
                    scBtn.style.backgroundColor = "#868e96";
                    scBtn.style.color = "#fff";
                    scBtn.style.border = "2px solid transparent";
                }
            }
        }

        function toggleApplicationMode() {
            var btn = document.getElementById("toggleModeBtn");
            // 스케줄 코드 모드일 때 → 휴무로 전환
            if (currentAppMode === "SCHEDULE_CODE") {
                currentAppMode = "NORMAL";
            } else if (currentAppMode === "NORMAL") {
                currentAppMode = "PETITION";
            } else if (currentAppMode === "PETITION") {
                currentAppMode = "ANNUAL";
            } else {
                currentAppMode = "NORMAL";
            }
            // 버튼 텍스트 갱신
            if (btn) {
                if (currentAppMode === "NORMAL")   btn.innerText = "휴무";
                if (currentAppMode === "PETITION") btn.innerText = "청원";
                if (currentAppMode === "ANNUAL")   btn.innerText = "연차";
            }
            setModeButtonStyles();
        }

        // ====== 스케줄 코드 기능 ======
