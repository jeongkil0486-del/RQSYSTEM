/**
 * notices.js — 지점별 공지사항
 *
 * DB 직접 접근 없음. 모든 RTDB 읽기/쓰기는 Cloud Function 경유.
 *   listNotices    : 공지 목록 + 호출자 읽음 여부
 *   markNoticeRead : 읽음 처리 (호출자 uid 전용)
 *   saveNotice     : 공지 저장/수정
 *   deleteNotice   : 공지 삭제
 *
 * 직원 공지 표시 구조:
 *   - staffNoticeBanner  : 달력 위 항상 표시 영역 (일반 + 중요 공지 목록)
 *   - importantNoticeModal : 중요 공지 팝업 (로그인 직후 1회, 확인 시 숨김)
 *
 * 규칙:
 *   - 전지점(ALL) 공지 없음. 무조건 deptId 지정.
 *   - submitRequest / cancelRequest / calendar.js 와 완전 분리.
 */

// ── 전역 상태 ──────────────────────────────────────────────────────────────────
var _noticeEditId     = null;
var _noticeAdminDept  = "";
var _importantQueue   = [];   // 팝업 순서 대기열 [{id, data, deptId}]
var _importantCurrent = null; // 현재 팝업에 표시 중인 공지

// ─────────────────────────────────────────────────────────────────────────────
// 공통 헬퍼
// ─────────────────────────────────────────────────────────────────────────────
function _noticeEsc(str) {
    return String(str || "")
        .replace(/&/g, "&amp;").replace(/</g, "&lt;")
        .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function _fmtNoticeDate(ms) {
    if (!ms) return "";
    var d = new Date(ms);
    return (d.getMonth() + 1) + "/" + d.getDate()
         + " " + d.getHours() + ":" + ("0" + d.getMinutes()).slice(-2);
}

// ─────────────────────────────────────────────────────────────────────────────
// ① 직원 모드 — 공지 로드 및 표시
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initNoticeListener(deptId)
 * 직원 로그인 후 1회 호출. fn.listNotices 로 공지를 가져와
 * 배너와 팝업에 분리 표시한다. db.ref 직접 사용 없음.
 */
function initNoticeListener(deptId) {
    if (!deptId || isAdmin || isSuperAdmin) return;

    var container = document.getElementById("noticeMain");
    if (container) {
        container.innerHTML = "<span style='color:#aaa;font-size:12px;'>공지사항을 불러오는 중...</span>";
    }

    fn.listNotices({ deptId: deptId }).then(function(result) {
        var notices = (result.data && result.data.notices) || {};
        var myReads = (result.data && result.data.myReads) || {};
        _renderStaffNotices(notices, myReads, deptId);
    }).catch(function(e) {
        console.error("[notices] listNotices(staff) failed:", e);
        if (container) {
            container.innerHTML = "<span style='color:#aaa;font-size:12px;'>공지사항을 불러오지 못했습니다.</span>";
        }
    });
}

/**
 * _renderStaffNotices(notices, myReads, deptId)
 * - important=true + 안 읽은 공지 → 배너 + 팝업 둘 다
 * - important=false + 안 읽은 공지 → 배너만
 * - 읽은 공지(myReads[nid] === true) → 배너·팝업 모두 제외
 */
function _renderStaffNotices(notices, myReads, deptId) {
    // ── 공지를 중요/일반으로 분류 ──────────────────────────────────────────────
    var bannerImportant = [];  // 배너용 중요 공지 (팝업 큐와 완전히 분리)
    var popupQueue      = [];  // 팝업 큐용 중요 공지
    var bannerNormal    = [];  // 배너용 일반 공지

    Object.keys(notices).forEach(function(nid) {
        var n = notices[nid];
        if (!n || !n.active) return;
        // myReads[nid] 가 정확히 true 인 경우만 읽은 것으로 처리
        if (myReads[nid] === true) return;

        if (n.important === true) {
            // 배너와 팝업에 각각 독립 객체로 추가 (공유 참조 없음)
            bannerImportant.push({ id: nid, data: n, deptId: deptId });
            popupQueue.push({ id: nid, data: n, deptId: deptId });
        } else {
            bannerNormal.push({ id: nid, data: n, deptId: deptId });
        }
    });

    // ── 디버그 로그 ────────────────────────────────────────────────────────────
    console.log("[notices] 중요 공지:", bannerImportant.length + "건",
        bannerImportant.map(function(x) { return x.data.title; }));
    console.log("[notices] 일반 공지:", bannerNormal.length + "건");
    console.log("[notices] myReads:", JSON.stringify(myReads));

    // ── 최신순 정렬 ────────────────────────────────────────────────────────────
    var byDateDesc = function(a, b) { return (b.data.createdAt || 0) - (a.data.createdAt || 0); };
    bannerImportant.sort(byDateDesc);
    bannerNormal.sort(byDateDesc);

    // ── 배너 렌더링: 중요공지 먼저, 일반공지 뒤 ──────────────────────────────
    // bannerImportant 와 popupQueue 는 서로 다른 배열이므로
    // _showNextImportantPopup() 의 shift() 가 배너 데이터에 영향을 주지 않음
    var bannerItems = bannerImportant.concat(bannerNormal);
    console.log("[notices] 배너 렌더링 항목 수:", bannerItems.length);
    _renderNoticeBanner(bannerItems, deptId);

    // ── 중요 공지 팝업 ────────────────────────────────────────────────────────
    if (popupQueue.length > 0) {
        _importantQueue = popupQueue;  // popupQueue 는 bannerImportant 와 별개 배열
        _showNextImportantPopup();
    }
}

// ── 배너 렌더링 ────────────────────────────────────────────────────────────────
function _renderNoticeBanner(items, deptId) {
    var container = document.getElementById("noticeMain");
    if (!container) return;

    if (items.length === 0) {
        container.innerHTML = "<span style='color:#aaa;font-size:12px;'>새 공지사항이 없습니다.</span>";
        return;
    }

    var html = "";
    items.forEach(function(item) {
        var n   = item.data;
        var nid = item.id;
        if (n.important) {
            html += "<div class='notice-item notice-important' id='notice-" + nid + "'>"
                  + "<span class='notice-badge-important'>중요</span>"
                  + "<div class='notice-body'>"
                  + "<div class='notice-title-imp'>" + _noticeEsc(n.title) + "</div>"
                  + "<div class='notice-content-text'>" + _noticeEsc(n.content).replace(/\n/g, "<br>") + "</div>"
                  + "<div class='notice-meta'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                  + "</div>"
                  + "<button class='notice-read-btn notice-read-btn-imp'"
                  + " onclick='markNoticeRead(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>확인</button>"
                  + "</div>";
        } else {
            html += "<div class='notice-item notice-normal' id='notice-" + nid + "'>"
                  + "<div class='notice-dot'></div>"
                  + "<div class='notice-body'>"
                  + "<div class='notice-title-normal'>" + _noticeEsc(n.title) + "</div>"
                  + "<div class='notice-content-text notice-content-collapsed'>" + _noticeEsc(n.content).replace(/\n/g, "<br>") + "</div>"
                  + "<div class='notice-meta'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                  + "</div>"
                  + "<button class='notice-read-btn'"
                  + " onclick='markNoticeRead(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>확인</button>"
                  + "</div>";
        }
    });
    container.innerHTML = html;
}

// ── 중요 공지 팝업 ─────────────────────────────────────────────────────────────
function _showNextImportantPopup() {
    if (_importantQueue.length === 0) return;
    _importantCurrent = _importantQueue.shift();

    var modal   = document.getElementById("importantNoticeModal");
    var titleEl = document.getElementById("importantNoticeTitle");
    var bodyEl  = document.getElementById("importantNoticeContent");
    var metaEl  = document.getElementById("importantNoticeMeta");
    if (!modal) return;

    var n = _importantCurrent.data;
    if (titleEl) titleEl.textContent = n.title || "";
    if (bodyEl)  bodyEl.textContent  = n.content || "";
    if (metaEl)  metaEl.textContent  = _fmtNoticeDate(n.createdAt);
    modal.style.display = "flex";
}

/**
 * confirmImportantNotice()
 * 팝업 "확인했습니다" 버튼 → 팝업만 닫음.
 * markNoticeRead 호출 없음. 배너/내역 DOM 삭제 없음.
 * 재로그인 시에도 내역 확인(markNoticeRead)을 누르기 전까지 공지는 계속 표시.
 */
function confirmImportantNotice() {
    var modal = document.getElementById("importantNoticeModal");
    if (modal) modal.style.display = "none";
    _importantCurrent = null;

    // 다음 중요 공지 팝업이 있으면 순차 표시
    if (_importantQueue.length > 0) {
        setTimeout(_showNextImportantPopup, 300);
    }
}

/**
 * markNoticeRead(noticeId, deptId)
 * 배너/내역의 "확인" 버튼 클릭 시에만 호출.
 * → 해당 공지를 내역에서 즉시 제거 + fn.markNoticeRead 로 읽음 기록.
 * → 재로그인 시 이 함수가 호출된 공지만 표시되지 않음.
 */
function markNoticeRead(noticeId, deptId) {
    if (!noticeId || !deptId) return;

    var el = document.getElementById("notice-" + noticeId);
    if (el) el.remove();

    var container = document.getElementById("noticeMain");
    if (container && !container.querySelector(".notice-item")) {
        container.innerHTML = "<span style='color:#aaa;font-size:12px;'>새 공지사항이 없습니다.</span>";
    }

    fn.markNoticeRead({ deptId: deptId, noticeId: noticeId })
        .catch(function(e) { console.warn("[notices] markNoticeRead failed:", e && e.message); });
}

// ─────────────────────────────────────────────────────────────────────────────
// ② 관리자 모드 — 공지 관리 UI
// ─────────────────────────────────────────────────────────────────────────────
function drawNoticeAdminPanel() {
    if (!isAdmin && !isSuperAdmin) return;

    var container = document.getElementById("noticeAdminPanelContent");
    if (!container) return;

    if (!currentDept && !isSuperAdmin) {
        container.innerHTML = "<div style='color:#888;font-size:12px;'>지점 정보를 불러오는 중...</div>";
        setTimeout(drawNoticeAdminPanel, 200);
        return;
    }

    if (isSuperAdmin) {
        _drawNoticeSuperAdminSelector(container);
        return;
    }

    _noticeAdminDept = currentDept;
    _drawNoticeAdminForDept(container, currentDept);
}

function _drawNoticeSuperAdminSelector(container) {
    fn.listDepartments({}).then(function(result) {
        var depts = (result.data && result.data.departments) || [];
        if (!_noticeAdminDept && depts.length > 0) {
            _noticeAdminDept = depts[0].deptId || depts[0].id || "";
        }
        var deptOptions = depts.map(function(d) {
            var dId = d.deptId || d.id || "";
            var sel = dId === _noticeAdminDept ? " selected" : "";
            return "<option value='" + _noticeEsc(dId) + "'" + sel + ">" + _noticeEsc(d.name || dId) + "</option>";
        }).join("");

        container.innerHTML =
            "<div style='margin-bottom:10px;display:flex;align-items:center;gap:8px;'>"
            + "<label style='font-weight:bold;font-size:13px;'>지점 선택</label>"
            + "<select id='noticeAdminDeptSelect' class='form-select' style='width:180px;'"
            + " onchange='_onNoticeAdminDeptChange()'>" + deptOptions + "</select></div>"
            + "<div id='noticeAdminDeptContent'><div style='color:#aaa;font-size:12px;'>로딩중...</div></div>";

        _drawNoticeAdminForDept(document.getElementById("noticeAdminDeptContent"), _noticeAdminDept);
    }).catch(function(e) {
        console.error("[notices] listDepartments failed:", e);
        container.innerHTML = "<span style='color:#c00;'>지점 목록 로드 실패: " + _noticeEsc(e && e.message) + "</span>";
    });
}

function _onNoticeAdminDeptChange() {
    var sel = document.getElementById("noticeAdminDeptSelect");
    if (!sel) return;
    _noticeAdminDept = sel.value;
    _noticeEditId = null;
    var inner = document.getElementById("noticeAdminDeptContent");
    if (inner) _drawNoticeAdminForDept(inner, _noticeAdminDept);
}

function _drawNoticeAdminForDept(container, deptId) {
    if (!container) return;
    if (!deptId) {
        container.innerHTML = "<div style='color:#888;font-size:12px;'>지점 정보를 불러오는 중...</div>";
        return;
    }
    container.innerHTML = "<div style='color:#aaa;font-size:12px;'>로딩중...</div>";

    fn.listNotices({ deptId: deptId }).then(function(result) {
        var notices = (result.data && result.data.notices) || {};
        var items = [];
        Object.keys(notices).forEach(function(nid) {
            var n = notices[nid];
            if (n) items.push({ id: nid, data: n });
        });
        items.sort(function(a, b) { return (b.data.createdAt || 0) - (a.data.createdAt || 0); });

        var editingData = _noticeEditId && notices[_noticeEditId] ? notices[_noticeEditId] : null;
        var formTitle   = editingData ? _noticeEsc(editingData.title)   : "";
        var formContent = editingData ? _noticeEsc(editingData.content) : "";
        var formImp     = editingData ? (editingData.important ? " checked" : "") : "";
        var formActive  = editingData ? (editingData.active === false ? "" : " checked") : " checked";
        var cancelBtn   = _noticeEditId
            ? "<button type='button' class='btn btn-secondary' style='margin-left:6px;' onclick='_cancelNoticeEdit()'>취소</button>"
            : "";

        var html =
            "<div style='background:#f8faff;border:1px solid #dbeafe;border-radius:8px;padding:14px;margin-bottom:14px;'>"
            + "<div style='font-weight:bold;font-size:13px;color:#1d4ed8;margin-bottom:10px;'>"
            + (_noticeEditId ? "공지 수정" : "새 공지 작성") + "</div>"
            + "<div style='margin-bottom:8px;'>"
            + "<input type='text' id='noticeFormTitle' class='form-input' placeholder='제목' value=\"" + formTitle + "\" style='width:100%;'></div>"
            + "<div style='margin-bottom:8px;'>"
            + "<textarea id='noticeFormContent' class='form-input' placeholder='내용' rows='4' style='width:100%;resize:vertical;'>" + formContent + "</textarea></div>"
            + "<div style='display:flex;gap:16px;align-items:center;margin-bottom:10px;font-size:13px;'>"
            + "<label><input type='checkbox' id='noticeFormImportant'" + formImp + "> 중요 공지 <span style='font-size:11px;color:#c62828;'>(직원 로그인 시 팝업 표시)</span></label>"
            + "<label><input type='checkbox' id='noticeFormActive'" + formActive + "> 표시 활성화</label>"
            + "</div>"
            + "<div style='display:flex;gap:8px;'>"
            + "<button type='button' class='btn btn-primary-sm' onclick='submitNoticeForm(\"" + _noticeEsc(deptId) + "\")'>"
            + (_noticeEditId ? "수정 저장" : "공지 저장") + "</button>"
            + cancelBtn + "</div></div>";

        if (items.length === 0) {
            html += "<div style='color:#aaa;font-size:12px;padding:8px 0;'>등록된 공지사항이 없습니다.</div>";
        } else {
            html += "<div style='display:flex;flex-direction:column;gap:8px;'>";
            items.forEach(function(item) {
                var n   = item.data;
                var nid = item.id;
                var impBadge    = n.important ? "<span class='notice-admin-badge-imp'>중요</span>" : "";
                var activeBadge = n.active
                    ? "<span class='notice-admin-badge-active'>표시중</span>"
                    : "<span class='notice-admin-badge-off'>숨김</span>";
                html += "<div class='notice-admin-row" + (nid === _noticeEditId ? " notice-admin-row-editing" : "") + "'>"
                    + "<div style='flex:1;min-width:0;'>"
                    + "<div style='display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px;'>"
                    + impBadge + activeBadge
                    + "<span style='font-weight:bold;font-size:13px;'>" + _noticeEsc(n.title) + "</span>"
                    + "</div>"
                    + "<div style='font-size:12px;color:#666;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:420px;'>" + _noticeEsc(n.content) + "</div>"
                    + "<div style='font-size:11px;color:#aaa;margin-top:2px;'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                    + "</div>"
                    + "<div style='display:flex;gap:6px;flex-shrink:0;'>"
                    + "<button type='button' class='btn btn-secondary' style='font-size:11px;padding:4px 10px;'"
                    + " onclick='_editNotice(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>수정</button>"
                    + "<button type='button' class='btn' style='font-size:11px;padding:4px 10px;background:#fef2f2;color:#c62828;border:1px solid #fca5a5;border-radius:6px;'"
                    + " onclick='_deleteNotice(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>삭제</button>"
                    + "</div></div>";
            });
            html += "</div>";
        }
        container.innerHTML = html;
    }).catch(function(e) {
        console.error("[notices] listNotices(admin) failed (deptId=" + deptId + "):", e);
        container.innerHTML =
            "<div style='color:#c62828;font-size:12px;'>공지사항을 불러오지 못했습니다. ("
            + _noticeEsc((e && e.message) || "알 수 없는 오류") + ")</div>";
    });
}

function submitNoticeForm(deptId) {
    var title   = (document.getElementById("noticeFormTitle")    || {}).value || "";
    var content = (document.getElementById("noticeFormContent")  || {}).value || "";
    var imp     = !!(document.getElementById("noticeFormImportant") || {}).checked;
    var active  = !!(document.getElementById("noticeFormActive")    || {}).checked;
    title = title.trim(); content = content.trim();
    if (!title)   { alert("제목을 입력해주세요."); return; }
    if (!content) { alert("내용을 입력해주세요."); return; }
    if (!deptId)  { alert("지점이 설정되지 않았습니다."); return; }
    var payload = { deptId: deptId, title: title, content: content, important: imp, active: active };
    if (_noticeEditId) payload.noticeId = _noticeEditId;
    fn.saveNotice(payload).then(function() {
        _noticeEditId = null;
        _refreshNoticeAdminPanel();
    }).catch(function(e) {
        console.error("[notices] saveNotice failed:", e);
        alert((e && e.message) || "공지 저장 실패");
    });
}

function _editNotice(noticeId, deptId) {
    _noticeEditId = noticeId;
    var target = isSuperAdmin
        ? document.getElementById("noticeAdminDeptContent")
        : document.getElementById("noticeAdminPanelContent");
    if (target) _drawNoticeAdminForDept(target, deptId);
}

function _cancelNoticeEdit() {
    _noticeEditId = null;
    _refreshNoticeAdminPanel();
}

function _deleteNotice(noticeId, deptId) {
    if (!confirm("이 공지를 삭제하시겠습니까?\n(읽음 기록도 함께 삭제됩니다)")) return;
    if (_noticeEditId === noticeId) _noticeEditId = null;
    fn.deleteNotice({ deptId: deptId, noticeId: noticeId }).then(function() {
        _refreshNoticeAdminPanel();
    }).catch(function(e) {
        console.error("[notices] deleteNotice failed:", e);
        alert((e && e.message) || "공지 삭제 실패");
    });
}

function _refreshNoticeAdminPanel() {
    if (isSuperAdmin) {
        var inner = document.getElementById("noticeAdminDeptContent");
        if (inner && _noticeAdminDept) _drawNoticeAdminForDept(inner, _noticeAdminDept);
    } else {
        var container = document.getElementById("noticeAdminPanelContent");
        if (container) _drawNoticeAdminForDept(container, currentDept);
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// window 노출
// ─────────────────────────────────────────────────────────────────────────────
window.initNoticeListener       = initNoticeListener;
window.drawNoticeAdminPanel     = drawNoticeAdminPanel;
window.submitNoticeForm         = submitNoticeForm;
window.markNoticeRead           = markNoticeRead;
window.confirmImportantNotice   = confirmImportantNotice;
window._editNotice              = _editNotice;
window._cancelNoticeEdit        = _cancelNoticeEdit;
window._deleteNotice            = _deleteNotice;
window._onNoticeAdminDeptChange = _onNoticeAdminDeptChange;
