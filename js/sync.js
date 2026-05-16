/**
 * Sync Module — cross-device listening-progress sync via Google Drive's
 * per-app data folder ("appDataFolder"). Each user gets a private file
 * named `progress.json` that only this app can see; phone + laptop both
 * read/merge/write it so the "Continue listening" position stays current
 * wherever the user picks up the book.
 *
 * Schema of the synced file:
 *
 *   {
 *     "books": {
 *       "r2:<book-id>":  { currentTime, duration, percentage, lastRead },
 *       "drive:<fileId>":{ ... },
 *       ...
 *     },
 *     "_updatedAt": <epoch-ms>
 *   }
 *
 * Merge policy: per book, the entry with the higher `lastRead` wins.
 * That makes it last-writer-wins on a per-book basis without needing
 * vector clocks — fine for a single user across 2-3 devices.
 */

const Sync = {
    APPDATA_FILENAME: 'progress.json',
    DEBOUNCE_MS: 30000,           // ~one upload per 30s of continuous play
    _debounceTimer: null,
    _fileId: null,
    _disabled: false,             // becomes true on scope-missing 403 etc.
    _syncing: false,

    /**
     * Run after sign-in: download the remote progress, merge it with
     * local, and push back if local had anything newer. Best-effort —
     * any failure (offline, missing scope, expired token) disables sync
     * silently rather than blocking the app.
     */
    async init() {
        if (this._disabled) return;
        if (typeof Auth === 'undefined' || !Auth.getAccessToken?.()) return;
        try {
            await this._mergeWithRemote();
        } catch (e) {
            if (e?.scopeMissing) {
                console.warn('[sync] drive.appdata scope missing — sync disabled until next sign-in');
                this._disabled = true;
            } else {
                console.warn('[sync] init failed:', e);
            }
        }
    },

    /**
     * Schedule a debounced upload. Called from AudioPlayer.saveProgress
     * on every tick — debouncing keeps Drive write traffic at ~1 req /
     * 30 s instead of ~4 req / s.
     */
    scheduleUpload() {
        if (this._disabled) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = setTimeout(() => this._upload(), this.DEBOUNCE_MS);
    },

    /**
     * Push immediately (pause / visibility-hidden / before-unload).
     * Cancels any pending debounced upload.
     */
    async flushUpload() {
        if (this._disabled) return;
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
        await this._upload();
    },

    /**
     * Reset state on sign-out so a different user signing in doesn't
     * accidentally inherit the previous user's appData fileId.
     */
    reset() {
        clearTimeout(this._debounceTimer);
        this._debounceTimer = null;
        this._fileId = null;
        this._disabled = false;
        this._syncing = false;
    },

    // --- internals -------------------------------------------------------

    async _mergeWithRemote() {
        const fileId = await this._findFile();
        if (!fileId) {
            // First run on this account — seed the remote with our local
            return this._upload();
        }
        const remote = await this._download(fileId);
        const remoteBooks = (remote && typeof remote === 'object' && remote.books) || {};
        const localBooks = Storage.getAllBookProgress();
        const merged = this._merge(localBooks, remoteBooks);

        // Write merged back to local
        Storage.set(CONFIG.STORAGE_KEYS.bookProgress, merged);

        // Only push if local had something newer/different
        if (JSON.stringify(merged) !== JSON.stringify(remoteBooks)) {
            await this._uploadBody(fileId, merged);
        }
    },

    async _upload() {
        if (this._syncing) return;
        this._syncing = true;
        try {
            const fileId = await this._findFile();
            const books = Storage.getAllBookProgress();
            await this._uploadBody(fileId, books);
        } catch (e) {
            if (e?.scopeMissing) this._disabled = true;
            console.warn('[sync] upload failed:', e);
        } finally {
            this._syncing = false;
        }
    },

    _merge(local, remote) {
        const out = {};
        const keys = new Set([...Object.keys(local || {}), ...Object.keys(remote || {})]);
        for (const k of keys) {
            const l = local?.[k];
            const r = remote?.[k];
            if (!l) { out[k] = r; continue; }
            if (!r) { out[k] = l; continue; }
            // Per-book last-writer-wins by lastRead timestamp
            out[k] = (l.lastRead || 0) >= (r.lastRead || 0) ? l : r;
        }
        return out;
    },

    /** Find an existing progress.json in appDataFolder. Returns id or null. */
    async _findFile() {
        if (this._fileId) return this._fileId;
        const url = new URL('https://www.googleapis.com/drive/v3/files');
        url.searchParams.set('spaces', 'appDataFolder');
        url.searchParams.set('q', `name='${this.APPDATA_FILENAME}' and trashed=false`);
        url.searchParams.set('fields', 'files(id,modifiedTime)');
        const resp = await this._fetch(url.toString());
        if (!resp.ok) throw await this._toError(resp);
        const data = await resp.json();
        const file = data.files?.[0];
        this._fileId = file?.id || null;
        return this._fileId;
    },

    async _download(fileId) {
        const resp = await this._fetch(
            `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`,
        );
        if (!resp.ok) throw await this._toError(resp);
        return resp.json();
    },

    async _uploadBody(fileId, books) {
        const body = JSON.stringify({ books, _updatedAt: Date.now() });
        if (fileId) {
            // Patch existing file content
            const resp = await this._fetch(
                `https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`,
                {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body,
                },
            );
            if (!resp.ok) throw await this._toError(resp);
            return;
        }
        // Multipart create (metadata + content) in appDataFolder
        const boundary = '-------AudiobookSync' + Math.random().toString(36).slice(2);
        const meta = JSON.stringify({
            name: this.APPDATA_FILENAME,
            parents: ['appDataFolder'],
            mimeType: 'application/json',
        });
        const multipart =
            `--${boundary}\r\n` +
            `Content-Type: application/json; charset=UTF-8\r\n\r\n` +
            meta + '\r\n' +
            `--${boundary}\r\n` +
            `Content-Type: application/json\r\n\r\n` +
            body + '\r\n' +
            `--${boundary}--`;
        const resp = await this._fetch(
            'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart',
            {
                method: 'POST',
                headers: { 'Content-Type': `multipart/related; boundary=${boundary}` },
                body: multipart,
            },
        );
        if (!resp.ok) throw await this._toError(resp);
        const data = await resp.json();
        this._fileId = data.id;
    },

    async _fetch(url, opts = {}) {
        const token = Auth.getAccessToken?.();
        if (!token) {
            const e = new Error('no_token');
            e.scopeMissing = false;
            throw e;
        }
        return fetch(url, {
            ...opts,
            headers: {
                ...(opts.headers || {}),
                Authorization: `Bearer ${token}`,
            },
        });
    },

    async _toError(resp) {
        let body = '';
        try { body = await resp.text(); } catch (_) { /* ignore */ }
        const err = new Error(`drive_api_${resp.status}: ${body.slice(0, 200)}`);
        // 403 + "insufficient" / "insufficientPermissions" = scope missing
        // (typical when an existing token was issued before drive.appdata
        // was added to the scopes list). The user has to re-consent.
        if (resp.status === 403 && /insufficient/i.test(body)) {
            err.scopeMissing = true;
        }
        return err;
    },
};
