function checkAuth() {
    var email = document.getElementById("username").value.trim();
    var pass = document.getElementById("password").value.trim();

    if (email === "" || pass === "") {
        alert("이메일과 비밀번호를 모두 입력해주세요.");
        return;
    }

    if (email.indexOf("@") === -1) {
        alert("이제 로그인 ID 대신 이메일 주소를 사용합니다.");
        return;
    }

    setLoginButtonState(true, "로그인 중...");

    auth.signInWithEmailAndPassword(email, pass).catch(function(error) {
        var message = "로그인에 실패했습니다.";

        if (error && error.code === "auth/user-not-found") {
            message = "등록된 계정을 찾을 수 없습니다.";
        } else if (error && error.code === "auth/wrong-password") {
            message = "비밀번호가 올바르지 않습니다.";
        } else if (error && error.code === "auth/invalid-email") {
            message = "이메일 형식이 올바르지 않습니다.";
        } else if (error && error.message) {
            message = error.message;
        }

        alert(message);
        setLoginButtonState(false, "로그인");
    });
}

function loginSuccess(name) {
    currentUser = name;
    setLoginButtonState(false, "로그인");
    refreshData();
    document.getElementById("loginArea").style.display = "none";
    modal.style.display = "flex";
}
