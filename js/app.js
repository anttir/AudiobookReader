/**
 * Main Application - AudioBook Reader
 */

const App = {
    currentScreen: 'login',
    currentFolder: null,
    library: null,
    files: null,
    currentBook: null,      // Current book being read (can be multi-part)
    currentPartIndex: 0,    // Current part index in multi-part book
    currentMode: 'read',    // 'read' or 'listen'
    folderStack: [],

    /**
     * Initialize the application
     */
    async init() {
        // Apply saved theme
        this.applyTheme();

        // Restore active storage source + render selector
        Providers.restoreActive();
        this.renderSourceSelector();
        this.updateFolderSelectorVisibility();

        // Initialize modules
        PDFViewer.init();
        EPUBViewer.init();
        AudioPlayer.init();

        // Initialize authentication
        Auth.init((isLoggedIn, user) => this.onAuthChange(isLoggedIn, user));

        // Setup event listeners
        this.setupEventListeners();

        // Hide loading screen after a short delay
        setTimeout(() => {
            document.getElementById('loading-screen').classList.add('hidden');
        }, 500);
    },

    /**
     * Render the source selector tabs from registered providers.
     */
    renderSourceSelector() {
        const container = document.getElementById('source-selector');
        if (!container) return;
        const activeId = Providers.activeId();
        const buttons = Providers.list().map(p => {
            const isActive = p.id === activeId;
            return `
                <button type="button" class="source-btn ${isActive ? 'active' : ''}" data-source="${p.id}"
                    style="
                        display: flex; align-items: center; gap: 6px;
                        padding: 6px 12px; border-radius: 999px; cursor: pointer;
                        background: ${isActive ? 'var(--accent)' : 'var(--bg-secondary)'};
                        color: ${isActive ? 'white' : 'var(--text-primary)'};
                        border: 1px solid ${isActive ? 'var(--accent)' : 'var(--border-color)'};
                        font-size: 0.85rem; white-space: nowrap;
                    ">
                    <span style="display: inline-flex; width: 18px; height: 18px;">${p.icon || ''}</span>
                    <span>${p.displayName}</span>
                </button>
            `;
        }).join('');
        container.innerHTML = buttons;
        container.querySelectorAll('.source-btn').forEach(btn => {
            btn.addEventListener('click', () => this.switchSource(btn.dataset.source));
        });
    },

    /** Switch the active storage source. */
    async switchSource(sourceId) {
        if (sourceId === Providers.activeId()) return;
        // Stop any in-flight audio so we don't leak streams across sources
        AudioPlayer.stop();
        Providers.setActive(sourceId);
        this.currentBook = null;
        this.renderSourceSelector();
        this.updateFolderSelectorVisibility();
        await this.loadLibrary();
    },

    /** Drive shows a folder picker; manifest-based sources hide it. */
    updateFolderSelectorVisibility() {
        const folderSelector = document.getElementById('folder-selector');
        if (!folderSelector) return;
        const provider = Providers.active();
        folderSelector.style.display = provider?.supportsBrowsing ? '' : 'none';
    },

    /**
     * Resolve the namespaced progress key for an item.
     * Items from R2 carry an explicit progressKey (one per book); Drive
     * items fall back to "drive:<fileId>".
     */
    _itemProgressKey(item) {
        if (!item) return null;
        return item.progressKey || `${item.sourceId || 'drive'}:${item.key || item.id}`;
    },

    /** Convenience: read stored progress for an item. */
    _getItemProgress(item) {
        const key = this._itemProgressKey(item);
        return key ? Storage.getBookProgress(key) : null;
    },

    /**
     * Setup event listeners
     */
    setupEventListeners() {
        // Login button
        document.getElementById('google-signin-btn').addEventListener('click', () => {
            Auth.signIn();
        });

        // Folder selection
        document.getElementById('select-folder-btn').addEventListener('click', () => {
            this.openFolderPicker();
        });

        document.getElementById('change-folder-btn').addEventListener('click', () => {
            this.openFolderPicker();
        });

        // Refresh button
        document.getElementById('refresh-btn').addEventListener('click', () => {
            this.refreshLibrary();
        });

        // Settings
        document.getElementById('settings-btn').addEventListener('click', () => {
            this.openSettings();
        });

        document.getElementById('close-settings').addEventListener('click', () => {
            this.closeModal('settings-modal');
        });

        document.getElementById('user-avatar').addEventListener('click', () => {
            this.openSettings();
        });

        // Logout
        document.getElementById('logout-btn').addEventListener('click', () => {
            Auth.signOut();
            this.closeModal('settings-modal');
        });

        // Theme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                this.setTheme(e.target.dataset.theme);
            });
        });

        // Reader controls
        document.getElementById('back-to-library').addEventListener('click', () => {
            // Stop audio when leaving the book
            AudioPlayer.stop();
            this.currentBook = null;
            this.showScreen('library');
            this.hidePartsButton();
        });

        document.getElementById('toggle-mode').addEventListener('click', () => {
            this.toggleMode();
        });

        // Reader settings
        document.getElementById('reader-settings-btn').addEventListener('click', () => {
            this.openModal('reader-settings-modal');
        });

        document.getElementById('close-reader-settings').addEventListener('click', () => {
            this.closeModal('reader-settings-modal');
        });

        // Zoom controls
        document.getElementById('zoom-in').addEventListener('click', () => PDFViewer.zoomIn());
        document.getElementById('zoom-out').addEventListener('click', () => PDFViewer.zoomOut());
        document.getElementById('zoom-fit').addEventListener('click', () => PDFViewer.fitToWidth());

        // EPUB theme buttons
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const theme = btn.dataset.theme;
                // Update button states
                document.querySelectorAll('.theme-btn').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                // Apply theme to EPUB
                EPUBViewer.applyTheme(theme);
            });
        });

        // Set initial theme button state
        const savedTheme = Storage.getSettings().readerTheme || 'dark';
        document.querySelector(`.theme-btn[data-theme="${savedTheme}"]`)?.classList.add('active');

        // File picker
        document.getElementById('close-picker').addEventListener('click', () => {
            this.closeModal('file-picker-modal');
        });

        document.getElementById('picker-cancel').addEventListener('click', () => {
            this.closeModal('file-picker-modal');
        });

        document.getElementById('picker-select').addEventListener('click', () => {
            this.selectCurrentFolder();
        });

        document.getElementById('picker-back').addEventListener('click', () => {
            this.navigatePickerBack();
        });

        // Parts button
        document.getElementById('show-parts-btn').addEventListener('click', () => {
            this.showChapterList();
        });

        // Chapter list close
        document.getElementById('close-chapters').addEventListener('click', () => {
            this.hideChapterList();
        });

        // Modal backdrop click to close
        document.querySelectorAll('.modal').forEach(modal => {
            modal.addEventListener('click', (e) => {
                if (e.target === modal) {
                    this.closeModal(modal.id);
                }
            });
        });

        // R2 configuration
        const r2SaveBtn = document.getElementById('r2-save-btn');
        const r2ClearBtn = document.getElementById('r2-clear-btn');
        if (r2SaveBtn) r2SaveBtn.addEventListener('click', () => this.saveR2Config());
        if (r2ClearBtn) r2ClearBtn.addEventListener('click', () => this.clearR2Config());
    },

    /** Save R2 config from the settings form. */
    saveR2Config() {
        const input = document.getElementById('r2-base-url');
        const status = document.getElementById('r2-config-status');
        const url = (input?.value || '').trim();
        if (!url) {
            if (status) status.textContent = 'Anna bucketin URL.';
            return;
        }
        if (!/^https?:\/\//i.test(url)) {
            if (status) status.textContent = 'URL:n pitää alkaa https://';
            return;
        }
        const defaultUrl = CONFIG?.R2_DEFAULT_BASE_URL || '';
        try {
            // Saving the same value as the default URL = no override needed;
            // just clear any existing override so the default stays in effect.
            if (defaultUrl && url.replace(/\/+$/, '') === defaultUrl.replace(/\/+$/, '')) {
                R2Provider.clearConfig();
                if (status) status.textContent = 'Käytössä default-URL (config.js).';
            } else {
                R2Provider.setConfig({ baseUrl: url });
                if (status) status.textContent = 'Tallennettu. Vaihda lähteeksi Cloudflare R2.';
            }
            this.showToast('R2-asetukset tallennettu', 'success');
            if (Providers.activeId() === 'r2') this.loadLibrary();
        } catch (e) {
            if (status) status.textContent = 'Virhe: ' + e.message;
        }
    },

    /**
     * Clear the user override. If a default URL is configured in
     * CONFIG.R2_DEFAULT_BASE_URL it stays in effect (the input
     * re-renders to the default value); otherwise R2 becomes
     * unconfigured.
     */
    clearR2Config() {
        R2Provider.clearConfig();
        const cfg = R2Provider.getConfig();
        const input = document.getElementById('r2-base-url');
        const status = document.getElementById('r2-config-status');
        if (cfg?._isDefault) {
            if (input) input.value = cfg.baseUrl;
            if (status) status.textContent = `Palautettu default-URL: ${cfg.baseUrl}`;
            this.showToast('Palautettu default-URL:hin', 'info');
        } else {
            if (input) input.value = '';
            if (status) status.textContent = 'Tyhjennetty (ei default-URL:a).';
            this.showToast('R2-asetukset tyhjennetty', 'info');
        }
        if (Providers.activeId() === 'r2') this.loadLibrary();
    },

    /**
     * Handle authentication state change
     */
    onAuthChange(isLoggedIn, user) {
        if (isLoggedIn && user) {
            // Update user UI
            document.getElementById('user-image').src = user.picture || '';
            document.getElementById('settings-user-image').src = user.picture || '';
            document.getElementById('settings-user-name').textContent = user.name || user.email;

            // Check for saved folder
            const savedFolder = Storage.getSelectedFolder();
            if (savedFolder) {
                this.currentFolder = savedFolder;
                document.getElementById('folder-name').textContent = savedFolder.name;
                document.getElementById('current-folder-path').textContent = savedFolder.name;
            }

            // Show library
            this.showScreen('library');

            // Always try to load the active provider's library (R2 needs no
            // folder; Drive needs a saved one).
            this.loadLibrary();

            // Best-effort: pull cross-device listening progress from
            // Drive's appData folder. Re-renders the "Continue listening"
            // card if a newer position came from another device.
            if (typeof Sync !== 'undefined') {
                Sync.init().then(() => {
                    // Refresh library so "Jatka lukemista" picks up any
                    // merged-in progress from other devices.
                    this.renderLibrary?.();
                });
            }
        } else {
            if (typeof Sync !== 'undefined') Sync.reset();
            this.showScreen('login');
        }
    },

    /**
     * Show a specific screen
     */
    showScreen(screenName) {
        const screens = ['login', 'library', 'reader'];

        screens.forEach(name => {
            const screen = document.getElementById(`${name}-screen`);
            if (name === screenName) {
                screen.classList.remove('hidden');
            } else {
                screen.classList.add('hidden');
            }
        });

        this.currentScreen = screenName;
    },

    /**
     * Open folder picker
     */
    async openFolderPicker() {
        this.openModal('file-picker-modal');
        this.folderStack = [];
        await this.loadPickerFolder('root');
    },

    /**
     * Load folder contents in picker
     */
    async loadPickerFolder(folderId, folderName = 'My Drive') {
        const content = document.getElementById('picker-content');
        content.innerHTML = '<div class="picker-loading"><div class="loader"></div><p>Ladataan...</p></div>';

        // Update back button
        const backBtn = document.getElementById('picker-back');
        backBtn.classList.toggle('hidden', this.folderStack.length === 0);

        // Update title
        document.getElementById('picker-title').textContent = folderName;

        try {
            const files = await Drive.getAllFilesInFolder(folderId);
            const folders = files.filter(f => Drive.isFolder(f));

            // Check if this folder has supported files
            const hasContent = files.some(f => Drive.isEbook(f) || Drive.isAudio(f));

            // Enable/disable select button
            document.getElementById('picker-select').disabled = !hasContent && folderId !== 'root';

            // Render folder list
            if (folders.length === 0 && folderId === 'root') {
                content.innerHTML = `
                    <div class="empty-state" style="padding: 40px;">
                        <p>Ei kansioita</p>
                    </div>
                `;
                return;
            }

            let html = '<div class="picker-list">';

            folders.forEach(folder => {
                html += `
                    <div class="picker-item" data-id="${folder.id}" data-name="${folder.name}">
                        <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z" fill="#f39c12"/></svg>
                        <span>${folder.name}</span>
                    </div>
                `;
            });

            html += '</div>';
            content.innerHTML = html;

            // Add click handlers
            content.querySelectorAll('.picker-item').forEach(item => {
                item.addEventListener('click', () => {
                    this.folderStack.push({ id: folderId, name: folderName });
                    this.loadPickerFolder(item.dataset.id, item.dataset.name);
                });
            });

            // Store current folder info
            this.pickerCurrentFolder = { id: folderId, name: folderName };

        } catch (error) {
            console.error('Error loading folder:', error);
            content.innerHTML = `
                <div class="empty-state" style="padding: 40px;">
                    <p>Virhe kansion lataamisessa</p>
                </div>
            `;
        }
    },

    /**
     * Navigate back in picker
     */
    navigatePickerBack() {
        if (this.folderStack.length > 0) {
            const prev = this.folderStack.pop();
            this.loadPickerFolder(prev.id, prev.name);
        }
    },

    /**
     * Select current folder in picker
     */
    selectCurrentFolder() {
        if (this.pickerCurrentFolder) {
            this.currentFolder = this.pickerCurrentFolder;
            Storage.setSelectedFolder(this.currentFolder);

            document.getElementById('folder-name').textContent = this.currentFolder.name;
            document.getElementById('current-folder-path').textContent = this.currentFolder.name;

            this.closeModal('file-picker-modal');
            this.loadLibrary();
        }
    },

    /**
     * Load library from the active storage provider.
     */
    async loadLibrary() {
        const content = document.getElementById('library-content');
        const provider = Providers.active();
        if (!provider) {
            content.innerHTML = `<div class="empty-state"><p>Ei tallennuslähdettä valittuna</p></div>`;
            return;
        }

        // Drive needs a selected folder; R2 (manifest-based) doesn't.
        if (provider.supportsBrowsing && !this.currentFolder) {
            content.innerHTML = `<div class="empty-state"><p>Valitse kansio yllä olevalla painikkeella</p></div>`;
            return;
        }

        if (!provider.isConfigured()) {
            content.innerHTML = `
                <div class="empty-state" style="padding: 40px;">
                    <p>${provider.displayName} ei ole konfiguroitu</p>
                    <button id="open-source-settings" class="primary-btn" style="margin-top: 12px;">Avaa asetukset</button>
                </div>`;
            document.getElementById('open-source-settings')?.addEventListener('click', () => this.openSettings());
            return;
        }

        content.innerHTML = '<div class="picker-loading"><div class="loader"></div><p>Ladataan kirjastoa...</p></div>';

        try {
            const folderId = provider.supportsBrowsing ? this.currentFolder?.id : null;
            this.library = await provider.getLibraryStructure(folderId);
            this.files = this._deriveFlatFiles(this.library);
            this.renderLibrary();
        } catch (error) {
            console.error('Error loading library:', error);
            content.innerHTML = `
                <div class="empty-state">
                    <p>Virhe kirjaston lataamisessa: ${error.message || error}</p>
                </div>
            `;
        }
    },

    /**
     * Build a flat file list from a normalised library — replaces the
     * old Drive.getOrganizedFiles call so all providers can produce it
     * from a single fetch.
     */
    _deriveFlatFiles(library) {
        if (!library) return { folders: [], ebooks: [], audio: [], pdfs: [], epubs: [], archives: [] };
        const provider = Providers.active();
        const folders = library.folders || [];
        const ebooks = [
            ...(library.standaloneFiles?.ebooks || []),
            ...(library.books || []).flatMap(b => b.ebooks || []),
        ];
        const audio = [
            ...(library.standaloneFiles?.audio || []),
            ...(library.books || []).flatMap(b => b.audioFiles || []),
        ];
        return {
            folders,
            ebooks,
            audio,
            pdfs: ebooks.filter(i => provider?.isPDF?.(i)),
            epubs: ebooks.filter(i => provider?.isEPUB?.(i)),
            archives: [],
        };
    },

    /**
     * Refresh library
     */
    refreshLibrary() {
        if (this.currentFolder) {
            this.loadLibrary();
            this.showToast('Kirjasto päivitetty', 'success');
        }
    },

    /**
     * Render library content
     */
    renderLibrary() {
        const content = document.getElementById('library-content');

        const hasBooks = this.library?.books?.length > 0;
        const hasStandaloneEbooks = this.library?.standaloneFiles?.ebooks?.length > 0;
        const hasStandaloneAudio = this.library?.standaloneFiles?.audio?.length > 0;
        const hasFolders = this.files?.folders?.length > 0;

        if (!hasBooks && !hasStandaloneEbooks && !hasStandaloneAudio && !hasFolders) {
            content.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 100 100" class="empty-icon">
                        <rect x="20" y="30" width="60" height="50" rx="5" fill="#4a90d9" opacity="0.3"/>
                        <path d="M30 45 L70 45" stroke="#4a90d9" stroke-width="3"/>
                        <path d="M30 55 L60 55" stroke="#4a90d9" stroke-width="3"/>
                    </svg>
                    <p>Ei kirjoja tai äänitiedostoja tässä kansiossa</p>
                </div>
            `;
            return;
        }

        let html = '';

        // Show continue reading if available
        const lastRead = this.getLastReadBook();
        if (lastRead) {
            html += this.renderContinueReading(lastRead);
        }

        // Render books (multi-part or from subfolders)
        if (hasBooks) {
            html += '<div class="library-section"><h3>Kirjat</h3><div class="book-grid">';
            this.library.books.forEach(book => {
                html += this.renderBookCard(book);
            });
            html += '</div></div>';
        }

        // Render standalone ebooks
        if (hasStandaloneEbooks) {
            html += '<div class="library-section"><h3>Yksittäiset kirjat</h3><div class="file-list">';
            this.library.standaloneFiles.ebooks.forEach(file => {
                const progress = this._getItemProgress(file);
                const type = Drive.isEPUB(file) ? 'epub' : 'pdf';
                html += this.renderFileItem(file, type, progress);
            });
            html += '</div></div>';
        }

        // Render standalone audio
        if (hasStandaloneAudio) {
            html += '<div class="library-section"><h3>Yksittäiset äänitiedostot</h3><div class="file-list">';
            this.library.standaloneFiles.audio.forEach(file => {
                const progress = this._getItemProgress(file);
                html += this.renderFileItem(file, 'audio', progress);
            });
            html += '</div></div>';
        }

        // Render subfolders that are not books
        if (hasFolders) {
            const nonBookFolders = this.files.folders.filter(f =>
                !this.library.books.some(b => b.id === f.id)
            );
            if (nonBookFolders.length > 0) {
                html += '<div class="library-section"><h3>Kansiot</h3><div class="file-list">';
                nonBookFolders.forEach(folder => {
                    html += `
                        <div class="file-item subfolder" data-id="${folder.id}" data-name="${folder.name}">
                            <div class="file-icon folder">
                                <svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>
                            </div>
                            <div class="file-details">
                                <div class="file-name">${folder.name}</div>
                                <div class="file-meta">Kansio</div>
                            </div>
                        </div>
                    `;
                });
                html += '</div></div>';
            }
        }

        content.innerHTML = html;

        // Add click handlers
        this.setupLibraryClickHandlers(content);
    },

    /**
     * Render continue reading card
     */
    renderContinueReading(lastRead) {
        return `
            <div class="continue-reading" data-book-id="${lastRead.id}" data-type="${lastRead.type}">
                <h3>Jatka lukemista</h3>
                <div class="book-name">${lastRead.name}</div>
                <div class="book-chapter">${lastRead.progressText}</div>
                <button class="continue-btn">
                    <svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    Jatka
                </button>
            </div>
        `;
    },

    /**
     * Get last read book info — scoped to the active source so a switch
     * doesn't surface a "continue reading" card pointing at the other
     * library.
     */
    getLastReadBook() {
        const allProgress = Storage.getAllBookProgress();
        if (!allProgress || Object.keys(allProgress).length === 0) return null;

        const activeSource = Providers.activeId();
        let lastRead = null;
        let lastTime = 0;

        for (const [progressKey, progress] of Object.entries(allProgress)) {
            const parsed = Storage.parseProgressKey(progressKey);
            if (!parsed) continue;
            if (parsed.sourceId !== activeSource) continue;
            if (progress.lastRead && progress.lastRead > lastTime) {
                lastTime = progress.lastRead;
                lastRead = { progressKey, itemKey: parsed.itemKey, ...progress };
            }
        }

        if (!lastRead || lastRead.percentage === 100) return null;

        const provider = Providers.active();

        const findItem = (key) => {
            // Search audio first (more common entry point), then ebooks,
            // then book-level entries (for R2 HLS where progressKey == bookId).
            const all = [
                ...(this.files?.audio || []),
                ...(this.files?.ebooks || []),
            ];
            const direct = all.find(f => f.key === key || f.id === key);
            if (direct) {
                let type = 'audio';
                if (provider?.isPDF?.(direct)) type = 'pdf';
                else if (provider?.isEPUB?.(direct)) type = 'epub';
                return { item: direct, type };
            }
            // Try matching by book progressKey (R2 HLS books)
            const book = (this.library?.books || []).find(b => b.id === key || b.progressKey === `${activeSource}:${key}`);
            if (book) {
                const first = (book.audioFiles?.[0]) || (book.ebooks?.[0]);
                if (first) {
                    const type = first.isPlaylist ? 'audio' : (provider?.isPDF?.(first) ? 'pdf' : provider?.isEPUB?.(first) ? 'epub' : 'audio');
                    return { item: first, type, book };
                }
            }
            return null;
        };

        const hit = findItem(lastRead.itemKey);
        if (!hit) return null;

        const displayName = (hit.book?.name || hit.item.name || '').replace(/\.[^/.]+$/, '');
        return {
            id: hit.item.key || hit.item.id,
            item: hit.item,
            book: hit.book || null,
            name: displayName,
            type: hit.type,
            progressText: `${lastRead.percentage}% valmis`,
        };
    },

    /**
     * Render a book card
     */
    renderBookCard(book) {
        // Calculate overall progress
        const progress = this.calculateBookProgress(book);
        const typeIcon = book.primaryType === 'audio'
            ? '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1z"/></svg>';

        const partsText = book.isMultiPart
            ? `${book.ebookCount + book.audioCount} osaa`
            : '';

        // Prefer a real cover image (R2 books expose `cover` as a full URL
        // built from the manifest entry); fall back to the format SVG.
        const coverArt = book.cover
            ? `<img src="${book.cover}" alt="" loading="lazy" decoding="async">`
            : typeIcon;

        return `
            <div class="book-card" data-book-id="${book.id}" data-book-type="${book.primaryType}">
                <div class="book-cover">
                    ${coverArt}
                    ${book.primaryType === 'both' ? '<span class="book-type-badge">Kirja + Audio</span>' : ''}
                    ${partsText ? `<span class="parts-indicator">${partsText}</span>` : ''}
                    <div class="book-progress">
                        <div class="book-progress-bar" style="width: ${progress}%"></div>
                    </div>
                </div>
                <div class="book-info">
                    <div class="book-title">${book.name}</div>
                    <div class="book-meta">
                        ${book.primaryType === 'ebook' ? 'E-kirja' : book.primaryType === 'audio' ? 'Äänikirja' : 'E-kirja & Ääni'}
                    </div>
                </div>
            </div>
        `;
    },

    /**
     * Calculate overall progress for a book.
     * - Book-level progressKey (R2 HLS): one entry covers the whole book.
     * - Multi-part Drive books: average per-file percentages.
     */
    calculateBookProgress(book) {
        if (book.progressKey) {
            const p = Storage.getBookProgress(book.progressKey);
            if (p) return p.percentage || 0;
        }

        let totalProgress = 0;
        let partCount = 0;
        const checkProgress = (files) => {
            files.forEach(file => {
                const key = file.progressKey || `${file.sourceId || 'drive'}:${file.key || file.id}`;
                const progress = Storage.getBookProgress(key);
                if (progress) totalProgress += progress.percentage || 0;
                partCount++;
            });
        };
        if (book.ebooks) checkProgress(book.ebooks);
        if (book.audioFiles) checkProgress(book.audioFiles);
        return partCount > 0 ? Math.round(totalProgress / partCount) : 0;
    },

    /**
     * Render a file item
     */
    renderFileItem(file, type, progress) {
        const progressPercent = progress?.percentage || 0;
        const progressText = progress ? `${progressPercent}% luettu` : '';

        const icons = {
            pdf: '<svg viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>',
            epub: '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>',
            audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>'
        };

        const icon = icons[type] || icons.pdf;

        return `
            <div class="file-item" data-id="${file.id}" data-name="${file.name}" data-type="${type}">
                <div class="file-icon ${type}">
                    ${icon}
                </div>
                <div class="file-details">
                    <div class="file-name">${file.name}</div>
                    <div class="file-meta">${progressText}</div>
                </div>
                ${progressPercent > 0 ? `
                    <div style="width: 60px; height: 4px; background: var(--border-color); border-radius: 2px;">
                        <div style="width: ${progressPercent}%; height: 100%; background: var(--accent); border-radius: 2px;"></div>
                    </div>
                ` : ''}
            </div>
        `;
    },

    /**
     * Setup click handlers for library items
     */
    setupLibraryClickHandlers(content) {
        // Continue reading — search by item key OR book id (HLS books).
        const continueCard = content.querySelector('.continue-reading');
        if (continueCard) {
            continueCard.addEventListener('click', () => {
                const key = continueCard.dataset.bookId;
                const type = continueCard.dataset.type;
                const allFiles = [...(this.files?.ebooks || []), ...(this.files?.audio || [])];
                let item = allFiles.find(f => f.key === key || f.id === key);
                if (!item) {
                    const book = (this.library?.books || []).find(b => b.id === key);
                    if (book) {
                        this.openBook(book);
                        return;
                    }
                }
                if (item) this.openItem(item, type);
            });
        }

        // Book cards
        content.querySelectorAll('.book-card').forEach(card => {
            card.addEventListener('click', () => {
                const bookId = card.dataset.bookId;
                const book = this.library.books.find(b => b.id === bookId);
                if (book) {
                    this.openBook(book);
                }
            });
        });

        // File items
        content.querySelectorAll('.file-item:not(.subfolder)').forEach(item => {
            item.addEventListener('click', () => {
                this.openFile(item.dataset.id, item.dataset.name, item.dataset.type);
            });
        });

        // Subfolders
        content.querySelectorAll('.file-item.subfolder').forEach(item => {
            item.addEventListener('click', () => {
                this.currentFolder = { id: item.dataset.id, name: item.dataset.name };
                Storage.setSelectedFolder(this.currentFolder);
                document.getElementById('folder-name').textContent = item.dataset.name;
                this.loadLibrary();
            });
        });
    },

    /**
     * Open a multi-part book
     */
    async openBook(book) {
        this.currentBook = book;

        let startIndex = 0;
        const startType = book.primaryType === 'audio' ? 'audio' : 'ebook';

        const files = startType === 'audio' ? book.audioFiles : book.ebooks;
        for (let i = 0; i < files.length; i++) {
            const progress = this._getItemProgress(files[i]);
            if (progress && progress.percentage < 100) {
                startIndex = i;
                break;
            }
        }

        this.currentPartIndex = startIndex;

        const file = files[startIndex];
        const type = startType === 'audio' ? 'audio' : (Drive.isEPUB(file) ? 'epub' : 'pdf');

        await this.openItem(file, type);

        if (book.isMultiPart) {
            this.showPartsButton(startIndex + 1, files.length);
        }
    },

    /**
     * Open a file. Accepts a normalised item (preferred) OR a bare Drive
     * fileId (legacy callers from DOM data-id attributes). When given an
     * id, we resolve it against the current library so we can recover the
     * full item (and therefore the source provider).
     */
    async openFile(fileIdOrItem, fileName, type) {
        let item;
        if (fileIdOrItem && typeof fileIdOrItem === 'object') {
            item = fileIdOrItem;
        } else {
            // Legacy string-id path
            const all = [
                ...(this.files?.ebooks || []),
                ...(this.files?.audio || []),
                ...(this.currentBook?.audioFiles || []),
                ...(this.currentBook?.ebooks || []),
            ];
            item = all.find(f => f.key === fileIdOrItem || f.id === fileIdOrItem)
                || { sourceId: Providers.activeId() || 'drive', key: fileIdOrItem, name: fileName, id: fileIdOrItem };
        }
        return this.openItem(item, type);
    },

    /**
     * Open an item using the right provider/viewer combo.
     * The PDF/EPUB viewers are Drive-only (their internal API uses Drive
     * fileIds); for other sources we toast and bail.
     */
    async openItem(item, typeHint) {
        if (!item) return;

        const provider = Providers.get(item.sourceId);
        if (!provider) {
            this.showToast('Tuntematon lähde', 'error');
            return;
        }

        this.showScreen('reader');
        document.getElementById('pdf-viewer-container').classList.add('hidden');
        document.getElementById('epub-viewer-container').classList.add('hidden');
        document.getElementById('audio-player-container').classList.add('hidden');

        const isAudio = typeHint === 'audio' || provider.isAudio(item);
        const isPDF = !isAudio && (typeHint === 'pdf' || provider.isPDF(item));
        const isEPUB = !isAudio && (typeHint === 'epub' || provider.isEPUB(item));

        if (isAudio) {
            this.currentMode = 'listen';
            document.getElementById('audio-player-container').classList.remove('hidden');
            const audioFiles = this.currentBook?.audioFiles?.length
                ? this.currentBook.audioFiles
                : (this.files?.audio || [item]);
            AudioPlayer.setPlaylist(audioFiles);
            await AudioPlayer.loadTrack(item);
            // Single-file HLS book that ships chapter metadata? Reveal the
            // "Sisällysluettelo" button so the user can jump between
            // chapters even though the book isn't multi-file.
            if (this.currentBook?.chapters?.length && !this.currentBook.isMultiPart) {
                this.showChapterListButton(this.currentBook.chapters.length);
            }
        } else if (isPDF) {
            if (item.sourceId !== 'drive') {
                this.showToast('PDF on tällä hetkellä tuettu vain Google Drivestä', 'info');
                return;
            }
            this.currentMode = 'read';
            document.getElementById('pdf-viewer-container').classList.remove('hidden');
            await PDFViewer.loadFromDrive(item.key, item.name);
        } else if (isEPUB) {
            if (item.sourceId !== 'drive') {
                this.showToast('EPUB on tällä hetkellä tuettu vain Google Drivestä', 'info');
                return;
            }
            this.currentMode = 'read';
            document.getElementById('epub-viewer-container').classList.remove('hidden');
            await EPUBViewer.loadFromDrive(item.key, item.name);
        }

        this.updateModeIcon();
    },

    /**
     * Show parts button
     */
    showPartsButton(current, total) {
        const btn = document.getElementById('show-parts-btn');
        document.getElementById('parts-info').textContent = `Osa ${current}/${total}`;
        btn.classList.remove('hidden');
    },

    /**
     * Show the parts button as a "Sisällysluettelo" entry point — used
     * for HLS audiobooks that ship a `chapters` array but only have one
     * underlying audio file (so the file-based parts label is wrong).
     */
    showChapterListButton(count) {
        const btn = document.getElementById('show-parts-btn');
        document.getElementById('parts-info').textContent = `${count} kappaletta`;
        btn.classList.remove('hidden');
    },

    /**
     * Hide parts button
     */
    hidePartsButton() {
        document.getElementById('show-parts-btn').classList.add('hidden');
    },

    /**
     * Show chapter/parts list
     */
    showChapterList() {
        if (!this.currentBook) return;

        const list = document.getElementById('chapter-list');
        const chapters = document.getElementById('chapters');

        // HLS audiobooks with a `chapters` manifest array: render those
        // (each entry seeks to chapter.start) instead of the playlist
        // file. The non-HLS code path below handles multi-file books.
        if (this.currentBook.chapters?.length) {
            const ch = this.currentBook.chapters;
            const currentTime = AudioPlayer.audio?.currentTime || 0;
            let activeIdx = 0;
            for (let i = 0; i < ch.length; i++) {
                if (ch[i].start <= currentTime) activeIdx = i;
                else break;
            }
            let chapterHtml = '';
            ch.forEach((c, i) => {
                chapterHtml += `
                    <li class="${i === activeIdx ? 'active' : ''}" data-chapter-index="${i}">
                        <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                        <span>${c.title}</span>
                        <span class="chapter-progress">${AudioPlayer.formatTime(c.start)}</span>
                    </li>
                `;
            });
            chapters.innerHTML = chapterHtml;
            chapters.querySelectorAll('li[data-chapter-index]').forEach(item => {
                item.addEventListener('click', () => {
                    const idx = Number(item.dataset.chapterIndex);
                    AudioPlayer.seekToChapter(ch[idx]);
                    this.hideChapterList();
                });
            });
            // Scroll active row into view (chapter lists can be long)
            const active = chapters.querySelector('li.active');
            if (active) active.scrollIntoView({ block: 'center' });
            list.classList.remove('hidden');
            return;
        }

        let html = '';

        // Add ebook parts
        if (this.currentBook.ebooks?.length > 0) {
            this.currentBook.ebooks.forEach((file, index) => {
                const progress = this._getItemProgress(file);
                const progressText = progress ? `${progress.percentage}%` : '';
                const isActive = PDFViewer.currentFileId === file.id || EPUBViewer.currentFileId === file.id;

                html += `
                    <li class="${isActive ? 'active' : ''}" data-file-id="${file.id}" data-file-name="${file.name}" data-type="${Drive.isEPUB(file) ? 'epub' : 'pdf'}">
                        <svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2z"/></svg>
                        <span>${file.name.replace(/\.[^/.]+$/, '')}</span>
                        <span class="chapter-progress">${progressText}</span>
                    </li>
                `;
            });
        }

        // Add audio parts
        if (this.currentBook.audioFiles?.length > 0) {
            if (this.currentBook.ebooks?.length > 0) {
                html += '<li style="padding: 8px 16px; color: var(--text-secondary); font-size: 0.8rem; border: none;">ÄÄNITIEDOSTOT</li>';
            }
            this.currentBook.audioFiles.forEach((file, index) => {
                const progress = this._getItemProgress(file);
                const progressText = progress ? `${progress.percentage}%` : '';
                const isActive = AudioPlayer.currentFileId === file.id;

                html += `
                    <li class="${isActive ? 'active' : ''}" data-file-id="${file.id}" data-file-name="${file.name}" data-type="audio">
                        <svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>
                        <span>${file.name.replace(/\.[^/.]+$/, '')}</span>
                        <span class="chapter-progress">${progressText}</span>
                    </li>
                `;
            });
        }

        chapters.innerHTML = html;

        // Add click handlers
        chapters.querySelectorAll('li[data-file-id]').forEach(item => {
            item.addEventListener('click', () => {
                this.openFile(item.dataset.fileId, item.dataset.fileName, item.dataset.type);
                this.hideChapterList();

                // Update parts button
                const allFiles = [...(this.currentBook.ebooks || []), ...(this.currentBook.audioFiles || [])];
                const index = allFiles.findIndex(f => f.id === item.dataset.fileId);
                if (index !== -1) {
                    this.showPartsButton(index + 1, allFiles.length);
                }
            });
        });

        list.classList.remove('hidden');
    },

    /**
     * Hide chapter list
     */
    hideChapterList() {
        document.getElementById('chapter-list').classList.add('hidden');
    },

    /**
     * Toggle between read and listen mode
     */
    toggleMode() {
        const hasAudio = this.currentBook?.audioFiles?.length > 0 || this.files?.audio?.length > 0;
        const hasEbooks = this.currentBook?.ebooks?.length > 0 || this.files?.ebooks?.length > 0;

        if (this.currentMode === 'read' && hasAudio) {
            // Switch to audio
            this.currentMode = 'listen';
            document.getElementById('pdf-viewer-container').classList.add('hidden');
            document.getElementById('epub-viewer-container').classList.add('hidden');
            document.getElementById('audio-player-container').classList.remove('hidden');

            // Load first audio if not already playing
            if (!AudioPlayer.currentFileId) {
                const audioFiles = this.currentBook?.audioFiles || this.files?.audio || [];
                if (audioFiles.length > 0) {
                    const firstAudio = audioFiles[0];
                    AudioPlayer.setPlaylist(audioFiles);
                    AudioPlayer.loadTrack(firstAudio.id, firstAudio.name);
                }
            }
        } else if (this.currentMode === 'listen' && hasEbooks) {
            // Switch to ebook
            this.currentMode = 'read';
            document.getElementById('audio-player-container').classList.add('hidden');

            // Load first ebook if not already loaded
            const ebooks = this.currentBook?.ebooks || this.files?.ebooks || [];
            if (ebooks.length > 0) {
                const firstBook = ebooks[0];
                const type = Drive.isEPUB(firstBook) ? 'epub' : 'pdf';

                if (type === 'epub') {
                    document.getElementById('pdf-viewer-container').classList.add('hidden');
                    document.getElementById('epub-viewer-container').classList.remove('hidden');
                    if (!EPUBViewer.currentFileId) {
                        EPUBViewer.loadFromDrive(firstBook.id, firstBook.name);
                    }
                } else {
                    document.getElementById('epub-viewer-container').classList.add('hidden');
                    document.getElementById('pdf-viewer-container').classList.remove('hidden');
                    if (!PDFViewer.currentFileId) {
                        PDFViewer.loadFromDrive(firstBook.id, firstBook.name);
                    }
                }
            }
        }

        this.updateModeIcon();
    },

    /**
     * Update mode toggle icon and visibility
     */
    updateModeIcon() {
        const toggleBtn = document.getElementById('toggle-mode');
        const readIcon = document.querySelector('.mode-icon-read');
        const listenIcon = document.querySelector('.mode-icon-listen');

        // Check if both formats exist
        const hasAudio = this.currentBook?.audioFiles?.length > 0 || this.files?.audio?.length > 0;
        const hasEbooks = this.currentBook?.ebooks?.length > 0 || this.files?.ebooks?.length > 0;
        const hasBothFormats = hasAudio && hasEbooks;

        // Show/hide the toggle button based on available formats
        if (hasBothFormats) {
            toggleBtn.classList.remove('hidden');
            toggleBtn.style.opacity = '1';
            toggleBtn.style.pointerEvents = 'auto';
        } else {
            toggleBtn.classList.add('hidden');
        }

        // Update the icon based on current mode (shows what you'll switch TO)
        if (this.currentMode === 'read') {
            // Currently reading, show headphones icon (to switch to listen)
            readIcon.classList.add('hidden');
            listenIcon.classList.remove('hidden');
        } else {
            // Currently listening, show book icon (to switch to read)
            readIcon.classList.remove('hidden');
            listenIcon.classList.add('hidden');
        }
    },

    /**
     * Open settings modal
     */
    openSettings() {
        // Pre-fill R2 inputs from current config
        const r2Input = document.getElementById('r2-base-url');
        const r2Status = document.getElementById('r2-config-status');
        const cfg = R2Provider.getConfig();
        if (r2Input) r2Input.value = cfg?.baseUrl || '';
        if (r2Status) {
            if (!cfg) {
                r2Status.textContent = 'Ei konfiguroitu.';
            } else if (cfg._isDefault) {
                r2Status.textContent = `Käytössä default-URL (config.js): ${cfg.baseUrl}`;
            } else {
                r2Status.textContent = `Custom URL: ${cfg.baseUrl}`;
            }
        }

        this.openModal('settings-modal');
    },

    /**
     * Open a modal
     */
    openModal(modalId) {
        document.getElementById(modalId).classList.remove('hidden');
    },

    /**
     * Close a modal
     */
    closeModal(modalId) {
        document.getElementById(modalId).classList.add('hidden');
    },

    /**
     * Apply theme
     */
    applyTheme() {
        const settings = Storage.getSettings();
        document.body.setAttribute('data-theme', settings.theme);

        // Update active theme button
        document.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === settings.theme);
        });
    },

    /**
     * Set theme
     */
    setTheme(theme) {
        Storage.setSettings({ theme });
        this.applyTheme();
        // Update EPUB viewer theme if active
        if (EPUBViewer.rendition) {
            EPUBViewer.applyTheme();
        }
    },

    /**
     * Show loading overlay
     */
    showLoading(show, text = 'Ladataan...') {
        const loading = document.getElementById('loading-screen');
        const textEl = document.getElementById('loading-text');

        if (show) {
            loading.classList.remove('hidden');
            if (textEl) textEl.textContent = text;
            this.updateLoadingProgress(0, 0);
        } else {
            loading.classList.add('hidden');
        }
    },

    /**
     * Update loading progress
     */
    updateLoadingProgress(loaded, total) {
        const barEl = document.getElementById('loading-bar');
        const percentEl = document.getElementById('loading-percent');

        if (!barEl || !percentEl) return;

        if (total > 0) {
            const percent = Math.round((loaded / total) * 100);
            barEl.style.width = percent + '%';
            const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
            const totalMB = (total / (1024 * 1024)).toFixed(1);
            percentEl.textContent = `${percent}% (${loadedMB} / ${totalMB} MB)`;
        } else if (loaded > 0) {
            barEl.style.width = '50%';
            const loadedMB = (loaded / (1024 * 1024)).toFixed(1);
            percentEl.textContent = `${loadedMB} MB`;
        } else {
            barEl.style.width = '0%';
            percentEl.textContent = '0%';
        }
    },

    /**
     * Show toast notification
     */
    showToast(message, type = 'info') {
        const container = document.getElementById('toast-container');
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.textContent = message;
        container.appendChild(toast);

        // Remove after 3 seconds
        setTimeout(() => {
            toast.style.opacity = '0';
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }
};

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});
