/**
 * Cover image cache backed by IndexedDB.
 *
 * Why IndexedDB and not localStorage:
 *   - localStorage caps at ~5-10 MB and stores strings only (binary needs
 *     base64 → 33% overhead). Covers can easily push tens of MB across a
 *     full library.
 *   - IndexedDB stores Blobs natively, has multi-GB quota, async API.
 *
 * Keying scheme (chosen by caller):
 *   - Drive:  "drive:<fileId>@<modifiedTime>"  — modifiedTime acts as cache
 *             buster; uploading a new revision of the same file changes the
 *             key, the old entry stays until LRU evicts it.
 *   - R2:     not cached here — manifest covers are already public URLs
 *             served from the bucket with the browser HTTP cache.
 *
 * "No cover" sentinel: when extraction fails or the EPUB doesn't ship a
 * cover, we still write an entry with `missing: true` so we don't keep
 * retrying on every library render.
 */
const CoverCache = {
    DB_NAME: 'audiobook-reader-covers',
    DB_VERSION: 1,
    STORE: 'covers',
    /** Soft cap; eviction trims oldest entries when total bytes exceed this. */
    MAX_BYTES: 200 * 1024 * 1024,

    _dbPromise: null,
    _evictTimer: null,

    _open() {
        if (this._dbPromise) return this._dbPromise;
        this._dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(this.DB_NAME, this.DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(this.STORE)) {
                    const store = db.createObjectStore(this.STORE, { keyPath: 'key' });
                    store.createIndex('lastAccessed', 'lastAccessed');
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
        });
        return this._dbPromise;
    },

    /**
     * Look up a cover by key. Touches `lastAccessed` so the LRU eviction
     * keeps recently-used covers around.
     * @returns {Promise<{blob: Blob|null, missing: boolean}|null>}
     */
    async get(key) {
        try {
            const db = await this._open();
            return new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                const store = tx.objectStore(this.STORE);
                const req = store.get(key);
                req.onsuccess = () => {
                    const entry = req.result;
                    if (!entry) { resolve(null); return; }
                    entry.lastAccessed = Date.now();
                    store.put(entry);
                    resolve({ blob: entry.blob || null, missing: !!entry.missing });
                };
                req.onerror = () => reject(req.error);
            });
        } catch (e) {
            console.warn('[cover-cache] get failed:', e);
            return null;
        }
    },

    async put(key, blob) {
        try {
            const db = await this._open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).put({
                    key,
                    blob,
                    missing: false,
                    size: blob.size,
                    lastAccessed: Date.now(),
                });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
            this._scheduleEviction();
        } catch (e) {
            console.warn('[cover-cache] put failed:', e);
        }
    },

    /** Remember that this item has no cover so future renders skip it. */
    async putMissing(key) {
        try {
            const db = await this._open();
            await new Promise((resolve, reject) => {
                const tx = db.transaction(this.STORE, 'readwrite');
                tx.objectStore(this.STORE).put({
                    key,
                    blob: null,
                    missing: true,
                    size: 0,
                    lastAccessed: Date.now(),
                });
                tx.oncomplete = resolve;
                tx.onerror = () => reject(tx.error);
            });
        } catch (e) {
            console.warn('[cover-cache] putMissing failed:', e);
        }
    },

    /** Debounce eviction; bursts of puts only trigger one sweep. */
    _scheduleEviction() {
        if (this._evictTimer) return;
        this._evictTimer = setTimeout(() => {
            this._evictTimer = null;
            this._evict().catch(e => console.warn('[cover-cache] evict failed:', e));
        }, 5000);
    },

    async _evict() {
        const db = await this._open();
        const all = await new Promise((resolve, reject) => {
            const tx = db.transaction(this.STORE, 'readonly');
            const req = tx.objectStore(this.STORE).getAll();
            req.onsuccess = () => resolve(req.result || []);
            req.onerror = () => reject(req.error);
        });

        let total = 0;
        for (const e of all) total += e.size || 0;
        if (total <= this.MAX_BYTES) return;

        // Oldest first.
        all.sort((a, b) => (a.lastAccessed || 0) - (b.lastAccessed || 0));
        const tx = db.transaction(this.STORE, 'readwrite');
        const store = tx.objectStore(this.STORE);
        for (const e of all) {
            if (total <= this.MAX_BYTES) break;
            store.delete(e.key);
            total -= e.size || 0;
        }
        await new Promise((resolve, reject) => {
            tx.oncomplete = resolve;
            tx.onerror = () => reject(tx.error);
        });
    },
};
