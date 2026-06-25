// ── 전역 상태 변수 ────────────────────────────────────────────────────────────
var auth = firebase.auth();

// 로그인 후 채워지는 값 (이메일·사번은 화면에 절대 노출 X)
var currentUid          = "";
var currentUser         = "";   // displayName (이름)
var currentUserRole     = "";   // "staff" | "admin" | "super_admin"
var currentProfile      = null;
var currentDept         = "";
var isAdmin             = false;
var isSuperAdmin        = false;

// UI 상태
var liveDBData          = {};
var currentAppMode      = "NORMAL";
var dbListener          = null;
var allowedUsers        = [];
var deptEmployees       = [];
var employeeByUid       = {};
var employeeByEmpNo     = {};
var employeeByName      = {};
var adminViewCache      = {};
var _deptListeners      = [];
var currentDeptAccessRestricted   = false;
var currentDeptAccessErrorMessage = "";

// 스케줄 코드 관련
var currentScheduleCode = "";
var _superResetTargetAdminId = "";

// 레거시 호환용 (기존 DB 키 패턴 유지)
var ADMIN_ACCOUNTS      = {};
var ADMIN_DEFAULT_PASS  = {};
var SUPER_ADMIN_ID      = null;
var ALL_DEPTS           = [];
var _adminAccountsLoaded = false;
var isLegacyPasswordFeatureEnabled = false;

var defaultGroupA = [];
var defaultGroupB = [];
var defaultGroupC = [];
var defaultGroupD = [];
var defaultGroupE = [];

var modal = document.getElementById("calendarModal");
