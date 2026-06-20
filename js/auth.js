/**
 * Authentication Module — OAuth Authorization-Code flow via the Worker.
 *
 * The browser never holds the Google refresh token. Instead:
 *   - signIn() / startDriveUpgrade() redirect to <AUTH_BASE_URL>/auth/login.
 *   - The Worker runs the Authorization Code + PKCE exchange, seals the
 *     refresh token into an opaque session token, and redirects back to the
 *     app with `#auth=<session>`.
 *   - We store that session token in localStorage and POST it to
 *     <AUTH_BASE_URL>/auth/token to mint a fresh Google access token whenever
 *     one is needed (boot, scheduled refresh, foreground wake, reactive 401).
 *
 * This replaces the old GIS token-client + hidden-iframe silent refresh,
 * which iOS Safari ITP blocked (causing the ~hourly re-login). The session
 * token lives in first-party localStorage and travels as a Bearer header, so
 * there is no third-party-cookie dependency.
 *
 * The rest of the app keeps using the same surface: getAccessToken() (sync,
 * cached), refreshToken() (async), getUser(), hasDriveAccess(), signOut().
 */

const Auth = {
    accessToken: null,
    user: null,
    session: null,
    onAuthChange: null,
    // Epoch ms when the current access_token stops working. Google tokens
    // last ~3600s; we refresh ~60s before to avoid mid-request expiry.
    _expiresAt: 0,
    _refreshTimer: null,
    // In-flight refresh so concurrent callers (HLS segment fetches, Sync,
    // etc.) share one Worker round-trip instead of stampeding.
    _refreshPromise: null,
    SESSION_STORAGE_KEY: 'audiobook_session',
    GRANTED_SCOPES_STORAGE_KEY: 'audiobook_granted_scopes',
    EXPIRES_AT_STORAGE_KEY: 'audiobook_access_token_exp',  // legacy; cleaned on sign-out
    REFRESH_LEAD_MS: 60_000,

    /**
     * Initialize. Handles the post-login redirect fragment, restores any
     * stored session, and arms the wake-refresh listener.
     */
    init(onAuthChange) {
        this.onAuthChange = onAuthChange;

        // 1. If we just came back from the Worker's /auth/callback, the
        //    session token (or an error) is in the URL fragment.
        if (this._consumeAuthFragment()) {
            this._installWakeRefreshListener();
            return;
        }

        // 2. Returning visit: restore the stored session + profile.
        this.session = Storage.get(this.SESSION_STORAGE_KEY);
        this.user = Storage.getUser();

        this._installWakeRefreshListener();

        if (this.session) {
            // Mint a fresh access token. On success refreshToken() fires
            // onAuthChange(true). On a hard auth failure we sign out; on a
            // transient network error we stay optimistically signed in with
            // the stored profile and let a later wake/retry recover.
            this.refreshToken().catch((err) => {
                if (err && err.authInvalid) {
                    this.softSignOut();
                } else if (this.user && this.onAuthChange) {
                    this.onAuthChange(true, this.user);
                }
            });
        }
        // No session → leave the default login screen as-is.
    },

    /**
     * Parse `#auth=<session>` / `#auth_error=<reason>` from the redirect
     * landing. Returns true if a fragment was handled.
     */
    _consumeAuthFragment() {
        const hash = location.hash || '';
        if (hash.length < 2) return false;
        const params = new URLSearchParams(hash.slice(1));
        const auth = params.get('auth');
        const err = params.get('auth_error');
        if (!auth && !err) return false;

        this._clearHash();

        if (auth) {
            this.session = auth;
            Storage.set(this.SESSION_STORAGE_KEY, auth);
            this.refreshToken().catch(() => this.softSignOut());
            return true;
        }

        // err
        console.warn('[auth] login error:', err);
        if (typeof App !== 'undefined' && App.showToast) {
            App.showToast(this._authErrorMessage(err), 'error');
        }
        if (this.onAuthChange) this.onAuthChange(false, null);
        return true;
    },

    _clearHash() {
        try {
            history.replaceState(null, '', location.pathname + location.search);
        } catch (_e) {
            location.hash = '';
        }
    },

    _authErrorMessage(err) {
        if (err === 'forbidden') {
            return 'Tämä Google-tili ei ole sallittujen listalla';
        }
        if (err === 'no_refresh_token') {
            return 'Kirjautuminen epäonnistui (ei refresh tokenia). Yritä uudelleen.';
        }
        return 'Kirjautuminen epäonnistui';
    },

    /** Return URL for the OAuth round-trip: current page minus any fragment. */
    _returnUrl() {
        return location.origin + location.pathname + location.search;
    },

    /**
     * Begin sign-in. Full-page redirect to the Worker, which bounces to
     * Google and back. Robust on iOS (including home-screen PWA) where
     * popups are flaky.
     */
    signIn() {
        const url = `${CONFIG.AUTH_BASE_URL}/auth/login?return=${encodeURIComponent(this._returnUrl())}`;
        location.assign(url);
    },

    /**
     * Incremental authorization for Google Drive. Same redirect flow with
     * `add=drive`, so Google asks for the sensitive Drive scopes only now.
     * The page navigates away and returns with a session that includes the
     * Drive scopes; hasDriveAccess() then reflects that.
     */
    startDriveUpgrade() {
        const url = `${CONFIG.AUTH_BASE_URL}/auth/login?add=drive&return=${encodeURIComponent(this._returnUrl())}`;
        location.assign(url);
    },

    /**
     * Mint a fresh Google access token from the stored session token by
     * POSTing to the Worker. Concurrent callers share one request.
     *
     * Fires onAuthChange(true, user) only on the first successful token of
     * the session (the login transition); scheduled/reactive refreshes stay
     * silent so we don't reload the library every hour.
     *
     * Rejects with `err.authInvalid = true` when the session is rejected
     * (expired/revoked) so callers can sign the user out; transient network
     * failures reject without that flag.
     */
    refreshToken() {
        if (this._refreshPromise) return this._refreshPromise;
        const session = this.session || Storage.get(this.SESSION_STORAGE_KEY);
        if (!session) {
            const e = new Error('no_session');
            e.authInvalid = true;
            return Promise.reject(e);
        }

        const isFirst = !this.accessToken;

        this._refreshPromise = (async () => {
            let resp;
            try {
                resp = await fetch(`${CONFIG.AUTH_BASE_URL}/auth/token`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${session}` },
                });
            } catch (networkErr) {
                // Offline / transient — not an auth failure.
                throw networkErr;
            }
            if (!resp.ok) {
                const e = new Error(`auth_token_${resp.status}`);
                // Only 401/403 mean the session is genuinely invalid (→ sign
                // out). Everything else (5xx, 429, other transient failures)
                // is treated as recoverable, so a Worker/Google blip doesn't
                // bounce a listening user back to the login screen.
                e.authInvalid = resp.status === 401 || resp.status === 403;
                throw e;
            }
            const data = await resp.json();

            this.accessToken = data.access_token;
            const lifetimeMs = (parseInt(data.expires_in, 10) || 3600) * 1000;
            this._expiresAt = Date.now() + lifetimeMs;

            // Persist granted scopes so hasDriveAccess() works across loads.
            const scopes = typeof data.scopes === 'string'
                ? data.scopes.split(' ').filter(Boolean)
                : [];
            Storage.set(this.GRANTED_SCOPES_STORAGE_KEY, scopes);

            // Refresh the cached profile (the Worker echoes it back).
            const user = {
                email: data.email,
                name: data.name,
                picture: data.picture,
            };
            this.user = user;
            Storage.setUser(user);

            this._scheduleAutoRefresh();

            if (isFirst) {
                console.info('[auth] signed in / session restored');
                if (this.onAuthChange) this.onAuthChange(true, user);
            } else {
                console.info(`[auth] token refreshed (expires in ${Math.round(lifetimeMs / 60000)}min)`);
            }
            return this.accessToken;
        })();

        // Clear the in-flight marker whether it resolves or rejects.
        this._refreshPromise.finally(() => { this._refreshPromise = null; });
        return this._refreshPromise;
    },

    /**
     * Foreground-wake refresh. Background tabs throttle setTimeout (Chrome
     * drops to ~1 Hz after 5 min; iOS Safari pauses entirely), so a refresh
     * scheduled for the 59th minute may never fire while the user listens
     * with the screen off. Re-check on every foreground transition.
     */
    _installWakeRefreshListener() {
        if (this._wakeListenerInstalled) return;
        this._wakeListenerInstalled = true;

        const wake = () => {
            if (!this.accessToken || !this._expiresAt) return;
            const refreshAt = this._expiresAt - this.REFRESH_LEAD_MS;
            if (Date.now() >= refreshAt) {
                this.refreshToken().catch(err => {
                    console.warn('[auth] wake refresh failed:', err?.message || err);
                });
            } else {
                this._scheduleAutoRefresh();
            }
        };

        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') wake();
        });
        window.addEventListener('focus', wake);
        // iOS Safari restores from BFCache without firing visibilitychange
        window.addEventListener('pageshow', wake);
    },

    /**
     * Schedule a silent token refresh ~60s before the current token expires.
     * Idempotent. A timer failure is non-fatal — the wake listener and the
     * reactive 401 retries in the R2 provider / HLS player catch real
     * failures, and we never sign the user out from a background timer.
     */
    _scheduleAutoRefresh() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (!this._expiresAt) return;
        const onFail = err => {
            console.warn('[auth] scheduled refresh failed (will retry on wake/request):', err?.message || err);
        };
        const delay = this._expiresAt - Date.now() - this.REFRESH_LEAD_MS;
        if (delay <= 0) {
            this.refreshToken().catch(onFail);
            return;
        }
        this._refreshTimer = setTimeout(() => {
            this.refreshToken().catch(onFail);
        }, delay);
    },

    /** True when the access token has expired (or is missing). */
    isExpired() {
        if (!this.accessToken) return true;
        if (!this._expiresAt) return false;
        return Date.now() >= this._expiresAt;
    },

    /**
     * True if `storedScopes` already contains every scope in the
     * space-separated `scopeStr`.
     */
    _scopesInclude(storedScopes, scopeStr) {
        if (!Array.isArray(storedScopes)) return false;
        const required = (scopeStr || '').split(' ').filter(Boolean);
        return required.every(s => storedScopes.includes(s));
    },

    /** True once the user has granted the Drive scopes (this device). */
    hasDriveAccess() {
        const stored = Storage.get(this.GRANTED_SCOPES_STORAGE_KEY);
        return this._scopesInclude(stored, CONFIG.DRIVE_SCOPES);
    },

    /**
     * "Soft" sign-out used when a refresh fails because the session is
     * invalid. Drops the in-memory token + the stored session, routes back
     * to login, but leaves settings / R2 config / progress intact. The user
     * just clicks "Kirjaudu" to start a fresh login.
     */
    softSignOut() {
        this.accessToken = null;
        this.session = null;
        this._expiresAt = 0;
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        Storage.remove(this.SESSION_STORAGE_KEY);
        Storage.remove(this.EXPIRES_AT_STORAGE_KEY);
        if (this.onAuthChange) this.onAuthChange(false, null);
    },

    /** Check if user is authenticated. */
    isAuthenticated() {
        return !!this.accessToken && !!this.user;
    },

    /** Current access token (synchronous, cached). */
    getAccessToken() {
        return this.accessToken;
    },

    /** Current user. */
    getUser() {
        return this.user;
    },

    /**
     * Full sign-out: revoke the refresh token at Google (via the Worker) and
     * wipe local identity. Used by the explicit "Kirjaudu ulos" button.
     */
    signOut() {
        const session = this.session || Storage.get(this.SESSION_STORAGE_KEY);
        if (session) {
            // Best-effort revoke; don't block the UI on it.
            fetch(`${CONFIG.AUTH_BASE_URL}/auth/logout`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${session}` },
            }).catch(() => { /* ignore */ });
        }

        this.accessToken = null;
        this.user = null;
        this.session = null;
        this._expiresAt = 0;
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        Storage.clearUserData();
        Storage.remove(this.SESSION_STORAGE_KEY);
        Storage.remove(this.EXPIRES_AT_STORAGE_KEY);
        Storage.remove(this.GRANTED_SCOPES_STORAGE_KEY);

        if (this.onAuthChange) {
            this.onAuthChange(false, null);
        }
    },
};
