/**
 * Extract an EPUB cover image without downloading the whole file.
 *
 * Strategy: an EPUB is a regular ZIP archive. ZIP has its file table
 * (central directory) at the END of the file, so we can fetch just the
 * tail and then issue follow-up ranged requests for the few entries we
 * actually need.
 *
 * Steps per book:
 *   1. Fetch last ~64 KB → locate End of Central Directory (EOCD) →
 *      parse central directory.
 *   2. Range-fetch META-INF/container.xml → find the OPF path.
 *   3. Range-fetch the OPF file → find the cover image href.
 *   4. Range-fetch the cover image entry → inflate if DEFLATEd → Blob.
 *
 * Bandwidth: typically 50–200 KB per book, vs 1–20 MB for a full
 * download. Tradeoff is a handful of HTTP round-trips per book.
 *
 * Limitations:
 *   - Only standard ZIP32 (no ZIP64). EPUB spec technically permits
 *     ZIP64 but in practice all EPUBs are well under 4 GB and use ZIP32.
 *   - Only DEFLATE (method 8) and Stored (method 0). EPUB spec forbids
 *     other compression methods.
 *   - Filenames are decoded as UTF-8. Older EPUBs may use CP437, but
 *     EPUB3 mandates UTF-8 and EPUB2 in practice uses ASCII.
 */
const EpubCover = {
    /**
     * Fetch the cover for an EPUB on Google Drive.
     * @param {string} fileId   Drive fileId
     * @param {number} fileSize total bytes (from Drive metadata)
     * @returns {Promise<Blob|null>} cover Blob, or null if none / on error
     */
    async fetchFromDrive(fileId, fileSize) {
        if (!fileId || !fileSize || fileSize < 100) return null;
        const url = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
        const fetcher = (start, end) => this._fetchDriveRange(url, start, end, fileSize);
        return this._extract(fetcher, fileSize);
    },

    async _extract(fetcher, fileSize) {
        try {
            const cd = await this._readCentralDirectory(fetcher, fileSize);
            if (!cd) return null;

            const containerEntry = cd.entries.find(e => e.name === 'META-INF/container.xml');
            if (!containerEntry) return null;
            const containerBytes = await this._readEntry(fetcher, containerEntry);
            if (!containerBytes) return null;
            const opfPath = this._parseContainer(this._decodeUtf8(containerBytes));
            if (!opfPath) return null;

            const opfEntry = cd.entries.find(e => e.name === opfPath);
            if (!opfEntry) return null;
            const opfBytes = await this._readEntry(fetcher, opfEntry);
            if (!opfBytes) return null;
            const coverInfo = this._parseOpfForCover(this._decodeUtf8(opfBytes), opfPath);
            if (!coverInfo) return null;

            const coverEntry = cd.entries.find(e => e.name === coverInfo.path);
            if (!coverEntry) return null;
            const coverBytes = await this._readEntry(fetcher, coverEntry);
            if (!coverBytes) return null;

            return new Blob([coverBytes], { type: coverInfo.mediaType || 'image/jpeg' });
        } catch (e) {
            console.warn('[epub-cover] extraction failed:', e);
            return null;
        }
    },

    // ---- HTTP --------------------------------------------------------------

    async _fetchDriveRange(url, start, end, totalSize) {
        if (end >= totalSize) end = totalSize - 1;
        if (start < 0) start = 0;
        const token = (typeof Auth !== 'undefined') ? Auth.getAccessToken() : null;
        const headers = { 'Range': `bytes=${start}-${end}` };
        if (token) headers['Authorization'] = `Bearer ${token}`;
        const res = await fetch(url, { headers });
        if (!(res.ok || res.status === 206)) {
            throw new Error(`Range fetch failed: ${res.status}`);
        }
        return new Uint8Array(await res.arrayBuffer());
    },

    // ---- ZIP parsing -------------------------------------------------------

    /**
     * Locate EOCD and return the parsed central directory entries.
     */
    async _readCentralDirectory(fetcher, fileSize) {
        // EOCD is 22 bytes minimum, plus up to 65535 bytes of trailing
        // comment. Grab the whole possible region in one fetch.
        const tailSize = Math.min(fileSize, 22 + 65535);
        const tailStart = fileSize - tailSize;
        const tail = await fetcher(tailStart, fileSize - 1);

        const eocdOffset = this._findEocd(tail);
        if (eocdOffset < 0) return null;

        const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
        const totalEntries = dv.getUint16(eocdOffset + 10, true);
        const cdSize = dv.getUint32(eocdOffset + 12, true);
        const cdOffset = dv.getUint32(eocdOffset + 16, true);

        let cdBytes;
        if (cdOffset >= tailStart) {
            // Central directory is already in the tail we just fetched.
            const localStart = cdOffset - tailStart;
            cdBytes = tail.subarray(localStart, localStart + cdSize);
        } else {
            cdBytes = await fetcher(cdOffset, cdOffset + cdSize - 1);
        }

        const entries = this._parseCentralDirectory(cdBytes, totalEntries);
        return { entries };
    },

    /** Scan tail backwards for the EOCD signature 0x06054b50 ("PK\x05\x06"). */
    _findEocd(tail) {
        for (let i = tail.length - 22; i >= 0; i--) {
            if (
                tail[i] === 0x50 && tail[i + 1] === 0x4b &&
                tail[i + 2] === 0x05 && tail[i + 3] === 0x06
            ) {
                return i;
            }
        }
        return -1;
    },

    /**
     * Parse Central Directory File Header records. Returns an array of
     * { name, method, compressedSize, localOffset } — the minimum needed
     * to range-fetch and decompress each entry.
     */
    _parseCentralDirectory(buf, expectedEntries) {
        const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
        const entries = [];
        let p = 0;
        while (p + 46 <= buf.length) {
            if (dv.getUint32(p, true) !== 0x02014b50) break;
            const method = dv.getUint16(p + 10, true);
            const compressedSize = dv.getUint32(p + 20, true);
            const nameLen = dv.getUint16(p + 28, true);
            const extraLen = dv.getUint16(p + 30, true);
            const commentLen = dv.getUint16(p + 32, true);
            const localOffset = dv.getUint32(p + 42, true);
            const name = this._decodeUtf8(buf.subarray(p + 46, p + 46 + nameLen));
            entries.push({ name, method, compressedSize, localOffset });
            p += 46 + nameLen + extraLen + commentLen;
            if (entries.length >= expectedEntries) break;
        }
        return entries;
    },

    /**
     * Read & decompress a single ZIP entry. Issues two range fetches:
     * one for the local file header (variable-length fields) and one
     * for the compressed data.
     */
    async _readEntry(fetcher, entry) {
        const headStart = entry.localOffset;
        const headBytes = await fetcher(headStart, headStart + 29);
        const dv = new DataView(headBytes.buffer, headBytes.byteOffset, headBytes.byteLength);
        if (dv.getUint32(0, true) !== 0x04034b50) return null;
        const localNameLen = dv.getUint16(26, true);
        const localExtraLen = dv.getUint16(28, true);
        const dataStart = headStart + 30 + localNameLen + localExtraLen;
        const dataEnd = dataStart + entry.compressedSize - 1;
        const compressed = await fetcher(dataStart, dataEnd);

        if (entry.method === 0) return compressed;
        if (entry.method === 8) return this._inflateRaw(compressed);
        // Other compression methods are out of spec for EPUB; bail.
        return null;
    },

    async _inflateRaw(bytes) {
        if (typeof DecompressionStream === 'undefined') {
            throw new Error('DecompressionStream not supported in this browser');
        }
        const stream = new Response(bytes).body
            .pipeThrough(new DecompressionStream('deflate-raw'));
        return new Uint8Array(await new Response(stream).arrayBuffer());
    },

    // ---- EPUB XML helpers --------------------------------------------------

    /** Parse META-INF/container.xml → full-path of the OPF file. */
    _parseContainer(xml) {
        try {
            const doc = new DOMParser().parseFromString(xml, 'application/xml');
            const rootfile = doc.getElementsByTagName('rootfile')[0];
            return rootfile?.getAttribute('full-path') || null;
        } catch { return null; }
    },

    /**
     * Find the cover image in an OPF manifest.
     *
     * EPUB3: manifest <item> carrying properties="cover-image".
     * EPUB2: <meta name="cover" content="ID"> in metadata, then look up
     *        the matching <item id="ID"> in manifest.
     *
     * Returns { path, mediaType } with `path` relative to the archive
     * root (OPF directory + href, ../ resolved).
     */
    _parseOpfForCover(opfXml, opfPath) {
        let doc;
        try {
            doc = new DOMParser().parseFromString(opfXml, 'application/xml');
        } catch { return null; }

        const opfDir = opfPath.includes('/') ? opfPath.replace(/[^/]+$/, '') : '';
        const items = Array.from(doc.getElementsByTagName('item'));

        // EPUB3 path.
        let coverItem = items.find(it => {
            const props = (it.getAttribute('properties') || '').split(/\s+/);
            return props.includes('cover-image');
        });

        // EPUB2 fallback.
        if (!coverItem) {
            const metas = Array.from(doc.getElementsByTagName('meta'));
            const coverMeta = metas.find(m => m.getAttribute('name') === 'cover');
            const coverId = coverMeta?.getAttribute('content');
            if (coverId) coverItem = items.find(it => it.getAttribute('id') === coverId);
        }

        if (!coverItem) return null;
        const href = coverItem.getAttribute('href');
        if (!href) return null;
        const mediaType = coverItem.getAttribute('media-type') || 'image/jpeg';
        return { path: this._normalisePath(opfDir + decodeURIComponent(href)), mediaType };
    },

    /** Resolve '.', '..' and double slashes within a ZIP-internal path. */
    _normalisePath(p) {
        const segs = p.split('/');
        const out = [];
        for (const s of segs) {
            if (s === '.' || s === '') continue;
            if (s === '..') out.pop();
            else out.push(s);
        }
        return out.join('/');
    },

    _decodeUtf8(bytes) {
        return new TextDecoder('utf-8').decode(bytes);
    },
};
