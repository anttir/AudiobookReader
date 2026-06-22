# Oman kopion pystytys (self-hosting)

Tämä on forkkaajan ohje: omat Google- ja Cloudflare-tunnukset, oma
hostaus. **Jos haluat vain käyttää sovellusta**, mene
[live-versioon](https://anttir.github.io/AudiobookReader/) — tätä ohjetta ei
tarvita.

Sovellus tarvitsee kolme palaa:
1. **Google Cloud -projekti** (OAuth-client e-kirja/Drive-osille).
2. **Cloudflare Worker** (kirjautumisen backend + R2-proxy).
3. **Staattinen hostaus** sovellukselle (esim. GitHub Pages).

## 1. Google Cloud + OAuth-client

1. [Google Cloud Console](https://console.cloud.google.com/) → **New Project**.
2. **APIs & Services → Library** → ota käyttöön **Google Drive API**.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**
   → tyyppi **Web application**.
   - Tämä on **luottamuksellinen client** (sillä on client secret) — Worker
     käyttää sitä Authorization Code -flow'hun.
4. Talteen: **Client ID** ja **Client secret**.

OAuth consent screenin julkaisutila, redirect URI ja client secretin
asettaminen Workeriin on kuvattu tarkasti kohdassa
**[authentication.md → Setup](authentication.md#setup-oman-kopion-pystytys)** (kohdat 1–4). Tee ne sieltä
— niitä ei toisteta tässä, jotta ohje pysyy ajan tasalla yhdessä paikassa.

## 2. Cloudflare Worker

Worker hoitaa `/auth/*`-kirjautumisen ja yksityisen R2-bucketin välityksen.
Pystytys, sidonnat (`BUCKET`, `ALLOWED_EMAILS`, `GOOGLE_CLIENT_ID`,
`CORS_ALLOWED_ORIGINS`) ja secretti (`GOOGLE_CLIENT_SECRET`):
**[tools/r2-auth-worker/README.md](../tools/r2-auth-worker/README.md)**.

R2-bucketin rakenne ja sisällön upload:
**[uploading-books.md](uploading-books.md)** + [tools/upload-to-r2/](../tools/upload-to-r2/).

## 3. Sovelluksen config

Aseta omat arvosi `js/config.js`:ään:

```javascript
GOOGLE_CLIENT_ID:     '<oma-client-id>.apps.googleusercontent.com',
AUTH_BASE_URL:        'https://<oma-worker>.workers.dev',  // /auth/* täällä
R2_DEFAULT_BASE_URL:  'https://<oma-worker>.workers.dev',  // R2-proxy täällä
GOOGLE_API_KEY:       '<oma-api-key>',                     // Google Picker
```

`AUTH_BASE_URL`:n täytyy täsmätä Workerin osoitteeseen, ja saman osoitteen
`/auth/callback`:n täytyy olla OAuth-clientin **Authorized redirect URI**
(ks. [authentication.md → redirect URI](authentication.md#2-lisää-redirect-uri)).

## 4. Hostaus

### GitHub Pages (suositeltu)
1. Pushaa koodi omaan repoon.
2. **Settings → Pages** → Source: *Deploy from a branch* → **main**, kansio
   `/ (root)`.
3. Lisää Pages-URL (esim. `https://USERNAME.github.io`) Workerin
   `CORS_ALLOWED_ORIGINS`-listaan.
4. Jatkossa push `main`:iin julkaisee automaattisesti (~30 s).

Workerin voi vastaavasti kytkeä deployaamaan Gitistä (Cloudflare Workers
Builds, root `tools/r2-auth-worker`) — ks. [authentication.md → Workerin deploy](authentication.md#4-workerin-deploy).

### Paikallinen kehitys
```bash
python -m http.server 8000   # tai npx serve .  / php -S localhost:8000
```
Lisää `http://localhost:8000` Workerin `CORS_ALLOWED_ORIGINS`-listaan ja
`http://localhost:8000` (+ `/auth/callback` jos ajat Workeria paikallisesti)
OAuth-clientin sallittuihin osoitteisiin.

### Muu staattinen hostaus
Mikä tahansa staattinen hostaus käy (Firebase Hosting, Netlify, Cloudflare
Pages, …) — sovellus on pelkkiä staattisia tiedostoja. Muista lisätä uusi
origin Workerin `CORS_ALLOWED_ORIGINS`-listaan.
