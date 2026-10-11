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
    // "Where was I?" jump-back state: when the playhead suddenly moves a
    // long way (lock-screen scrub, misclick on the progress bar), we
    // remember where it was so the user can get back with one tap.
    _lastStableTime: null,     // playhead position tracked at timeupdate rate
    _jumpBack: null,           // { time, at } — position before the last big jump
    _suppressJumpDetection: false,
    // Seeks smaller than this are treated as intentional (30 s skip
    // buttons, arrow keys) and don't arm the jump-back marker.
    JUMP_BACK_THRESHOLD: 60,
    // Seeks within this window count as one scrubbing gesture: the
    // origin of the first seek stays the place to return to.
    JUMP_BACK_MERGE_MS: 10000,

    // Listening-position recovery, persisted per progress key (see
    // Storage.mergeProgressEntry for the synced schema):
    //   _maxTime — "Kuunneltu asti": furthest point reached by continuous
    //              playback. Only grows; independent of currentTime, so a
    //              bogus saved position can always be undone.
    //   _history — [{ t, at, reason }] newest first: positions before big
    //              jumps + a checkpoint every CHECKPOINT_S of playback.
    _maxTime: undefined,
    _history: [],
    _listen: null,             // stepListenTracker state for this track
    // Save guard ("don't let a transient 0 overwrite the good position"):
    _restoreDone: false,       // restore seek finished (or nothing to restore)
    _restoreTarget: null,      // saved position the restore seek goes to
    _offerContinue: false,     // toast "jatka kuunnellusta" once restored
    _offerRef: undefined,      // …compared against this position instead of maxTime
    _userSeekGen: undefined,   // _loadGen in which a user seek was queued
    _restorePendingSince: null,// wall-clock ms the restore was first seen pending
    _restoreRetried: false,    // restore seek re-issued once already
    _recovering: false,        // hls.js media-error recovery in progress
    _recoveringSince: null,
    _recoverPlayed: 0,         // continuous playback (s) since recovery began
    _loadGen: 0,               // bumped per load; stale deferred seeks check it
    _userIntentUntil: 0,       // explicit user seek → backwards save allowed
    _lastSaveAt: 0,
    _lastBlockReason: null,
    // A timeupdate step larger than this (s) is a seek, not playback —
    // unless the wall clock says that much playback really elapsed
    // (throttled background tab / screen off).
    CONTINUOUS_MAX_DELTA: 5,
    // After a forward jump past maxTime, adopt the new position only once
    // playback has continued there this long (s). Also: a backwards
    // position without user intent is saved once played this long.
    FORWARD_ADOPT_S: 120,
    // Show "Jatka kuunnellusta" when this far (s) behind maxTime.
    CONTINUE_SHOW_GAP: 30,
    // History checkpoint every N seconds of playback.
    CHECKPOINT_S: 300,
    // Refuse to save a position this much (s) behind the stored one
    // unless it came from an explicit user action.
    BACKWARD_GUARD_S: 60,
    USER_INTENT_MS: 10000,
    // timeupdate fires ~4 Hz; persist at most this often while playing.
    // Pause / hide / unload / stop still save immediately.
    SAVE_THROTTLE_MS: 5000,
    // Restore seek still not landed after this long (while timeupdates
    // run): re-issue it once, then stop waiting — the zero/backwards
    // guard still protects the stored position.
    RESTORE_TIMEOUT_MS: 10000,
    // Media-error recovery counts as over after this much continuous
    // playback (s), or at the latest after RECOVERY_MAX_MS.
    RECOVERY_CLEAR_S: 3,
    RECOVERY_MAX_MS: 30000,
    // "Jatka kuunnellusta" never targets the very end of the file.
    END_MARGIN_S: 5,

    // Output keep-alive. USB-C DACs with their own power-save / auto-mute
    // (Apple EarPods USB-C) mute on digital silence and fade the next
    // audio back in. Silence reaches them when the <audio> element is
    // torn down (between files, stalls, error recovery, auth reloads) and
    // from near-silent stretches in the audio itself (e.g. encoder
    // priming at HLS segment starts), which Android's volume scaling
    // rounds to zero. An inaudible Web Audio tone mixed into the output
    // keeps the DAC from ever seeing zeros while the user is listening.
    _keepAlive: null,          // { ctx, gain }; false = unavailable
    _keepAliveStopTimer: null,
    _keepAliveSuspendTimer: null,
    // 20 Hz at -50 dBFS peak: far below hearing threshold at that
    // frequency (~78 dB SPL), yet loud enough to stay non-zero after
    // volume scaling into a 16-bit output. Not digital silence either way:
    // Chrome moves an all-zero Web Audio output to a fake sink after 30 s.
    KEEPALIVE_HZ: 20,
    KEEPALIVE_GAIN: 0.003,
    // Fade time constant (s) on start/stop, so the tone never steps.
    KEEPALIVE_FADE_S: 0.02,
    // Nothing playing this long (next file loading — Drive downloads it
    // whole first — or a stall) releases the output.
    KEEPALIVE_IDLE_MS: 60000,

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

        // Detect big playhead jumps from ANY source — in-app progress bar,
        // chapter list, or the OS lock-screen scrubber (which seeks the
        // element directly without going through our UI).
        this.audio.addEventListener('seeking', () => this._onSeeking());
        this.audio.addEventListener('seeked', () => this._onSeeked());
        this.audio.addEventListener('playing', () => this._onPlaying());

        // Background-tab resilience: when the audio element stalls (Chrome
        // throttles segment loads for hidden tabs), poke hls.js to resume
        // loading rather than waiting for the timer to catch up.
        this.audio.addEventListener('waiting', () => this._nudgeBuffer('waiting'));
        this.audio.addEventListener('stalled', () => this._nudgeBuffer('stalled'));

        // Element not producing audio (stall, teardown between files):
        // hold the keep-alive output only for a bounded time.
        this.audio.addEventListener('waiting', () => this._scheduleKeepAliveStop());
        this.audio.addEventListener('emptied', () => this._scheduleKeepAliveStop());

        // Control buttons
        document.getElementById('play-pause').addEventListener('click', () => this.togglePlayPause());
        document.getElementById('prev-track').addEventListener('click', () => this.prevTrack());
        document.getElementById('next-track').addEventListener('click', () => this.nextTrack());
        document.getElementById('rewind-30').addEventListener('click', () => this.seek(-30));
        document.getElementById('forward-30').addEventListener('click', () => this.seek(30));

        // Progress bar
        const progressBar = document.getElementById('progress-bar');
        progressBar.addEventListener('input', (e) => this.onProgressChange(e));

        // Jump-back controls ("where was I before that seek?")
        document.getElementById('jump-back-btn').addEventListener('click', () => this.returnToPreviousPosition());
        document.getElementById('jump-back-marker').addEventListener('click', () => this.returnToPreviousPosition());

        // "Jatka kuunnellusta" + position history
        document.getElementById('continue-max-btn').addEventListener('click', () => this.continueFromMax());
        document.getElementById('listened-marker').addEventListener('click', () => this.continueFromMax());
        document.getElementById('position-history-btn').addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePositionHistory(undefined, { returnFocus: true });
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape') this.togglePositionHistory(false, { returnFocus: true });
        });
        // Close the history popover on any click outside it
        document.addEventListener('click', (e) => {
            const panel = document.getElementById('position-history');
            if (panel && !panel.classList.contains('hidden') && !panel.contains(e.target)) {
                this.togglePositionHistory(false);
            }
        });

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

        // Saves are throttled while playing — persist the outgoing track's
        // position before switching (next/prev track, auth reload).
        if (this.currentItem) this.saveProgress();

        this.isLoading = true;

        // Jump-back state is per-track: a saved position in another file
        // means nothing here. Kept when re-loading the same track (e.g.
        // the auth-refresh reload path). The stable-time tracker resets
        // always so the progress-restore seek below isn't mistaken for a
        // user jump.
        const sameTrack = this.currentItem
            && this.currentItem.sourceId === item.sourceId
            && this.currentItem.key === item.key;
        if (!sameTrack) this._clearJumpBack();
        this._lastStableTime = null;

        // Same-track reload (auth refresh): resume where playback actually
        // is, not at the stored position — the outgoing save may have been
        // refused (step back without intent, error recovery), and that must
        // not silently move the listener.
        const outgoing = sameTrack && this._restoreDone && this.audio.readyState >= 1
            && Number.isFinite(this.audio.currentTime) && this.audio.currentTime > 0
            ? this.audio.currentTime : undefined;

        this.currentItem = item;
        // Invalidates deferred (loadedmetadata) seeks queued for the
        // previous load, so they can't land on this track.
        this._loadGen++;

        // Recovery state for this track: maxTime + history from storage
        // (merged with what we held in memory on a same-track reload).
        // Saving the position is blocked until the restore seek below
        // has actually landed.
        const pKey = this._progressKeyFor(item);
        const progress = Storage.getBookProgress(pKey);
        this._loadRecoveryState(progress, sameTrack, outgoing);

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

            // Restore saved position (read above, before teardown) — or,
            // on a same-track reload, the outgoing one. The progressKey
            // lets HLS books save under their book id instead of the
            // playlist-file key. A user seek queued during this load
            // (chapter tap) wins over the restore.
            const restoreTo = outgoing ?? progress?.currentTime;
            if (this._userSeekGen === this._loadGen) {
                // The queued user seek's `seeked` completes the restore.
            } else if (restoreTo) {
                this._restoreTarget = restoreTo;
                // For HLS the seek must wait until manifest is parsed; we
                // queue it via a one-shot listener.
                if (isHls && (!this.audio.duration || isNaN(this.audio.duration))) {
                    this._whenMetadata(() => { this.audio.currentTime = restoreTo; });
                } else {
                    this.audio.currentTime = restoreTo;
                }
            } else {
                // Nothing to restore — the position may be saved right away.
                this._markRestoreDone();
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
            console.info('R2 auth error — attempting silent token refresh');
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
                this._recoverHlsError(data, window.Hls.ErrorTypes);
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

    /**
     * Fatal non-auth hls.js error (most commonly a flaky mobile connection
     * mid-segment): try to recover transparently before surfacing
     * anything. hls.js exposes startLoad()/recoverMediaError() exactly for
     * this. `types` = Hls.ErrorTypes.
     */
    _recoverHlsError(data, types) {
        if (this._hlsRecoveryAttempts >= 3) {
            App.showToast('HLS-virhe: ' + (data.details || 'tuntematon'), 'error');
            return;
        }
        this._hlsRecoveryAttempts++;
        const wasPlaying = !this.audio.paused;
        if (data.type === types.NETWORK_ERROR) {
            // startLoad() doesn't move the playhead (the element often
            // keeps playing from its buffer), so saves stay allowed; a
            // transient 0 is caught by the zero/backwards guard anyway.
            console.warn(`HLS network recovery attempt #${this._hlsRecoveryAttempts}: ${data.details}`);
            try { this.hls?.startLoad(); } catch (e) { console.error(e); }
        } else if (data.type === types.MEDIA_ERROR) {
            // recoverMediaError() re-attaches the media, which can briefly
            // report currentTime 0 — keep the position out of storage until
            // playback has run continuously again (see _trackRecovery).
            console.warn(`HLS media recovery attempt #${this._hlsRecoveryAttempts}: ${data.details}`);
            this._setRecovering();
            try { this.hls?.recoverMediaError(); } catch (e) { console.error(e); }
        } else {
            App.showToast('HLS-virhe: ' + (data.details || 'tuntematon'), 'error');
            return;
        }
        // Resume playback if the stall paused us
        if (wasPlaying) {
            this.audio.play().catch(err => console.warn('Auto-resume after HLS recovery failed:', err));
        }
    },

    _setRecovering() {
        this._recovering = true;
        this._recoveringSince = Date.now();
        this._recoverPlayed = 0;
    },

    _clearRecovering() {
        this._recovering = false;
        this._recoveringSince = null;
        this._recoverPlayed = 0;
    },

    /**
     * Per timeupdate while recovering: over once playback has run
     * continuously for RECOVERY_CLEAR_S, or RECOVERY_MAX_MS have passed —
     * so a recovery that never produces `playing`/`seeked` can't block
     * saves for the rest of the session.
     */
    _trackRecovery(played, jumped) {
        if (!this._recovering) return;
        if (this._recoveringSince == null) this._recoveringSince = Date.now();
        this._recoverPlayed = jumped ? 0 : (this._recoverPlayed || 0) + played;
        if (this._recoverPlayed >= this.RECOVERY_CLEAR_S
            || Date.now() - this._recoveringSince >= this.RECOVERY_MAX_MS) {
            this._clearRecovering();
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
        // A successful (re)load proves the current token works — re-arm the
        // one-shot auth-retry guard so a later expiry can recover too. (HLS
        // does the equivalent on FRAG_LOADED.)
        this._authRefreshAttempted = false;

        this._checkRestoreLanded();

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
        this._stopKeepAlive();
        this._lastStableTime = null;
        this._clearJumpBack();
        this._clearRecoveryState();
    },

    /** Forget the per-track recovery state (it's persisted already). */
    _clearRecoveryState() {
        this._maxTime = undefined;
        this._history = [];
        this._listen = null;
        this._restoreDone = false;
        this._restoreTarget = null;
        this._restorePendingSince = null;
        this._restoreRetried = false;
        this._offerContinue = false;
        this._offerRef = undefined;
        this._clearRecovering();
        this._userIntentUntil = 0;
        this._loadGen++;   // drop deferred seeks queued for this track
        this.togglePositionHistory(false);
        this._renderRecovery();
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
        this._markUserIntent();
        const newTime = this.audio.currentTime + seconds;
        this.audio.currentTime = Math.max(0, Math.min(newTime, this.audio.duration));
    },

    /**
     * Go to previous track
     */
    prevTrack() {
        if (this.audio.currentTime > 3) {
            // If more than 3 seconds in, restart current track
            this._markUserIntent();
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

        // Track the "stable" playhead position for jump detection. Not
        // updated mid-seek, so when `seeking` fires this still holds the
        // position the user was actually listening at. Also not before
        // metadata: the teardown load() queues a timeupdate at 0 that
        // would otherwise make the restore seek look like a jump from 0.
        if (!this.audio.seeking && this.audio.readyState >= 1 && !isNaN(duration)) {
            this._lastStableTime = current;
        }

        if (!this._restoreDone) this._checkRestoreLanded(true);

        if (!isNaN(duration)) {
            // Update progress bar
            const progressBar = document.getElementById('progress-bar');
            progressBar.value = (current / duration) * 100;

            // Update time displays
            document.getElementById('current-time').textContent = this.formatTime(current);

            // Refresh chapter title if the book carries chapter metadata
            this._updateCurrentChapter(current);

            // "Kuunneltu asti" + periodic history checkpoint
            let played = 0, jumped = false;
            if (this._restoreDone && this._listen) {
                const res = this.stepListenTracker(this._listen, {
                    t: current,
                    now: performance.now(),
                    rate: this.audio.playbackRate,
                    playing: !this.audio.paused && !this.audio.seeking,
                }, this._maxTime);
                this._maxTime = res.maxTime;
                played = res.played;
                jumped = res.jumped;
                if (res.checkpoint) this._addHistory(current, 'checkpoint');
            }
            this._trackRecovery(played, jumped);
            this._renderRecovery();

            // Save progress periodically (throttled)
            if (Date.now() - this._lastSaveAt >= this.SAVE_THROTTLE_MS) {
                this.saveProgress({ periodic: true });
            }
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
     * `seeking` fired on the audio element — from the in-app progress bar,
     * the chapter list, or the OS lock-screen scrubber. If the playhead
     * moved far from where the user was listening, arm the jump-back
     * marker so they can get back with one tap.
     */
    _onSeeking() {
        // Every seek breaks the "continuous playback" run of the maxTime
        // tracker, suppressed ones included.
        if (this._listen) this._listen.seekSeen = true;
        if (this._suppressJumpDetection) {
            this._suppressJumpDetection = false;
            return;
        }
        // The restore seek (and anything before it lands) isn't a jump.
        if (!this._restoreDone) return;
        const from = this._lastStableTime;
        const to = this.audio.currentTime;
        if (from == null || isNaN(to)) return;
        if (Math.abs(to - from) < this.JUMP_BACK_THRESHOLD) return;

        const now = Date.now();
        if (this._jumpBack && (now - this._jumpBack.at) < this.JUMP_BACK_MERGE_MS) {
            // Same scrubbing gesture (drag, repeated taps) — keep the
            // original origin, just extend the merge window.
            this._jumpBack.at = now;
        } else {
            this._jumpBack = { time: from, at: now };
            // New origin → worth keeping beyond this session.
            this._addHistory(from, 'jump');
        }
        this._renderJumpBack();
    },

    /**
     * `seeked`: the first one after loadTrack is the restore seek landing
     * (or a user seek that superseded it) — from here on the element's
     * position is the real one and may be saved. An explicit user seek
     * is persisted right away (the intent window is short).
     */
    _onSeeked() {
        // Where it actually landed — a seek other than the restore (hls.js
        // gap nudge, a queued user seek) may be what completed.
        if (!this._restoreDone && (this._restoreTarget != null || this._userSeekGen === this._loadGen)) {
            this._markRestoreDone(this.audio.currentTime);
        }
        if (this._hasUserIntent()) this.saveProgress({ periodic: true });
    },

    /** `playing`: if the restore seek was silently dropped, retry it. */
    _onPlaying() {
        this._startKeepAlive();
        this._checkRestoreLanded();
    },

    /**
     * Restore-seek watchdog. Marks the restore done once the element sits
     * at the target. If it doesn't (seek silently ignored — iOS, or a seek
     * before the range was seekable): on canplay/playing re-issue it once;
     * from timeupdate (`timed`) re-issue after RESTORE_TIMEOUT_MS, and
     * after another one stop waiting so saves / maxTime aren't frozen for
     * the session. The zero/backwards guard still protects the stored
     * position in that case.
     */
    _checkRestoreLanded(timed = false) {
        if (this._restoreDone || this._restoreTarget == null || this.audio.seeking) return;
        const current = this.audio.currentTime;
        if (this.audio.readyState >= 2 && Math.abs(current - this._restoreTarget) < 2) {
            this._markRestoreDone();
            return;
        }
        if (!(this.audio.readyState >= 1)) return;   // no metadata yet — can't seek
        if (!timed) {
            this._retryRestoreSeek();
            return;
        }
        if (this._restorePendingSince == null) {
            this._restorePendingSince = Date.now();
            return;
        }
        if (Date.now() - this._restorePendingSince < this.RESTORE_TIMEOUT_MS) return;
        if (this._retryRestoreSeek()) {
            this._restorePendingSince = Date.now();
            return;
        }
        const target = this._restoreTarget;
        console.warn(`[progress] restore seek to ${this.formatTime(target)} did not land; continuing at ${this.formatTime(current)}`);
        if (Math.abs(current - target) > this.BACKWARD_GUARD_S) {
            // Keep the position we failed to restore findable, and point
            // the offer at it (not at maxTime).
            this._history = Storage.mergeHistory(
                [{ t: target, at: Date.now(), reason: 'restore' }], this._history);
            this._offerRef = target;
            this._offerContinue = true;
        }
        this._markRestoreDone(current);
        this.saveProgress({ periodic: true });
    },

    /** Re-issue the restore seek (once per load). */
    _retryRestoreSeek() {
        if (this._restoreRetried) return false;
        this._restoreRetried = true;
        const d = this.audio.duration;
        this.audio.currentTime = Number.isFinite(d) ? Math.min(this._restoreTarget, d) : this._restoreTarget;
        return true;
    },

    /**
     * Run `fn` on the next loadedmetadata — unless another track has been
     * loaded by then (the listener would otherwise seek the new track to
     * the old one's position). `user: true` marks an explicit user seek:
     * it cancels the pending restore of this load, whichever of the two
     * was queued first.
     */
    _whenMetadata(fn, { user = false } = {}) {
        const gen = this._loadGen;
        if (user) {
            this._userSeekGen = gen;
            this._restoreTarget = null;
            this._offerContinue = false;
        }
        const onReady = () => {
            this.audio.removeEventListener('loadedmetadata', onReady);
            if (gen !== this._loadGen) return;
            if (!user && this._userSeekGen === gen) return;   // user seek wins
            fn();
        };
        this.audio.addEventListener('loadedmetadata', onReady);
    },

    /** Explicit user seek: a backwards position may be saved for a moment. */
    _markUserIntent() {
        this._userIntentUntil = Date.now() + this.USER_INTENT_MS;
    },

    _hasUserIntent() {
        return Date.now() < this._userIntentUntil;
    },

    _progressKeyFor(item) {
        return item.progressKey || `${item.sourceId}:${item.key}`;
    },

    /**
     * Reset per-track recovery state from the stored progress entry.
     * Old entries have no maxTime — seed it from their currentTime. With
     * no entry at all nothing has been listened yet, so 0 is the real
     * value (not a placeholder).
     */
    _loadRecoveryState(progress, sameTrack, outgoing) {
        const seed = Number.isFinite(progress?.maxTime) ? progress.maxTime
            : Number.isFinite(progress?.currentTime) ? progress.currentTime
            : 0;
        this._maxTime = Storage.maxDefined(seed, sameTrack ? this._maxTime : undefined);
        this._history = Storage.mergeHistory(progress?.history, sameTrack ? this._history : []);
        this._listen = this._newListenState();
        this._restoreDone = false;
        this._restoreTarget = null;
        this._restorePendingSince = null;
        this._restoreRetried = false;
        // Book opened: offer "Jatka" if the restore lands well behind
        // maxTime. Same-track reload (silent auth refresh): only if it
        // lands well behind where playback was (`outgoing`) — re-listening
        // behind maxTime is normal and mustn't nag every hour.
        this._offerContinue = !sameTrack || outgoing !== undefined;
        this._offerRef = sameTrack ? outgoing : undefined;
        this._clearRecovering();
        this._userIntentUntil = 0;
        this._lastBlockReason = null;
        this.togglePositionHistory(false);
        this._renderRecovery();
    },

    _newListenState() {
        return { prev: null, prevNow: null, runStart: null, runPlayed: 0, cpPlayed: 0, seekSeen: false };
    },

    /**
     * The restore seek has landed (or there was nothing to restore). If
     * the restored position is well behind "kuunneltu asti" — typically a
     * position that got reset to 0 — offer to continue from there.
     */
    _markRestoreDone(restoredTo = this._restoreTarget ?? 0) {
        if (this._restoreDone) return;
        this._restoreDone = true;
        this._restoreTarget = null;
        this._restorePendingSince = null;
        this._listen = this._newListenState();
        if (this._offerContinue) {
            this._offerContinue = false;
            // Reference: the outgoing / unrestorable position when set,
            // else "kuunneltu asti".
            const fromRef = this._offerRef !== undefined;
            const ref = fromRef ? this._offerRef : this._continueTarget();
            this._offerRef = undefined;
            if (ref !== undefined && ref - restoredTo > this.BACKWARD_GUARD_S
                && typeof App !== 'undefined' && this.currentItem) {
                // Bind the offer to this book + value: the toast outlives
                // track switches.
                const key = this._progressKeyFor(this.currentItem);
                const msg = fromRef
                    ? 'Toisto ei jatkunut edellisestä kohdasta'
                    : 'Tallennettu kohta on ennen kuunneltua kohtaa';
                App.showToast(msg, 'info', {
                    label: `Jatka kohdasta ${this.formatTime(ref)}`,
                    onClick: () => {
                        if (!this.currentItem || this._progressKeyFor(this.currentItem) !== key) return;
                        this._userSeekTo(ref, this.END_MARGIN_S);
                    },
                });
            }
        }
        this._renderRecovery();
    },

    /**
     * Where "Jatka kuunnellusta" goes: maxTime, kept END_MARGIN_S clear
     * of the end of the file. Undefined when there's nothing sensible to
     * continue to (unknown, or the file is listened to the end).
     */
    _continueTarget() {
        const maxTime = this._maxTime;
        if (maxTime === undefined) return undefined;
        const duration = this.audio?.duration;
        if (!Number.isFinite(duration)) return maxTime;
        if (maxTime >= duration - this.END_MARGIN_S) return undefined;
        return maxTime;
    },

    /**
     * One timeupdate step of the "kuunneltu asti" tracker. Pure apart
     * from mutating `st` (see _newListenState).
     *
     * A step counts as continuous playback when it moves forward by at
     * most CONTINUOUS_MAX_DELTA — or by more, if no seek happened and the
     * wall clock (× playbackRate) accounts for it (throttled background
     * tab). Anything else starts a new run at the new position.
     * maxTime then grows to the playhead when the run started at or
     * behind maxTime (continuous from known ground), or — after a jump
     * forward past it — once the run has played FORWARD_ADOPT_S.
     *
     * @param {object} st  tracker state (mutated)
     * @param {{t:number, now:number, rate:number, playing:boolean}} tick
     *        t = currentTime (s), now = performance.now() (ms)
     * @param {number|undefined} maxTime
     * @returns {{maxTime:number|undefined, checkpoint:boolean,
     *            played:number, jumped:boolean}}  played = seconds of
     *          continuous playback this step; jumped = run restarted
     */
    stepListenTracker(st, { t, now, rate, playing }, maxTime) {
        let checkpoint = false, played = 0, jumped = false;
        const seekSeen = st.seekSeen;
        st.seekSeen = false;
        if (st.prev == null) {
            st.runStart = t;
            st.runPlayed = 0;
        } else {
            const delta = t - st.prev;
            const wallS = st.prevNow != null ? (now - st.prevNow) / 1000 : null;
            const wallExplains = !seekSeen && wallS != null
                && delta <= wallS * (rate || 1) + this.CONTINUOUS_MAX_DELTA;
            const continuous = delta >= -1 && (delta <= this.CONTINUOUS_MAX_DELTA || wallExplains);
            if (!continuous) {
                st.runStart = t;
                st.runPlayed = 0;
                jumped = true;
            } else if (playing && delta > 0) {
                played = delta;
                st.runPlayed += delta;
                st.cpPlayed += delta;
                if (st.cpPlayed >= this.CHECKPOINT_S) {
                    st.cpPlayed = 0;
                    checkpoint = true;
                }
            }
        }
        st.prev = t;
        st.prevNow = now;

        if (playing && (maxTime === undefined || t > maxTime)) {
            const anchored = maxTime !== undefined
                && st.runStart <= maxTime + this.CONTINUOUS_MAX_DELTA;
            if (anchored || st.runPlayed >= this.FORWARD_ADOPT_S) maxTime = t;
        }
        return { maxTime, checkpoint, played, jumped };
    },

    /**
     * Save guard for currentTime. Returns why the position must NOT be
     * persisted, or null when it may. Pure.
     *  - before the restore seek has landed, during error recovery, or
     *    while the element has no current data (position not real yet);
     *  - a 0 or a big step back from the stored position, unless it came
     *    from an explicit user action — or playback has continued there
     *    for FORWARD_ADOPT_S (a deliberate lock-screen scrub, which we
     *    can't tell from an accidental one up front).
     */
    positionSaveBlock({ t, stored, restoreDone, recovering, readyState, userIntent, runPlayed }) {
        if (!restoreDone) return 'restore-pending';
        if (recovering) return 'recovering';
        if (!(readyState >= 2)) return 'not-ready';
        if (userIntent) return null;
        const storedT = stored?.currentTime;
        if (Number.isFinite(storedT) && storedT > 0) {
            if (t === 0) return 'zero';
            if (t < storedT - this.BACKWARD_GUARD_S && !(runPlayed >= this.FORWARD_ADOPT_S)) {
                return 'backwards';
            }
        }
        return null;
    },

    /** Record a position in the per-book history and persist it. */
    _addHistory(t, reason) {
        if (!Number.isFinite(t)) return;
        this._history = Storage.mergeHistory([{ t, at: Date.now(), reason }], this._history);
        this._renderRecovery();
        this.saveProgress({ periodic: true });
    },

    /**
     * Seek (explicitly) to a position, kept `endMargin` s clear of the
     * end; queued if metadata isn't loaded (intent is re-marked then, so a
     * slow load can't outlive the intent window).
     */
    _userSeekTo(target, endMargin = 0) {
        if (!Number.isFinite(target)) return;
        const apply = () => {
            this._markUserIntent();
            // A recovery jump is its own gesture, not part of the scrub it
            // repairs: take the current jump-back origin out of the merge
            // window so this seek records where we leave (undoable).
            if (this._jumpBack) this._jumpBack.at = 0;
            const duration = this.audio.duration;
            this.audio.currentTime = Math.max(0, Math.min(target, duration - endMargin));
            // Refresh the chapter label immediately (matters when paused).
            this._currentChapterIndex = -1;
            this._updateCurrentChapter(this.audio.currentTime);
        };
        if (!this.audio.duration || isNaN(this.audio.duration)) {
            this._whenMetadata(apply, { user: true });
            return;
        }
        apply();
    },

    /**
     * "Jatka kuunnellusta": go to the furthest point reached by continuous
     * playback. The jump arms the jump-back marker like any big seek, so
     * this can be undone too.
     */
    continueFromMax() {
        const target = this._continueTarget();
        if (target === undefined) return;
        this._userSeekTo(target, this.END_MARGIN_S);
    },

    /** Seek to a "Paikkahistoria" entry. */
    seekToHistory(entry) {
        this.togglePositionHistory(false);
        this._userSeekTo(entry?.t);
    },

    /**
     * Show/hide the "Paikkahistoria" popover (no arg = toggle). Opening
     * moves focus into the list; `returnFocus` (Escape / toggle button)
     * puts it back on the history button.
     */
    togglePositionHistory(show, { returnFocus = false } = {}) {
        const panel = document.getElementById('position-history');
        const btn = document.getElementById('position-history-btn');
        if (!panel) return;
        const wasOpen = !panel.classList.contains('hidden');
        const open = show ?? !wasOpen;
        if (open) this._renderPositionHistory();
        panel.classList.toggle('hidden', !open);
        if (btn) btn.setAttribute('aria-expanded', String(open));
        if (open && !wasOpen) {
            panel.querySelector?.('.ph-row')?.focus?.();
        } else if (!open && wasOpen && returnFocus) {
            btn?.focus?.();
        }
    },

    _renderPositionHistory() {
        const list = document.getElementById('position-history-list');
        if (!list) return;
        list.replaceChildren();
        const chapters = this._currentChapters();
        const today = new Date().toDateString();
        for (const entry of this._history) {
            const li = document.createElement('li');
            const row = document.createElement('button');
            row.type = 'button';
            row.className = 'ph-row';
            const d = new Date(entry.at);
            const clock = d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' });
            const when = document.createElement('span');
            when.className = 'ph-when';
            when.textContent = d.toDateString() === today
                ? clock
                : `${d.getDate()}.${d.getMonth() + 1}. ${clock}`;
            const chapter = document.createElement('span');
            chapter.className = 'ph-chapter';
            if (chapters) chapter.textContent = chapters[this._chapterIndexAt(entry.t)]?.title || '';
            const pos = document.createElement('span');
            pos.className = 'ph-pos';
            pos.textContent = this.formatTime(entry.t);
            row.append(when, chapter);
            // Call out positions that aren't just jump origins/checkpoints:
            // listened but not saved as current (blocked step back), and a
            // saved position that was replaced or couldn't be restored.
            const tagText = this.HISTORY_REASON_TAGS[entry.reason];
            if (tagText) {
                const tag = document.createElement('span');
                tag.className = 'ph-tag';
                tag.textContent = tagText;
                row.append(tag);
            }
            row.append(pos);
            row.title = this.HISTORY_REASON_LABELS[entry.reason] || '';
            row.addEventListener('click', (e) => {
                e.stopPropagation();
                this.seekToHistory(entry);
            });
            li.appendChild(row);
            list.appendChild(li);
        }
    },

    HISTORY_REASON_LABELS: {
        jump: 'Ennen hyppyä',
        checkpoint: 'Välitallennus',
        unsaved: 'Keskeytynyt kuuntelu (kohtaa ei tallennettu nykyiseksi)',
        restore: 'Aiemmin tallennettu kuuntelukohta',
    },

    HISTORY_REASON_TAGS: {
        unsaved: 'keskeytynyt',
        restore: 'tallennettu kohta',
    },

    /**
     * Position the "kuunneltu asti" marker and toggle "Jatka kuunnellusta"
     * and the history button. Called at timeupdate rate — DOM writes only
     * on change.
     */
    _renderRecovery() {
        const marker = document.getElementById('listened-marker');
        const btn = document.getElementById('continue-max-btn');
        const histBtn = document.getElementById('position-history-btn');
        if (!marker || !btn || !histBtn) return;
        histBtn.classList.toggle('hidden', !this._history.length || !this.currentItem);
        const duration = this.audio?.duration;
        const maxTime = this._maxTime;
        if (!this.currentItem || maxTime === undefined || !duration || isNaN(duration)) {
            marker.classList.add('hidden');
            btn.classList.add('hidden');
            return;
        }
        const left = Math.min(100, (maxTime / duration) * 100).toFixed(2) + '%';
        if (marker.style.left !== left) marker.style.left = left;
        marker.classList.toggle('hidden', !(maxTime > 0));
        const target = this._continueTarget();
        const behind = this._restoreDone && target !== undefined
            && target - this.audio.currentTime > this.CONTINUE_SHOW_GAP;
        btn.classList.toggle('hidden', !behind);
        const label = this.formatTime(maxTime);
        const timeEl = document.getElementById('continue-max-time');
        if (timeEl.textContent !== label) {
            timeEl.textContent = label;
            marker.title = `Kuunneltu asti ${label}`;
        }
    },

    /**
     * Seek back to the position saved before the last big jump. The
     * position we leave becomes the new marker, so an unwanted return
     * can itself be undone.
     */
    returnToPreviousPosition() {
        const jb = this._jumpBack;
        if (!jb || !this.audio.duration || isNaN(this.audio.duration)) return;
        const from = this.audio.currentTime;
        this._suppressJumpDetection = true;
        this._markUserIntent();
        this._addHistory(from, 'jump');
        this.audio.currentTime = Math.max(0, Math.min(jb.time, this.audio.duration));
        this._lastStableTime = this.audio.currentTime;
        // at: 0 keeps the swapped marker out of the merge window — a new
        // seek right after a return should record a fresh origin, not
        // extend this one.
        this._jumpBack = { time: from, at: 0 };
        this._renderJumpBack();
        // Refresh the chapter label immediately (matters when paused).
        this._currentChapterIndex = -1;
        this._updateCurrentChapter(this.audio.currentTime);
    },

    _clearJumpBack() {
        this._jumpBack = null;
        this._renderJumpBack();
    },

    /**
     * Show/position the marker on the progress bar and the "Palaa
     * kohtaan" button, or hide both when there is nothing to return to.
     */
    _renderJumpBack() {
        const marker = document.getElementById('jump-back-marker');
        const btn = document.getElementById('jump-back-btn');
        if (!marker || !btn) return;
        const duration = this.audio?.duration;
        if (!this._jumpBack || !duration || isNaN(duration)) {
            marker.classList.add('hidden');
            btn.classList.add('hidden');
            return;
        }
        marker.style.left = ((this._jumpBack.time / duration) * 100) + '%';
        marker.classList.remove('hidden');
        document.getElementById('jump-back-time').textContent = this.formatTime(this._jumpBack.time);
        btn.classList.remove('hidden');
    },

    /**
     * Seek to a chapter (or any { start } object). Starts playback if it
     * was paused, queues the seek if metadata isn't loaded yet.
     */
    seekToChapter(chapter) {
        if (!chapter || typeof chapter.start !== 'number') return;
        const target = Math.max(0, chapter.start);
        this._markUserIntent();
        if (!this.audio.duration || isNaN(this.audio.duration)) {
            // Re-mark intent when the seek actually happens — a slow load
            // can outlive the intent window. Cancels the pending restore.
            this._whenMetadata(() => {
                this._markUserIntent();
                this.audio.currentTime = target;
            }, { user: true });
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

        // Marker position depends on duration, which we may not have had
        // when the jump was recorded.
        this._renderJumpBack();
        this._renderRecovery();

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
            this._stopKeepAlive();
        }
    },

    /**
     * On play event
     */
    onPlay() {
        this.isPlaying = true;
        this.updatePlayButton();
        this._acquireBackgroundLock();
        this._startKeepAlive();
    },

    /**
     * On pause event
     */
    onPause() {
        this.isPlaying = false;
        this.updatePlayButton();
        // End of a file fires `pause` before `ended`: the next file is
        // about to load, so keep the output open across the switch. Any
        // other pause (user, lost audio focus) releases it.
        if (this.audio.ended) this._scheduleKeepAliveStop();
        else this._stopKeepAlive();
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
     * Run the keep-alive tone (see _keepAlive). Called from play /
     * playing, after the user has interacted with the page, so the
     * context may start. Skipped on iOS: separate audio-session handling
     * there, and the DAC problem is an Android one.
     */
    _startKeepAlive() {
        this._cancelKeepAliveStop();
        if (this._keepAlive === false) return;
        if (!this._keepAlive) {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            const iOS = /iP(hone|ad|od)/.test(navigator.userAgent)
                || (/Macintosh/.test(navigator.userAgent) && navigator.maxTouchPoints > 1);
            if (!Ctx || iOS) {
                this._keepAlive = false;
                return;
            }
            try {
                const ctx = new Ctx({ latencyHint: 'playback' });
                const osc = ctx.createOscillator();
                const gain = ctx.createGain();
                osc.frequency.value = this.KEEPALIVE_HZ;
                gain.gain.value = 0;
                osc.connect(gain).connect(ctx.destination);
                osc.start();
                this._keepAlive = { ctx, gain };
            } catch (e) {
                console.warn('Audio keep-alive unavailable:', e);
                this._keepAlive = false;
                return;
            }
        }
        const { ctx, gain } = this._keepAlive;
        clearTimeout(this._keepAliveSuspendTimer);
        // Unconditional: resume/suspend apply in call order, so a suspend
        // still in flight can't leave the output stopped (or vice versa).
        ctx.resume().catch(() => { /* not allowed yet */ });
        // Each fade continues from the current value — no steps.
        gain.gain.setTargetAtTime(this.KEEPALIVE_GAIN, ctx.currentTime, this.KEEPALIVE_FADE_S);
    },

    /** Fade the tone out, then suspend the context (releases the output). */
    _stopKeepAlive() {
        this._cancelKeepAliveStop();
        if (!this._keepAlive) return;
        const { ctx, gain } = this._keepAlive;
        gain.gain.setTargetAtTime(0, ctx.currentTime, this.KEEPALIVE_FADE_S);
        clearTimeout(this._keepAliveSuspendTimer);
        this._keepAliveSuspendTimer = setTimeout(() => {
            ctx.suspend().catch(() => {});
        }, this.KEEPALIVE_FADE_S * 5000);
    },

    /** Release the output after KEEPALIVE_IDLE_MS unless playback resumes. */
    _scheduleKeepAliveStop() {
        if (!this._keepAlive || this._keepAliveStopTimer) return;
        this._keepAliveStopTimer = setTimeout(() => {
            this._keepAliveStopTimer = null;
            this._stopKeepAlive();
        }, this.KEEPALIVE_IDLE_MS);
    },

    _cancelKeepAliveStop() {
        clearTimeout(this._keepAliveStopTimer);
        this._keepAliveStopTimer = null;
    },

    /**
     * On error
     */
    onError(e) {
        console.error('Audio error:', e);
        const code = this.audio.error?.code;
        if (this.audio.error) {
            console.error('Audio error code:', code);
            console.error('Audio error message:', this.audio.error.message);
        }

        // R2 native (non-HLS) audio carries the Google token in the URL
        // (?_token=). When it expires mid-playback the next byte-range
        // request 401s and the element throws a network/src error. Mirror
        // the HLS auth-recovery path: refresh the token and reload from the
        // saved position before bothering the user. HLS has its own handler
        // (the hls.js ERROR event), so we only cover the direct path here.
        const item = this.currentItem;
        const isTokenedR2 = item?.sourceId === 'r2'
            && !item.isPlaylist
            && !this.hls
            && typeof Auth !== 'undefined'
            && !this._authRefreshAttempted;
        const looksLikeAuthExpiry = code === (window.MediaError?.MEDIA_ERR_NETWORK ?? 2)
            || code === (window.MediaError?.MEDIA_ERR_SRC_NOT_SUPPORTED ?? 4);
        if (isTokenedR2 && looksLikeAuthExpiry) {
            console.info('R2 native audio error — attempting silent token refresh + reload');
            this._handleAuthError();
            return;
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
            this._markUserIntent();
            this.audio.currentTime = (percent / 100) * duration;
        }
    },

    /**
     * Save playback progress. The position goes through positionSaveBlock
     * (no transient 0s / unintended big steps back); maxTime and history
     * are merged with what's stored and written even when the position
     * isn't, so they never shrink.
     *
     * `periodic: true` = throttled/internal save. Without it this is a
     * "last chance" save (pause, hide, unload, stop, track switch): if the
     * position is then refused as a step back, it goes into the history
     * as 'unsaved' so a deliberate scrub back (lock screen) isn't lost.
     */
    saveProgress({ periodic = false } = {}) {
        if (!this.currentItem) return;
        this._lastSaveAt = Date.now();
        this._trackRecovery(0, false);   // time-box also while paused

        const current = this.audio.currentTime;
        const duration = this.audio.duration;
        if (isNaN(duration) || !(duration > 0)) return;

        const pKey = this._progressKeyFor(this.currentItem);
        const stored = Storage.getBookProgress(pKey);

        const block = this.positionSaveBlock({
            t: current,
            stored,
            restoreDone: this._restoreDone,
            recovering: this._recovering,
            readyState: this.audio.readyState,
            userIntent: this._hasUserIntent(),
            runPlayed: this._listen?.runPlayed,
        });
        if (block !== this._lastBlockReason) {
            if (block) console.info(`[progress] not saving position ${this.formatTime(current)}: ${block}`);
            this._lastBlockReason = block;
        }
        if (block === 'backwards' && !periodic) {
            this._history = Storage.mergeHistory(
                [{ t: current, at: Date.now(), reason: 'unsaved' }], this._history);
            this._renderRecovery();
        }
        // A step back accepted without user intent (played there long
        // enough) overwrites the stored position — keep that one findable.
        const storedT = stored?.currentTime;
        if (!block && !this._hasUserIntent() && Number.isFinite(storedT)
            && storedT - current > this.BACKWARD_GUARD_S) {
            this._history = Storage.mergeHistory(
                [{ t: storedT, at: Date.now(), reason: 'restore' }], this._history);
            this._renderRecovery();
        }

        const maxTime = Storage.maxDefined(this._maxTime, stored?.maxTime);
        const history = Storage.mergeHistory(this._history, stored?.history);
        this._maxTime = maxTime;
        this._history = history;
        const recovery = {};
        if (maxTime !== undefined) recovery.maxTime = maxTime;
        if (history.length) recovery.history = history;

        if (!block) {
            Storage.updateBookProgress(pKey, {
                currentTime: current,
                duration: duration,
                percentage: Math.round((current / duration) * 100),
                ...recovery,
            });
        } else if (stored && (recovery.maxTime !== stored.maxTime
            || JSON.stringify(recovery.history) !== JSON.stringify(stored.history))) {
            // Position rejected, but recovery data moved on — store just
            // that, without bumping lastRead (it must not win the sync's
            // last-writer-wins for the position).
            Storage.updateBookProgress(pKey, recovery, { touch: false });
        } else {
            return;
        }
        // Cross-device sync via Drive appData (debounced inside Sync)
        if (typeof Sync !== 'undefined') Sync.scheduleUpload();
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
        this._stopKeepAlive();
        this._lastStableTime = null;
        this._clearJumpBack();
        this._clearRecoveryState();
    }
};
