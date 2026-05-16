/**
 * Storage Provider base — contract shared by all storage sources.
 *
 * A provider exposes a uniform API for listing books and playing them back,
 * regardless of whether the underlying storage is Google Drive, Cloudflare R2,
 * S3, IPFS, etc. Items returned by providers are normalised:
 *
 *   {
 *     sourceId,           // 'drive', 'r2', ...
 *     key,                // provider-specific identifier (Drive fileId, R2 object key)
 *     name,               // user-visible file name (e.g. "Chapter01.mp3")
 *     mimeType,           // optional, may be undefined
 *     size,               // optional
 *     isFolder,           // boolean
 *     extra               // provider-specific extras (passthrough)
 *   }
 *
 * Books (returned by listBooks) carry an optional `progressKey` that the
 * storage layer uses as a stable identifier across sources.
 */

const ProviderBase = {
    // --- identity ---------------------------------------------------------
    id: null,
    displayName: '',
    icon: '',
    // capabilities — clients (e.g. AudioPlayer) inspect these to decide
    // whether to use HLS, byte-range seek hints, etc.
    supportsHLS: false,
    supportsByteRange: false,

    // --- readiness --------------------------------------------------------
    isConfigured() { return true; },
    isAuthenticated() { return true; },
    isReady() { return this.isConfigured() && this.isAuthenticated(); },
    needsAuth() { return false; },

    async authenticate() {},
    async signOut() {},

    // --- type detection (default by file name; providers may override
    // when they have richer metadata such as mimeType) ---------------------
    AUDIO_EXTENSIONS: ['.mp3', '.m4a', '.m4b', '.wav', '.ogg', '.oga', '.flac', '.aac', '.opus', '.webm'],

    isFolder(item) { return !!item?.isFolder; },

    isHLSPlaylist(item) {
        return !!item?.name && item.name.toLowerCase().endsWith('.m3u8');
    },

    isPDF(item) {
        if (!item?.name) return false;
        return item.name.toLowerCase().endsWith('.pdf');
    },

    isEPUB(item) {
        if (!item?.name) return false;
        return item.name.toLowerCase().endsWith('.epub');
    },

    isEbook(item) {
        return this.isPDF(item) || this.isEPUB(item);
    },

    isAudio(item) {
        if (!item?.name) return false;
        const name = item.name.toLowerCase();
        if (this.isHLSPlaylist(item)) return true;
        return this.AUDIO_EXTENSIONS.some(ext => name.endsWith(ext));
    },

    // --- library navigation (required) ------------------------------------
    async listFolders(_parentId) {
        throw new Error(`[${this.id}] listFolders not implemented`);
    },

    async getLibraryStructure(_folderId) {
        throw new Error(`[${this.id}] getLibraryStructure not implemented`);
    },

    // --- item content access (required) -----------------------------------
    /** Returns a URL the browser can hand to <audio src> or hls.js. */
    async getStreamUrl(_item) {
        throw new Error(`[${this.id}] getStreamUrl not implemented`);
    },

    /** Returns a Blob; calls onProgress(loaded, total) during transfer. */
    async downloadAsBlob(_item, _onProgress) {
        throw new Error(`[${this.id}] downloadAsBlob not implemented`);
    },

    /** Returns ArrayBuffer (used by PDF.js). */
    async downloadAsArrayBuffer(_item) {
        throw new Error(`[${this.id}] downloadAsArrayBuffer not implemented`);
    },
};

/**
 * Helper: build a stable progress key that includes the source so that
 * the same logical book on Drive and R2 don't collide in localStorage.
 */
function makeProgressKey(sourceId, key) {
    return `${sourceId}:${key}`;
}
