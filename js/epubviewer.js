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
            App.showLoading(true);

            // Download the EPUB
            const blob = await Drive.downloadFile(fileId);
            const arrayBuffer = await blob.arrayBuffer();

            // Create book
            this.book = ePub(arrayBuffer);

            // Wait for book to be ready
            await this.book.ready;

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

            // Get saved progress
            const progress = Storage.getBookProgress(fileId);
            if (progress?.cfi) {
                await this.rendition.display(progress.cfi);
            } else {
                await this.rendition.display();
            }

            // Setup location change handler
            this.rendition.on('locationChanged', (location) => {
                this.onLocationChanged(location);
            });

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
     * Apply current theme to EPUB
     */
    applyTheme() {
        if (!this.rendition) return;

        const settings = Storage.getSettings();
        const themes = {
            dark: {
                body: {
                    background: '#1a1a2e',
                    color: '#eaeaea'
                }
            },
            light: {
                body: {
                    background: '#ffffff',
                    color: '#1a1a1a'
                }
            },
            sepia: {
                body: {
                    background: '#f4ecd8',
                    color: '#5c4b37'
                }
            }
        };

        const theme = themes[settings.theme] || themes.dark;
        this.rendition.themes.default(theme);

        // Apply font size
        const fontSize = settings.fontSize || 100;
        this.rendition.themes.fontSize(`${fontSize}%`);
    },

    /**
     * On location changed
     */
    onLocationChanged(location) {
        this.currentLocation = location;

        // Update progress display
        if (this.book.locations && this.book.locations.length()) {
            const percent = this.book.locations.percentageFromCfi(location.start.cfi);
            document.getElementById('epub-location').textContent = `${Math.round(percent * 100)}%`;
            document.getElementById('current-chapter').textContent = `${Math.round(percent * 100)}% luettu`;
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
        if (!this.currentFileId || !this.currentLocation) return;

        let percentage = 0;
        if (this.book.locations && this.book.locations.length()) {
            percentage = Math.round(
                this.book.locations.percentageFromCfi(this.currentLocation.start.cfi) * 100
            );
        }

        Storage.setBookProgress(this.currentFileId, {
            cfi: this.currentLocation.start.cfi,
            percentage: percentage
        });
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
