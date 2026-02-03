/**
 * Google Drive API Module
 */

const Drive = {
    /**
     * Make authenticated API request
     */
    async request(url, options = {}) {
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

    /**
     * List files in a folder
     */
    async listFiles(folderId = 'root', pageToken = null) {
        let query = `'${folderId}' in parents and trashed = false`;

        const params = new URLSearchParams({
            q: query,
            fields: 'nextPageToken, files(id, name, mimeType, size, thumbnailLink, modifiedTime, parents)',
            orderBy: 'name',
            pageSize: '100'
        });

        if (pageToken) {
            params.append('pageToken', pageToken);
        }

        const response = await this.request(`${CONFIG.API.DRIVE_FILES}?${params}`);
        return response.json();
    },

    /**
     * Get all files in folder (handles pagination)
     */
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

    /**
     * Filter files by supported types
     */
    filterSupportedFiles(files) {
        return files.filter(file => {
            return this.isPDF(file) || this.isAudio(file) || this.isFolder(file) || this.isArchive(file);
        });
    },

    /**
     * Check if file is PDF
     */
    isPDF(file) {
        return CONFIG.SUPPORTED_TYPES.pdf.includes(file.mimeType);
    },

    /**
     * Check if file is EPUB
     */
    isEPUB(file) {
        return CONFIG.SUPPORTED_TYPES.epub.includes(file.mimeType) ||
               file.name.toLowerCase().endsWith('.epub');
    },

    /**
     * Check if file is any ebook format
     */
    isEbook(file) {
        return this.isPDF(file) || this.isEPUB(file);
    },

    /**
     * Check if file is audio
     */
    isAudio(file) {
        // Check by MIME type
        if (CONFIG.SUPPORTED_TYPES.audio.includes(file.mimeType)) {
            return true;
        }
        // Also check by extension for better compatibility
        const audioExtensions = ['.mp3', '.m4a', '.m4b', '.wav', '.ogg', '.flac', '.aac', '.wma', '.opus', '.webm'];
        const name = file.name.toLowerCase();
        return audioExtensions.some(ext => name.endsWith(ext));
    },

    /**
     * Check if file is folder
     */
    isFolder(file) {
        return file.mimeType === 'application/vnd.google-apps.folder';
    },

    /**
     * Check if file is archive (ZIP)
     */
    isArchive(file) {
        return CONFIG.SUPPORTED_TYPES.archive.includes(file.mimeType);
    },

    /**
     * Get file metadata
     */
    async getFile(fileId) {
        const params = new URLSearchParams({
            fields: 'id, name, mimeType, size, thumbnailLink, modifiedTime, parents'
        });

        const response = await this.request(`${CONFIG.API.DRIVE_FILES}/${fileId}?${params}`);
        return response.json();
    },

    /**
     * Get file download URL
     */
    getDownloadUrl(fileId) {
        return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
    },

    /**
     * Download file as blob
     */
    async downloadFile(fileId) {
        const url = this.getDownloadUrl(fileId);
        const response = await this.request(url);
        return response.blob();
    },

    /**
     * Download file with progress callback
     */
    async downloadFileWithProgress(fileId, onProgress) {
        const url = this.getDownloadUrl(fileId);
        const token = Auth.getAccessToken();

        const response = await fetch(url, {
            headers: {
                'Authorization': `Bearer ${token}`
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
        }

        const contentLength = response.headers.get('content-length');
        const total = contentLength ? parseInt(contentLength, 10) : 0;

        if (!response.body) {
            // Fallback if ReadableStream not supported
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

            if (onProgress) {
                onProgress(loaded, total);
            }
        }

        const blob = new Blob(chunks);
        return blob;
    },

    /**
     * Download file as ArrayBuffer (for PDF.js)
     */
    async downloadFileAsArrayBuffer(fileId) {
        const url = this.getDownloadUrl(fileId);
        const response = await this.request(url);
        return response.arrayBuffer();
    },

    /**
     * Get streaming URL for audio files
     */
    getStreamUrl(fileId) {
        const token = Auth.getAccessToken();
        return `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&access_token=${token}`;
    },

    /**
     * Search for folders
     */
    async searchFolders(query = '') {
        let q = "mimeType = 'application/vnd.google-apps.folder' and trashed = false";
        if (query) {
            q += ` and name contains '${query}'`;
        }

        const params = new URLSearchParams({
            q: q,
            fields: 'files(id, name, parents)',
            orderBy: 'name',
            pageSize: '50'
        });

        const response = await this.request(`${CONFIG.API.DRIVE_FILES}?${params}`);
        return response.json();
    },

    /**
     * Get folder path (breadcrumb)
     */
    async getFolderPath(folderId) {
        const path = [];
        let currentId = folderId;

        while (currentId && currentId !== 'root') {
            try {
                const file = await this.getFile(currentId);
                path.unshift({ id: file.id, name: file.name });

                if (file.parents && file.parents.length > 0) {
                    currentId = file.parents[0];
                } else {
                    break;
                }
            } catch (e) {
                break;
            }
        }

        return path;
    },

    /**
     * Get files organized by type
     */
    async getOrganizedFiles(folderId) {
        const files = await this.getAllFilesInFolder(folderId);

        const organized = {
            folders: [],
            pdfs: [],
            epubs: [],
            ebooks: [],
            audio: [],
            archives: [],
            all: files
        };

        files.forEach(file => {
            if (this.isFolder(file)) {
                organized.folders.push(file);
            } else if (this.isPDF(file)) {
                organized.pdfs.push(file);
                organized.ebooks.push(file);
            } else if (this.isEPUB(file)) {
                organized.epubs.push(file);
                organized.ebooks.push(file);
            } else if (this.isAudio(file)) {
                organized.audio.push(file);
            } else if (this.isArchive(file)) {
                organized.archives.push(file);
            }
        });

        // Sort by name naturally (numbers in correct order)
        const naturalSort = (a, b) => {
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        };

        organized.folders.sort(naturalSort);
        organized.pdfs.sort(naturalSort);
        organized.epubs.sort(naturalSort);
        organized.ebooks.sort(naturalSort);
        organized.audio.sort(naturalSort);

        return organized;
    },

    /**
     * Analyze folder to determine if it's a multi-part book
     * Returns book info if folder contains multiple parts of same book
     */
    async analyzeBookFolder(folderId, folderName) {
        const files = await this.getAllFilesInFolder(folderId);

        const ebooks = files.filter(f => this.isEbook(f));
        const audioFiles = files.filter(f => this.isAudio(f));
        const subfolders = files.filter(f => this.isFolder(f));

        // Determine if this is a multi-part book
        const isMultiPartEbook = ebooks.length > 1;
        const isMultiPartAudio = audioFiles.length > 1;
        const hasContent = ebooks.length > 0 || audioFiles.length > 0;

        // Natural sort
        const naturalSort = (a, b) => {
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        };

        ebooks.sort(naturalSort);
        audioFiles.sort(naturalSort);

        return {
            id: folderId,
            name: folderName,
            isBook: hasContent && (isMultiPartEbook || isMultiPartAudio || subfolders.length === 0),
            isMultiPart: isMultiPartEbook || isMultiPartAudio,
            ebooks: ebooks,
            audioFiles: audioFiles,
            subfolders: subfolders,
            ebookCount: ebooks.length,
            audioCount: audioFiles.length,
            // Determine primary type
            primaryType: ebooks.length > 0 ? (audioFiles.length > 0 ? 'both' : 'ebook') : 'audio'
        };
    },

    /**
     * Get library structure - detects books (single or multi-part)
     */
    async getLibraryStructure(folderId) {
        const files = await this.getAllFilesInFolder(folderId);
        const library = {
            books: [],
            standaloneFiles: {
                ebooks: [],
                audio: []
            }
        };

        const naturalSort = (a, b) => {
            return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
        };

        // Process folders as potential books
        const folders = files.filter(f => this.isFolder(f));
        for (const folder of folders) {
            const bookInfo = await this.analyzeBookFolder(folder.id, folder.name);
            if (bookInfo.isBook) {
                library.books.push(bookInfo);
            }
        }

        // Process standalone files (not in subfolders)
        const standaloneEbooks = files.filter(f => this.isEbook(f));
        const standaloneAudio = files.filter(f => this.isAudio(f));

        // Group standalone files that might be parts of same book
        // (e.g., "BookName Part 1.pdf", "BookName Part 2.pdf")
        const ebookGroups = this.groupRelatedFiles(standaloneEbooks);
        const audioGroups = this.groupRelatedFiles(standaloneAudio);

        // Create book entries for grouped files
        for (const [groupName, groupFiles] of Object.entries(ebookGroups)) {
            if (groupFiles.length > 1) {
                library.books.push({
                    id: `group_${groupFiles[0].id}`,
                    name: groupName,
                    isBook: true,
                    isMultiPart: true,
                    ebooks: groupFiles.sort(naturalSort),
                    audioFiles: [],
                    subfolders: [],
                    ebookCount: groupFiles.length,
                    audioCount: 0,
                    primaryType: 'ebook',
                    isVirtualGroup: true
                });
            } else {
                library.standaloneFiles.ebooks.push(groupFiles[0]);
            }
        }

        for (const [groupName, groupFiles] of Object.entries(audioGroups)) {
            if (groupFiles.length > 1) {
                // Check if we already have a book with this name
                const existingBook = library.books.find(b => b.name === groupName);
                if (existingBook) {
                    existingBook.audioFiles = groupFiles.sort(naturalSort);
                    existingBook.audioCount = groupFiles.length;
                    existingBook.primaryType = 'both';
                } else {
                    library.books.push({
                        id: `group_audio_${groupFiles[0].id}`,
                        name: groupName,
                        isBook: true,
                        isMultiPart: true,
                        ebooks: [],
                        audioFiles: groupFiles.sort(naturalSort),
                        subfolders: [],
                        ebookCount: 0,
                        audioCount: groupFiles.length,
                        primaryType: 'audio',
                        isVirtualGroup: true
                    });
                }
            } else {
                library.standaloneFiles.audio.push(groupFiles[0]);
            }
        }

        // Sort books by name
        library.books.sort((a, b) => naturalSort(a, b));

        return library;
    },

    /**
     * Group related files by detecting common name patterns
     */
    groupRelatedFiles(files) {
        const groups = {};

        files.forEach(file => {
            // Try to extract base name (remove part numbers, extensions)
            let baseName = file.name
                .replace(/\.[^/.]+$/, '')  // Remove extension
                .replace(/[\s_-]*(osa|part|del|chapter|kappale|luku)[\s_-]*\d+/gi, '')  // Remove part indicators
                .replace(/[\s_-]*\d+[\s_-]*$/g, '')  // Remove trailing numbers
                .replace(/[\s_-]+$/, '')  // Remove trailing separators
                .trim();

            if (!baseName) baseName = file.name.replace(/\.[^/.]+$/, '');

            if (!groups[baseName]) {
                groups[baseName] = [];
            }
            groups[baseName].push(file);
        });

        return groups;
    }
};
