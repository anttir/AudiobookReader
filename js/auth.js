/**
 * Authentication Module - Handles Google Sign-In
 */

const Auth = {
    tokenClient: null,
    accessToken: null,
    user: null,
    onAuthChange: null,
    // Epoch ms when the current access_token stops working. Google tokens
    // last ~3600s; we refresh ~60s before to avoid mid-request expiry.
    _expiresAt: 0,
    _refreshTimer: null,
    // In-flight refresh so concurrent callers (HLS segment fetches, Sync,
    // etc.) share one Google round-trip instead of stampeding.
    _refreshPromise: null,
    // Per-session guard against a re-consent loop: if the user denies the
    // new scopes we must NOT immediately ask again the same session.
    _reconsentTried: false,
    EXPIRES_AT_STORAGE_KEY: 'audiobook_access_token_exp',
    GRANTED_SCOPES_STORAGE_KEY: 'audiobook_granted_scopes',
    REFRESH_LEAD_MS: 60_000,

    /**
     * Initialize Google Identity Services
     */
    init(onAuthChange) {
        this.onAuthChange = onAuthChange;

        // Check for stored token
        const storedToken = Storage.getAccessToken();
        const storedUser = Storage.getUser();
        const storedExp = Storage.get(this.EXPIRES_AT_STORAGE_KEY) || 0;
        const storedScopes = Storage.get(this.GRANTED_SCOPES_STORAGE_KEY);

        // Detect scope drift: CONFIG.SCOPES has changed since the stored
        // token was granted (e.g. drive.file → drive.readonly migration).
        // Force re-consent so the new token has the required scopes
        // BEFORE the app makes its first Drive request.
        if (storedToken && storedUser && this._hasScopeDrift(storedScopes)) {
            console.info('[auth] scope drift detected; clearing stored token and forcing re-consent');
            this._forceReconsentOnStartup = true;
        } else if (storedToken && storedUser) {
            this.accessToken = storedToken;
            this.user = storedUser;
            this._expiresAt = storedExp;
            // Verify token is still valid
            this.verifyToken();
        }

        // Initialize token client
        this.initTokenClient();

        // Refresh on wake. Background tabs throttle setTimeout (Chrome
        // drops to ~1 Hz after 5 min; iOS Safari pauses entirely), so a
        // refresh scheduled for the 59th minute may never fire while the
        // user is listening with the screen off. We re-check on every
        // foreground transition.
        this._installWakeRefreshListener();
    },

    /**
     * Trigger a token-state check whenever the page transitions to
     * foreground. If the scheduled refresh point has passed (or the
     * token is already expired), run a silent refresh now. Otherwise
     * re-arm the timer in case the previous one was throttled away.
     *
     * Idempotent — safe to call more than once.
     */
    _installWakeRefreshListener() {
        if (this._wakeListenerInstalled) return;
        this._wakeListenerInstalled = true;

        const wake = () => {
            if (!this.accessToken || !this._expiresAt) return;
            const refreshAt = this._expiresAt - this.REFRESH_LEAD_MS;
            if (Date.now() >= refreshAt) {
                console.info('[auth] wake: token at/past refresh point; refreshing now');
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
     * True if the stored granted-scopes list is missing any scope that
     * CONFIG.SCOPES now requires. A null storedScopes value means we
     * never recorded the grant (token predates this code) — treat as
     * mismatch so we get a fresh, audited grant.
     */
    _hasScopeDrift(storedScopes) {
        const required = (CONFIG.SCOPES || '').split(' ').filter(Boolean);
        if (!Array.isArray(storedScopes)) return true;
        return required.some(s => !storedScopes.includes(s));
    },

    /**
     * Initialize the Google OAuth token client
     */
    initTokenClient() {
        if (typeof google === 'undefined') {
            console.error('Google Identity Services not loaded');
            setTimeout(() => this.initTokenClient(), 500);
            return;
        }

        this.tokenClient = google.accounts.oauth2.initTokenClient({
            client_id: CONFIG.GOOGLE_CLIENT_ID,
            scope: CONFIG.SCOPES,
            callback: (response) => this.handleTokenResponse(response),
            error_callback: (error) => this.handleError(error)
        });

        // If init() detected scope drift on a returning user, request a
        // fresh consent now that the client is ready. This is gated by
        // _reconsentTried to avoid loops if the user denies.
        if (this._forceReconsentOnStartup && !this._reconsentTried) {
            this._forceReconsentOnStartup = false;
            this._reconsentTried = true;
            try {
                if (typeof App !== 'undefined' && App.showToast) {
                    App.showToast('Lupia päivitetään...', 'info');
                }
            } catch (_e) { /* App may not be ready yet */ }
            this.tokenClient.requestAccessToken({ prompt: 'consent' });
        }
    },

    /**
     * Handle token response from Google
     */
    async handleTokenResponse(response) {
        if (response.error) {
            this.handleError(response);
            return;
        }

        // Verify the granted scopes match what CONFIG.SCOPES requires.
        // If the user (or Google) downgraded the grant — e.g. they denied
        // a newly-added scope — kick off a one-shot re-consent.
        const requiredScopes = (CONFIG.SCOPES || '').split(' ').filter(Boolean);
        const allGranted = (typeof google !== 'undefined'
            && google.accounts?.oauth2?.hasGrantedAllScopes)
            ? google.accounts.oauth2.hasGrantedAllScopes(response, ...requiredScopes)
            : true;
        if (!allGranted) {
            if (this._reconsentTried) {
                // User denied the new scopes a moment ago; don't loop.
                console.warn('[auth] required scopes still missing after re-consent; continuing with reduced grant');
            } else {
                this._reconsentTried = true;
                console.info('[auth] missing required scopes; re-requesting with prompt=consent');
                try {
                    if (typeof App !== 'undefined' && App.showToast) {
                        App.showToast('Lupia päivitetään...', 'info');
                    }
                } catch (_e) { /* ignore */ }
                this.tokenClient.requestAccessToken({ prompt: 'consent' });
                return;
            }
        }

        const isRefresh = !!this.accessToken;
        this.accessToken = response.access_token;
        Storage.setAccessToken(this.accessToken);

        // Persist the granted scopes so the next page load can detect
        // CONFIG.SCOPES drift (e.g. a new release added a new scope).
        // We store what Google actually granted, not what we asked for.
        const grantedScopes = typeof response.scope === 'string'
            ? response.scope.split(' ').filter(Boolean)
            : requiredScopes;
        Storage.set(this.GRANTED_SCOPES_STORAGE_KEY, grantedScopes);

        // Record expiry so we can refresh silently before requests fail.
        // Google returns expires_in (seconds). Fall back to 1h if absent.
        const lifetimeMs = (parseInt(response.expires_in, 10) || 3600) * 1000;
        this._expiresAt = Date.now() + lifetimeMs;
        Storage.set(this.EXPIRES_AT_STORAGE_KEY, this._expiresAt);
        this._scheduleAutoRefresh();

        // Surface refresh success so a user looking at the console knows
        // the silent flow actually worked (and the "Blocked script
        // execution in 'about:srcdoc'" warning from GIS's hidden iframe
        // was the benign side-effect everyone reports).
        if (isRefresh) {
            console.info(`[auth] token refreshed silently (expires in ${Math.round(lifetimeMs/60000)}min)`);
        }

        // If this was a silent refresh (we already had a user object),
        // skip the userinfo round-trip — Google didn't give us anything
        // new about the user, and the extra fetch slows refresh latency.
        if (this.user) {
            if (this.onAuthChange) this.onAuthChange(true, this.user);
            return;
        }

        try {
            const userInfo = await this.fetchUserInfo();
            this.user = userInfo;
            Storage.setUser(userInfo);

            if (this.onAuthChange) {
                this.onAuthChange(true, userInfo);
            }
        } catch (error) {
            console.error('Failed to fetch user info:', error);
            this.handleError(error);
        }
    },

    /**
     * Schedule a silent token refresh ~60s before the current token
     * expires. Idempotent — clears any previously-scheduled timer.
     *
     * A timer failure here is non-fatal: we log and rely on the
     * visibility-wake listener and the reactive 401 retries in the
     * R2 provider / HLS player to catch real failures. Aggressively
     * signing the user out from a background timer would yank them
     * out of a listening session mid-chapter.
     */
    _scheduleAutoRefresh() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (!this._expiresAt) return;
        const delay = this._expiresAt - Date.now() - this.REFRESH_LEAD_MS;
        const onFail = err => {
            console.warn('[auth] scheduled refresh failed (will retry on next request/wake):', err?.message || err);
        };
        if (delay <= 0) {
            this.refreshToken().catch(onFail);
            return;
        }
        this._refreshTimer = setTimeout(() => {
            this.refreshToken().catch(onFail);
        }, delay);
    },

    /**
     * Silent re-grant of the access token using the existing Google
     * session. Returns a promise that resolves with the new token, or
     * rejects if Google refused (typically: user signed out at Google
     * or revoked consent — in which case they need to click Sign In
     * again).
     *
     * Concurrent callers share one in-flight refresh.
     */
    refreshToken() {
        if (this._refreshPromise) return this._refreshPromise;
        if (!this.tokenClient) {
            return Promise.reject(new Error('token client not initialized'));
        }

        this._refreshPromise = new Promise((resolve, reject) => {
            // Swap in temporary callbacks. On SUCCESS we still invoke
            // the persistent handleTokenResponse callback so Storage and
            // the auto-refresh timer get updated. On FAILURE we
            // deliberately DO NOT invoke the persistent handleError —
            // silent refresh failures are routine (Safari ITP blocks
            // the GIS hidden iframe, the user has 3rd-party cookies
            // off, transient network blips) and the persistent
            // handleError aggressively wipes Storage and bounces the
            // user to the login screen. Let the caller decide via the
            // rejected promise.
            const origCb = this.tokenClient.callback;
            const origErr = this.tokenClient.error_callback;
            const restore = () => {
                this.tokenClient.callback = origCb;
                this.tokenClient.error_callback = origErr;
                this._refreshPromise = null;
            };
            this.tokenClient.callback = (resp) => {
                try { origCb?.(resp); } finally { restore(); }
                if (resp.error) reject(new Error(resp.error));
                else resolve(resp.access_token);
            };
            this.tokenClient.error_callback = (err) => {
                restore();
                reject(err instanceof Error ? err : new Error(String(err?.type || 'auth_error')));
            };
            // prompt: '' = silent if Google session exists; no popup
            this.tokenClient.requestAccessToken({ prompt: '' });
        });
        return this._refreshPromise;
    },

    /** True when the access token has expired (or is missing). */
    isExpired() {
        if (!this.accessToken) return true;
        if (!this._expiresAt) return false;  // unknown → assume valid
        return Date.now() >= this._expiresAt;
    },

    /**
     * Handle authentication errors
     */
    handleError(error) {
        console.error('Auth error:', error);
        this.signOut();
        App.showToast('Kirjautuminen epäonnistui', 'error');
    },

    /**
     * Fetch user information from Google
     */
    async fetchUserInfo() {
        const response = await fetch(CONFIG.API.USER_INFO, {
            headers: {
                'Authorization': `Bearer ${this.accessToken}`
            }
        });

        if (!response.ok) {
            throw new Error('Failed to fetch user info');
        }

        return response.json();
    },

    /**
     * Verify stored token is still valid. If it's expired or actually
     * rejected (HTTP 401), try a silent refresh before falling back to
     * a soft sign-out. Transient network errors (offline, DNS blip) do
     * NOT bounce the user — we trust the stored token's known expiry
     * and let the next real request prove it works.
     */
    async verifyToken() {
        // If we already know it's expired, skip the wasted round-trip
        // and go straight to refresh.
        if (this.isExpired()) {
            await this._refreshOrSignOut();
            return;
        }
        let response;
        try {
            response = await fetch(CONFIG.API.USER_INFO, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
        } catch (_networkError) {
            // Offline / transient network failure on app start. Don't
            // wipe the session — the user may simply have no network
            // for a moment. Subsequent real requests will reveal if
            // the token is genuinely bad and trigger reactive refresh.
            console.info('[auth] userinfo fetch failed (network); keeping stored token');
            this._scheduleAutoRefresh();
            if (this.onAuthChange) this.onAuthChange(true, this.user);
            return;
        }
        if (!response.ok) {
            await this._refreshOrSignOut();
            return;
        }
        this._scheduleAutoRefresh();
        if (this.onAuthChange) this.onAuthChange(true, this.user);
    },

    async _refreshOrSignOut() {
        // tokenClient may not be ready yet (gsi/client.js still loading).
        // Wait for it briefly so we don't sign-out a returning user just
        // because the SDK was 200ms slow.
        for (let i = 0; i < 20 && !this.tokenClient; i++) {
            await new Promise(r => setTimeout(r, 150));
        }
        if (!this.tokenClient) {
            this.softSignOut();
            return;
        }
        try {
            await this.refreshToken();
            // handleTokenResponse already fired onAuthChange
        } catch (_e) {
            console.warn('Silent token refresh failed; reverting to login (stored profile preserved)');
            this.softSignOut();
        }
    },

    /**
     * "Soft" sign-out used when a silent refresh fails. Drops the
     * in-memory access token + persisted token+expiry, but leaves the
     * user profile, settings, R2 config, and progress in localStorage.
     * The app routes back to the login screen, but a returning user
     * keeps everything they've configured — they just need to click
     * Sign In to get a fresh token via the popup flow (which works
     * even when 3rd-party cookies are blocked).
     *
     * Contrast with signOut(): that revokes the Google grant and wipes
     * user identity, which is appropriate only when the user
     * explicitly hits "Sign out".
     */
    softSignOut() {
        this.accessToken = null;
        this._expiresAt = 0;
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        Storage.remove(CONFIG.STORAGE_KEYS.accessToken);
        Storage.remove(this.EXPIRES_AT_STORAGE_KEY);
        if (this.onAuthChange) this.onAuthChange(false, null);
    },

    /**
     * Initiate sign in flow
     */
    signIn() {
        if (!this.tokenClient) {
            console.error('Token client not initialized');
            App.showToast('Kirjautuminen ei ole vielä valmis', 'error');
            return;
        }

        // Request an access token
        this.tokenClient.requestAccessToken({ prompt: 'consent' });
    },

    /**
     * Sign out
     */
    signOut() {
        if (this.accessToken) {
            // Revoke the token
            google.accounts.oauth2.revoke(this.accessToken, () => {
                console.log('Token revoked');
            });
        }

        this.accessToken = null;
        this.user = null;
        this._expiresAt = 0;
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        Storage.clearUserData();
        Storage.remove(this.EXPIRES_AT_STORAGE_KEY);
        Storage.remove(this.GRANTED_SCOPES_STORAGE_KEY);
        // Allow a fresh re-consent attempt on the next sign-in.
        this._reconsentTried = false;

        if (this.onAuthChange) {
            this.onAuthChange(false, null);
        }
    },

    /**
     * Check if user is authenticated
     */
    isAuthenticated() {
        return !!this.accessToken && !!this.user;
    },

    /**
     * Get current access token
     */
    getAccessToken() {
        return this.accessToken;
    },

    /**
     * Get current user
     */
    getUser() {
        return this.user;
    }
};
