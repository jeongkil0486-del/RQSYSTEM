// config.js — Firebase 초기화 및 App Check 설정
//
// ⚠️ 이 파일은 GitHub 공개 저장소에 올려도 됩니다.
//    API Key는 Firebase Console > Authorized Domains 으로 보호됩니다.
//
// 초기화 순서가 중요합니다:
//   1. firebase.initializeApp()
//   2. firebase.appCheck().activate()  ← db, functions 사용 전
//   3. firebase.database()
//   4. firebase.functions()

var firebaseConfig = {
  apiKey:            "AIzaSyAeinBE3TPhnqGjg0-PPOt3GLghed-5cz0",
  authDomain:        "taerq-67005.firebaseapp.com",
  databaseURL:       "https://taerq-67005-default-rtdb.firebaseio.com",
  projectId:         "taerq-67005",
  storageBucket:     "taerq-67005.firebasestorage.app",
  messagingSenderId: "1020157696656",
  appId:             "1:1020157696656:web:33a633ff539bae5f6b1615"
};

// ── 1. Firebase 앱 초기화 ───────────────────────────────────────────────────
firebase.initializeApp(firebaseConfig);

// ── 2. App Check 초기화 (db/functions 사용 전에 반드시 먼저) ────────────────
//
// 배포 준비가 되면 아래 두 줄의 주석을 해제하고 사이트 키를 입력하세요.
// DEPLOY_GUIDE STEP 1 ~ 3 완료 후 해제합니다.
//
var appCheck = firebase.appCheck();
appCheck.activate("6Lf3lTMtAAAAAOioiDzqdblAO9do7l8HMQi1Zh5Z", true);

// ── 3. Firebase 서비스 객체 (App Check 초기화 후 생성) ──────────────────────
var db       = firebase.database();
var fnClient = firebase.functions();
