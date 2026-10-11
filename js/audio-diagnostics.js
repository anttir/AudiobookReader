/**
 * Audio diagnostics (opt-in: Asetukset → Tietoja → Äänidiagnostiikka).
 *
 * Measures what the <audio> element actually plays — tapped with
 * captureStream(), so playback itself is untouched — and records:
 *  - holes: short near-silent gaps inside speech, and whether they sit on
 *    an HLS segment boundary (segments encoded one at a time put one at
 *    every boundary);
 *  - digital silence: stretches at ≈ zero (gated pauses), which USB-C DACs
 *    such as Apple EarPods USB-C mute on and fade back in from;
 *  - stalls: `waiting` while playing.
 * Results persist in localStorage, so they survive leaving the book.
 */
const AudioDiagnostics = {
    STORAGE_KEY: 'audioDiagnostics',
    // Same ?v= cache-bust as this script.
    WORKLET_SRC: 'js/level-meter-worklet.js' + (document.currentScript ? new URL(document.currentScript.src).search : ''),
    // Levels are per render quantum (128 frames ≈ 2.7 ms at 48 kHz).
    HOLE_DB: -60,           // this quiet counts as near-silent
    SPEECH_DB: -45,         // a hole needs audio this loud (avg) on both sides
    CONTEXT_MS: 50,         // ...over this long
    HOLE_MIN_MS: 8,
    HOLE_MAX_MS: 120,       // longer = a pause, not a hole
    SILENCE_DB: -90,        // ≈ digital zero
    SILENCE_MIN_MS: 50,
    BOUNDARY_TOL_S: 0.3,    // hole this close to a segment start = on the boundary
    SETTLE_MS: 300,         // ignore audio right after playback (re)starts
    MAX_EVENTS: 30,

    enabled: false,
    stats: null,
    unavailable: null,      // reason diagnostics can't run here
    _graph: null,           // Promise of { ctx, node, stream }
    _source: null,
    _track: null,
    _validSince: null,      // performance.now() of the last (re)start
    _win: [],               // recent { db, t } (t = media time, s)
    _scan: 0,
    _lastPersist: 0,

    init(audio) {
        this.audio = audio;
        this.enabled = !!Storage.getSettings().audioDiagnostics;
        this.stats = this._load();
        audio.addEventListener('playing', () => this._onPlaying());
        for (const ev of ['pause', 'seeking', 'emptied', 'ended']) {
            audio.addEventListener(ev, () => this._invalidate());
        }
        audio.addEventListener('waiting', () => {
            if (this.enabled && this._validSince != null && !audio.seeking) {
                this.stats.stalls++;
                this._event({ type: 'stall', t: audio.currentTime });
            }
            this._invalidate();
        });
        this.renderLive();
    },

    setEnabled(on) {
        this.enabled = on;
        Storage.setSettings({ audioDiagnostics: on });
        if (on && !this.audio.paused) {
            this._onPlaying();
        } else if (!on) {
            this._invalidate();
            this._graph?.then(g => g.ctx.close()).catch(() => {});
            this._graph = null;
            this._source = null;
            this._track = null;
        }
        this.renderLive();
    },

    reset() {
        this.stats = this._fresh();
        this._persist();
        this.renderLive();
    },

    async _onPlaying() {
        if (!this.enabled) return;
        this._invalidate();
        this._validSince = performance.now();
        try {
            await this._connect();
        } catch (e) {
            console.warn('[diag] unavailable:', e);
            this.unavailable = e.message || String(e);
            this.renderLive();
        }
    },

    /** Build the analysis graph once; (re)bind it to the element's current audio track. */
    async _connect() {
        if (typeof this.audio.captureStream !== 'function') {
            throw new Error('selain ei tue äänen mittausta (captureStream)');
        }
        if (!this._graph) {
            this._graph = (async () => {
                const ctx = new AudioContext();
                await ctx.audioWorklet.addModule(this.WORKLET_SRC);
                const node = new AudioWorkletNode(ctx, 'level-meter');
                node.port.onmessage = (e) => this._onLevels(e.data, ctx.sampleRate);
                // Only nodes that reach the destination are rendered; muted.
                const mute = ctx.createGain();
                mute.gain.value = 0;
                node.connect(mute).connect(ctx.destination);
                const stream = this.audio.captureStream();
                stream.addEventListener('addtrack', () => this._connect().catch(() => {}));
                return { ctx, node, stream };
            })();
            this._graph.catch(() => { this._graph = null; });
        }
        const { ctx, node, stream } = await this._graph;
        ctx.resume().catch(() => {});
        const track = stream.getAudioTracks()[0];
        if (track && track !== this._track) {
            this._source?.disconnect();
            this._source = ctx.createMediaStreamSource(new MediaStream([track]));
            this._source.connect(node);
            this._track = track;
        }
    },

    _onLevels(levels, sampleRate) {
        const a = this.audio;
        if (!this.enabled || this._validSince == null || a.paused || a.seeking) return;
        if (performance.now() - this._validSince < this.SETTLE_MS) return;
        if (levels.includes(null)) {        // input not connected yet
            this._invalidate(false);
            return;
        }
        const quantumS = 128 / sampleRate;
        const mediaQ = quantumS * a.playbackRate;
        const now = a.currentTime;
        levels.forEach((db, k) => this._win.push({ db, t: now - (levels.length - 1 - k) * mediaQ }));
        this.stats.listenedS += levels.length * mediaQ;
        this._analyse(quantumS * 1000);
        if (Date.now() - this._lastPersist > 10000) {
            this._persist();
            this.renderLive();
        }
    },

    /** Find finished near-silent runs that have enough context after them. */
    _analyse(quantumMs) {
        const w = this._win;
        const ctxN = Math.ceil(this.CONTEXT_MS / quantumMs);
        let i = this._scan;
        while (i < w.length) {
            if (w[i].db >= this.HOLE_DB) { i++; continue; }
            let j = i;
            while (j < w.length && w[j].db < this.HOLE_DB) j++;
            if (j + ctxN > w.length) break;          // wait for the run / context to finish
            this._classify(i, j, ctxN, quantumMs);
            i = j;
        }
        this._scan = i;
        const drop = this._scan - 2 * ctxN;
        if (drop > 512) {
            w.splice(0, drop);
            this._scan -= drop;
        }
    },

    _classify(i, j, ctxN, quantumMs) {
        const w = this._win;
        const ms = (j - i) * quantumMs;
        let min = Infinity;
        for (let k = i; k < j; k++) min = Math.min(min, w[k].db);
        if (min <= this.SILENCE_DB && ms >= this.SILENCE_MIN_MS) {
            this.stats.silences++;
            this.stats.silenceS += ms / 1000;
            this._event({ type: 'silence', t: w[i].t, ms });
        }
        if (ms < this.HOLE_MIN_MS || ms > this.HOLE_MAX_MS || i < ctxN) return;
        if (this._power(i - ctxN, i) < this.SPEECH_DB || this._power(j, j + ctxN) < this.SPEECH_DB) return;
        const boundary = this._onBoundary(w[i].t);
        this.stats.holes++;
        if (boundary) this.stats.holesOnBoundary++;
        this._event({ type: 'hole', t: w[i].t, ms, boundary, db: Math.round(min) });
    },

    /** Average level (dB) of window entries [a, b). */
    _power(a, b) {
        let sum = 0;
        for (let k = a; k < b; k++) sum += Math.pow(10, this._win[k].db / 10);
        return 10 * Math.log10(sum / (b - a));
    },

    _onBoundary(t) {
        const hls = (typeof AudioPlayer !== 'undefined') ? AudioPlayer.hls : null;
        const frags = hls?.levels?.[Math.max(0, hls.currentLevel)]?.details?.fragments;
        if (!frags?.length) return false;
        return frags.some((f, k) => k > 0 && Math.abs(f.start - t) <= this.BOUNDARY_TOL_S);
    },

    /** Playback stopped / jumped: analysis restarts from fresh context. */
    _invalidate(stopped = true) {
        if (stopped) this._validSince = null;
        this._win = [];
        this._scan = 0;
    },

    _event(e) {
        const book = (typeof App !== 'undefined') ? App.currentBook?.name : null;
        this.stats.events.unshift({ ...e, at: Date.now(), book });
        this.stats.events.length = Math.min(this.stats.events.length, this.MAX_EVENTS);
        this._persist();
        this.renderLive();
    },

    _fresh() {
        return { since: Date.now(), listenedS: 0, holes: 0, holesOnBoundary: 0,
            silences: 0, silenceS: 0, stalls: 0, events: [] };
    },

    _load() {
        try {
            const s = JSON.parse(localStorage.getItem(this.STORAGE_KEY));
            if (s && Array.isArray(s.events)) return { ...this._fresh(), ...s };
        } catch { /* fall through */ }
        return this._fresh();
    },

    _persist() {
        this._lastPersist = Date.now();
        try {
            localStorage.setItem(this.STORAGE_KEY, JSON.stringify(this.stats));
        } catch { /* storage full / blocked — keep in memory */ }
    },

    /** One-line counter under the chapter title while diagnostics are on. */
    renderLive() {
        const el = document.getElementById('diag-live');
        if (!el) return;
        el.classList.toggle('hidden', !this.enabled);
        if (!this.enabled) return;
        if (this.unavailable) {
            el.textContent = `Diagnostiikka ei toimi: ${this.unavailable}`;
            return;
        }
        const s = this.stats;
        const last = s.events[0];
        const fmt = (t) => (typeof AudioPlayer !== 'undefined') ? AudioPlayer.formatTime(t) : t.toFixed(1);
        const signal = (typeof AudioPlayer !== 'undefined') ? AudioPlayer.keepAliveStatus() : '?';
        el.textContent = `Diagnostiikka · katkoja ${s.holes} (saumoissa ${s.holesOnBoundary})`
            + ` · hiljaisuus ${s.silences} · pysähdyksiä ${s.stalls}`
            + (last ? ` · viimeisin ${fmt(last.t)}` : '')
            + ` · herätys ${signal}`;
    },

    /** Multi-line summary for Asetukset → Tietoja. */
    summaryText() {
        const s = this.stats;
        const d = new Date(s.since);
        const fmt = (t) => (typeof AudioPlayer !== 'undefined') ? AudioPlayer.formatTime(t) : t.toFixed(1);
        const label = { hole: 'katko', silence: 'hiljaisuus', stall: 'pysähdys' };
        const lines = [
            `Mitattu ${Math.round(s.listenedS / 60)} min (alkaen ${d.getDate()}.${d.getMonth() + 1}. `
                + `${d.toLocaleTimeString('fi-FI', { hour: '2-digit', minute: '2-digit' })})`,
            `Lyhyet katkot puheessa: ${s.holes}, joista segmenttisaumoissa ${s.holesOnBoundary}`,
            `Digitaalinen hiljaisuus: ${s.silences} kertaa, yht. ${s.silenceS.toFixed(1)} s`,
            `Puskurointipysähdyksiä: ${s.stalls}`,
        ];
        if (this.unavailable) lines.push(`Ei toimi tässä selaimessa: ${this.unavailable}`);
        if (s.events.length) {
            lines.push('', 'Viimeisimmät:');
            for (const e of s.events.slice(0, 12)) {
                const ms = e.ms != null ? ` ${Math.round(e.ms)} ms` : '';
                lines.push(`  ${fmt(e.t)} ${label[e.type]}${ms}${e.boundary ? ' (saumassa)' : ''}`);
            }
        }
        return lines.join('\n');
    },
};
