/**
 * Authentication Module - Handles Google Sign-In
 */

const Auth = {
    tokenClient: null,
    accessToken: null,
    user: null,
    onAuthChange: null,

    /**
     * Initialize Google Identity Services
     */
    init(onAuthChange) {
        this.onAuthChange = onAuthChange;

        // Check for stored token
        const storedToken = Storage.getAccessToken();
        const storedUser = Storage.getUser();

        if (storedToken && storedUser) {
            this.accessToken = storedToken;
            this.user = storedUser;
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

        this.accessToken = response.access_token;
        Storage.setAccessToken(this.accessToken);

        // Fetch user info
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
     * Verify stored token is still valid
     */
    async verifyToken() {
        try {
            const response = await fetch(CONFIG.API.USER_INFO, {
                headers: {
                    'Authorization': `Bearer ${this.accessToken}`
                }
            });

            if (!response.ok) {
                throw new Error('Token invalid');
            }

            // Token is valid, notify app
            if (this.onAuthChange) {
                this.onAuthChange(true, this.user);
            }
        } catch (error) {
            // Token invalid, clear and require new sign in
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
        Storage.clearUserData();

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
