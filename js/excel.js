        function exportToExcel() {
            if (!isAdmin) return;
            var tm = getTargetYearMonth();
            var totalDaysInMonth = new Date(parseInt(tm.year), parseInt(tm.month), 0).getDate();
            var targetSuffix = "_" + tm.fullStr + "_";

            // 사용된 스케줄 코드 목록 수집
            var scList = getScheduleCodeList();

            var headerRow = ["직원 이름"];
            for (var d = 1; d <= totalDaysInMonth; d++) {
                headerRow.push(d + "일");
            }

            var excelSheetData = [headerRow];

            // allowedUsers 배열 순서대로 렌더링
            allowedUsers.forEach(function(userName) {
                var userRow = [userName];

                for (var d = 1; d <= totalDaysInMonth; d++) {
                    var normalKey   = "rq_" + userName + targetSuffix + d;
                    var petitionKey = "rq_" + userName + targetSuffix + d + "_petition";
                    var annualKey   = "rq_" + userName + targetSuffix + d + "_annual";

                    if (liveDBData[normalKey] !== undefined) {
                        userRow.push("휴");
                    } else if (liveDBData[petitionKey] !== undefined) {
                        userRow.push("청");
                    } else if (liveDBData[annualKey] !== undefined) {
                        userRow.push("연");
                    } else {
                        // 스케줄 코드 확인 (sc_코드명_이름_YYYYMM_일)
                        var foundCode = "";
                        for (var si = 0; si < scList.length; si++) {
                            var scKey = "sc_" + scList[si].name + "_" + userName + targetSuffix + d;
                            if (liveDBData[scKey] !== undefined) {
                                foundCode = scList[si].name;
                                break;
                            }
                        }
                        userRow.push(foundCode);
                    }
                }
                excelSheetData.push(userRow);
            });

            var worksheet = XLSX.utils.aoa_to_sheet(excelSheetData);
            var workbook = XLSX.utils.book_new();
            XLSX.utils.book_append_sheet(workbook, worksheet, tm.year + "년 " + parseInt(tm.month) + "월 마감");

            var colWidths = [{ wch: 12 }];
            for (var d = 1; d <= totalDaysInMonth; d++) {
                colWidths.push({ wch: 8 });
            }
            worksheet["!cols"] = colWidths;

            var fileName = "Trinity_AirService_" + currentDept + "_RQ_스케줄_" + tm.fullStr + ".xlsx";
            XLSX.writeFile(workbook, fileName);
        }
