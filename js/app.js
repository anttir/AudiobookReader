/**
 * Main Application - AudioBook Reader
 */

const App = {
    currentScreen: 'login',
    currentFolder: null,
    files: null,
    currentMode: 'read', // 'read' or 'listen'
    folderStack: [],

    /**
     * Initialize the application
     */
    async init() {
        // Apply saved theme
        this.applyTheme();

        // Initialize modules
        PDFViewer.init();
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
            this.showScreen('library');
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
            const hasContent = files.some(f => Drive.isPDF(f) || Drive.isAudio(f));

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

        if (!this.files || (this.files.pdfs.length === 0 && this.files.audio.length === 0)) {
            content.innerHTML = `
                <div class="empty-state">
                    <svg viewBox="0 0 100 100" class="empty-icon">
                        <rect x="20" y="30" width="60" height="50" rx="5" fill="#4a90d9" opacity="0.3"/>
                        <path d="M30 45 L70 45" stroke="#4a90d9" stroke-width="3"/>
                        <path d="M30 55 L60 55" stroke="#4a90d9" stroke-width="3"/>
                    </svg>
                    <p>Ei PDF- tai äänitiedostoja tässä kansiossa</p>
                </div>
            `;
            return;
        }

        let html = '<div class="file-list">';

        // Render PDFs
        if (this.files.pdfs.length > 0) {
            html += '<h3 style="margin: 16px 0 8px; color: var(--text-secondary); font-size: 0.85rem;">PDF-TIEDOSTOT</h3>';
            this.files.pdfs.forEach(file => {
                const progress = Storage.getBookProgress(file.id);
                html += this.renderFileItem(file, 'pdf', progress);
            });
        }

        // Render audio files
        if (this.files.audio.length > 0) {
            html += '<h3 style="margin: 16px 0 8px; color: var(--text-secondary); font-size: 0.85rem;">ÄÄNITIEDOSTOT</h3>';
            this.files.audio.forEach(file => {
                const progress = Storage.getBookProgress(file.id);
                html += this.renderFileItem(file, 'audio', progress);
            });
        }

        // Render subfolders
        if (this.files.folders.length > 0) {
            html += '<h3 style="margin: 16px 0 8px; color: var(--text-secondary); font-size: 0.85rem;">ALIKANSIOT</h3>';
            this.files.folders.forEach(folder => {
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
        }

        html += '</div>';
        content.innerHTML = html;

        // Add click handlers for files
        content.querySelectorAll('.file-item:not(.subfolder)').forEach(item => {
            item.addEventListener('click', () => {
                this.openFile(item.dataset.id, item.dataset.name, item.dataset.type);
            });
        });

        // Add click handlers for subfolders
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
     * Render a file item
     */
    renderFileItem(file, type, progress) {
        const progressPercent = progress?.percentage || 0;
        const progressText = progress ? `${progressPercent}% luettu` : '';

        const icon = type === 'pdf'
            ? '<svg viewBox="0 0 24 24"><path d="M20 2H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8.5 7.5c0 .83-.67 1.5-1.5 1.5H9v2H7.5V7H10c.83 0 1.5.67 1.5 1.5v1zm5 2c0 .83-.67 1.5-1.5 1.5h-2.5V7H15c.83 0 1.5.67 1.5 1.5v3zm4-3H19v1h1.5V11H19v2h-1.5V7h3v1.5zM9 9.5h1v-1H9v1zM4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm10 5.5h1v-3h-1v3z"/></svg>'
            : '<svg viewBox="0 0 24 24"><path d="M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z"/></svg>';

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
     * Open a file
     */
    async openFile(fileId, fileName, type) {
        this.showScreen('reader');

        if (type === 'pdf') {
            this.currentMode = 'read';
            document.getElementById('pdf-viewer-container').classList.remove('hidden');
            document.getElementById('audio-player-container').classList.add('hidden');
            await PDFViewer.loadFromDrive(fileId, fileName);
        } else if (type === 'audio') {
            this.currentMode = 'listen';
            document.getElementById('pdf-viewer-container').classList.add('hidden');
            document.getElementById('audio-player-container').classList.remove('hidden');

            // Set playlist with all audio files
            AudioPlayer.setPlaylist(this.files.audio);
            await AudioPlayer.loadTrack(fileId, fileName);
        }

        this.updateModeIcon();
    },

    /**
     * Toggle between read and listen mode
     */
    toggleMode() {
        if (this.currentMode === 'read' && this.files?.audio.length > 0) {
            // Switch to audio
            this.currentMode = 'listen';
            document.getElementById('pdf-viewer-container').classList.add('hidden');
            document.getElementById('audio-player-container').classList.remove('hidden');

            // Load first audio if not already playing
            if (!AudioPlayer.currentFileId && this.files.audio.length > 0) {
                const firstAudio = this.files.audio[0];
                AudioPlayer.setPlaylist(this.files.audio);
                AudioPlayer.loadTrack(firstAudio.id, firstAudio.name);
            }
        } else if (this.currentMode === 'listen' && this.files?.pdfs.length > 0) {
            // Switch to PDF
            this.currentMode = 'read';
            document.getElementById('pdf-viewer-container').classList.remove('hidden');
            document.getElementById('audio-player-container').classList.add('hidden');

            // Load first PDF if not already loaded
            if (!PDFViewer.currentFileId && this.files.pdfs.length > 0) {
                const firstPdf = this.files.pdfs[0];
                PDFViewer.loadFromDrive(firstPdf.id, firstPdf.name);
            }
        }

        this.updateModeIcon();
    },

    /**
     * Update mode toggle icon
     */
    updateModeIcon() {
        const readIcon = document.querySelector('.mode-icon-read');
        const listenIcon = document.querySelector('.mode-icon-listen');

        if (this.currentMode === 'read') {
            readIcon.classList.remove('hidden');
            listenIcon.classList.add('hidden');
        } else {
            readIcon.classList.add('hidden');
            listenIcon.classList.remove('hidden');
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
    },

    /**
     * Show loading overlay
     */
    showLoading(show) {
        const loading = document.getElementById('loading-screen');
        if (show) {
            loading.classList.remove('hidden');
        } else {
            loading.classList.add('hidden');
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
