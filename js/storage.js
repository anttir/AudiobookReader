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
     * Merge fields into an existing progress entry instead of replacing
     * it (setBookProgress replaces). Used by the audio player so the
     * listening-recovery fields (maxTime, history) survive every write.
     * `touch: false` leaves lastRead alone — for writes that only carry
     * recovery data and must not win the sync's last-writer-wins race
     * for currentTime.
     */
    updateBookProgress(key, patch, { touch = true } = {}) {
        const k = this._progressKey(key);
        const allProgress = this.get(CONFIG.STORAGE_KEYS.bookProgress) || {};
        const next = { ...(allProgress[k] || {}), ...patch };
        if (touch) next.lastRead = Date.now();
        allProgress[k] = next;
        return this.set(CONFIG.STORAGE_KEYS.bookProgress, allProgress);
    },

    // --- Listening-position recovery (audio) -----------------------------
    //
    // Audio progress entries may carry, besides currentTime/duration/
    // percentage/lastRead:
    //   maxTime  — "Kuunneltu asti": furthest point reached by continuous
    //              playback (seconds). Never decreases.
    //   history  — [{ t, at, reason }] positions worth returning to (before
    //              big jumps + periodic checkpoints), newest first.
    // Both are optional so old entries (and old app versions, which drop
    // unknown fields when they rewrite an entry) stay compatible.

    HISTORY_MAX: 20,
    // Entries closer than this (seconds of book time) are one place.
    HISTORY_DEDUPE_S: 30,

    /**
     * Union of history lists: newest first, one entry per ~30 s of book
     * time (the newest wins), capped at HISTORY_MAX. Pure.
     */
    mergeHistory(...lists) {
        const all = [];
        for (const list of lists) {
            if (!Array.isArray(list)) continue;
            for (const e of list) {
                if (e && Number.isFinite(e.t) && Number.isFinite(e.at)) all.push(e);
            }
        }
        all.sort((a, b) => (b.at - a.at) || (a.t - b.t));
        const out = [];
        for (const e of all) {
            if (out.some(k => Math.abs(k.t - e.t) < this.HISTORY_DEDUPE_S)) continue;
            out.push({ t: e.t, at: e.at, reason: e.reason });
            if (out.length >= this.HISTORY_MAX) break;
        }
        return out;
    },

    /**
     * Largest of the given values that is an actual number, or undefined
     * when none is (missing data stays missing). Pure.
     */
    maxDefined(...values) {
        const nums = values.filter(v => Number.isFinite(v));
        return nums.length ? Math.max(...nums) : undefined;
    },

    /**
     * Merge two versions of one book's progress (local vs. synced).
     * Position fields (currentTime/duration/percentage/lastRead + anything
     * else) come from the newer lastRead, as before; maxTime is the max of
     * both and history the union — so an entry rewritten by an old app
     * version (which drops those fields) can't erase them. Pure.
     */
    mergeProgressEntry(a, b) {
        if (!a) return b;
        if (!b) return a;
        const newer = (a.lastRead || 0) >= (b.lastRead || 0) ? a : b;
        const out = { ...newer };
        const maxTime = this.maxDefined(a.maxTime, b.maxTime);
        if (maxTime !== undefined) out.maxTime = maxTime;
        else delete out.maxTime;
        const history = this.mergeHistory(a.history, b.history);
        if (history.length) out.history = history;
        else delete out.history;
        return out;
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
