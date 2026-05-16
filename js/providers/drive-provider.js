/**
 * Google Drive Storage Provider
 *
 * Owns all Drive API access. Implements the StorageProvider contract while
 * also exposing the historical `Drive.*` API surface (downloadFileWithProgress,
 * getAllFilesInFolder, isPDF/isEPUB/isAudio/...) so that the untouched
 * pdfviewer.js / epubviewer.js modules continue to work via the `Drive` alias
 * exported at the bottom of this file.
 */

const DriveProvider = Object.assign(Object.create(ProviderBase), {
    // --- identity & capabilities -----------------------------------------
    id: 'drive',
    displayName: 'Google Drive',
    icon: `<svg viewBox="0 0 24 24"><path fill="#1da462" d="M7.71 3.5l1.15 2L4.15 13.5h2.3L11.31 5.5 10.16 3.5z"/><path fill="#ea4335" d="M7.71 3.5L4.15 13.5h2.3l3.71-8L16 3.5z"/><path fill="#ffba00" d="M16 3.5l-3.85 6.69L15.85 16.5h-9.4l2.31 4h12L19.85 16.5z"/><path fill="#0066da" d="M4.15 13.5L1.85 17.5l2.3 4 3.7-6.5z"/><path fill="#00832d" d="M16 3.5L19.85 10l-3.7 6.5 3.7 6.5L23 13.5z"/></svg>`,
    supportsHLS: false,           // would need a CORS proxy; not implemented
    supportsByteRange: true,
    /** Player should download to Blob before playing (preserves existing behaviour) */
    audioPlaybackMode: 'blob',
    /** Drive uses native folder browsing via picker */
    supportsBrowsing: true,

    // --- readiness --------------------------------------------------------
    isConfigured() { return !!CONFIG.GOOGLE_CLIENT_ID; },
    isAuthenticated() { return typeof Auth !== 'undefined' && Auth.isAuthenticated(); },
    needsAuth() { return true; },

    async authenticate() {
        if (typeof Auth !== 'undefined') Auth.signIn();
    },

    async signOut() {
        if (typeof Auth !== 'undefined') Auth.signOut();
    },

    // --- raw HTTP layer (private) ----------------------------------------
    async _request(url, options = {}) {
        const token = Auth.getAccessToken();
        if (!token) {
            throw new Error('Not authenticated');
        }

        const response = await fetch(url, {
            ...options,
            headers: {
                'Authorization': `Bearer ${token}`,
                ...options.headers
            }
        });

        if (!response.ok) {
            if (response.status === 401) {
                Auth.signOut();
                throw new Error('Session expired');
            }
            throw new Error(`API error: ${response.status}`);
        }

        return response;
    },

    // --- legacy Drive helpers (preserved verbatim) -----------------------
    // These accept raw Drive file objects (with `mimeType`) AND normalised
    // items (which also carry `name` and optional `mimeType`).

    isPDF(file) {
        if (!file) return false;
        if (file.mimeType && CONFIG.SUPPORTED_TYPES.pdf.includes(file.mimeType)) return true;
        return !!file.name && file.name.toLowerCase().endsWith('.pdf');
    },

    isEPUB(file) {
        if (!file) return false;
        if (file.mimeType && CONFIG.SUPPORTED_TYPES.epub.includes(file.mimeType)) return true;
        return !!file.name && file.name.toLowerCase().endsWith('.epub');
    },

    isEbook(file) { return this.isPDF(file) || this.isEPUB(file); },

    isAudio(file) {
        if (!file) return false;
        if (file.mimeType && CONFIG.SUPPORTED_TYPES.audio.includes(file.mimeType)) return true;
        if (!file.name) return false;
        const name = file.name.toLowerCase();
        return ProviderBase.AUDIO_EXTENSIONS.some(ext => name.endsWith(ext)) || name.endsWith('.m3u8');
    },

    isHLSPlaylist(file) {
        if (!file?.name) return false;
        return file.name.toLowerCase().endsWith('.m3u8');
    },

    isFolder(file) {
        if (!file) return false;
        if (file.isFolder === true) return true;
        return file.mimeType === 'application/vnd.google-apps.folder';
    },

    isArchive(file) {
        if (!file?.mimeType) return false;
        return CONFIG.SUPPORTED_TYPES.archive.includes(file.mimeType);
    },

    // --- raw Drive API (used by app.js folder picker + legacy callers) ---

    async listFiles(folderId = 'root', pageToken = null) {
        let query = `'${folderId}' in parents and trashed = false`;
        const params = new URLSearchParams({
            q: query,
            fields: 'nextPageToken, files(id, name, mimeType, size, thumbnailLink, modifiedTime, parents)',
            orderBy: 'name',
            pageSize: '100'
        });
        if (pageToken) params.append('pageToken', pageToken);
        const response = await this._request(`${CONFIG.API.DRIVE_FILES}?${params}`);
        return response.json();
    },

    async getAllFilesInFolder(folderId = 'root') {
        let allFiles = [];
        let pageToken = null;
        do {
            const result = await this.listFiles(folderId, pageToken);
            allFiles = allFiles.concat(result.files || []);
            pageToken = result.nextPageToken;
        } while (pageToken);
        return allFiles;
    },

    async getFile(fileId) {
        const params = new URLSearchParams({
            fields: 'id, name, mimeType, size, thumbnailLink, modifiedTime, parents'
        });
        const response = await this._request(`${CONFIG.API.DRIVE_FILES}/${fileId}?${params}`);
        return response.json();
    },

    getDownloadUrl(fileId) {
        return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    },

    async downloadFile(fileId) {
        const response = await this._request(this.getDownloadUrl(fileId));
        return response.blob();
    },

    async downloadFileWithProgress(fileId, onProgress) {
        const url = this.getDownloadUrl(fileId);
        const token = Auth.getAccessToken();
        const response = await fetch(url, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        if (!response.body) {
            const blob = await response.blob();
            if (onProgress) onProgress(blob.size, blob.size);
            return blob;
        }

        const reader = response.body.getReader();
        const chunks = [];
        let loaded = 0;
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            loaded += value.length;
            if (onProgress) onProgress(loaded, total);
        }
        return new Blob(chunks);
    },

    async downloadFileAsArrayBuffer(fileId) {
        const response = await this._request(this.getDownloadUrl(fileId));
        return response.arrayBuffer();
    },

    // --- normalisation & library structure -------------------------------

    /** Convert a raw Drive file into a normalised item (provider-agnostic). */
    _toItem(file) {
        return {
            // normalised fields
            sourceId: 'drive',
            key: file.id,
            name: file.name,
            isFolder: this.isFolder(file),
            // legacy Drive fields preserved for back-compat
            id: file.id,
            mimeType: file.mimeType,
            size: file.size ? Number(file.size) : undefined,
            thumbnailLink: file.thumbnailLink,
            modifiedTime: file.modifiedTime,
            parents: file.parents,
        };
    },

    async listFolders(parentId = 'root') {
        const result = await this.listFiles(parentId);
        return (result.files || [])
            .filter(f => this.isFolder(f))
            .map(f => this._toItem(f));
    },

    // --- book detection (was inlined in old Drive) ----------------------

    _naturalSort(a, b) {
        return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    },

    _groupRelatedFiles(files) {
        const groups = {};
        files.forEach(file => {
            let baseName = file.name
                .replace(/\.[^/.]+$/, '')
                .replace(/[\s_-]*(osa|part|del|chapter|kappale|luku)[\s_-]*\d+/gi, '')
                .replace(/[\s_-]*\d+[\s_-]*$/g, '')
                .replace(/[\s_-]+$/, '')
                .trim();
            if (!baseName) baseName = file.name.replace(/\.[^/.]+$/, '');
            if (!groups[baseName]) groups[baseName] = [];
            groups[baseName].push(file);
        });
        return groups;
    },

    async _analyzeBookFolder(folderId, folderName) {
        const files = await this.getAllFilesInFolder(folderId);
        const ebooks = files.filter(f => this.isEbook(f));
        const audioFiles = files.filter(f => this.isAudio(f));
        const subfolders = files.filter(f => this.isFolder(f));

        const isMultiPartEbook = ebooks.length > 1;
        const isMultiPartAudio = audioFiles.length > 1;
        const hasContent = ebooks.length > 0 || audioFiles.length > 0;

        ebooks.sort(this._naturalSort);
        audioFiles.sort(this._naturalSort);

        return {
            id: folderId,
            name: folderName,
            isBook: hasContent && (isMultiPartEbook || isMultiPartAudio || subfolders.length === 0),
            isMultiPart: isMultiPartEbook || isMultiPartAudio,
            ebooks: ebooks.map(f => this._toItem(f)),
            audioFiles: audioFiles.map(f => this._toItem(f)),
            subfolders: subfolders.map(f => this._toItem(f)),
            ebookCount: ebooks.length,
            audioCount: audioFiles.length,
            primaryType: ebooks.length > 0 ? (audioFiles.length > 0 ? 'both' : 'ebook') : 'audio',
            format: 'native',
            sourceId: 'drive',
            progressKey: null,           // single-file books use file's progressKey
        };
    },

    /**
     * Build a normalised library structure for the given Drive folder.
     * Returns { sourceId, books: [...], standaloneFiles: { ebooks, audio }, folders }.
     */
    async getLibraryStructure(folderId) {
        const files = await this.getAllFilesInFolder(folderId);
        const library = {
            sourceId: 'drive',
            folderId,
            books: [],
            standaloneFiles: { ebooks: [], audio: [] },
            folders: files.filter(f => this.isFolder(f)).map(f => this._toItem(f)),
        };

        const folders = files.filter(f => this.isFolder(f));
        for (const folder of folders) {
            const bookInfo = await this._analyzeBookFolder(folder.id, folder.name);
            if (bookInfo.isBook) library.books.push(bookInfo);
        }

        const standaloneEbooks = files.filter(f => this.isEbook(f));
        const standaloneAudio = files.filter(f => this.isAudio(f));

        const ebookGroups = this._groupRelatedFiles(standaloneEbooks);
        const audioGroups = this._groupRelatedFiles(standaloneAudio);

        for (const [groupName, groupFiles] of Object.entries(ebookGroups)) {
            if (groupFiles.length > 1) {
                library.books.push({
                    id: `group_${groupFiles[0].id}`,
                    name: groupName,
                    sourceId: 'drive',
                    isBook: true,
                    isMultiPart: true,
                    ebooks: groupFiles.sort(this._naturalSort).map(f => this._toItem(f)),
                    audioFiles: [],
                    subfolders: [],
                    ebookCount: groupFiles.length,
                    audioCount: 0,
                    primaryType: 'ebook',
                    isVirtualGroup: true,
                    format: 'native',
                });
            } else {
                library.standaloneFiles.ebooks.push(this._toItem(groupFiles[0]));
            }
        }

        for (const [groupName, groupFiles] of Object.entries(audioGroups)) {
            if (groupFiles.length > 1) {
                const existing = library.books.find(b => b.name === groupName);
                if (existing) {
                    existing.audioFiles = groupFiles.sort(this._naturalSort).map(f => this._toItem(f));
                    existing.audioCount = groupFiles.length;
                    existing.primaryType = 'both';
                } else {
                    library.books.push({
                        id: `group_audio_${groupFiles[0].id}`,
                        name: groupName,
                        sourceId: 'drive',
                        isBook: true,
                        isMultiPart: true,
                        ebooks: [],
                        audioFiles: groupFiles.sort(this._naturalSort).map(f => this._toItem(f)),
                        subfolders: [],
                        ebookCount: 0,
                        audioCount: groupFiles.length,
                        primaryType: 'audio',
                        isVirtualGroup: true,
                        format: 'native',
                    });
                }
            } else {
                library.standaloneFiles.audio.push(this._toItem(groupFiles[0]));
            }
        }

        library.books.sort((a, b) => this._naturalSort(a, b));
        return library;
    },

    /**
     * Flat organised view (folders / pdfs / epubs / ebooks / audio / archives).
     * Returns normalised items.
     */
    async getOrganizedFiles(folderId) {
        const files = await this.getAllFilesInFolder(folderId);
        const organized = {
            folders: [], pdfs: [], epubs: [], ebooks: [], audio: [], archives: [], all: files,
        };
        files.forEach(file => {
            const item = this._toItem(file);
            if (this.isFolder(file)) organized.folders.push(item);
            else if (this.isPDF(file)) { organized.pdfs.push(item); organized.ebooks.push(item); }
            else if (this.isEPUB(file)) { organized.epubs.push(item); organized.ebooks.push(item); }
            else if (this.isAudio(file)) organized.audio.push(item);
            else if (this.isArchive(file)) organized.archives.push(item);
        });
        organized.folders.sort(this._naturalSort);
        organized.pdfs.sort(this._naturalSort);
        organized.epubs.sort(this._naturalSort);
        organized.ebooks.sort(this._naturalSort);
        organized.audio.sort(this._naturalSort);
        return organized;
    },

    /**
     * @deprecated kept for backwards-compat with the original Drive helper;
     * folder path resolution is not used by the new provider flow.
     */
    async getFolderPath(folderId) {
        const path = [];
        let currentId = folderId;
        while (currentId && currentId !== 'root') {
            try {
                const file = await this.getFile(currentId);
                path.unshift({ id: file.id, name: file.name });
                currentId = file.parents?.[0] || null;
            } catch (e) { break; }
        }
        return path;
    },

    // --- new normalised playback API -------------------------------------

    /**
     * For Drive the only safe public stream URL leaks the access token, so
     * the player downloads the whole blob and creates an object URL. This
     * method exists for completeness and returns the authenticated URL —
     * callers that prefer blob playback should use downloadAsBlob.
     */
    async getStreamUrl(item) {
        const token = Auth.getAccessToken();
        return `${this.getDownloadUrl(item.key)}&access_token=${token}`;
    },

    async downloadAsBlob(item, onProgress) {
        return this.downloadFileWithProgress(item.key, onProgress);
    },

    async downloadAsArrayBuffer(item) {
        return this.downloadFileAsArrayBuffer(item.key);
    },
});

// Legacy global alias so the untouched pdf/epub viewers continue to work.
const Drive = DriveProvider;
