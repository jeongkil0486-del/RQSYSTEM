// config.js — Firebase 초기화 (App Check OFF 테스트 버전)
//
// ⚠️ 이 파일은 GitHub 공개 저장소에 올려도 됩니다.
//    API Key는 Firebase Console > Authorized Domains 으로 보호됩니다.
//
// 초기화 순서가 중요합니다:
//   1. firebase.initializeApp()
//   2. firebase.database()
//   3. firebase.functions()

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

// ── 2. App Check OFF 테스트 ───────────────────────────────────────────────
// 현재 단계에서는 App Check SDK 로드를 실행하지 않습니다.
// Functions/Rules는 건드리지 않고, 웹 배포에서 App Check 영향 여부만 확인합니다.

// ── 3. Firebase 서비스 객체 ────────────────────────────────────────────────
var db       = firebase.database();
var fnClient = firebase.functions();
