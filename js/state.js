var auth = firebase.auth();

var ADMIN_ACCOUNTS = {};
var ADMIN_DEFAULT_PASS = {};
var SUPER_ADMIN_ID = null;
var SUPER_ADMIN_PASS = null;
var _adminAccountsLoaded = false;
var ALL_DEPTS = [];

var modal = document.getElementById("calendarModal");
var currentUid = "";
var currentUser = "";
var currentUserEmail = "";
var currentUserRole = "";
var currentProfile = null;
var currentDept = "";
var isAdmin = false;
var isSuperAdmin = false;
var liveDBData = {};
var currentAppMode = "NORMAL";
var dbListener = null;
var allowedUsers = [];

var defaultGroupA = [];
var defaultGroupB = [];
var defaultGroupC = [];
var defaultGroupD = [];
var defaultGroupE = [];

var _deptListeners = [];
var isLegacyPasswordFeatureEnabled = false;
