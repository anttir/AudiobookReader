/**
 * AudiobookReader Worker (Cloudflare)
 *
 * Two responsibilities, routed by path:
 *
 *   /auth/*  — OAuth 2.0 Authorization Code + PKCE backend. The Worker is a
 *              confidential client: it holds the Google client secret,
 *              exchanges the auth code for an access + refresh token, and
 *              hands the browser an opaque, encrypted **session token**
 *              (stateless — the refresh token is sealed inside it). The SPA
 *              stores that in localStorage and calls /auth/token to mint a
 *              fresh Google access token whenever it needs one. This is what
 *              makes token refresh work on iOS Safari, where the old GIS
 *              hidden-iframe silent refresh is blocked by ITP.
 *
 *   everything else — the original authenticated R2 proxy: verifies a Google
 *              access token (header or ?_token=), checks the email allowlist,
 *              and streams the requested R2 object (with Range support).
 *
 * Session tokens are encrypted with an AES-GCM key derived (HKDF) from
 * GOOGLE_CLIENT_SECRET, so there is no separate key to provision and no KV
 * namespace — the session is self-contained. PKCE verifier + state for the
 * login round-trip ride in a short-lived first-party cookie on this domain.
 *
 * Required config (see wrangler.toml / dashboard):
 *   - GOOGLE_CLIENT_ID   (var)    OAuth web client id
 *   - GOOGLE_CLIENT_SECRET (secret) OAuth web client secret  ← new
 *   - ALLOWED_EMAILS     (var)    comma-separated allowlist
 *   - CORS_ALLOWED_ORIGINS (var)  app origins (also used for /auth CORS)
 *   - APP_ORIGINS        (var, optional) overrides allowed return origins
 *   - BUCKET             (binding) R2 bucket
 */

const TOKEN_CACHE_MAX_TTL_S = 300;

// Scope tiers — mirror js/config.js. Base is non-sensitive (clean consent +
// enough for R2). Drive is requested incrementally via /auth/login?add=drive.
const SCOPE_BASE =
    'openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/userinfo.profile';
const SCOPE_DRIVE =
    'https://www.googleapis.com/auth/drive.readonly https://www.googleapis.com/auth/drive.appdata';

// A session token older than this must re-authenticate.
const SESSION_MAX_AGE_MS = 90 * 24 * 3600 * 1000;

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        if (url.pathname.startsWith('/auth/')) {
            try {
                switch (url.pathname) {
                    case '/auth/login':    return await handleAuthLogin(request, env, url);
                    case '/auth/callback': return await handleAuthCallback(request, env, url);
                    case '/auth/token':    return await handleAuthToken(request, env);
                    case '/auth/logout':   return await handleAuthLogout(request, env);
                    default:               return new Response('not found', { status: 404 });
                }
            } catch (e) {
                // Never leak secrets in error text.
                return new Response(`auth_error: ${e?.message || 'unknown'}`, { status: 500 });
            }
        }
        return handleR2(request, env, ctx);
    },
};

// =====================================================================
// Auth: Authorization Code + PKCE, stateless encrypted sessions
// =====================================================================

/** GET /auth/login?return=<app-url>&add=drive — redirect to Google consent. */
async function handleAuthLogin(request, env, url) {
    if (!env.GOOGLE_CLIENT_SECRET) {
        return new Response('GOOGLE_CLIENT_SECRET not configured', { status: 500 });
    }
    const ret = url.searchParams.get('return') || '';
    const allowedOrigins = appOrigins(env);
    if (!isAllowedReturn(ret, allowedOrigins)) {
        return new Response('invalid return url', { status: 400 });
    }

    const add = url.searchParams.get('add');
    const scope = add === 'drive' ? `${SCOPE_BASE} ${SCOPE_DRIVE}` : SCOPE_BASE;

    const key = await sessionKey(env);
    const verifier = randomB64url(32);
    const challenge = await s256(verifier);
    const state = randomB64url(16);
    const redirectUri = `${url.origin}/auth/callback`;

    // Stash verifier + state + return target in a short-lived first-party
    // cookie. It is sent back on the top-level navigation from Google, so
    // it survives iOS ITP (first-party, top-level context).
    const stateCookie = await seal({ verifier, state, ret, add: add || '' }, key);

    const auth = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    auth.searchParams.set('client_id', env.GOOGLE_CLIENT_ID);
    auth.searchParams.set('redirect_uri', redirectUri);
    auth.searchParams.set('response_type', 'code');
    auth.searchParams.set('scope', scope);
    auth.searchParams.set('access_type', 'offline');     // → refresh token
    auth.searchParams.set('prompt', 'consent');          // ensure refresh token issued
    auth.searchParams.set('include_granted_scopes', 'true');
    auth.searchParams.set('state', state);
    auth.searchParams.set('code_challenge', challenge);
    auth.searchParams.set('code_challenge_method', 'S256');

    const headers = new Headers({ Location: auth.toString() });
    headers.append('Set-Cookie', loginCookie(encodeURIComponent(stateCookie), 600));
    return new Response(null, { status: 302, headers });
}

/** GET /auth/callback — exchange code, seal session, redirect back to app. */
async function handleAuthCallback(request, env, url) {
    const key = await sessionKey(env);
    const cookie = getCookie(request, 'abr_login');
    const clear = loginCookie('', 0);

    let st;
    try {
        st = await open(cookie, key);
    } catch (_e) {
        return new Response('login session expired, please retry', {
            status: 400, headers: { 'Set-Cookie': clear },
        });
    }

    // From here we can redirect back into the app with an error or, on
    // success, the session token in the fragment. Mark no-store so the
    // redirect (which may carry #auth=<session>) is never cached.
    const back = (frag) => new Response(null, {
        status: 302,
        headers: new Headers([
            ['Location', `${st.ret}#${frag}`],
            ['Set-Cookie', clear],
            ['Cache-Control', 'no-store'],
        ]),
    });

    const err = url.searchParams.get('error');
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    if (err) return back(`auth_error=${encodeURIComponent(err)}`);
    if (!code || !state || state !== st.state) return back('auth_error=state_mismatch');

    const redirectUri = `${url.origin}/auth/callback`;
    const tokenResp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            redirect_uri: redirectUri,
            grant_type: 'authorization_code',
            code_verifier: st.verifier,
        }),
    });
    if (!tokenResp.ok) return back('auth_error=token_exchange');
    const tok = await tokenResp.json();
    if (!tok.refresh_token) return back('auth_error=no_refresh_token');

    const ui = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    if (!ui.ok) return back('auth_error=userinfo');
    const info = await ui.json();

    const allow = parseList(env.ALLOWED_EMAILS);
    if (!info.email || !allow.includes(info.email)) return back('auth_error=forbidden');

    const session = await seal({
        rt: tok.refresh_token,
        email: info.email,
        sub: info.sub,
        name: info.name,
        picture: info.picture,
        scopes: tok.scope || '',
        iat: Date.now(),
    }, key);

    return back(`auth=${encodeURIComponent(session)}`);
}

/** POST /auth/token — session token in → fresh Google access token out. */
async function handleAuthToken(request, env) {
    const cors = authCors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    const session = bearer(request);
    if (!session) return json({ error: 'missing_session' }, 401, cors);

    const key = await sessionKey(env);
    let s;
    try { s = await open(session, key); } catch (_e) { return json({ error: 'invalid_session' }, 401, cors); }
    if (!s.iat || Date.now() - s.iat > SESSION_MAX_AGE_MS) {
        return json({ error: 'session_expired' }, 401, cors);
    }

    const r = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: env.GOOGLE_CLIENT_ID,
            client_secret: env.GOOGLE_CLIENT_SECRET,
            grant_type: 'refresh_token',
            refresh_token: s.rt,
        }),
    });
    if (!r.ok) {
        // invalid_grant = refresh token revoked/expired → user must re-login.
        return json({ error: 'refresh_failed' }, 401, cors);
    }
    const t = await r.json();
    return json({
        access_token: t.access_token,
        expires_in: t.expires_in,
        scopes: t.scope || s.scopes || '',
        email: s.email,
        name: s.name,
        picture: s.picture,
    }, 200, cors);
}

/** POST /auth/logout — revoke the refresh token at Google. */
async function handleAuthLogout(request, env) {
    const cors = authCors(request, env);
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, cors);

    const session = bearer(request);
    if (session) {
        try {
            const key = await sessionKey(env);
            const s = await open(session, key);
            if (s.rt) {
                await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(s.rt)}`,
                    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
            }
        } catch (_e) { /* best effort */ }
    }
    return new Response(null, { status: 204, headers: cors });
}

// --- auth helpers ----------------------------------------------------

function appOrigins(env) {
    return parseList(env.APP_ORIGINS || env.CORS_ALLOWED_ORIGINS);
}

function isAllowedReturn(ret, origins) {
    if (!ret) return false;
    try { return origins.includes(new URL(ret).origin); } catch (_e) { return false; }
}

function loginCookie(value, maxAge) {
    return `abr_login=${value}; Path=/auth; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

function getCookie(request, name) {
    const h = request.headers.get('Cookie') || '';
    const m = h.match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : null;
}

function bearer(request) {
    const m = (request.headers.get('Authorization') || '').match(/^Bearer\s+(.+)$/i);
    return m ? m[1] : null;
}

function authCors(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = parseList(env.CORS_ALLOWED_ORIGINS);
    const allowOrigin = allowed.includes(origin) ? origin : (allowed[0] || '');
    return {
        'Access-Control-Allow-Origin': allowOrigin,
        'Vary': 'Origin',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Authorization, Content-Type',
        'Access-Control-Max-Age': '3600',
        // /auth/token returns a fresh OAuth access token — never let any
        // cache (browser or intermediary) store it.
        'Cache-Control': 'no-store',
        'Pragma': 'no-cache',
    };
}

// --- crypto: HKDF key + AES-GCM seal/open + PKCE ---------------------

let _sessionKeyPromise = null;
function sessionKey(env) {
    // Cached per isolate; the secret is constant for the deployment.
    if (_sessionKeyPromise) return _sessionKeyPromise;
    _sessionKeyPromise = (async () => {
        const secret = env.GOOGLE_CLIENT_SECRET;
        if (!secret) throw new Error('GOOGLE_CLIENT_SECRET not configured');
        const enc = new TextEncoder();
        const base = await crypto.subtle.importKey('raw', enc.encode(secret), 'HKDF', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'HKDF', hash: 'SHA-256', salt: enc.encode('abr-session-v1'), info: enc.encode('aes-gcm') },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt'],
        );
    })();
    return _sessionKeyPromise;
}

async function seal(obj, key) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const pt = new TextEncoder().encode(JSON.stringify(obj));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, pt);
    return `v1.${b64urlEncode(iv)}.${b64urlEncode(ct)}`;
}

async function open(token, key) {
    const parts = String(token || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('bad token format');
    const iv = b64urlDecode(parts[1]);
    const ct = b64urlDecode(parts[2]);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ct);
    return JSON.parse(new TextDecoder().decode(pt));
}

function randomB64url(n) {
    return b64urlEncode(crypto.getRandomValues(new Uint8Array(n)));
}

async function s256(verifier) {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
    return b64urlEncode(d);
}

function b64urlEncode(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(str) {
    let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
    while (s.length % 4) s += '=';
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function parseList(v) {
    return (v || '').split(',').map(s => s.trim()).filter(Boolean);
}

// =====================================================================
// R2 proxy (unchanged behaviour)
// =====================================================================

async function handleR2(request, env, ctx) {
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

    const allowList = parseList(env.ALLOWED_EMAILS);
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
    respHeaders.set('cache-control', 'private, max-age=0, must-revalidate');

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
}

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
        { cf: { cacheTtl: 0 } },
    );
    if (!resp.ok) {
        return { ok: false, error: `tokeninfo_http_${resp.status}` };
    }
    const info = await resp.json();
    if (info.error_description) return { ok: false, error: info.error_description };
    if (!info.email) return { ok: false, error: 'no_email_in_token' };

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
    const allowed = parseList(env.CORS_ALLOWED_ORIGINS);
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
