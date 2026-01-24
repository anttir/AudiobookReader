/**
 * Storage Manager - Handles localStorage for settings and progress
 */

const Storage = {
    /**
     * Get item from localStorage with JSON parsing
     */
    get(key) {
        try {
            const item = localStorage.getItem(key);
            return item ? JSON.parse(item) : null;
        } catch (e) {
            console.error('Storage.get error:', e);
            return null;
        }
    },

    /**
     * Set item in localStorage with JSON stringification
     */
    set(key, value) {
        try {
            localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (e) {
            console.error('Storage.set error:', e);
            return false;
        }
    },

    /**
     * Remove item from localStorage
     */
    remove(key) {
        try {
            localStorage.removeItem(key);
            return true;
        } catch (e) {
            console.error('Storage.remove error:', e);
            return false;
        }
    },

    /**
     * Get user data
     */
    getUser() {
        return this.get(CONFIG.STORAGE_KEYS.user);
    },

    /**
     * Set user data
     */
    setUser(user) {
        return this.set(CONFIG.STORAGE_KEYS.user, user);
    },

    /**
     * Get access token
     */
    getAccessToken() {
        return this.get(CONFIG.STORAGE_KEYS.accessToken);
    },

    /**
     * Set access token
     */
    setAccessToken(token) {
        return this.set(CONFIG.STORAGE_KEYS.accessToken, token);
    },

    /**
     * Get selected folder
     */
    getSelectedFolder() {
        return this.get(CONFIG.STORAGE_KEYS.selectedFolder);
    },

    /**
     * Set selected folder
     */
    setSelectedFolder(folder) {
        return this.set(CONFIG.STORAGE_KEYS.selectedFolder, folder);
    },

    /**
     * Get app settings
     */
    getSettings() {
        const settings = this.get(CONFIG.STORAGE_KEYS.settings);
        return { ...CONFIG.DEFAULTS, ...settings };
    },

    /**
     * Set app settings
     */
    setSettings(settings) {
        const current = this.getSettings();
        return this.set(CONFIG.STORAGE_KEYS.settings, { ...current, ...settings });
    },

    /**
     * Get book progress
     */
    getBookProgress(fileId) {
        const allProgress = this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
        return allProgress[fileId] || null;
    },

    /**
     * Set book progress
     */
    setBookProgress(fileId, progress) {
        const allProgress = this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
        allProgress[fileId] = {
            ...progress,
            lastRead: Date.now()
        };
        return this.set(CONFIG.STORAGE_KEYS.bookProgress, allProgress);
    },

    /**
     * Get all book progress
     */
    getAllBookProgress() {
        return this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
    },

    /**
     * Clear all user data (for logout)
     */
    clearUserData() {
        this.remove(CONFIG.STORAGE_KEYS.user);
        this.remove(CONFIG.STORAGE_KEYS.accessToken);
        // Keep settings and folder selection
    },

    /**
     * Clear all data
     */
    clearAll() {
        Object.values(CONFIG.STORAGE_KEYS).forEach(key => {
            this.remove(key);
        });
    }
};
