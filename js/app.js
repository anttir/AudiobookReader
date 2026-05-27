/**
 * Main Application - AudioBook Reader
 */

/**
 * Library sort options shown in the dropdown above the book lists.
 * `value` is persisted in Storage.getSettings().librarySort; `label` is the
 * Finnish text rendered in the <option>.
 */
const SORT_OPTIONS = [
    { value: 'recent-desc', label: 'Viimeksi kuunneltu — uusin ensin' },
    { value: 'recent-asc',  label: 'Viimeksi kuunneltu — vanhin ensin' },
    { value: 'alpha-asc',   label: 'Aakkosissa — A–Ö' },
    { value: 'alpha-desc',  label: 'Aakkosissa — Ö–A' },
    { value: 'added-desc',  label: 'Lisäysjärjestys — uusin ensin' },
    { value: 'added-asc',   label: 'Lisäysjärjestys — vanhin ensin' },
];
const DEFAULT_LIBRARY_SORT = 'recent-desc';

/**
 * Library view modes. 'icons' shows a grid of cover thumbnails (Windows
 * "Large icons"); 'details' shows a compact list with a small thumbnail
 * per row (Windows "Details"). Persisted in Storage settings as
 * `libraryView`.
 */
const LIBRARY_VIEWS = ['icons', 'details'];
const DEFAULT_LIBRARY_VIEW = 'icons';

const App = {
    currentScreen: 'login',
    currentFolder: null,
    library: null,
    files: null,
    currentBook: null,      // Current book being read (can be multi-part)
    currentPartIndex: 0,    // Current part index in multi-part book
    currentMode: 'read',    // 'read' or 'listen'

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
     * Open Google Picker so the user grants the app access to a folder.
     * Required by the drive.file OAuth scope — we can't list root or
     * arbitrary folders, only ones the user has picked here.
     */
    async openFolderPicker() {
        try {
            const folder = await Drive.pickFolder();
            if (!folder) return;
            this.currentFolder = folder;
            Storage.setSelectedFolder(folder);
            document.getElementById('folder-name').textContent = folder.name;
            const pathEl = document.getElementById('current-folder-path');
            if (pathEl) pathEl.textContent = folder.name;
            await this.loadLibrary();
        } catch (error) {
            console.error('Picker error:', error);
            this.showToast('Kansion valinta epäonnistui: ' + (error.message || error), 'error');
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
            // drive.file: a previously-saved folder is unreachable until
            // the user re-picks it via Google Picker. Surface that
            // explicitly instead of a generic error.
            const msg = String(error?.message || error);
            const isAccessIssue = provider.id === 'drive' && /\b(403|404)\b/.test(msg);
            if (isAccessIssue && this.currentFolder) {
                this.currentFolder = null;
                Storage.setSelectedFolder(null);
                document.getElementById('folder-name').textContent = 'Valitse kansio Google Drivestä';
                const pathEl = document.getElementById('current-folder-path');
                if (pathEl) pathEl.textContent = 'Ei valittu';
                content.innerHTML = `
                    <div class="empty-state" style="padding: 40px;">
                        <p>Kansiota ei löydy tai siihen ei ole pääsyä. Valitse kansio uudelleen Pickeristä.</p>
                        <button id="repick-folder-btn" class="primary-btn" style="margin-top: 12px;">Valitse kansio</button>
                    </div>`;
                document.getElementById('repick-folder-btn')
                    ?.addEventListener('click', () => this.openFolderPicker());
                return;
            }
            content.innerHTML = `
                <div class="empty-state">
                    <p>Virhe kirjaston lataamisessa: ${msg}</p>
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
     * Render library content.
     *
     * Two view modes share the same sectioning and data, but differ in
     * the inner card markup: Icons mode renders book-card thumbnails in
     * a grid; Details mode renders compact list rows with a small cover
     * thumbnail. The view is persisted via Storage settings.
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

        const sortValue = this._getLibrarySort();
        const view = this._getLibraryView();
        const hasSortable = hasBooks || hasStandaloneEbooks || hasStandaloneAudio;
        const gridClass = view === 'icons' ? 'book-grid' : 'file-list';
        let html = '';

        // Toolbar (sort + view toggle) — only when there's something sortable.
        // The "Jatka lukemista" card and "Kansiot" section are not affected
        // by sort or view, but the view toggle still applies to whichever
        // sections render.
        html += this._renderLibraryToolbar({ sortValue, view, showSort: hasSortable });

        // Show continue reading if available
        const lastRead = this.getLastReadBook();
        if (lastRead) {
            html += this.renderContinueReading(lastRead);
        }

        // Books (multi-part or from subfolders)
        if (hasBooks) {
            const books = this._sortLibraryItems(this.library.books, sortValue);
            html += `<div class="library-section"><h3>Kirjat</h3><div class="${gridClass}">`;
            books.forEach(book => {
                html += view === 'icons' ? this.renderBookCard(book) : this.renderBookRow(book);
            });
            html += '</div></div>';
        }

        // Standalone ebooks
        if (hasStandaloneEbooks) {
            const ebooks = this._sortLibraryItems(this.library.standaloneFiles.ebooks, sortValue);
            html += `<div class="library-section"><h3>Yksittäiset kirjat</h3><div class="${gridClass}">`;
            ebooks.forEach(file => {
                const progress = this._getItemProgress(file);
                const type = (Providers.active()?.isEPUB?.(file)) ? 'epub' : 'pdf';
                html += view === 'icons'
                    ? this.renderFileCard(file, type, progress)
                    : this.renderFileItem(file, type, progress);
            });
            html += '</div></div>';
        }

        // Standalone audio
        if (hasStandaloneAudio) {
            const audio = this._sortLibraryItems(this.library.standaloneFiles.audio, sortValue);
            html += `<div class="library-section"><h3>Yksittäiset äänitiedostot</h3><div class="${gridClass}">`;
            audio.forEach(file => {
                const progress = this._getItemProgress(file);
                html += view === 'icons'
                    ? this.renderFileCard(file, 'audio', progress)
                    : this.renderFileItem(file, 'audio', progress);
            });
            html += '</div></div>';
        }

        // Subfolders that are not books
        if (hasFolders) {
            const nonBookFolders = this.files.folders.filter(f =>
                !this.library.books.some(b => b.id === f.id)
            );
            if (nonBookFolders.length > 0) {
                html += `<div class="library-section"><h3>Kansiot</h3><div class="${gridClass}">`;
                nonBookFolders.forEach(folder => {
                    html += view === 'icons'
                        ? this.renderFolderCard(folder)
                        : this.renderFolderRow(folder);
                });
                html += '</div></div>';
            }
        }

        content.innerHTML = html;

        // Toolbar handlers — wire before library handlers so clicks on
        // the controls don't bubble into anything below.
        const sortSelect = content.querySelector('#library-sort-select');
        if (sortSelect) {
            sortSelect.addEventListener('change', (e) => {
                Storage.setSettings({ librarySort: e.target.value });
                this.renderLibrary();
            });
        }
        content.querySelectorAll('.view-toggle-btn').forEach(btn => {
            btn.addEventListener('click', () => this._setLibraryView(btn.dataset.view));
        });

        // Item click handlers + lazy cover loader.
        this.setupLibraryClickHandlers(content);
        this._attachCoverLoader(content);
    },

    /**
     * Read the persisted library sort key from Storage, falling back to the
     * default. Unknown values (e.g. a future option that's been retired) also
     * fall back to the default so the dropdown never renders an empty choice.
     */
    _getLibrarySort() {
        const saved = Storage.getSettings().librarySort;
        return SORT_OPTIONS.some(o => o.value === saved) ? saved : DEFAULT_LIBRARY_SORT;
    },

    /**
     * Build the library toolbar: sort dropdown on the left, view toggle
     * (Icons / Details) on the right. When there's nothing sortable we
     * still render the view toggle on its own so the user can switch
     * modes from any non-empty library state.
     */
    _renderLibraryToolbar({ sortValue, view, showSort }) {
        const sortPart = showSort ? (() => {
            const options = SORT_OPTIONS.map(opt => {
                const selected = opt.value === sortValue ? ' selected' : '';
                return `<option value="${opt.value}"${selected}>${opt.label}</option>`;
            }).join('');
            return `
                <label for="library-sort-select" class="library-toolbar-label">Järjestys:</label>
                <select id="library-sort-select" class="library-sort-select">${options}</select>
            `;
        })() : '';

        const toggle = `
            <div class="view-toggle" role="group" aria-label="Näkymä">
                <button type="button" class="view-toggle-btn ${view === 'icons' ? 'active' : ''}" data-view="icons" title="Kuvakkeet">
                    <svg viewBox="0 0 24 24"><path d="M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z"/></svg>
                </button>
                <button type="button" class="view-toggle-btn ${view === 'details' ? 'active' : ''}" data-view="details" title="Lista">
                    <svg viewBox="0 0 24 24"><path d="M3 5h18v2H3zm0 6h18v2H3zm0 6h18v2H3z"/></svg>
                </button>
            </div>
        `;

        return `<div class="library-toolbar">${sortPart}<div class="library-toolbar-spacer"></div>${toggle}</div>`;
    },

    /** Read persisted view mode, falling back to default for unknown values. */
    _getLibraryView() {
        const v = Storage.getSettings().libraryView;
        return LIBRARY_VIEWS.includes(v) ? v : DEFAULT_LIBRARY_VIEW;
    },

    /** Set view mode and re-render. */
    _setLibraryView(view) {
        if (!LIBRARY_VIEWS.includes(view)) return;
        if (this._getLibraryView() === view) return;
        Storage.setSettings({ libraryView: view });
        this.renderLibrary();
    },

    /**
     * Resolve cover info for a library item.
     *   - R2 books / files expose `cover` as a public URL → kind 'image'
     *   - Drive EPUBs (standalone or first ebook of a multi-part book) →
     *     kind 'lazy' (cover loader will extract via partial-ZIP fetch)
     *   - Anything else → kind 'none' (caller shows SVG fallback)
     */
    _coverFor(item) {
        if (!item) return { kind: 'none' };
        if (typeof item.cover === 'string' && item.cover) {
            return { kind: 'image', src: item.cover };
        }

        // For multi-part books, prefer the first EPUB child.
        const isDriveEpub = (x) =>
            x && x.sourceId === 'drive' &&
            (x.mimeType === 'application/epub+zip' || /\.epub$/i.test(x.name || ''));

        let epub = null;
        if (isDriveEpub(item)) {
            epub = item;
        } else if (Array.isArray(item.ebooks)) {
            epub = item.ebooks.find(isDriveEpub) || null;
        }

        if (epub && epub.key && epub.size) {
            const stamp = epub.modifiedTime || '';
            return {
                kind: 'lazy',
                key: `drive:${epub.key}@${stamp}`,
                source: 'drive',
                id: epub.key,
                size: epub.size,
            };
        }
        return { kind: 'none' };
    },

    /**
     * Render the cover slot HTML — an <img> sized by the parent .book-cover
     * box. For 'lazy' covers the <img> starts with no src; the cover loader
     * fills it in once it intersects the viewport. CSS hides the SVG
     * fallback once the img has loaded (via the .cover-loaded class).
     */
    _renderCoverSlot(cover) {
        if (cover.kind === 'image') {
            return `<img class="cover-img cover-loaded" src="${cover.src}" alt="" loading="lazy" decoding="async">`;
        }
        if (cover.kind === 'lazy') {
            return `<img class="cover-img lazy-cover"
                         data-cover-key="${cover.key}"
                         data-cover-source="${cover.source}"
                         data-cover-id="${cover.id}"
                         data-cover-size="${cover.size}"
                         alt="" decoding="async">`;
        }
        return '';
    },

    /**
     * Sort an array of library items (books OR standalone files) by the
     * chosen sort key. Returns a new array — callers can safely splice the
     * result without mutating `this.library`.
     *
     * Items missing the sort key always sort to the END of the list,
     * regardless of direction (so empty rows don't surface first).
     */
    _sortLibraryItems(items, sortValue) {
        if (!Array.isArray(items) || items.length === 0) return [];
        const arr = items.slice();
        const sorter = this._comparatorFor(sortValue);
        arr.sort(sorter);
        return arr;
    },

    /** Build a comparator for the named sort. */
    _comparatorFor(sortValue) {
        switch (sortValue) {
            case 'alpha-asc':   return this._compareAlpha(true);
            case 'alpha-desc':  return this._compareAlpha(false);
            case 'recent-asc':  return this._compareNumericKey(item => this._lastReadKey(item), true);
            case 'recent-desc': return this._compareNumericKey(item => this._lastReadKey(item), false);
            case 'added-asc':   return this._compareNumericKey(item => this._addedKey(item), true);
            case 'added-desc':  return this._compareNumericKey(item => this._addedKey(item), false);
            default:            return this._compareNumericKey(item => this._lastReadKey(item), false);
        }
    },

    /** Alphabetical comparator using Finnish collation. */
    _compareAlpha(ascending) {
        const dir = ascending ? 1 : -1;
        return (a, b) => {
            const an = a?.name || '';
            const bn = b?.name || '';
            return an.localeCompare(bn, 'fi', { numeric: true, sensitivity: 'base' }) * dir;
        };
    },

    /**
     * Numeric comparator. `keyFn` returns the comparable number for an
     * item, or `undefined` when the item has no value for the chosen key.
     * Missing values always go to the END regardless of direction.
     */
    _compareNumericKey(keyFn, ascending) {
        const dir = ascending ? 1 : -1;
        return (a, b) => {
            const av = keyFn(a);
            const bv = keyFn(b);
            const aMissing = av === undefined || av === null || Number.isNaN(av);
            const bMissing = bv === undefined || bv === null || Number.isNaN(bv);
            if (aMissing && bMissing) {
                // Stable-ish tiebreaker on name so the missing tail isn't
                // randomly ordered between renders.
                return (a?.name || '').localeCompare(b?.name || '', 'fi', { numeric: true, sensitivity: 'base' });
            }
            if (aMissing) return 1;
            if (bMissing) return -1;
            if (av === bv) return 0;
            return av < bv ? -1 * dir : 1 * dir;
        };
    },

    /**
     * Last-read epoch ms for a library item.
     * - Books with a book-level progressKey (R2): direct lookup.
     * - Multi-part books (Drive folder/group): max lastRead across parts.
     * - Standalone files: their own progress.
     * Returns undefined when nothing has been read.
     */
    _lastReadKey(item) {
        if (!item) return undefined;

        // Book-level progressKey covers HLS/R2 + any future single-key book.
        if (item.progressKey) {
            const p = Storage.getBookProgress(item.progressKey);
            if (p?.lastRead) return p.lastRead;
        }

        // Multi-part book: scan its parts.
        const parts = [
            ...(item.ebooks || []),
            ...(item.audioFiles || []),
        ];
        if (parts.length > 0) {
            let max;
            for (const part of parts) {
                const p = this._getItemProgress(part);
                if (p?.lastRead && (max === undefined || p.lastRead > max)) {
                    max = p.lastRead;
                }
            }
            return max;
        }

        // Standalone file.
        const p = this._getItemProgress(item);
        return p?.lastRead;
    },

    /**
     * "Added-at" key for a library item.
     * - R2 books carry `_addedAt` (manifest index, lower = added earlier).
     * - Drive books/files carry `modifiedTime` (ISO string); we parse to
     *   epoch ms so it sorts on the same numeric axis as the R2 index
     *   would (lower = earlier). The two scales never mix in practice
     *   because each library belongs to a single provider.
     * Returns undefined when neither field is available.
     */
    _addedKey(item) {
        if (!item) return undefined;
        if (typeof item._addedAt === 'number') return item._addedAt;
        const mt = item.modifiedTime;
        if (typeof mt === 'string' && mt) {
            const t = Date.parse(mt);
            if (!Number.isNaN(t)) return t;
        }
        return undefined;
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
     * Render a book card (Icons view).
     */
    renderBookCard(book) {
        const progress = this.calculateBookProgress(book);
        const partsText = book.isMultiPart ? `${book.ebookCount + book.audioCount} osaa` : '';
        const cover = this._coverFor(book);
        const typeLabel = this._bookTypeLabel(book);

        return `
            <div class="book-card" data-book-id="${book.id}" data-book-type="${book.primaryType}">
                <div class="book-cover">
                    ${this._coverFallbackSvg(book.primaryType === 'audio' ? 'audio' : 'ebook')}
                    ${this._renderCoverSlot(cover)}
                    ${book.primaryType === 'both' ? '<span class="book-type-badge">Kirja + Audio</span>' : ''}
                    ${partsText ? `<span class="parts-indicator">${partsText}</span>` : ''}
                    <div class="book-progress">
                        <div class="book-progress-bar" style="width: ${progress}%"></div>
                    </div>
                </div>
                <div class="book-info">
                    <div class="book-title">${book.name}</div>
                    <div class="book-meta">${typeLabel}</div>
                </div>
            </div>
        `;
    },

    /**
     * Render a book as a compact row (Details view). Carries the same
     * data-book-id so the existing click handler picks it up.
     */
    renderBookRow(book) {
        const progress = this.calculateBookProgress(book);
        const partsText = book.isMultiPart ? `${book.ebookCount + book.audioCount} osaa · ` : '';
        const cover = this._coverFor(book);
        const typeLabel = this._bookTypeLabel(book);
        const progressText = progress > 0 ? `${progress}% luettu` : '';
        const meta = [partsText + typeLabel, progressText].filter(Boolean).join(' · ');

        return `
            <div class="book-card book-row" data-book-id="${book.id}" data-book-type="${book.primaryType}">
                <div class="row-cover">
                    ${this._coverFallbackSvg(book.primaryType === 'audio' ? 'audio' : 'ebook', 'small')}
                    ${this._renderCoverSlot(cover)}
                </div>
                <div class="file-details">
                    <div class="file-name">${book.name}</div>
                    <div class="file-meta">${meta}</div>
                </div>
                ${progress > 0 ? `
                    <div class="row-progress">
                        <div class="row-progress-bar" style="width: ${progress}%"></div>
                    </div>
                ` : ''}
            </div>
        `;
    },

    /** Human-readable type label for a book. */
    _bookTypeLabel(book) {
        if (book.primaryType === 'ebook') return 'E-kirja';
        if (book.primaryType === 'audio') return 'Äänikirja';
        return 'E-kirja & Ääni';
    },

    /**
     * SVG used as a fallback inside .book-cover / .row-cover when there's
     * no real cover. Variant 'small' is used by row thumbnails.
     */
    _coverFallbackSvg(kind, size = 'large') {
        const cls = `cover-fallback cover-fallback-${size} cover-fallback-${kind}`;
        if (kind === 'audio') {
            return `<svg class="${cls}" viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>`;
        }
        if (kind === 'pdf') {
            return `<svg class="${cls}" viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>`;
        }
        if (kind === 'folder') {
            return `<svg class="${cls}" viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
        }
        // ebook / default
        return `<svg class="${cls}" viewBox="0 0 24 24"><path d="M21 5c-1.11-.35-2.33-.5-3.5-.5-1.95 0-4.05.4-5.5 1.5-1.45-1.1-3.55-1.5-5.5-1.5S2.45 4.9 1 6v14.65c0 .25.25.5.5.5.1 0 .15-.05.25-.05C3.1 20.45 5.05 20 6.5 20c1.95 0 4.05.4 5.5 1.5 1.35-.85 3.8-1.5 5.5-1.5 1.65 0 3.35.3 4.75 1.05.1.05.15.05.25.05.25 0 .5-.25.5-.5V6c-.6-.45-1.25-.75-2-1z"/></svg>`;
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
     * Render a file row (Details view). EPUBs get a small cover thumbnail
     * when one is available (or extractable); PDFs and audio keep their
     * colored icon block.
     */
    renderFileItem(file, type, progress) {
        const progressPercent = progress?.percentage || 0;
        const progressText = progress ? `${progressPercent}% luettu` : '';

        const cover = type === 'epub' ? this._coverFor(file) : { kind: 'none' };
        const thumb = cover.kind !== 'none'
            ? `<div class="row-cover">
                   ${this._coverFallbackSvg('ebook', 'small')}
                   ${this._renderCoverSlot(cover)}
               </div>`
            : `<div class="file-icon ${type}">${this._iconForType(type)}</div>`;

        return `
            <div class="file-item" data-id="${file.id}" data-name="${file.name}" data-type="${type}">
                ${thumb}
                <div class="file-details">
                    <div class="file-name">${file.name}</div>
                    <div class="file-meta">${progressText}</div>
                </div>
                ${progressPercent > 0 ? `
                    <div class="row-progress">
                        <div class="row-progress-bar" style="width: ${progressPercent}%"></div>
                    </div>
                ` : ''}
            </div>
        `;
    },

    /**
     * Render a standalone file as a card (Icons view). EPUBs get the
     * cover slot; audio + PDF use a coloured fallback that fills the
     * book-cover box.
     */
    renderFileCard(file, type, progress) {
        const progressPercent = progress?.percentage || 0;
        const cover = type === 'epub' ? this._coverFor(file) : { kind: 'none' };
        const typeLabel = type === 'audio' ? 'Äänitiedosto' : type === 'epub' ? 'EPUB' : 'PDF';
        const fallbackKind = type === 'audio' ? 'audio' : type === 'pdf' ? 'pdf' : 'ebook';

        return `
            <div class="book-card file-card" data-id="${file.id}" data-name="${file.name}" data-type="${type}">
                <div class="book-cover book-cover-${fallbackKind}">
                    ${this._coverFallbackSvg(fallbackKind)}
                    ${this._renderCoverSlot(cover)}
                    <div class="book-progress">
                        <div class="book-progress-bar" style="width: ${progressPercent}%"></div>
                    </div>
                </div>
                <div class="book-info">
                    <div class="book-title">${file.name}</div>
                    <div class="book-meta">${typeLabel}${progressPercent > 0 ? ` · ${progressPercent}%` : ''}</div>
                </div>
            </div>
        `;
    },

    /** Folder rendered as a card (Icons view). */
    renderFolderCard(folder) {
        return `
            <div class="book-card subfolder folder-card" data-id="${folder.id}" data-name="${folder.name}">
                <div class="book-cover book-cover-folder">
                    ${this._coverFallbackSvg('folder')}
                </div>
                <div class="book-info">
                    <div class="book-title">${folder.name}</div>
                    <div class="book-meta">Kansio</div>
                </div>
            </div>
        `;
    },

    /** Folder rendered as a list row (Details view). */
    renderFolderRow(folder) {
        return `
            <div class="file-item subfolder" data-id="${folder.id}" data-name="${folder.name}">
                <div class="file-icon folder">
                    ${this._iconForType('folder')}
                </div>
                <div class="file-details">
                    <div class="file-name">${folder.name}</div>
                    <div class="file-meta">Kansio</div>
                </div>
            </div>
        `;
    },

    /** Inline SVG for the small icon-box used by file-item rows. */
    _iconForType(type) {
        const icons = {
            pdf: '<svg viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>',
            epub: '<svg viewBox="0 0 24 24"><path d="M18 2H6c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 4h5v8l-2.5-1.5L6 12V4z"/></svg>',
            audio: '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>',
            folder: '<svg viewBox="0 0 24 24"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>',
        };
        return icons[type] || icons.pdf;
    },

    /**
     * Wire click handlers for the rendered library. Cards (`.book-card`)
     * and rows (`.file-item`) can each represent a book, a standalone
     * file, or a subfolder — the data attributes disambiguate.
     */
    setupLibraryClickHandlers(content) {
        // Continue reading — search by item key OR book id (HLS books).
        const continueCard = content.querySelector('.continue-reading');
        if (continueCard) {
            continueCard.addEventListener('click', () => {
                const key = continueCard.dataset.bookId;
                const type = continueCard.dataset.type;
                // Prefer book lookup first: when the item belongs to a book
                // (R2 HLS, multi-part Drive), going through openBook sets
                // currentBook so the player picks up cover/chapters/name.
                const books = this.library?.books || [];
                const parentBook = books.find(b =>
                    b.id === key
                    || (b.audioFiles || []).some(f => f.key === key || f.id === key)
                    || (b.ebooks || []).some(f => f.key === key || f.id === key)
                );
                if (parentBook) {
                    this.openBook(parentBook);
                    return;
                }
                const allFiles = [...(this.files?.ebooks || []), ...(this.files?.audio || [])];
                const item = allFiles.find(f => f.key === key || f.id === key);
                if (item) this.openItem(item, type);
            });
        }

        const openFromCard = (card) => {
            // Subfolder: navigate into it by replacing the current selection
            // with just this folder. Folder navigation may still surface
            // children for users whose grants pre-date the Dec 2025 Google
            // regression; for new grants the user will need to re-pick from
            // inside the subfolder via the Picker.
            if (card.classList.contains('subfolder')) {
                this.currentFolder = { id: card.dataset.id, name: card.dataset.name };
                Storage.setSelectedFolder(this.currentFolder);
                document.getElementById('folder-name').textContent = card.dataset.name;
                this.loadLibrary();
                return;
            }
            // Book: identified by data-book-id.
            const bookId = card.dataset.bookId;
            if (bookId) {
                const book = this.library.books.find(b => b.id === bookId);
                if (book) this.openBook(book);
                return;
            }
            // Standalone file: identified by data-id + data-type.
            if (card.dataset.id && card.dataset.type) {
                this.openFile(card.dataset.id, card.dataset.name, card.dataset.type);
            }
        };

        // Both view modes (book-card grid + file-item list) route through
        // the same dispatcher.
        content.querySelectorAll('.book-card').forEach(c => c.addEventListener('click', () => openFromCard(c)));
        content.querySelectorAll('.file-item').forEach(c => c.addEventListener('click', () => openFromCard(c)));
    },

    // ---------------------------------------------------------------
    // Lazy cover loader: IntersectionObserver-driven, concurrency-capped.
    // For Drive EPUBs, extracts the cover via partial ZIP read (see
    // EpubCover) and caches the Blob in IndexedDB (see CoverCache) keyed
    // by fileId + modifiedTime so re-renders are instant. "No cover"
    // results are cached too so a book without a cover doesn't get
    // re-fetched on every library render.
    // ---------------------------------------------------------------

    _coverLoader: {
        observer: null,
        queue: [],
        inflight: 0,
        MAX_CONCURRENT: 4,
        objectUrls: [],
    },

    _attachCoverLoader(content) {
        // Tear down previous observer + revoke any object URLs created
        // for the prior render (the <img>s holding them are gone now).
        const loader = this._coverLoader;
        if (loader.observer) loader.observer.disconnect();
        loader.queue = [];
        loader.inflight = 0;
        for (const url of loader.objectUrls) URL.revokeObjectURL(url);
        loader.objectUrls = [];

        const targets = content.querySelectorAll('img.lazy-cover');
        if (!targets.length) return;

        loader.observer = new IntersectionObserver((entries) => {
            for (const entry of entries) {
                if (!entry.isIntersecting) continue;
                loader.observer.unobserve(entry.target);
                this._enqueueCoverJob(entry.target);
            }
        }, { rootMargin: '200px' });

        targets.forEach(t => loader.observer.observe(t));
    },

    _enqueueCoverJob(img) {
        this._coverLoader.queue.push(img);
        this._pumpCoverQueue();
    },

    _pumpCoverQueue() {
        const loader = this._coverLoader;
        while (loader.inflight < loader.MAX_CONCURRENT && loader.queue.length > 0) {
            const img = loader.queue.shift();
            loader.inflight++;
            this._loadCover(img).catch(() => {}).finally(() => {
                loader.inflight--;
                this._pumpCoverQueue();
            });
        }
    },

    async _loadCover(img) {
        if (!img.isConnected) return;
        const { coverKey: key, coverSource: source, coverId: id, coverSize: size } = img.dataset;
        if (!key) return;

        // 1) Cache lookup. A 'missing' hit means we already tried and
        //    there's no cover — leave the SVG fallback alone.
        const cached = await CoverCache.get(key);
        if (cached) {
            if (cached.blob) this._setCoverImage(img, cached.blob);
            return;
        }

        // 2) Extract from EPUB on Drive. Other sources don't reach here
        //    today; if a future source is added that supports lazy
        //    covers it can branch on `source` here.
        if (source !== 'drive') {
            await CoverCache.putMissing(key);
            return;
        }
        const blob = await EpubCover.fetchFromDrive(id, Number(size));
        if (blob) {
            await CoverCache.put(key, blob);
            if (img.isConnected) this._setCoverImage(img, blob);
        } else {
            await CoverCache.putMissing(key);
        }
    },

    _setCoverImage(img, blob) {
        if (!img.isConnected) return;
        const url = URL.createObjectURL(blob);
        this._coverLoader.objectUrls.push(url);
        img.src = url;
        img.classList.add('cover-loaded');
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
