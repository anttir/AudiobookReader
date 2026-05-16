/**
 * AudiobookReader R2 Auth Proxy (Cloudflare Worker)
 *
 * Acts as an authenticated front door to a private R2 bucket. The Worker:
 *   1. Reads a Google OAuth access token from `Authorization: Bearer ...`
 *      (HLS / fetch requests) or the `?_token=` query param (for
 *      <audio src> / <img src> use cases where headers cannot be set).
 *   2. Verifies the token against Google's tokeninfo endpoint and checks
 *      the resolved email against an allowlist.
 *   3. Streams the requested object from the bound R2 bucket, forwarding
 *      Range / If-None-Match headers so HLS byte-range fetches keep
 *      working.
 *
 * Verified token → email lookups are cached in `caches.default` for up to
 * 5 minutes (or until the token would expire, whichever is sooner) so
 * playback doesn't ping Google's tokeninfo on every single segment.
 *
 * The Worker URL becomes the value of the R2 base URL in the web app's
 * settings, replacing the pub-*.r2.dev URL.
 */

const TOKEN_CACHE_MAX_TTL_S = 300;

export default {
    /**
     * @param {Request} request
     * @param {{ BUCKET: R2Bucket, ALLOWED_EMAILS?: string, CORS_ALLOWED_ORIGINS?: string, GOOGLE_CLIENT_ID?: string }} env
     * @param {ExecutionContext} ctx
     */
    async fetch(request, env, ctx) {
        const origin = request.headers.get('Origin') || '';
        const cors = buildCorsHeaders(origin, env);

        if (request.method === 'OPTIONS') {
            return new Response(null, { status: 204, headers: cors });
        }
        if (request.method !== 'GET' && request.method !== 'HEAD') {
            return json({ error: 'method_not_allowed' }, 405, cors);
        }

        const url = new URL(request.url);
        const key = url.pathname.replace(/^\/+/, '');
        if (!key) return json({ error: 'no_key' }, 400, cors);

        // --- authn -----------------------------------------------------
        const token = extractToken(request, url);
        if (!token) {
            return json({ error: 'missing_token' }, 401, cors);
        }

        const verified = await verifyGoogleToken(token, env, ctx);
        if (!verified.ok) {
            return json({ error: 'invalid_token', detail: verified.error }, 401, cors);
        }

        const allowList = (env.ALLOWED_EMAILS || '')
            .split(',').map(s => s.trim()).filter(Boolean);
        if (!allowList.includes(verified.email)) {
            return json({ error: 'forbidden', email: verified.email }, 403, cors);
        }

        // --- fetch from R2 --------------------------------------------
        const rangeArg = parseRange(request.headers.get('Range'));
        const obj = await env.BUCKET.get(key, rangeArg ? { range: rangeArg } : undefined);
        if (!obj) {
            return new Response('Not Found', { status: 404, headers: cors });
        }

        const respHeaders = new Headers(cors);
        obj.writeHttpMetadata(respHeaders);
        respHeaders.set('etag', obj.httpEtag);
        respHeaders.set('accept-ranges', 'bytes');
        // Worker output is per-user-authenticated → must not be shared-cached
        respHeaders.set('cache-control', 'private, max-age=0, must-revalidate');

        // Partial response when Range was requested
        if (obj.range) {
            const start = obj.range.offset || 0;
            const length = obj.range.length ?? (obj.size - start);
            const end = start + length - 1;
            respHeaders.set('content-range', `bytes ${start}-${end}/${obj.size}`);
            respHeaders.set('content-length', String(length));
            return new Response(request.method === 'HEAD' ? null : obj.body, {
                status: 206, headers: respHeaders,
            });
        }
        respHeaders.set('content-length', String(obj.size));
        return new Response(request.method === 'HEAD' ? null : obj.body, {
            status: 200, headers: respHeaders,
        });
    },
};

/** Pull bearer token from header or `?_token=` query (for <audio src>). */
function extractToken(request, url) {
    const auth = request.headers.get('Authorization') || '';
    const m = auth.match(/^Bearer\s+(.+)$/i);
    if (m) return m[1];
    const q = url.searchParams.get('_token');
    return q || null;
}

/**
 * Verify a Google OAuth access token against the tokeninfo endpoint.
 * Caches the email lookup in `caches.default` keyed by SHA-256(token).
 * Returns { ok: true, email } or { ok: false, error }.
 */
async function verifyGoogleToken(token, env, ctx) {
    const cache = caches.default;
    const cacheKey = await tokenCacheKey(token);
    const cached = await cache.match(cacheKey);
    if (cached) {
        const data = await cached.json();
        return { ok: true, email: data.email };
    }

    const resp = await fetch(
        `https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=${encodeURIComponent(token)}`,
        // Don't let Cloudflare cache the unauthenticated lookup itself
        { cf: { cacheTtl: 0 } },
    );
    if (!resp.ok) {
        return { ok: false, error: `tokeninfo_http_${resp.status}` };
    }
    const info = await resp.json();
    if (info.error_description) return { ok: false, error: info.error_description };
    if (!info.email) return { ok: false, error: 'no_email_in_token' };

    // Optional audience binding so a token issued for a different OAuth app
    // can't be replayed against us.
    if (env.GOOGLE_CLIENT_ID && info.aud !== env.GOOGLE_CLIENT_ID) {
        return { ok: false, error: 'audience_mismatch' };
    }

    const exp = parseInt(info.exp || '0', 10);
    const remaining = Math.max(0, exp - Math.floor(Date.now() / 1000));
    const ttl = Math.min(TOKEN_CACHE_MAX_TTL_S, Math.max(0, remaining - 30));
    if (ttl > 10) {
        const cacheResp = new Response(JSON.stringify({ email: info.email }), {
            headers: { 'Cache-Control': `public, max-age=${ttl}`, 'Content-Type': 'application/json' },
        });
        ctx.waitUntil(cache.put(cacheKey, cacheResp));
    }
    return { ok: true, email: info.email };
}

async function tokenCacheKey(token) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(token));
    const hex = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    // caches.default requires a Request with an http(s) URL
    return new Request(`https://r2-auth-cache.invalid/${hex}`);
}

/** Parse "bytes=START-END?" into the shape R2.get expects. */
function parseRange(header) {
    if (!header) return null;
    const m = header.match(/^bytes=(\d+)-(\d*)$/);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    if (Number.isNaN(start)) return null;
    if (m[2]) {
        const end = parseInt(m[2], 10);
        if (Number.isNaN(end) || end < start) return null;
        return { offset: start, length: end - start + 1 };
    }
    return { offset: start };
}

function buildCorsHeaders(origin, env) {
    const allowed = (env.CORS_ALLOWED_ORIGINS || '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '');
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Range, Content-Type, If-None-Match',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, ETag',
        'Access-Control-Max-Age': '3600',
    };
}

function json(obj, status, headers) {
    return new Response(JSON.stringify(obj), {
        status,
        headers: { ...headers, 'Content-Type': 'application/json' },
    });
}
