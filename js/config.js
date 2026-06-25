var firebaseConfig = {
            apiKey: "AIzaSyAeinBE3TPhnqGjg0-PPOt3GLghed-5cz0",
            authDomain: "taerq-67005.firebaseapp.com",
            databaseURL: "https://taerq-67005-default-rtdb.firebaseio.com",
            projectId: "taerq-67005",
            storageBucket: "taerq-67005.firebasestorage.app",
            messagingSenderId: "1020157696656",
            appId: "1:1020157696656:web:33a633ff539bae5f6b1615"
        };
        firebase.initializeApp(firebaseConfig);
        var db = firebase.database();
        var _rawDbRef = db.ref.bind(db);

        function _isLegacyTrinityPathBlocked(path) {
            if (typeof path !== "string") return false;
            if (path.indexOf("trinity_system") !== 0) return false;
            if (typeof isSuperAdmin !== "undefined" && isSuperAdmin === true) return false;
            if (typeof currentUserRole !== "undefined" && currentUserRole === "super_admin") return false;
            return true;
        }

        function _makeBlockedSnapshot() {
            return {
                key: null,
                ref: null,
                val: function() { return null; },
                exists: function() { return false; },
                child: function() { return _makeBlockedSnapshot(); }
            };
        }

        function _makeBlockedRef(path) {
            return {
                key: String(path || "").split("/").pop(),
                once: function(eventType, successCallback) {
                    var snap = _makeBlockedSnapshot();
                    if (typeof successCallback === "function") successCallback(snap);
                    return Promise.resolve(snap);
                },
                on: function() { return null; },
                off: function() {},
                set: function() { return Promise.resolve(null); },
                update: function() { return Promise.resolve(null); },
                remove: function() { return Promise.resolve(null); },
                transaction: function(updateFn, onComplete) {
                    var snap = _makeBlockedSnapshot();
                    if (typeof onComplete === "function") onComplete(null, false, snap);
                    return Promise.resolve({ committed: false, snapshot: snap });
                },
                child: function(childPath) {
                    return _makeBlockedRef(String(path || "") + "/" + childPath);
                }
            };
        }

        db.ref = function(path) {
            if (_isLegacyTrinityPathBlocked(path)) {
                return _makeBlockedRef(path);
            }
            return _rawDbRef(path);
        };
