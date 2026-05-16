/**
 * Cloudflare R2 Storage Provider
 *
 * Books on R2 live behind a public access URL (e.g. `https://pub-<hash>.r2.dev`
 * or a custom domain). The `pub-*.r2.dev` URL is GET-only — it does NOT expose
 * S3-style LIST — so the provider relies on a manifest file at the bucket root:
 *
 *   <baseUrl>/index.json
 *
 *   {
 *     "version": 1,
 *     "books": [
 *       {
 *         "id":       "stoneheart",                       // unique, also the book prefix
 *         "name":     "Stoneheart",
 *         "format":   "hls" | "native",
 *         "playlist": "stoneheart/playlist.m3u8",         // required if format=hls
 *         "audioFile":"stoneheart/audiobook.m4a",         // required if format=native
 *         "cover":    "stoneheart/cover.jpg",             // optional
 *         "duration": 36854.2                             // optional, seconds
 *       }
 *     ]
 *   }
 *
 * Progress is stored under `r2:<bookId>` — one entry per book — regardless of
 * whether the book is an HLS playlist or a single native file.
 */

const R2Provider = Object.assign(Object.create(ProviderBase), {
    id: 'r2',
    displayName: 'Cloudflare R2',
    icon: `<svg viewBox="0 0 24 24"><path fill="#f6821f" d="M14.5 8H9.7c-2 0-3.7 1.4-4.1 3.2C4 11.5 3 12.8 3 14.3 3 16 4.3 17.3 6 17.3h8.5c2.2 0 4-1.8 4-4S16.7 9.3 14.5 8z"/><path fill="#ffd166" d="M21 12.5c0 1.7-1.3 3-3 3h-3.5c1.4-.5 2.5-1.6 3-3 .3-1 .2-2 -.2-2.9.4-.4.9-.6 1.5-.6 1.2 0 2.2 1 2.2 2.2v1.3z"/></svg>`,
    supportsHLS: true,
    supportsByteRange: true,
    audioPlaybackMode: 'direct',
    supportsBrowsing: false,

    // localStorage key for the user's R2 configuration. Kept separate from
    // CONFIG.STORAGE_KEYS because R2 config is mutable user data, not a
    // frozen build-time constant.
    R2_CONFIG_KEY: 'audiobook_r2_config',
    R2_INDEX_PATH: 'index.json',

    // --- configuration -----------------------------------------------------

    /**
     * Returns the active R2 config. Order of precedence:
     *   1. user override saved in localStorage (Settings → Save)
     *   2. CONFIG.R2_DEFAULT_BASE_URL from js/config.js (shipped with app)
     *   3. null
     *
     * The returned object includes `_isDefault: true` when the default
     * URL is in effect so the UI can show "default in use".
     */
    getConfig() {
        const saved = Storage.get(this.R2_CONFIG_KEY);
        if (saved?.baseUrl) return saved;
        const defaultUrl = (typeof CONFIG !== 'undefined') ? CONFIG.R2_DEFAULT_BASE_URL : '';
        if (defaultUrl) {
            return { baseUrl: defaultUrl, label: null, _isDefault: true };
        }
        return null;
    },

    setConfig(config) {
        if (!config?.baseUrl) throw new Error('R2 config requires baseUrl');
        // Trim trailing slash + whitespace
        const normalised = {
            baseUrl: String(config.baseUrl).trim().replace(/\/+$/, ''),
            label: config.label || null,
        };
        return Storage.set(this.R2_CONFIG_KEY, normalised);
    },

    /** Remove user override → next read falls back to the default (if any). */
    clearConfig() {
        return Storage.remove(this.R2_CONFIG_KEY);
    },

    isConfigured() {
        return !!this.getConfig()?.baseUrl;
    },

    isAuthenticated() { return true; },     // public bucket
    needsAuth() { return false; },

    // --- url helpers -------------------------------------------------------

    _baseUrl() {
        const c = this.getConfig();
        if (!c?.baseUrl) throw new Error('R2 is not configured');
        return c.baseUrl;
    },

    _absUrl(key) {
        if (!key) return null;
        return `${this._baseUrl()}/${String(key).replace(/^\/+/, '')}`;
    },

    /**
     * URL for resources that end up in <img src> (covers) — needs the
     * token as a query param since the auth-worker proxy can't read
     * headers from an <img> request. Mirrors what getStreamUrl does for
     * <audio src> on Safari.
     */
    _imgUrl(key) {
        const url = this._absUrl(key);
        if (!url) return null;
        const token = this._accessToken();
        return token ? `${url}?_token=${encodeURIComponent(token)}` : url;
    },

    /**
     * Returns true if the configured base URL is a plain public
     * `pub-<hash>.r2.dev` endpoint — that URL ignores Authorization
     * headers and, more importantly, its CORS rules typically don't
     * allow them, so we MUST NOT send Bearer tokens to it (preflight
     * would fail). Anything else (Workers URL, custom domain) is
     * assumed to be the r2-auth-worker proxy or similar and gets the
     * token.
     */
    _isPublicR2() {
        const base = this.getConfig()?.baseUrl || '';
        return /\/\/pub-[0-9a-f]+\.r2\.dev/i.test(base);
    },

    /**
     * Google access token, if signed in AND the base URL is not a plain
     * public R2 endpoint. Used by both the `Authorization` header on
     * fetch/XHR (R2-auth-worker proxy) and the `?_token=` query param
     * when URLs end up in <audio src> / <img src> where headers can't
     * be set.
     */
    _accessToken() {
        if (this._isPublicR2()) return null;
        if (typeof Auth === 'undefined') return null;
        return Auth.getAccessToken?.() || null;
    },

    _authHeaders() {
        const token = this._accessToken();
        return token ? { 'Authorization': `Bearer ${token}` } : {};
    },

    // --- manifest ----------------------------------------------------------

    async _fetchManifest() {
        const url = this._absUrl(this.R2_INDEX_PATH);
        // cache: 'no-cache' so book additions surface without forcing the user
        // to hard-refresh; the file is small.
        const resp = await fetch(url, { cache: 'no-cache', headers: this._authHeaders() });
        if (!resp.ok) {
            throw new Error(`R2 manifest fetch failed (${resp.status}). URL: ${url}`);
        }
        const json = await resp.json();
        if (!Array.isArray(json?.books)) {
            throw new Error('R2 manifest is malformed: expected { books: [] }');
        }
        return json;
    },

    /** Convert a manifest entry into the normalised book + audio item. */
    _manifestEntryToBook(entry) {
        if (!entry?.id) return null;

        const isHls = entry.format === 'hls' && !!entry.playlist;
        const audioKey = isHls ? entry.playlist : entry.audioFile;
        const audioName = audioKey
            ? String(audioKey).split('/').pop()
            : entry.name;
        const progressKey = `r2:${entry.id}`;

        const audioFiles = audioKey ? [{
            sourceId: 'r2',
            key: audioKey,
            name: audioName,
            mimeType: isHls ? 'application/vnd.apple.mpegurl' : undefined,
            isFolder: false,
            isPlaylist: isHls,
            progressKey,
            // legacy id kept so existing comparisons (file.id === ...) still work
            id: `${entry.id}:audio`,
        }] : [];

        return {
            sourceId: 'r2',
            id: entry.id,
            name: entry.name || entry.id,
            isBook: true,
            isMultiPart: false,
            primaryType: 'audio',
            format: isHls ? 'hls' : 'native',
            ebooks: [],
            audioFiles,
            ebookCount: 0,
            audioCount: audioFiles.length,
            cover: entry.cover ? this._imgUrl(entry.cover) : null,
            duration: entry.duration,
            progressKey,
            // Optional manifest fields surfaced for UI / MediaSession.
            author: entry.author || null,
            narrator: entry.narrator || null,
            chapters: this._normaliseChapters(entry.chapters),
        };
    },

    /**
     * Validate + normalise the optional `chapters` array on a manifest
     * entry. Returns null when missing/empty so callers can do a simple
     * truthy check. Entries are sorted by start so the player can lookup
     * the current chapter with a linear scan.
     */
    _normaliseChapters(raw) {
        if (!Array.isArray(raw) || !raw.length) return null;
        const out = raw
            .map((c, i) => ({
                title: (c && typeof c.title === 'string' ? c.title.trim() : '') || `Luku ${i + 1}`,
                start: (c && typeof c.start === 'number' && c.start >= 0) ? Number(c.start) : null,
            }))
            .filter(c => c.start !== null)
            .sort((a, b) => a.start - b.start);
        return out.length ? out : null;
    },

    // --- library -----------------------------------------------------------

    async getLibraryStructure(_folderId) {
        const empty = {
            sourceId: 'r2',
            folderId: null,
            books: [],
            standaloneFiles: { ebooks: [], audio: [] },
            folders: [],
        };
        if (!this.isConfigured()) return empty;

        const manifest = await this._fetchManifest();
        const books = (manifest.books || [])
            .map(b => this._manifestEntryToBook(b))
            .filter(Boolean);

        // Sort naturally by display name
        books.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

        return { ...empty, books };
    },

    async listFolders(_parentId) {
        return [];                          // R2 has no nested folder UI
    },

    // --- playback ----------------------------------------------------------

    async getStreamUrl(item) {
        const url = this._absUrl(item.key);
        // HLS goes through hls.js, which sets the Authorization header via
        // xhrSetup (see AudioPlayer._loadHls). For everything else the URL
        // ends up in <audio src> / <img src> where headers can't be set,
        // so we fall back to a `?_token=` query param the worker also
        // accepts.
        if (this.isHLSPlaylist(item)) return url;
        const token = this._accessToken();
        return token ? `${url}?_token=${encodeURIComponent(token)}` : url;
    },

    async downloadAsBlob(item, onProgress) {
        const url = this._absUrl(item.key);
        const resp = await fetch(url, { headers: this._authHeaders() });
        if (!resp.ok) throw new Error(`R2 fetch failed: ${resp.status}`);

        const contentLength = resp.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        if (!resp.body) {
            const blob = await resp.blob();
            if (onProgress) onProgress(blob.size, blob.size);
            return blob;
        }

        const reader = resp.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (onProgress) onProgress(loaded, total);
        }
        return new Blob(chunks);
    },

    async downloadAsArrayBuffer(item) {
        const blob = await this.downloadAsBlob(item);
        return blob.arrayBuffer();
    },
});
