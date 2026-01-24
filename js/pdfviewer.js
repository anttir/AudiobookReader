/**
 * PDF Viewer Module using PDF.js
 */

const PDFViewer = {
    pdfDoc: null,
    currentPage: 1,
    totalPages: 0,
    scale: 1.5,
    rendering: false,
    pendingPage: null,
    currentFileId: null,
    canvas: null,
    ctx: null,

    /**
     * Initialize the PDF viewer
     */
    init() {
        // Set PDF.js worker
        pdfjsLib.GlobalWorkerOptions.workerSrc =
            'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';

        // Create canvas element
        this.canvas = document.createElement('canvas');
        this.ctx = this.canvas.getContext('2d');

        const container = document.getElementById('pdf-viewer');
        container.innerHTML = '';
        container.appendChild(this.canvas);

        // Setup navigation
        this.setupNavigation();
        this.setupGestures();
    },

    /**
     * Setup navigation buttons
     */
    setupNavigation() {
        document.getElementById('prev-page').addEventListener('click', () => this.prevPage());
        document.getElementById('next-page').addEventListener('click', () => this.nextPage());

        // Keyboard navigation
        document.addEventListener('keydown', (e) => {
            if (!this.pdfDoc) return;

            if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
                this.prevPage();
            } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
                this.nextPage();
            }
        });
    },

    /**
     * Setup touch gestures for mobile
     */
    setupGestures() {
        const container = document.getElementById('pdf-viewer');
        let startX = 0;
        let startY = 0;

        container.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        container.addEventListener('touchend', (e) => {
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const diffX = endX - startX;
            const diffY = endY - startY;

            // Horizontal swipe
            if (Math.abs(diffX) > Math.abs(diffY) && Math.abs(diffX) > 50) {
                if (diffX > 0) {
                    this.prevPage();
                } else {
                    this.nextPage();
                }
            }
        }, { passive: true });
    },

    /**
     * Load a PDF from Google Drive
     */
    async loadFromDrive(fileId, fileName) {
        this.currentFileId = fileId;

        try {
            App.showLoading(true);

            // Download the PDF
            const arrayBuffer = await Drive.downloadFileAsArrayBuffer(fileId);

            // Load with PDF.js
            const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
            this.pdfDoc = await loadingTask.promise;
            this.totalPages = this.pdfDoc.numPages;

            // Get saved progress
            const progress = Storage.getBookProgress(fileId);
            this.currentPage = progress?.page || 1;

            // Update UI
            document.getElementById('current-book-title').textContent = fileName;
            this.updatePageInfo();

            // Render first page
            await this.renderPage(this.currentPage);

            App.showLoading(false);
            return true;

        } catch (error) {
            console.error('Error loading PDF:', error);
            App.showLoading(false);
            App.showToast('PDF:n lataaminen epäonnistui', 'error');
            return false;
        }
    },

    /**
     * Render a specific page
     */
    async renderPage(pageNum) {
        if (this.rendering) {
            this.pendingPage = pageNum;
            return;
        }

        this.rendering = true;

        try {
            const page = await this.pdfDoc.getPage(pageNum);

            // Calculate scale to fit container
            const container = document.getElementById('pdf-viewer');
            const containerWidth = container.clientWidth - 40;
            const containerHeight = container.clientHeight - 40;

            const viewport = page.getViewport({ scale: 1 });
            const scaleX = containerWidth / viewport.width;
            const scaleY = containerHeight / viewport.height;
            this.scale = Math.min(scaleX, scaleY, 2); // Max scale 2x

            const scaledViewport = page.getViewport({ scale: this.scale });

            // Set canvas size
            this.canvas.height = scaledViewport.height;
            this.canvas.width = scaledViewport.width;

            // Render the page
            const renderContext = {
                canvasContext: this.ctx,
                viewport: scaledViewport
            };

            await page.render(renderContext).promise;

            this.currentPage = pageNum;
            this.updatePageInfo();
            this.saveProgress();

        } catch (error) {
            console.error('Error rendering page:', error);
        }

        this.rendering = false;

        // Render pending page if any
        if (this.pendingPage !== null) {
            const pending = this.pendingPage;
            this.pendingPage = null;
            this.renderPage(pending);
        }
    },

    /**
     * Go to next page
     */
    nextPage() {
        if (this.currentPage < this.totalPages) {
            this.renderPage(this.currentPage + 1);
        }
    },

    /**
     * Go to previous page
     */
    prevPage() {
        if (this.currentPage > 1) {
            this.renderPage(this.currentPage - 1);
        }
    },

    /**
     * Go to specific page
     */
    goToPage(pageNum) {
        if (pageNum >= 1 && pageNum <= this.totalPages) {
            this.renderPage(pageNum);
        }
    },

    /**
     * Update page info display
     */
    updatePageInfo() {
        const pageInfo = document.getElementById('page-info');
        pageInfo.textContent = `${this.currentPage} / ${this.totalPages}`;

        // Update chapter display
        document.getElementById('current-chapter').textContent = `Sivu ${this.currentPage}`;

        // Update navigation buttons
        document.getElementById('prev-page').disabled = this.currentPage <= 1;
        document.getElementById('next-page').disabled = this.currentPage >= this.totalPages;
    },

    /**
     * Save reading progress
     */
    saveProgress() {
        if (!this.currentFileId) return;

        Storage.setBookProgress(this.currentFileId, {
            page: this.currentPage,
            totalPages: this.totalPages,
            percentage: Math.round((this.currentPage / this.totalPages) * 100)
        });
    },

    /**
     * Set zoom level
     */
    setZoom(scale) {
        this.scale = scale;
        this.renderPage(this.currentPage);
    },

    /**
     * Zoom in
     */
    zoomIn() {
        this.setZoom(Math.min(this.scale * 1.2, 3));
    },

    /**
     * Zoom out
     */
    zoomOut() {
        this.setZoom(Math.max(this.scale / 1.2, 0.5));
    },

    /**
     * Fit to width
     */
    fitToWidth() {
        const container = document.getElementById('pdf-viewer');
        this.renderPage(this.currentPage);
    },

    /**
     * Get current progress percentage
     */
    getProgress() {
        if (!this.pdfDoc) return 0;
        return Math.round((this.currentPage / this.totalPages) * 100);
    },

    /**
     * Clean up
     */
    destroy() {
        if (this.pdfDoc) {
            this.pdfDoc.destroy();
            this.pdfDoc = null;
        }
        this.currentFileId = null;
        this.currentPage = 1;
        this.totalPages = 0;
    }
};
