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
     * Normalise a progress key.
     *
     * Accepts:
     *   - (sourceId, itemKey)            → "sourceId:itemKey"
     *   - ("sourceId:itemKey")           → returned as-is
     *   - ("rawDriveFileId")             → "drive:rawDriveFileId" (legacy)
     *
     * The legacy fallback exists so the untouched pdf/epub viewers
     * (which still pass a bare Drive fileId) continue to work.
     */
    _progressKey(keyOrSource, maybeKey) {
        if (maybeKey !== undefined && maybeKey !== null) {
            return `${keyOrSource}:${maybeKey}`;
        }
        if (typeof keyOrSource === 'string' && keyOrSource.includes(':')) {
            return keyOrSource;
        }
        return `drive:${keyOrSource}`;
    },

    /**
     * Split a namespaced progress key back into { sourceId, itemKey }.
     * Returns null for malformed keys.
     */
    parseProgressKey(key) {
        if (typeof key !== 'string') return null;
        const idx = key.indexOf(':');
        if (idx < 1) return null;
        return { sourceId: key.slice(0, idx), itemKey: key.slice(idx + 1) };
    },

    /**
     * Get book progress.
     * Call as getBookProgress(sourceId, itemKey) or getBookProgress("source:key")
     * or, for legacy callers, getBookProgress(driveFileId).
     */
    getBookProgress(keyOrSource, maybeKey) {
        const key = this._progressKey(keyOrSource, maybeKey);
        const allProgress = this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
        return allProgress[key] || null;
    },

    /**
     * Set book progress.
     * Call as setBookProgress(sourceId, itemKey, progress) or
     * setBookProgress("source:key", progress) or, for legacy callers,
     * setBookProgress(driveFileId, progress).
     */
    setBookProgress(keyOrSource, progressOrKey, maybeProgress) {
        let key, progress;
        if (maybeProgress !== undefined) {
            key = this._progressKey(keyOrSource, progressOrKey);
            progress = maybeProgress;
        } else {
            key = this._progressKey(keyOrSource);
            progress = progressOrKey;
        }
        const allProgress = this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
        allProgress[key] = {
            ...progress,
            lastRead: Date.now()
        };
        return this.set(CONFIG.STORAGE_KEYS.bookProgress, allProgress);
    },

    /**
     * Get all book progress, keyed by namespaced progress key.
     */
    getAllBookProgress() {
        return this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
    },

    /**
     * One-time migration: pre-namespaced keys (raw Drive fileIds) get the
     * "drive:" prefix so they don't collide with future R2 entries.
     */
    _migrateProgressKeysV1() {
        const settings = this.get(CONFIG.STORAGE_KEYS.settings) || {};
        if (settings.progressKeysMigrated_v1) return;

        const all = this.get(CONFIG.STORAGE_KEYS.bookProgress);
        if (all && typeof all === 'object') {
            const migrated = {};
            let changed = false;
            for (const [k, v] of Object.entries(all)) {
                if (k.includes(':')) {
                    migrated[k] = v;
                } else {
                    migrated[`drive:${k}`] = v;
                    changed = true;
                }
            }
            if (changed) {
                this.set(CONFIG.STORAGE_KEYS.bookProgress, migrated);
                console.info(`[storage] migrated ${Object.keys(migrated).length} progress keys → namespaced`);
            }
        }
        settings.progressKeysMigrated_v1 = true;
        this.set(CONFIG.STORAGE_KEYS.settings, settings);
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

// Run progress-key migration once on load. Safe to call repeatedly.
try { Storage._migrateProgressKeysV1(); } catch (e) { console.warn('progress migration failed:', e); }
