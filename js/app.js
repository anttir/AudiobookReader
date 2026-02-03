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

            // Load files if folder is selected
            if (this.currentFolder) {
                this.loadLibrary();
            }
        } else {
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
     * Load library from selected folder
     */
    async loadLibrary() {
        if (!this.currentFolder) return;

        const content = document.getElementById('library-content');
        content.innerHTML = '<div class="picker-loading"><div class="loader"></div><p>Ladataan kirjastoa...</p></div>';

        try {
            // Get library structure (books and standalone files)
            this.library = await Drive.getLibraryStructure(this.currentFolder.id);
            // Also get flat file list for backwards compatibility
            this.files = await Drive.getOrganizedFiles(this.currentFolder.id);
            this.renderLibrary();
        } catch (error) {
            console.error('Error loading library:', error);
            content.innerHTML = `
                <div class="empty-state">
                    <p>Virhe kirjaston lataamisessa</p>
                </div>
            `;
        }
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
                const progress = Storage.getBookProgress(file.id);
                const type = Drive.isEPUB(file) ? 'epub' : 'pdf';
                html += this.renderFileItem(file, type, progress);
            });
            html += '</div></div>';
        }

        // Render standalone audio
        if (hasStandaloneAudio) {
            html += '<div class="library-section"><h3>Yksittäiset äänitiedostot</h3><div class="file-list">';
            this.library.standaloneFiles.audio.forEach(file => {
                const progress = Storage.getBookProgress(file.id);
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
     * Get last read book info
     */
    getLastReadBook() {
        const allProgress = Storage.getAllBookProgress();
        if (!allProgress || Object.keys(allProgress).length === 0) return null;

        // Find most recently read
        let lastRead = null;
        let lastTime = 0;

        for (const [fileId, progress] of Object.entries(allProgress)) {
            if (progress.lastRead && progress.lastRead > lastTime) {
                lastTime = progress.lastRead;
                lastRead = { id: fileId, ...progress };
            }
        }

        if (!lastRead || lastRead.percentage === 100) return null;

        // Try to find the file info
        const findFile = (id) => {
            if (this.files?.ebooks) {
                const ebook = this.files.ebooks.find(f => f.id === id);
                if (ebook) return { file: ebook, type: Drive.isEPUB(ebook) ? 'epub' : 'pdf' };
            }
            if (this.files?.audio) {
                const audio = this.files.audio.find(f => f.id === id);
                if (audio) return { file: audio, type: 'audio' };
            }
            return null;
        };

        const fileInfo = findFile(lastRead.id);
        if (!fileInfo) return null;

        return {
            id: lastRead.id,
            name: fileInfo.file.name.replace(/\.[^/.]+$/, ''),
            type: fileInfo.type,
            progressText: `${lastRead.percentage}% valmis`
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

        return `
            <div class="book-card" data-book-id="${book.id}" data-book-type="${book.primaryType}">
                <div class="book-cover">
                    ${typeIcon}
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
     * Calculate overall progress for a multi-part book
     */
    calculateBookProgress(book) {
        let totalProgress = 0;
        let partCount = 0;

        const checkProgress = (files) => {
            files.forEach(file => {
                const progress = Storage.getBookProgress(file.id);
                if (progress) {
                    totalProgress += progress.percentage || 0;
                }
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
        // Continue reading
        const continueCard = content.querySelector('.continue-reading');
        if (continueCard) {
            continueCard.addEventListener('click', () => {
                const bookId = continueCard.dataset.bookId;
                const type = continueCard.dataset.type;
                // Find file in files
                const allFiles = [...(this.files?.ebooks || []), ...(this.files?.audio || [])];
                const file = allFiles.find(f => f.id === bookId);
                if (file) {
                    this.openFile(file.id, file.name, type);
                }
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

        // Determine which part to start with (last read or first)
        let startIndex = 0;
        let startType = book.primaryType === 'audio' ? 'audio' : 'ebook';

        // Check for saved progress
        const files = startType === 'audio' ? book.audioFiles : book.ebooks;
        for (let i = 0; i < files.length; i++) {
            const progress = Storage.getBookProgress(files[i].id);
            if (progress && progress.percentage < 100) {
                startIndex = i;
                break;
            }
        }

        this.currentPartIndex = startIndex;

        // Open the file
        const file = files[startIndex];
        const type = startType === 'audio' ? 'audio' : (Drive.isEPUB(file) ? 'epub' : 'pdf');

        await this.openFile(file.id, file.name, type);

        // Show parts button for multi-part books
        if (book.isMultiPart) {
            this.showPartsButton(startIndex + 1, files.length);
        }
    },

    /**
     * Open a file
     */
    async openFile(fileId, fileName, type) {
        this.showScreen('reader');

        // Hide all viewers first
        document.getElementById('pdf-viewer-container').classList.add('hidden');
        document.getElementById('epub-viewer-container').classList.add('hidden');
        document.getElementById('audio-player-container').classList.add('hidden');

        if (type === 'pdf') {
            this.currentMode = 'read';
            document.getElementById('pdf-viewer-container').classList.remove('hidden');
            await PDFViewer.loadFromDrive(fileId, fileName);
        } else if (type === 'epub') {
            this.currentMode = 'read';
            document.getElementById('epub-viewer-container').classList.remove('hidden');
            await EPUBViewer.loadFromDrive(fileId, fileName);
        } else if (type === 'audio') {
            this.currentMode = 'listen';
            document.getElementById('audio-player-container').classList.remove('hidden');

            // Set playlist with all audio files from current book or library
            const audioFiles = this.currentBook?.audioFiles || this.files?.audio || [];
            AudioPlayer.setPlaylist(audioFiles);
            await AudioPlayer.loadTrack(fileId, fileName);
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

        let html = '';

        // Add ebook parts
        if (this.currentBook.ebooks?.length > 0) {
            this.currentBook.ebooks.forEach((file, index) => {
                const progress = Storage.getBookProgress(file.id);
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
                const progress = Storage.getBookProgress(file.id);
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
