/**
 * Cloudflare R2 Storage Provider — stub.
 *
 * The full implementation lands in the next commit. We register the stub now
 * so the index.html script load doesn't 404 and the registry can resolve the
 * provider when the UI starts showing the source selector.
 */

const R2Provider = Object.assign(Object.create(ProviderBase), {
    id: 'r2',
    displayName: 'Cloudflare R2',
    icon: `<svg viewBox="0 0 24 24"><path fill="#f6821f" d="M16.5 16.5L13 12l3.5-4.5h-9L4 12l3.5 4.5z"/><path fill="#faae40" d="M20 12l-3.5-4.5L13 12l3.5 4.5z"/></svg>`,
    supportsHLS: true,
    supportsByteRange: true,
    audioPlaybackMode: 'direct',
    supportsBrowsing: false,

    isConfigured() { return false; },        // not yet configurable
    isAuthenticated() { return true; },      // public bucket, no auth needed
    needsAuth() { return false; },

    async getLibraryStructure(_folderId) {
        return {
            sourceId: 'r2',
            books: [],
            standaloneFiles: { ebooks: [], audio: [] },
            folders: [],
        };
    },
});
