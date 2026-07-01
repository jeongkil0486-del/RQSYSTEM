/**
 * notices.js — 지점별 공지사항
 *
 * DB 직접 접근 없음. 모든 RTDB 읽기/쓰기는 Cloud Function 경유.
 *   listNotices     : 공지 목록 + 호출자 읽음 여부
 *   markNoticeRead  : 읽음 처리 (호출자 uid 전용)
 *   saveNotice      : 공지 저장/수정
 *   deleteNotice    : 공지 삭제
 *
 * DB 경로 (Function 내부에서만 접근):
 *   trinity_system/{deptId}/notices/{noticeId}
 *   trinity_system/{deptId}/noticeReads/{noticeId}/{uid}
 *
 * 규칙:
 *   - 전지점(ALL) 공지 없음. 무조건 deptId 지정.
 *   - 직원: 자기 지점 공지만 열람/읽음 처리.
 *   - 관리자: 자기 지점 공지만 관리.
 *   - 슈퍼관리자: 지점 선택 드롭다운으로 특정 지점 관리.
 *   - submitRequest / cancelRequest / calendar.js 와 완전 분리.
 */

// ── 전역 상태 (notices.js 내부만 사용) ─────────────────────────────────────────
var _noticeEditId     = null;   // 수정 중인 noticeId (null=신규)
var _noticeAdminDept  = "";     // 슈퍼관리자가 선택한 지점 (관리자는 currentDept)

// ─────────────────────────────────────────────────────────────────────────────
// ① 공통 헬퍼
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
// ② 직원 모드 — 공지 표시
// ─────────────────────────────────────────────────────────────────────────────

/**
 * initNoticeListener(deptId)
 * 직원 로그인 직후 1회 호출.
 * fn.listNotices 로 공지 조회 — db.ref 직접 사용 없음.
 */
function initNoticeListener(deptId) {
    if (!deptId || isAdmin || isSuperAdmin) return;
    _loadStaffNotices(deptId);
}

function _loadStaffNotices(deptId) {
    var container = document.getElementById("noticeMain");
    if (!container) return;
    container.innerHTML = "<span style='color:#aaa;font-size:12px;'>공지사항을 불러오는 중...</span>";

    fn.listNotices({ deptId: deptId }).then(function(result) {
        var notices  = (result.data && result.data.notices)  || {};
        var myReads  = (result.data && result.data.myReads)  || {};
        _renderStaffNotices(notices, myReads, deptId);
    }).catch(function(e) {
        console.error("[notices] listNotices(staff) failed:", e);
        if (container) container.innerHTML = "<span style='color:#aaa;font-size:12px;'>공지사항을 불러오지 못했습니다.</span>";
    });
}

/**
 * _renderStaffNotices(notices, myReads, deptId)
 * active 공지 중 읽지 않은 것만 noticeMain 영역에 렌더링.
 * 중요 공지 → 상단 강조. 일반 공지 → 아래.
 */
function _renderStaffNotices(notices, myReads, deptId) {
    var container = document.getElementById("noticeMain");
    if (!container) return;

    // active 공지 중 안 읽은 것만 추출
    var unread = [];
    Object.keys(notices).forEach(function(nid) {
        var n = notices[nid];
        if (n && n.active && !myReads[nid]) {
            unread.push({ id: nid, data: n });
        }
    });

    if (unread.length === 0) {
        container.innerHTML = "<span style='color:#aaa;'>새 공지사항이 없습니다.</span>";
        return;
    }

    // 중요 공지 먼저, 최신순
    unread.sort(function(a, b) {
        var iA = a.data.important ? 1 : 0;
        var iB = b.data.important ? 1 : 0;
        if (iB !== iA) return iB - iA;
        return (b.data.createdAt || 0) - (a.data.createdAt || 0);
    });

    var html = "";
    unread.forEach(function(item) {
        var n  = item.data;
        var nid = item.id;
        var isImportant = !!n.important;

        if (isImportant) {
            html += "<div class='notice-item notice-important' id='notice-" + nid + "'>"
                  + "<span class='notice-badge-important'>중요</span>"
                  + "<div class='notice-body'>"
                  + "<div class='notice-title-imp'>" + _noticeEsc(n.title) + "</div>"
                  + "<div class='notice-content-text'>" + _noticeEsc(n.content).replace(/\n/g, "<br>") + "</div>"
                  + "<div class='notice-meta'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                  + "</div>"
                  + "<button class='notice-read-btn notice-read-btn-imp' onclick='markNoticeRead(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>확인</button>"
                  + "</div>";
        } else {
            html += "<div class='notice-item notice-normal' id='notice-" + nid + "'>"
                  + "<div class='notice-dot'></div>"
                  + "<div class='notice-body'>"
                  + "<div class='notice-title-normal'>" + _noticeEsc(n.title) + "</div>"
                  + "<div class='notice-content-text notice-content-collapsed'>" + _noticeEsc(n.content).replace(/\n/g, "<br>") + "</div>"
                  + "<div class='notice-meta'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                  + "</div>"
                  + "<button class='notice-read-btn' onclick='markNoticeRead(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>확인</button>"
                  + "</div>";
        }
    });

    container.innerHTML = html;
}

/**
 * markNoticeRead(noticeId, deptId)
 * 확인 버튼 클릭 → fn.markNoticeRead 호출 (db.ref 직접 접근 없음).
 * DOM에서 즉시 제거 후 Function 호출 (UX 우선).
 */
function markNoticeRead(noticeId, deptId) {
    if (!noticeId || !deptId) return;

    // 즉시 DOM 제거 (UX — 서버 응답 기다리지 않음)
    var el = document.getElementById("notice-" + noticeId);
    if (el) el.remove();

    var container = document.getElementById("noticeMain");
    if (container && !container.querySelector(".notice-item")) {
        container.innerHTML = "<span style='color:#aaa;'>새 공지사항이 없습니다.</span>";
    }

    // Function 경유 읽음 기록
    fn.markNoticeRead({ deptId: deptId, noticeId: noticeId })
        .catch(function(e) {
            console.warn("[notices] markNoticeRead failed:", e && e.message);
        });
}

// ─────────────────────────────────────────────────────────────────────────────
// ③ 관리자 모드 — 공지 관리 UI
// ─────────────────────────────────────────────────────────────────────────────

/**
 * drawNoticeAdminPanel()
 * 관리자: currentDept 기준 공지 목록 + 작성 폼.
 * 슈퍼관리자: 지점 선택 드롭다운 + 해당 지점 공지 목록.
 */
function drawNoticeAdminPanel() {
    if (!isAdmin && !isSuperAdmin) return;

    var container = document.getElementById("noticeAdminPanelContent");
    if (!container) return;

    // currentDept가 아직 준비되지 않은 경우 재시도
    if (!currentDept && !isSuperAdmin) {
        container.innerHTML = "<div style='color:#888;font-size:12px;'>지점 정보를 불러오는 중...</div>";
        setTimeout(drawNoticeAdminPanel, 200);
        return;
    }

    if (isSuperAdmin) {
        _drawNoticeSuperAdminSelector(container);
        return;
    }

    // 일반 관리자
    _noticeAdminDept = currentDept;
    _drawNoticeAdminForDept(container, currentDept);
}

/** 슈퍼관리자용 지점 선택 드롭다운 */
function _drawNoticeSuperAdminSelector(container) {
    fn.listDepartments({}).then(function(result) {
        var depts = (result.data && result.data.departments) || [];
        if (!_noticeAdminDept && depts.length > 0) {
            _noticeAdminDept = depts[0].deptId || depts[0].id || "";
        }

        var deptOptions = depts.map(function(d) {
            var dId = d.deptId || d.id || "";
            var sel = dId === _noticeAdminDept ? " selected" : "";
            return "<option value='" + _noticeEsc(dId) + "'" + sel + ">"
                 + _noticeEsc(d.name || dId) + "</option>";
        }).join("");

        container.innerHTML =
            "<div style='margin-bottom:10px;display:flex;align-items:center;gap:8px;'>"
            + "<label style='font-weight:bold;font-size:13px;'>지점 선택</label>"
            + "<select id='noticeAdminDeptSelect' class='form-select' style='width:180px;'"
            + " onchange='_onNoticeAdminDeptChange()'>" + deptOptions + "</select></div>"
            + "<div id='noticeAdminDeptContent'><div style='color:#aaa;font-size:12px;'>로딩중...</div></div>";

        _drawNoticeAdminForDept(
            document.getElementById("noticeAdminDeptContent"),
            _noticeAdminDept
        );
    }).catch(function(e) {
        console.error("[notices] listDepartments failed:", e);
        container.innerHTML = "<span style='color:#c00;'>지점 목록 로드 실패: " + _noticeEsc(e && e.message) + "</span>";
    });
}

/** 슈퍼관리자 지점 변경 핸들러 */
function _onNoticeAdminDeptChange() {
    var sel = document.getElementById("noticeAdminDeptSelect");
    if (!sel) return;
    _noticeAdminDept = sel.value;
    _noticeEditId = null;
    var inner = document.getElementById("noticeAdminDeptContent");
    if (inner) _drawNoticeAdminForDept(inner, _noticeAdminDept);
}

/**
 * _drawNoticeAdminForDept(container, deptId)
 * fn.listNotices 로 공지 조회 후 목록 + 작성폼 렌더링.
 * db.ref 직접 사용 없음.
 */
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
        items.sort(function(a, b) {
            return (b.data.createdAt || 0) - (a.data.createdAt || 0);
        });

        // 작성/수정 폼
        var editingData = _noticeEditId && notices[_noticeEditId] ? notices[_noticeEditId] : null;
        var formTitle   = editingData ? _noticeEsc(editingData.title)   : "";
        var formContent = editingData ? _noticeEsc(editingData.content) : "";
        var formImp     = editingData ? (editingData.important ? " checked" : "") : "";
        var formActive  = editingData ? (editingData.active === false ? "" : " checked") : " checked";
        var formLabel   = _noticeEditId ? "공지 수정" : "새 공지 작성";
        var cancelBtn   = _noticeEditId
            ? "<button type='button' class='btn btn-secondary' style='margin-left:6px;'"
              + " onclick='_cancelNoticeEdit()'>취소</button>"
            : "";

        var html =
            "<div style='background:#f8faff;border:1px solid #dbeafe;border-radius:8px;"
            + "padding:14px;margin-bottom:14px;'>"
            + "<div style='font-weight:bold;font-size:13px;color:#1d4ed8;margin-bottom:10px;'>"
            + formLabel + "</div>"
            + "<div style='margin-bottom:8px;'>"
            + "<input type='text' id='noticeFormTitle' class='form-input' placeholder='제목'"
            + " value=\"" + formTitle + "\" style='width:100%;'></div>"
            + "<div style='margin-bottom:8px;'>"
            + "<textarea id='noticeFormContent' class='form-input' placeholder='내용'"
            + " rows='4' style='width:100%;resize:vertical;'>" + formContent + "</textarea></div>"
            + "<div style='display:flex;gap:16px;align-items:center;margin-bottom:10px;font-size:13px;'>"
            + "<label><input type='checkbox' id='noticeFormImportant'" + formImp + "> 중요 공지</label>"
            + "<label><input type='checkbox' id='noticeFormActive'" + formActive + "> 표시 활성화</label>"
            + "</div>"
            + "<div style='display:flex;gap:8px;'>"
            + "<button type='button' class='btn btn-primary-sm'"
            + " onclick='submitNoticeForm(\"" + _noticeEsc(deptId) + "\")'>"
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
                html += "<div class='notice-admin-row"
                    + (nid === _noticeEditId ? " notice-admin-row-editing" : "") + "'>"
                    + "<div style='flex:1;min-width:0;'>"
                    + "<div style='display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-bottom:3px;'>"
                    + impBadge + activeBadge
                    + "<span style='font-weight:bold;font-size:13px;'>" + _noticeEsc(n.title) + "</span>"
                    + "</div>"
                    + "<div style='font-size:12px;color:#666;overflow:hidden;text-overflow:ellipsis;"
                    + "white-space:nowrap;max-width:420px;'>" + _noticeEsc(n.content) + "</div>"
                    + "<div style='font-size:11px;color:#aaa;margin-top:2px;'>" + _fmtNoticeDate(n.createdAt) + "</div>"
                    + "</div>"
                    + "<div style='display:flex;gap:6px;flex-shrink:0;'>"
                    + "<button type='button' class='btn btn-secondary'"
                    + " style='font-size:11px;padding:4px 10px;'"
                    + " onclick='_editNotice(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>수정</button>"
                    + "<button type='button' class='btn'"
                    + " style='font-size:11px;padding:4px 10px;background:#fef2f2;color:#c62828;"
                    + "border:1px solid #fca5a5;border-radius:6px;'"
                    + " onclick='_deleteNotice(\"" + _noticeEsc(nid) + "\",\"" + _noticeEsc(deptId) + "\")'>삭제</button>"
                    + "</div></div>";
            });
            html += "</div>";
        }

        container.innerHTML = html;
    }).catch(function(e) {
        console.error("[notices] listNotices(admin) failed (deptId=" + deptId + "):", e);
        container.innerHTML =
            "<div style='color:#c62828;font-size:12px;'>"
            + "공지사항을 불러오지 못했습니다. ("
            + _noticeEsc((e && e.message) || "알 수 없는 오류") + ")</div>";
    });
}

/** 공지 저장/수정 제출 */
function submitNoticeForm(deptId) {
    var title   = (document.getElementById("noticeFormTitle")    || {}).value || "";
    var content = (document.getElementById("noticeFormContent")  || {}).value || "";
    var imp     = !!(document.getElementById("noticeFormImportant") || {}).checked;
    var active  = !!(document.getElementById("noticeFormActive")    || {}).checked;

    title   = title.trim();
    content = content.trim();
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

/** 수정 버튼 — editId 세팅 후 폼 재렌더 */
function _editNotice(noticeId, deptId) {
    _noticeEditId = noticeId;
    var target = isSuperAdmin
        ? document.getElementById("noticeAdminDeptContent")
        : document.getElementById("noticeAdminPanelContent");
    if (target) _drawNoticeAdminForDept(target, deptId);
}

/** 수정 취소 */
function _cancelNoticeEdit() {
    _noticeEditId = null;
    _refreshNoticeAdminPanel();
}

/** 공지 삭제 */
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

/** 공지 관리 패널 새로고침 */
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
// ④ window 노출 (index.html inline onclick 에서 호출)
// ─────────────────────────────────────────────────────────────────────────────
window.initNoticeListener       = initNoticeListener;
window.drawNoticeAdminPanel     = drawNoticeAdminPanel;
window.submitNoticeForm         = submitNoticeForm;
window.markNoticeRead           = markNoticeRead;
window._editNotice              = _editNotice;
window._cancelNoticeEdit        = _cancelNoticeEdit;
window._deleteNotice            = _deleteNotice;
window._onNoticeAdminDeptChange = _onNoticeAdminDeptChange;
