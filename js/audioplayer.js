/**
 * Audio Player Module
 */

const AudioPlayer = {
    audio: null,
    playlist: [],
    currentIndex: 0,
    currentFileId: null,
    currentBlobUrl: null,  // Store blob URL for cleanup
    isPlaying: false,
    isLoading: false,
    updateInterval: null,

    /**
     * Initialize the audio player
     */
    init() {
        this.audio = document.getElementById('audio-element');
        this.setupEventListeners();
        this.setupMediaSession();
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
     * Load playlist from files
     */
    setPlaylist(audioFiles) {
        this.playlist = audioFiles.map(file => ({
            id: file.id,
            name: file.name
        }));
    },

    /**
     * Load and play a specific file
     */
    async loadTrack(fileId, fileName) {
        if (this.isLoading) return false;

        this.isLoading = true;
        this.currentFileId = fileId;

        // Find in playlist
        const index = this.playlist.findIndex(t => t.id === fileId);
        if (index !== -1) {
            this.currentIndex = index;
        }

        // Update UI immediately
        document.getElementById('audio-title').textContent = this.cleanFileName(fileName);
        document.getElementById('audio-chapter').textContent = `Kappale ${this.currentIndex + 1} / ${this.playlist.length}`;
        document.getElementById('current-book-title').textContent = this.cleanFileName(fileName);
        document.getElementById('current-time').textContent = 'Ladataan...';
        document.getElementById('duration').textContent = '';

        try {
            // Clean up previous blob URL
            if (this.currentBlobUrl) {
                URL.revokeObjectURL(this.currentBlobUrl);
                this.currentBlobUrl = null;
            }

            // Download audio file as blob (this uses Authorization header properly)
            App.showToast('Ladataan äänitiedostoa...', 'info');
            const blob = await Drive.downloadFile(fileId);

            // Create blob URL
            this.currentBlobUrl = URL.createObjectURL(blob);
            this.audio.src = this.currentBlobUrl;

            // Get saved progress
            const progress = Storage.getBookProgress(fileId);
            if (progress?.currentTime) {
                this.audio.currentTime = progress.currentTime;
            }

            // Update Media Session
            this.updateMediaSession(fileName);

            this.isLoading = false;
            return true;

        } catch (error) {
            console.error('Error loading audio:', error);
            this.isLoading = false;
            App.showToast('Äänitiedoston lataaminen epäonnistui', 'error');
            return false;
        }
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
     * Update Media Session metadata
     */
    updateMediaSession(title) {
        if ('mediaSession' in navigator) {
            navigator.mediaSession.metadata = new MediaMetadata({
                title: this.cleanFileName(title),
                artist: 'AudioBook Reader',
                album: 'Äänikirja'
            });
        }
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
            const track = this.playlist[this.currentIndex];
            this.loadTrack(track.id, track.name);
        }
    },

    /**
     * Go to next track
     */
    nextTrack() {
        if (this.currentIndex < this.playlist.length - 1) {
            this.currentIndex++;
            const track = this.playlist[this.currentIndex];
            this.loadTrack(track.id, track.name);
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

            // Save progress periodically
            this.saveProgress();
        }
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
    },

    /**
     * On pause event
     */
    onPause() {
        this.isPlaying = false;
        this.updatePlayButton();
        this.saveProgress();
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
        if (!this.currentFileId) return;

        const current = this.audio.currentTime;
        const duration = this.audio.duration;

        if (!isNaN(duration) && duration > 0) {
            Storage.setBookProgress(this.currentFileId, {
                currentTime: current,
                duration: duration,
                percentage: Math.round((current / duration) * 100)
            });
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
        if (this.currentBlobUrl) {
            URL.revokeObjectURL(this.currentBlobUrl);
            this.currentBlobUrl = null;
        }
        this.audio.src = '';
        this.playlist = [];
        this.currentIndex = 0;
        this.currentFileId = null;
    }
};
