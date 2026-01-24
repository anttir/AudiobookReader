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
     * Check if file is audio
     */
    isAudio(file) {
        return CONFIG.SUPPORTED_TYPES.audio.includes(file.mimeType);
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
            audio: [],
            archives: [],
            all: files
        };

        files.forEach(file => {
            if (this.isFolder(file)) {
                organized.folders.push(file);
            } else if (this.isPDF(file)) {
                organized.pdfs.push(file);
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
        organized.audio.sort(naturalSort);

        return organized;
    }
};
