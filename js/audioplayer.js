/**
 * Audio Player Module
 */

const AudioPlayer = {
    audio: null,
    playlist: [],          // array of normalised items
    currentIndex: 0,
    currentItem: null,     // the active item (replaces currentFileId)
    currentBlobUrl: null,  // blob URL for cleanup (Drive playback)
    hls: null,             // active hls.js instance (R2 / HLS playback)
    isPlaying: false,
    isLoading: false,
    updateInterval: null,
    _hlsLoadingPromise: null,
    _hlsRecoveryAttempts: 0,
    _currentChapterIndex: -1,
    _bgLockAbort: null,
    _authRefreshAttempted: false,
    // hls.js CDN — pinned version. Update intentionally; do not float to @latest.
    HLS_JS_SRC: 'https://cdn.jsdelivr.net/npm/hls.js@1.5.20/dist/hls.min.js',

    /**
     * Backwards-compatible alias: a few old call sites read `currentFileId`
     * to compare against the active track. Keep it in sync with currentItem.
     */
    get currentFileId() { return this.currentItem?.key || null; },

    /**
     * Initialize the audio player
     */
    init() {
        this.audio = document.getElementById('audio-element');
        this.setupEventListeners();
        this.setupMediaSession();

        // Save progress when page visibility changes or before unload
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveProgress();
                // Don't wait for the 30s debounce — push the current
                // position to Drive immediately so the other device
                // picks it up next time it loads.
                if (typeof Sync !== 'undefined') Sync.flushUpload();
            } else if (document.visibilityState === 'visible') {
                // Tab is back in foreground — Chrome de-throttles timers
                // here, but if we stalled while hidden the audio element
                // may need a kick to resume.
                this._nudgeBuffer('visible-again');
            }
        });

        window.addEventListener('beforeunload', () => {
            this.saveProgress();
            if (typeof Sync !== 'undefined') Sync.flushUpload();
        });
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Audio element events
        this.audio.addEventListener('timeupdate', () => this.onTimeUpdate());
        this.audio.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
        this.audio.addEventListener('ended', () => this.onEnded());
        this.audio.addEventListener('play', () => this.onPlay());
        this.audio.addEventListener('pause', () => this.onPause());
        this.audio.addEventListener('error', (e) => this.onError(e));
        this.audio.addEventListener('canplay', () => this.onCanPlay());

        // Background-tab resilience: when the audio element stalls (Chrome
        // throttles segment loads for hidden tabs), poke hls.js to resume
        // loading rather than waiting for the timer to catch up.
        this.audio.addEventListener('waiting', () => this._nudgeBuffer('waiting'));
        this.audio.addEventListener('stalled', () => this._nudgeBuffer('stalled'));

        // Control buttons
        document.getElementById('play-pause').addEventListener('click', () => this.togglePlayPause());
        document.getElementById('prev-track').addEventListener('click', () => this.prevTrack());
        document.getElementById('next-track').addEventListener('click', () => this.nextTrack());
        document.getElementById('rewind-30').addEventListener('click', () => this.seek(-30));
        document.getElementById('forward-30').addEventListener('click', () => this.seek(30));

        // Progress bar
        const progressBar = document.getElementById('progress-bar');
        progressBar.addEventListener('input', (e) => this.onProgressChange(e));

        // Playback speed
        document.getElementById('playback-speed').addEventListener('change', (e) => {
            this.setPlaybackSpeed(parseFloat(e.target.value));
        });

        // Keyboard controls
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    this.togglePlayPause();
                    break;
                case 'ArrowLeft':
                    this.seek(-10);
                    break;
                case 'ArrowRight':
                    this.seek(10);
                    break;
            }
        });
    },

    /**
     * Setup Media Session API for lock screen controls
     */
    setupMediaSession() {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.setActionHandler('play', () => this.play());
            navigator.mediaSession.setActionHandler('pause', () => this.pause());
            navigator.mediaSession.setActionHandler('previoustrack', () => this.prevTrack());
            navigator.mediaSession.setActionHandler('nexttrack', () => this.nextTrack());
            navigator.mediaSession.setActionHandler('seekbackward', () => this.seek(-10));
            navigator.mediaSession.setActionHandler('seekforward', () => this.seek(10));
        }
    },

    /**
     * Load playlist from items (or, for backwards compat, raw Drive files).
     * Items must carry sourceId + key + name; raw Drive files are normalised
     * to drive: items.
     */
    setPlaylist(audioFiles) {
        this.playlist = (audioFiles || []).map(f => this._normaliseItem(f));
    },

    /** Coerce an input (item OR bare Drive file) into a normalised item. */
    _normaliseItem(input) {
        if (!input) return null;
        if (input.sourceId && input.key) {
            // Already normalised — cover/progressKey pass through as-is.
            return input;
        }
        // Legacy Drive file shape (or audioFile with .id but no sourceId).
        // Propagate cover + progressKey when the caller already supplied
        // them so downstream (loadTrack, updateMediaSession, saveProgress)
        // can pick them up uniformly.
        return {
            sourceId: 'drive',
            key: input.id,
            name: input.name,
            mimeType: input.mimeType,
            cover: input.cover,
            progressKey: input.progressKey,
            // preserve legacy fields for any consumer that still reads them
            id: input.id,
        };
    },

    /**
     * Show loading overlay
     */
    showLoading(show, text = 'Ladataan äänitiedostoa...') {
        const overlay = document.getElementById('audio-loading');
        const textEl = document.getElementById('audio-loading-text');

        if (show) {
            overlay.classList.remove('hidden');
            textEl.textContent = text;
            this.updateLoadingProgress(0, 0);
        } else {
            overlay.classList.add('hidden');
        }
    },

    /**
     * Update loading progress bar
     */
    updateLoadingProgress(loaded, total) {
        const barEl = document.getElementById('audio-loading-bar');
        const sizeEl = document.getElementById('audio-loading-size');

        if (total > 0) {
            const percent = Math.round((loaded / total) * 100);
            barEl.style.width = percent + '%';
            sizeEl.textContent = `${percent}% (${this.formatSize(loaded)} / ${this.formatSize(total)})`;
        } else if (loaded > 0) {
            // Unknown total size, show loaded amount
            barEl.style.width = '50%';
            sizeEl.textContent = `${this.formatSize(loaded)}`;
        } else {
            barEl.style.width = '0%';
            sizeEl.textContent = '0%';
        }
    },

    /**
     * Format file size
     */
    formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    },

    /**
     * Load and play a track.
     *
     * Accepts a normalised item ({ sourceId, key, name, ... }) — for
     * backwards compatibility a (fileId, fileName) pair is also accepted
     * and treated as a Drive item.
     */
    async loadTrack(itemOrFileId, fileNameLegacy) {
        if (this.isLoading) return false;

        const item = (typeof itemOrFileId === 'string')
            ? this._normaliseItem({ id: itemOrFileId, name: fileNameLegacy })
            : this._normaliseItem(itemOrFileId);

        if (!item) return false;

        const provider = (typeof Providers !== 'undefined') ? Providers.get(item.sourceId) : null;
        if (!provider) {
            console.error('No provider for source:', item.sourceId);
            App.showToast('Tuntematon lähde: ' + item.sourceId, 'error');
            return false;
        }

        this.isLoading = true;
        this.currentItem = item;

        // Find in playlist by stable identity
        const index = this.playlist.findIndex(t => t.sourceId === item.sourceId && t.key === item.key);
        if (index !== -1) this.currentIndex = index;

        // Prefer the book name over the audio filename — for HLS books the
        // filename is just "playlist", which isn't useful as a title.
        const book = (typeof App !== 'undefined') ? App.currentBook : null;
        const fileName = this.cleanFileName(item.name || '');
        const displayName = (item.isPlaylist && book?.name) ? book.name : fileName;
        document.getElementById('audio-title').textContent = displayName;
        document.getElementById('current-book-title').textContent = displayName;
        document.getElementById('current-time').textContent = '0:00';
        document.getElementById('duration').textContent = '';

        // Default subtitle: chapter title if the book ships one, else the
        // legacy "track X of Y" for multi-file books.
        this._currentChapterIndex = -1;
        const chapters = book?.chapters;
        if (chapters?.length) {
            document.getElementById('audio-chapter').textContent = chapters[0].title;
            document.getElementById('current-chapter').textContent = chapters[0].title;
        } else {
            document.getElementById('audio-chapter').textContent = `Kappale ${this.currentIndex + 1} / ${this.playlist.length}`;
            document.getElementById('current-chapter').textContent = '';
        }

        // Album cover: prefer the item's own cover, then fall back to the
        // active book (R2 attaches the cover URL at book level, not on
        // each audio item). If neither exists, hide the <img> and let the
        // default SVG show through.
        this._renderAlbumCover(item.cover || (typeof App !== 'undefined' ? App.currentBook?.cover : null));

        this.showLoading(true, 'Ladataan: ' + displayName);

        try {
            await this._teardownPlayback();

            const isHls = provider.supportsHLS && provider.isHLSPlaylist(item);
            if (isHls) {
                await this._loadHls(provider, item);
            } else if (provider.audioPlaybackMode === 'blob') {
                await this._loadBlob(provider, item);
            } else {
                await this._loadDirect(provider, item);
            }

            // Restore saved position. Prefer the item's explicit
            // progressKey so HLS books save under their book id instead of
            // the playlist-file key.
            const pKey = item.progressKey || `${item.sourceId}:${item.key}`;
            const progress = Storage.getBookProgress(pKey);
            if (progress?.currentTime) {
                // For HLS the seek must wait until manifest is parsed; we
                // queue it via a one-shot listener.
                if (isHls && (!this.audio.duration || isNaN(this.audio.duration))) {
                    const onReady = () => {
                        this.audio.currentTime = progress.currentTime;
                        this.audio.removeEventListener('loadedmetadata', onReady);
                    };
                    this.audio.addEventListener('loadedmetadata', onReady);
                } else {
                    this.audio.currentTime = progress.currentTime;
                }
            }

            this.updateMediaSession(item);
            this.isLoading = false;
            this.showLoading(false);
            return true;

        } catch (error) {
            console.error('Error loading audio:', error);
            this.isLoading = false;
            this.showLoading(false);
            App.showToast('Äänitiedoston lataaminen epäonnistui', 'error');
            return false;
        }
    },

    /**
     * R2 auth-worker rejected our token (401/403). Try a silent token
     * refresh and reload the source — the user shouldn't have to click
     * "Sign in" every hour. Fall back to the toast only when the refresh
     * itself fails (genuine sign-out / revoked consent).
     *
     * Guarded so we don't loop: one refresh attempt per loaded track.
     */
    async _handleAuthError() {
        if (this._authRefreshAttempted || !this.currentItem) {
            App.showToast('R2: kirjautuminen vanhentui, kirjaudu uudelleen', 'error');
            if (typeof Auth !== 'undefined' && Auth.softSignOut) Auth.softSignOut();
            return;
        }
        this._authRefreshAttempted = true;
        try {
            if (typeof Auth === 'undefined' || !Auth.refreshToken) {
                throw new Error('Auth.refreshToken unavailable');
            }
            console.info('HLS auth error — attempting silent token refresh');
            await Auth.refreshToken();
            // Re-arm hls.js with the new token. Easiest is to fully
            // reload the source; preserves currentTime via the same
            // progress-restore path loadTrack uses.
            const item = this.currentItem;
            await this.loadTrack(item);
        } catch (err) {
            // Silent refresh failed (Safari ITP, user revoked, offline).
            // Drop to the login screen so the user can re-sign-in via
            // the popup flow — we'd otherwise sit on a player that
            // can't load any segments.
            console.warn('Silent token refresh failed:', err);
            App.showToast('R2: kirjautuminen vanhentui, kirjaudu uudelleen', 'error');
            if (typeof Auth !== 'undefined' && Auth.softSignOut) Auth.softSignOut();
        }
    },

    /**
     * Nudge playback when the audio element has stalled. Called from
     * waiting/stalled/visibilitychange. Asks hls.js to keep loading and
     * re-starts the audio element if it was paused implicitly by the
     * stall.
     */
    _nudgeBuffer(reason) {
        if (!this.currentItem) return;
        if (this.hls) {
            try { this.hls.startLoad(); } catch (e) { console.warn('startLoad failed:', e); }
        }
        // If we were supposed to be playing but the element paused
        // itself (Chrome does this after long stalls), restart it.
        if (this.isPlaying && this.audio.paused) {
            console.warn(`Audio stalled (${reason}); resuming playback`);
            this.audio.play().catch(err => console.warn('Resume after stall failed:', err));
        }
    },

    /** Cleanup HLS instance + blob URL before switching tracks. */
    async _teardownPlayback() {
        if (this.hls) {
            try { this.hls.destroy(); } catch (e) { console.warn('hls.destroy failed:', e); }
            this.hls = null;
        }
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }
        // Detach previous source so the audio element doesn't keep buffering it
        this.audio.removeAttribute('src');
        this.audio.load();
    },

    /** Blob playback (Google Drive): download then play. */
    async _loadBlob(provider, item) {
        const blob = await provider.downloadAsBlob(item, (loaded, total) => {
            this.updateLoadingProgress(loaded, total);
        });
        this.currentBlobUrl = URL.createObjectURL(blob);
        this.audio.src = this.currentBlobUrl;
    },

    /** Direct URL playback (R2 native audio over byte ranges). */
    async _loadDirect(provider, item) {
        const url = await provider.getStreamUrl(item);
        this.audio.src = url;
    },

    /** HLS playback via hls.js. */
    async _loadHls(provider, item) {
        const url = await provider.getStreamUrl(item);
        await this._ensureHlsLoaded();

        if (window.Hls && window.Hls.isSupported()) {
            this.hls = new window.Hls({
                // Audio-only HLS. Buffers are *deliberately* large: when a
                // Chrome tab goes to background, setTimeout throttles to
                // ~1 Hz after 5 min and the JS-side fragment scheduler
                // struggles to keep up with a small buffer. Pre-loading
                // ~10 min ahead means even a heavily throttled timer can
                // top up faster than the playhead consumes audio.
                // (Memory cost ≈ 1 MB / min at ~128 kbps — fine.)
                maxBufferLength: 120,
                maxMaxBufferLength: 600,
                // Keep some played audio in buffer for instant rewind.
                backBufferLength: 90,
                // Forward bytes to MSE as they arrive instead of waiting
                // for full segments — smooths out slow networks.
                progressive: true,
                lowLatencyMode: false,
                // Forward the Google access token on every HLS request so
                // the optional r2-auth-worker proxy can authorise it.
                // Suppressed when the URL is a public pub-*.r2.dev bucket —
                // its CORS rules don't allow the Authorization header, so
                // sending it would break the preflight.
                //
                // hls.js@1.5+ picks FetchLoader by default; xhrSetup only
                // fires on the XHR path. Set both so the header is sent
                // regardless of which loader is active.
                xhrSetup: function (xhr, requestUrl) {
                    if (typeof Auth === 'undefined') return;
                    const token = Auth.getAccessToken?.();
                    if (!token) return;
                    if (/\/\/pub-[0-9a-f]+\.r2\.dev/i.test(requestUrl)) return;
                    xhr.setRequestHeader('Authorization', `Bearer ${token}`);
                },
                fetchSetup: function (context, initParams) {
                    if (typeof Auth !== 'undefined'
                        && !/\/\/pub-[0-9a-f]+\.r2\.dev/i.test(context.url)) {
                        const token = Auth.getAccessToken?.();
                        if (token) {
                            const headers = new Headers(initParams.headers || {});
                            headers.set('Authorization', `Bearer ${token}`);
                            initParams.headers = headers;
                        }
                    }
                    return new Request(context.url, initParams);
                },
            });
            // Reset the recovery counter every time a fragment actually
            // loads — three transient stalls in a row counts as fatal, but
            // three stalls spread across an hour shouldn't. Same logic
            // for the auth-refresh guard: any successful segment fetch
            // proves the current token works.
            this._hlsRecoveryAttempts = 0;
            this.hls.on(window.Hls.Events.FRAG_LOADED, () => {
                this._hlsRecoveryAttempts = 0;
                this._authRefreshAttempted = false;
            });
            this.hls.on(window.Hls.Events.ERROR, (_event, data) => {
                if (!data.fatal) return;
                console.error('HLS fatal error:', data);
                const status = data.response?.code;
                // 401/403 = expired/missing Google token at the
                // auth-worker. Try a silent refresh + reload before
                // bothering the user — they shouldn't have to click
                // "Sign in" every hour just to keep listening.
                if (status === 401 || status === 403) {
                    this._handleAuthError();
                    return;
                }
                // For other fatal errors (most commonly a flaky mobile
                // connection mid-segment) try to recover transparently
                // before surfacing anything. hls.js exposes
                // startLoad()/recoverMediaError() exactly for this.
                if (this._hlsRecoveryAttempts >= 3) {
                    App.showToast('HLS-virhe: ' + (data.details || 'tuntematon'), 'error');
                    return;
                }
                this._hlsRecoveryAttempts++;
                const wasPlaying = !this.audio.paused;
                if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
                    console.warn(`HLS network recovery attempt #${this._hlsRecoveryAttempts}: ${data.details}`);
                    try { this.hls.startLoad(); } catch (e) { console.error(e); }
                } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
                    console.warn(`HLS media recovery attempt #${this._hlsRecoveryAttempts}: ${data.details}`);
                    try { this.hls.recoverMediaError(); } catch (e) { console.error(e); }
                } else {
                    App.showToast('HLS-virhe: ' + (data.details || 'tuntematon'), 'error');
                    return;
                }
                // Resume playback if the stall paused us
                if (wasPlaying) {
                    this.audio.play().catch(err => console.warn('Auto-resume after HLS recovery failed:', err));
                }
            });
            this.hls.loadSource(url);
            this.hls.attachMedia(this.audio);
        } else if (this.audio.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari has native HLS — token must travel in the URL since
            // <audio src> can't carry headers.
            const token = (typeof Auth !== 'undefined') ? Auth.getAccessToken?.() : null;
            this.audio.src = token
                ? `${url}${url.includes('?') ? '&' : '?'}_token=${encodeURIComponent(token)}`
                : url;
        } else {
            throw new Error('HLS-toistoa ei tueta tässä selaimessa');
        }
    },

    /** Lazy-load hls.js once. Concurrent calls share the same promise. */
    _ensureHlsLoaded() {
        if (window.Hls) return Promise.resolve();
        if (this._hlsLoadingPromise) return this._hlsLoadingPromise;
        this._hlsLoadingPromise = new Promise((resolve, reject) => {
            const script = document.createElement('script');
            script.src = this.HLS_JS_SRC;
            script.async = true;
            script.onload = () => resolve();
            script.onerror = () => {
                this._hlsLoadingPromise = null;
                reject(new Error('hls.js failed to load'));
            };
            document.head.appendChild(script);
        });
        return this._hlsLoadingPromise;
    },

    /**
     * Called when audio can start playing
     */
    onCanPlay() {
        if (this.isLoading) return;

        // Auto-play when loaded
        this.play();
    },

    /**
     * Clean file name for display
     */
    cleanFileName(name) {
        // Remove extension and clean up
        return name
            .replace(/\.[^/.]+$/, '')  // Remove extension
            .replace(/_/g, ' ')         // Replace underscores
            .replace(/-/g, ' - ')       // Add spaces around dashes
            .trim();
    },

    /**
     * Swap the <img id="album-cover"> source and toggle the .hidden class
     * so the default SVG art stays visible when no cover is available.
     */
    _renderAlbumCover(coverUrl) {
        const img = document.getElementById('album-cover');
        if (!img) return;
        if (coverUrl) {
            // Only reassign when it actually changes to avoid a refetch
            // (and a brief flash) when re-loading the same track.
            if (img.getAttribute('src') !== coverUrl) {
                img.src = coverUrl;
            }
            img.classList.remove('hidden');
        } else {
            img.classList.add('hidden');
            img.removeAttribute('src');
        }
    },

    /**
     * Update Media Session metadata. Accepts the normalised item so we can
     * source artwork from item.cover (or the active book's cover) and use
     * the book's author/name for the OS-level "Artist / Album" display.
     */
    updateMediaSession(item) {
        if (!('mediaSession' in navigator)) return;

        const book = (typeof App !== 'undefined') ? App.currentBook : null;
        // For HLS books the filename is "playlist" — fall back to the book
        // name (or the live chapter title, if available) so the OS shows
        // something meaningful on the lock screen.
        const chapter = this._currentChapterTitle();
        const fileTitle = this.cleanFileName(item?.name || '');
        const title = chapter
            || ((item?.isPlaylist && book?.name) ? book.name : fileTitle);
        const artist = book?.author || 'AudioBook Reader';
        const album = book?.name || 'Äänikirja';
        const coverUrl = item?.cover || book?.cover || null;

        const meta = { title, artist, album };
        if (coverUrl) {
            meta.artwork = [
                { src: coverUrl, sizes: '512x512', type: 'image/jpeg' },
                { src: coverUrl, sizes: '256x256', type: 'image/jpeg' },
            ];
        }
        navigator.mediaSession.metadata = new MediaMetadata(meta);
    },

    /**
     * Play
     */
    async play() {
        try {
            await this.audio.play();
        } catch (error) {
            console.error('Play error:', error);
            // On mobile, user interaction is required
            App.showToast('Paina play aloittaaksesi', 'info');
        }
    },

    /**
     * Pause
     */
    pause() {
        this.audio.pause();
    },

    /**
     * Stop playback completely (when leaving the book)
     */
    stop() {
        this.saveProgress();
        this.audio.pause();
        this.audio.currentTime = 0;

        // Tear down both blob and HLS resources
        if (this.hls) {
            try { this.hls.destroy(); } catch (e) { console.warn('hls.destroy failed:', e); }
            this.hls = null;
        }
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }

        // Reset state
        this.audio.removeAttribute('src');
        this.audio.load();
        this.currentItem = null;
        this.currentIndex = 0;
        this.playlist = [];
        this.isPlaying = false;
    },

    /**
     * Toggle play/pause
     */
    togglePlayPause() {
        if (this.isLoading) return;

        if (this.isPlaying) {
            this.pause();
        } else {
            this.play();
        }
    },

    /**
     * Seek relative to current position
     */
    seek(seconds) {
        if (!this.audio.duration) return;
        const newTime = this.audio.currentTime + seconds;
        this.audio.currentTime = Math.max(0, Math.min(newTime, this.audio.duration));
    },

    /**
     * Go to previous track
     */
    prevTrack() {
        if (this.audio.currentTime > 3) {
            // If more than 3 seconds in, restart current track
            this.audio.currentTime = 0;
        } else if (this.currentIndex > 0) {
            this.currentIndex--;
            this.loadTrack(this.playlist[this.currentIndex]);
        }
    },

    /**
     * Go to next track
     */
    nextTrack() {
        if (this.currentIndex < this.playlist.length - 1) {
            this.currentIndex++;
            this.loadTrack(this.playlist[this.currentIndex]);
        }
    },

    /**
     * Set playback speed
     */
    setPlaybackSpeed(speed) {
        this.audio.playbackRate = speed;
        Storage.setSettings({ playbackSpeed: speed });
    },

    /**
     * On time update
     */
    onTimeUpdate() {
        const current = this.audio.currentTime;
        const duration = this.audio.duration;

        if (!isNaN(duration)) {
            // Update progress bar
            const progressBar = document.getElementById('progress-bar');
            progressBar.value = (current / duration) * 100;

            // Update time displays
            document.getElementById('current-time').textContent = this.formatTime(current);

            // Refresh chapter title if the book carries chapter metadata
            this._updateCurrentChapter(current);

            // Save progress periodically
            this.saveProgress();
        }
    },

    /**
     * Resolve the active book's chapters array (or null).
     */
    _currentChapters() {
        const book = (typeof App !== 'undefined') ? App.currentBook : null;
        return book?.chapters?.length ? book.chapters : null;
    },

    /**
     * Find the chapter index whose start <= t. Returns -1 if no chapters.
     */
    _chapterIndexAt(t) {
        const chapters = this._currentChapters();
        if (!chapters) return -1;
        let idx = 0;
        for (let i = 0; i < chapters.length; i++) {
            if (chapters[i].start <= t) idx = i;
            else break;
        }
        return idx;
    },

    /**
     * Title of the chapter currently playing (or null when no chapters).
     */
    _currentChapterTitle() {
        const chapters = this._currentChapters();
        if (!chapters) return null;
        const idx = this._chapterIndexAt(this.audio?.currentTime || 0);
        return idx >= 0 ? chapters[idx].title : null;
    },

    /**
     * Update the chapter title displayed under the cover + in the header.
     * No-op when the index hasn't changed (so we don't thrash the DOM at
     * timeupdate's ~4Hz rate).
     */
    _updateCurrentChapter(currentTime) {
        const chapters = this._currentChapters();
        if (!chapters) return;
        const idx = this._chapterIndexAt(currentTime);
        if (idx === this._currentChapterIndex) return;
        this._currentChapterIndex = idx;
        const title = chapters[idx]?.title || '';
        const subEl = document.getElementById('audio-chapter');
        const headerEl = document.getElementById('current-chapter');
        if (subEl) subEl.textContent = title;
        if (headerEl) headerEl.textContent = title;
        // Refresh MediaSession so the lock screen also follows along
        if (this.currentItem) this.updateMediaSession(this.currentItem);
    },

    /**
     * Seek to a chapter (or any { start } object). Starts playback if it
     * was paused, queues the seek if metadata isn't loaded yet.
     */
    seekToChapter(chapter) {
        if (!chapter || typeof chapter.start !== 'number') return;
        const target = Math.max(0, chapter.start);
        if (!this.audio.duration || isNaN(this.audio.duration)) {
            const onReady = () => {
                this.audio.currentTime = target;
                this.audio.removeEventListener('loadedmetadata', onReady);
            };
            this.audio.addEventListener('loadedmetadata', onReady);
            return;
        }
        this.audio.currentTime = target;
        // Force-refresh the chapter label even if timeupdate hasn't fired
        // yet — useful when seeking while paused.
        this._currentChapterIndex = -1;
        this._updateCurrentChapter(target);
        if (!this.isPlaying) this.play();
    },

    /**
     * On metadata loaded
     */
    onMetadataLoaded() {
        const duration = this.audio.duration;
        document.getElementById('duration').textContent = this.formatTime(duration);
        document.getElementById('progress-bar').max = 100;

        // Restore playback speed
        const settings = Storage.getSettings();
        if (settings.playbackSpeed) {
            this.audio.playbackRate = settings.playbackSpeed;
            document.getElementById('playback-speed').value = settings.playbackSpeed;
        }
    },

    /**
     * On track ended
     */
    onEnded() {
        // Auto-play next track
        if (this.currentIndex < this.playlist.length - 1) {
            this.nextTrack();
        } else {
            this.isPlaying = false;
            this.updatePlayButton();
        }
    },

    /**
     * On play event
     */
    onPlay() {
        this.isPlaying = true;
        this.updatePlayButton();
        this._acquireBackgroundLock();
    },

    /**
     * On pause event
     */
    onPause() {
        this.isPlaying = false;
        this.updatePlayButton();
        this.saveProgress();
        // User paused — likely about to walk away from this device; push
        // the position so the next device can pick up exactly there.
        if (typeof Sync !== 'undefined') Sync.flushUpload();
        this._releaseBackgroundLock();
    },

    /**
     * Hold a navigator.locks lock while playing. Chrome's intensive
     * timer-throttling docs explicitly exempt tabs holding a Web Lock,
     * which keeps hls.js's segment scheduler responsive in background.
     * Quietly no-op when the API isn't available (older browsers).
     */
    _acquireBackgroundLock() {
        if (!navigator.locks?.request) return;
        if (this._bgLockAbort) return;
        const abort = new AbortController();
        this._bgLockAbort = abort;
        navigator.locks
            .request('audiobook-playback', { signal: abort.signal }, () => new Promise(() => {}))
            .catch(() => { /* AbortError on release is expected */ });
    },

    _releaseBackgroundLock() {
        if (!this._bgLockAbort) return;
        this._bgLockAbort.abort();
        this._bgLockAbort = null;
    },

    /**
     * On error
     */
    onError(e) {
        console.error('Audio error:', e);
        if (this.audio.error) {
            console.error('Audio error code:', this.audio.error.code);
            console.error('Audio error message:', this.audio.error.message);
        }
        this.isLoading = false;
        App.showToast('Virhe äänitiedoston toistossa', 'error');
    },

    /**
     * Update play button state
     */
    updatePlayButton() {
        const playIcon = document.querySelector('.play-icon');
        const pauseIcon = document.querySelector('.pause-icon');

        if (this.isPlaying) {
            playIcon.classList.add('hidden');
            pauseIcon.classList.remove('hidden');
        } else {
            playIcon.classList.remove('hidden');
            pauseIcon.classList.add('hidden');
        }
    },

    /**
     * On progress bar change
     */
    onProgressChange(e) {
        const percent = e.target.value;
        const duration = this.audio.duration;

        if (!isNaN(duration)) {
            this.audio.currentTime = (percent / 100) * duration;
        }
    },

    /**
     * Save playback progress
     */
    saveProgress() {
        if (!this.currentItem) return;

        const current = this.audio.currentTime;
        const duration = this.audio.duration;

        if (!isNaN(duration) && duration > 0) {
            const pKey = this.currentItem.progressKey
                || `${this.currentItem.sourceId}:${this.currentItem.key}`;
            Storage.setBookProgress(pKey, {
                currentTime: current,
                duration: duration,
                percentage: Math.round((current / duration) * 100)
            });
            // Cross-device sync via Drive appData (debounced inside Sync)
            if (typeof Sync !== 'undefined') Sync.scheduleUpload();
        }
    },

    /**
     * Format time as MM:SS or HH:MM:SS
     */
    formatTime(seconds) {
        if (isNaN(seconds)) return '0:00';

        const hrs = Math.floor(seconds / 3600);
        const mins = Math.floor((seconds % 3600) / 60);
        const secs = Math.floor(seconds % 60);

        if (hrs > 0) {
            return `${hrs}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
        }
        return `${mins}:${secs.toString().padStart(2, '0')}`;
    },

    /**
     * Get current progress percentage
     */
    getProgress() {
        if (!this.audio || isNaN(this.audio.duration)) return 0;
        return Math.round((this.audio.currentTime / this.audio.duration) * 100);
    },

    /**
     * Clean up
     */
    destroy() {
        this.pause();
        if (this.hls) {
            try { this.hls.destroy(); } catch (e) { /* ignore */ }
            this.hls = null;
        }
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }
        this.audio.removeAttribute('src');
        this.audio.load();
        this.playlist = [];
        this.currentIndex = 0;
        this.currentItem = null;
    }
};
