/**
 * EPUB Viewer Module using epub.js
 */

const EPUBViewer = {
    book: null,
    rendition: null,
    currentFileId: null,
    currentLocation: null,

    /**
     * Initialize the EPUB viewer
     */
    init() {
        this.setupNavigation();
        this.setupGestures();

        // Save progress when page visibility changes or before unload
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'hidden') {
                this.saveProgress();
            }
        });

        window.addEventListener('beforeunload', () => {
            this.saveProgress();
        });
    },

    /**
     * Setup navigation buttons
     */
    setupNavigation() {
        document.getElementById('epub-prev').addEventListener('click', () => this.prevPage());
        document.getElementById('epub-next').addEventListener('click', () => this.nextPage());

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!this.book) return;
            if (document.getElementById('epub-viewer-container').classList.contains('hidden')) return;

            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                this.prevPage();
            } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
                e.preventDefault();
                this.nextPage();
            }
        });
    },

    /**
     * Setup touch gestures for mobile
     */
    setupGestures() {
        const container = document.getElementById('epub-viewer');
        let startX = 0;

        container.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
        }, { passive: true });

        container.addEventListener('touchend', (e) => {
            const endX = e.changedTouches[0].clientX;
            const diffX = endX - startX;

            if (Math.abs(diffX) > 50) {
                if (diffX > 0) {
                    this.prevPage();
                } else {
                    this.nextPage();
                }
            }
        }, { passive: true });
    },

    /**
     * Load an EPUB from Google Drive
     */
    async loadFromDrive(fileId, fileName) {
        this.currentFileId = fileId;

        try {
            App.showLoading(true, 'Ladataan: ' + this.cleanFileName(fileName));

            // Download the EPUB with progress tracking
            const blob = await Drive.downloadFileWithProgress(fileId, (loaded, total) => {
                App.updateLoadingProgress(loaded, total);
            });
            const arrayBuffer = await blob.arrayBuffer();

            // Create book
            this.book = ePub(arrayBuffer);

            // Wait for book to be ready
            await this.book.ready;

            // Generate locations for progress tracking (critical for saving position!)
            await this.book.locations.generate(1024);

            // Get container
            const container = document.getElementById('epub-viewer');
            container.innerHTML = '';

            // Create rendition
            this.rendition = this.book.renderTo(container, {
                width: '100%',
                height: '100%',
                spread: 'none',
                flow: 'paginated'
            });

            // Apply theme
            this.applyTheme();

            // Setup location change handler BEFORE display so we catch the first location
            this.rendition.on('locationChanged', (location) => {
                this.onLocationChanged(location);
            });

            // Get saved progress and display
            const progress = Storage.getBookProgress(fileId);
            console.log('EPUB: Loaded progress for', fileId, progress);

            if (progress?.cfi) {
                try {
                    await this.rendition.display(progress.cfi);
                    console.log('EPUB: Restored to CFI', progress.cfi);
                } catch (e) {
                    console.warn('EPUB: Could not restore CFI, starting from beginning', e);
                    await this.rendition.display();
                }
            } else {
                await this.rendition.display();
            }

            // Update UI
            document.getElementById('current-book-title').textContent = this.cleanFileName(fileName);

            App.showLoading(false);
            return true;

        } catch (error) {
            console.error('Error loading EPUB:', error);
            App.showLoading(false);
            App.showToast('EPUB:n lataaminen epäonnistui', 'error');
            return false;
        }
    },

    /**
     * Clean file name for display
     */
    cleanFileName(name) {
        return name.replace(/\.epub$/i, '').replace(/_/g, ' ').trim();
    },

    /**
     * Apply current theme to EPUB (forces colors to override book styles)
     */
    applyTheme(themeName = null) {
        if (!this.rendition) return;

        const settings = Storage.getSettings();
        const activeTheme = themeName || settings.readerTheme || 'dark';

        // Save theme preference
        if (themeName) {
            Storage.setSettings({ readerTheme: themeName });
        }

        // Theme definitions with aggressive overrides
        const themes = {
            dark: {
                bg: '#1a1a2e',
                text: '#eaeaea',
                link: '#6bb5ff'
            },
            light: {
                bg: '#ffffff',
                text: '#1a1a1a',
                link: '#0066cc'
            },
            sepia: {
                bg: '#f4ecd8',
                text: '#5c4b37',
                link: '#8b4513'
            }
        };

        const t = themes[activeTheme] || themes.dark;

        // Apply comprehensive CSS that overrides book styles
        this.rendition.themes.register('custom', {
            'body': {
                'background-color': `${t.bg} !important`,
                'color': `${t.text} !important`
            },
            'body *': {
                'color': `${t.text} !important`,
                'background-color': 'transparent !important'
            },
            'p, div, span, h1, h2, h3, h4, h5, h6, li, td, th': {
                'color': `${t.text} !important`
            },
            'a': {
                'color': `${t.link} !important`
            }
        });
        this.rendition.themes.select('custom');

        // Apply font size
        const fontSize = settings.fontSize || 100;
        this.rendition.themes.fontSize(`${fontSize}%`);
    },

    /**
     * On location changed
     */
    onLocationChanged(location) {
        console.log('EPUB: Location changed', JSON.stringify(location, null, 2));
        this.currentLocation = location;

        // Extract CFI - epub.js returns CFI directly as string in start/end
        const startVal = location?.start;
        const cfi = (typeof startVal === 'string' && startVal.startsWith('epubcfi'))
            ? startVal
            : (startVal?.cfi || location?.startCfi || location?.cfi || location?.end);

        // Update progress display
        try {
            if (cfi && this.book && this.book.locations && this.book.locations.length()) {
                const percent = this.book.locations.percentageFromCfi(cfi);
                if (typeof percent === 'number' && !isNaN(percent)) {
                    document.getElementById('epub-location').textContent = `${Math.round(percent * 100)}%`;
                    document.getElementById('current-chapter').textContent = `${Math.round(percent * 100)}% luettu`;
                }
            }
        } catch (e) {
            console.warn('EPUB: Could not calculate percentage', e);
        }

        // Save progress
        this.saveProgress();
    },

    /**
     * Go to next page
     */
    nextPage() {
        if (this.rendition) {
            this.rendition.next();
        }
    },

    /**
     * Go to previous page
     */
    prevPage() {
        if (this.rendition) {
            this.rendition.prev();
        }
    },

    /**
     * Go to specific CFI location
     */
    goTo(cfi) {
        if (this.rendition) {
            this.rendition.display(cfi);
        }
    },

    /**
     * Save reading progress
     */
    saveProgress() {
        if (!this.currentFileId || !this.currentLocation) {
            console.log('EPUB: Cannot save progress - no fileId or location');
            return;
        }

        // Extract CFI - epub.js returns CFI directly as string in start/end
        const startVal = this.currentLocation?.start;
        const cfi = (typeof startVal === 'string' && startVal.startsWith('epubcfi'))
            ? startVal
            : (startVal?.cfi || this.currentLocation?.startCfi || this.currentLocation?.cfi);

        if (!cfi) {
            console.log('EPUB: No CFI found in location', this.currentLocation);
            return;
        }

        let percentage = 0;
        try {
            if (this.book && this.book.locations && this.book.locations.length()) {
                const pct = this.book.locations.percentageFromCfi(cfi);
                if (typeof pct === 'number' && !isNaN(pct)) {
                    percentage = Math.round(pct * 100);
                }
            }
        } catch (e) {
            console.warn('EPUB: Could not calculate percentage for save', e);
        }

        const progressData = {
            cfi: cfi,
            percentage: percentage,
            timestamp: Date.now()
        };

        console.log('EPUB: Saving progress', this.currentFileId, progressData);
        Storage.setBookProgress(this.currentFileId, progressData);
    },

    /**
     * Get table of contents
     */
    async getTOC() {
        if (!this.book) return [];

        await this.book.loaded.navigation;
        return this.book.navigation.toc;
    },

    /**
     * Set font size
     */
    setFontSize(percent) {
        if (this.rendition) {
            this.rendition.themes.fontSize(`${percent}%`);
            Storage.setSettings({ fontSize: percent });
        }
    },

    /**
     * Get current progress percentage
     */
    getProgress() {
        if (!this.book || !this.currentLocation) return 0;

        if (this.book.locations && this.book.locations.length()) {
            return Math.round(
                this.book.locations.percentageFromCfi(this.currentLocation.start.cfi) * 100
            );
        }
        return 0;
    },

    /**
     * Clean up
     */
    destroy() {
        if (this.book) {
            this.book.destroy();
            this.book = null;
        }
        if (this.rendition) {
            this.rendition = null;
        }
        this.currentFileId = null;
        this.currentLocation = null;
    }
};
