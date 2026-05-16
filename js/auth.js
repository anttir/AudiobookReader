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
    EXPIRES_AT_STORAGE_KEY: 'audiobook_access_token_exp',
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

        if (storedToken && storedUser) {
            this.accessToken = storedToken;
            this.user = storedUser;
            this._expiresAt = storedExp;
            // Verify token is still valid
            this.verifyToken();
        }

        // Initialize token client
        this.initTokenClient();
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
    },

    /**
     * Handle token response from Google
     */
    async handleTokenResponse(response) {
        if (response.error) {
            this.handleError(response);
            return;
        }

        const isRefresh = !!this.accessToken;
        this.accessToken = response.access_token;
        Storage.setAccessToken(this.accessToken);

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
     */
    _scheduleAutoRefresh() {
        if (this._refreshTimer) {
            clearTimeout(this._refreshTimer);
            this._refreshTimer = null;
        }
        if (!this._expiresAt) return;
        const delay = this._expiresAt - Date.now() - this.REFRESH_LEAD_MS;
        if (delay <= 0) {
            // Already past the refresh point — try immediately
            this.refreshToken().catch(() => { /* error_callback handles */ });
            return;
        }
        this._refreshTimer = setTimeout(() => {
            this.refreshToken().catch(() => { /* error_callback handles */ });
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
            // Swap in temporary callbacks that resolve THIS promise. The
            // tokenClient's persistent handlers (set in initTokenClient)
            // run too, so storage/UI updates still happen normally — we
            // just also resolve this promise so callers can `await`.
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
                try { origErr?.(err); } finally { restore(); }
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
     * Verify stored token is still valid. If it's expired or rejected,
     * try a silent refresh before falling back to sign-out — that way
     * a returning user with a recent-but-expired token doesn't get
     * bounced back to the sign-in screen.
     */
    async verifyToken() {
        // If we already know it's expired, skip the wasted round-trip
        // and go straight to refresh.
        if (this.isExpired()) {
            await this._refreshOrSignOut();
            return;
        }
        try {
            const response = await fetch(CONFIG.API.USER_INFO, {
                headers: { 'Authorization': `Bearer ${this.accessToken}` }
            });
            if (!response.ok) throw new Error('Token invalid');
            // Valid — wire up refresh timer + notify app
            this._scheduleAutoRefresh();
            if (this.onAuthChange) this.onAuthChange(true, this.user);
        } catch (_error) {
            await this._refreshOrSignOut();
        }
    },

    async _refreshOrSignOut() {
        // tokenClient may not be ready yet (gsi/client.js still loading).
        // Wait for it briefly so we don't sign-out a returning user just
        // because the SDK was 200ms slow.
        for (let i = 0; i < 20 && !this.tokenClient; i++) {
            await new Promise(r => setTimeout(r, 150));
        }
        if (!this.tokenClient) {
            this.signOut();
            return;
        }
        try {
            await this.refreshToken();
            // handleTokenResponse already fired onAuthChange
        } catch (_e) {
            console.warn('Silent token refresh failed; signing out');
            this.signOut();
        }
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
