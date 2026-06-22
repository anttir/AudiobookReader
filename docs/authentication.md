# Kirjautuminen ja tietoturva

Sovellus kirjaa käyttäjän sisään Googlella OAuth **Authorization Code + PKCE**
-flow'lla. [Cloudflare Worker](../tools/r2-auth-worker) toimii
luottamuksellisena backendinä: se tekee code-vaihdon, säilyttää Googlen
refresh tokenin ja antaa selaimelle oman session-tokenin. Selaimessa ei
koskaan ole Googlen refresh tokenia.

## Scope-tasot

Oikeudet pyydetään kahdessa tasossa, jotta tavallinen kuuntelu ei vaadi
arkaluonteisia Drive-oikeuksia:

| Taso | Scopet | Milloin | Consent |
|---|---|---|---|
| **Perus** | `openid`, `userinfo.email`, `userinfo.profile` | sisäänkirjautuessa | ei-arkaluonteinen → siisti tilinvalinta |
| **Drive** | `drive.readonly`, `drive.appdata` | vasta kun käyttäjä avaa Google Drive -lähteen | arkaluonteinen → näyttää vahvistamattoman sovelluksen varoituksen |

Perus-taso riittää sekä kirjautumiseen että Cloudflare R2 -kuunteluun
(auth-worker tarkistaa vain että token on voimassa ja sähköposti on
allowlistilla). Drive-taso pyydetään erikseen `js/auth.js`:n
`startDriveUpgrade()`-redirectillä.

## Kirjautumisvirta

1. `Auth.signIn()` tekee koko sivun redirectin `<AUTH_BASE_URL>/auth/login?return=<app-url>`.
2. Worker ohjaa Googlen suostumusruutuun ja vastaanottaa authorization coden
   osoitteeseen `/auth/callback`.
3. Worker vaihtaa coden access- + refresh-tokeniksi, **sinetöi** refresh
   tokenin session-tokeniin ja ohjaa takaisin appiin: `<app-url>#auth=<session>`.
4. SPA lukee fragmentin, tallentaa session-tokenin `localStorage`en ja siivoaa
   fragmentin URL:sta.
5. Kun tarvitaan tuore Google-access-token, SPA kutsuu `POST /auth/token`
   (`Authorization: Bearer <session>`). Worker uusii tokenin refresh tokenilla
   ja palauttaa sen.

Access tokenin uusinta toimii myös iOS Safarissa, koska se on tavallinen
first-party fetch-kutsu — ei kolmannen osapuolen evästettä eikä piiloiframea.

## Worker-endpointit

`/auth/*`-polut; muut polut Worker palvelee R2-proxynä.

| Endpoint | Tehtävä |
|---|---|
| `GET /auth/login` | Luo PKCE-verifierin + `state`-arvon, tallentaa ne lyhytikäiseen first-party-evästeeseen (`abr_login`, HttpOnly, `Path=/auth`), ja ohjaa Googlen authorization-endpointtiin (`access_type=offline`, `prompt=consent`, `scope`, `code_challenge`, `redirect_uri=<worker>/auth/callback`, `state`). `?add=drive` pyytää base+drive-scopet; `?return=<app-url>` muistetaan eväste­tilassa. |
| `GET /auth/callback` | Lukee `abr_login`-evästeen, vahvistaa `state`-arvon, vaihtaa coden (PKCE + client secret) tokeneiksi, tarkistaa että `email` on allowlistilla, sinetöi session-tokenin ja ohjaa appiin `#auth=<session>`. |
| `POST /auth/token` | Purkaa Bearer-session-tokenin, uusii refresh tokenilla ja palauttaa `{ access_token, expires_in, scopes, email, name, picture }` (`Cache-Control: no-store`). 401/403 = sessio mitätön; muut virheet ovat ohimeneviä. |
| `POST /auth/logout` | Purkaa session-tokenin ja revokoi Googlen refresh tokenin (`/revoke`). |

## Session-malli (tilaton)

Selaimelle annettava session-token on **AES-GCM-sinetöity blob**, joka
sisältää refresh tokenin ja käyttäjätiedot. Palvelimella ei ole istuntotilaa
(ei KV:tä):

```
session-token = base64url( AES-GCM-encrypt(
   key = HKDF(GOOGLE_CLIENT_SECRET),
   payload = { refreshToken, email, sub, scopes, name, picture, iat }
))
```

- Salausavain johdetaan `GOOGLE_CLIENT_SECRET`:stä (HKDF), joten erillistä
  avain-secretiä ei tarvita.
- Login-kierroksen PKCE-verifier + `state` kulkevat lyhytikäisessä
  first-party-evästeessä Workerin domainilla (callback on top-level-navigaatio
  Workerin originiin, joten eväste välittyy myös iOS:llä).
- Session-tokenilla on absoluuttinen maksimi-ikä (`iat`-kentästä, 90 vrk),
  minkä jälkeen vaaditaan uudelleenkirjautuminen.

## Suunnitteluvalinnat

- **Refresh token palvelimella, ei selaimessa.** iOS Safarin ITP estää
  kolmannen osapuolen evästeisiin / piiloiframeen nojaavan hiljaisen
  token-uusinnan. Kun refresh token on Workerissa ja uusinta on first-party
  bearer-fetch, kirjautuminen säilyy myös iOS:llä.
- **Session-token `localStorage`ssa, ei evästeessä.** Sovellus ja Worker ovat
  eri sitet (`*.github.io` vs `*.workers.dev`), joten Workerin eväste olisi
  selaimesta katsottuna kolmannen osapuolen eväste (ITP estää
  cross-site-fetchissä). `localStorage` on first-party sovelluksen originiin.
  HttpOnly-eväste­malli olisi mahdollinen, jos sovellus ja Worker hostataan
  saman rekisteröidyn domainin alle.
- **OAuth-sovellus "In production" -tilassa.** "Testing"-tilassa Google antaa
  refresh tokeneita, jotka vanhenevat 7 vrk:ssa. Tuotantotila poistaa tämän;
  ei-arkaluonteiset perus-scopet eivät vaadi Google-verifiointia.

## Tietoturva

- `GOOGLE_CLIENT_SECRET` on vain Workerin secret — ei koskaan repossa eikä SPA:ssa.
- **PKCE** suojaa authorization coden; **state** estää CSRF:n callbackissa.
- Refresh token on AES-GCM-salattuna session-tokenin sisällä; tunniste estää
  peukaloinnin (muokattu token hylätään).
- `/auth/token` vastaa `Cache-Control: no-store` — access tokenia ei talleteta
  välimuisteihin. CORS sallii vain app-originit.
- Sähköpostin allowlist tarkistetaan `/auth/callback`issa ja R2-fetchissä.
- **XSS-huomio:** session-token `localStorage`ssa on pitkäikäinen
  bearer-kredentiaali (sisältää sinetöidyn refresh tokenin). Jos XSS on
  uhkamallissa, same-site HttpOnly-eväste­malli pienentää vahinkosädettä.

## Tunnetut rajoitteet

- **Drive-scopet ovat arkaluonteisia/restricted.** Vahvistamattomana
  sovelluksena Google näyttää varoituksen Drive-luvan kohdalla ja rajaa
  käyttäjämäärän ~100:aan. Varoituksen saa pois vain Googlen verifioinnilla
  (brändi + restricted-scopejen tietoturva-arvio). R2-vain-käyttäjät eivät
  kohtaa varoitusta.
- **Aiemmin myönnetyt oikeudet säilyvät Google-tilillä.** Jos tili on joskus
  myöntänyt Drive-luvan, se näkyy tilin yhdistetyissä sovelluksissa, kunnes
  käyttäjä poistaa sen ([myaccount.google.com/permissions](https://myaccount.google.com/permissions)).
  Sovellus tarjoaa tähän ohjeen kirjautumisnäkymässä ja asetuksissa.
- **Per-laite-uloskirjautumista ei ole.** Tilattomassa mallissa `/auth/logout`
  revokoi refresh tokenin Googlella (kaikki laitteet). Per-laite-revokointi
  vaatisi palvelinpuolen istuntovaraston (esim. Cloudflare KV).
- **iOS `localStorage`-eviktio:** jos sovellusta ei avata ~7 vrk:aan Safarissa
  (ei home-screen-PWA), selain voi tyhjentää script-writable-säilön → yksi
  uudelleenkirjautuminen.

---

## Setup (oman kopion pystytys)

Forkkaajalle. Sovelluksen oma OAuth-client tunnistetaan client ID:stä, joka
on `js/config.js`:ssä (`GOOGLE_CLIENT_ID`). Worker-osoite on
`AUTH_BASE_URL`/`R2_DEFAULT_BASE_URL`. Yleinen pystytys:
[self-hosting.md](self-hosting.md).

### 1. Julkaise OAuth-sovellus tuotantoon

[Google Auth Platform → Audience](https://console.cloud.google.com/auth/audience)
→ **Publish app** → **Confirm**. Status: **In production**. Tämä estää refresh
tokenien 7 vrk:n vanhenemisen. (Verifiointia ei tarvita; Drive-scope näyttää
silti varoituksen.)

### 2. Lisää redirect URI

[Google Auth Platform → Clients](https://console.cloud.google.com/auth/clients)
→ OAuth Web client → **Authorized redirect URIs** → lisää
`https://<worker>/auth/callback` (esim.
`https://audiobookreader-r2.audiobooks.workers.dev/auth/callback`). Tämä on eri
asia kuin "Authorized JavaScript origins". Paikalliskehitykseen voi lisätä myös
`http://localhost:8787/auth/callback`.

### 3. Aseta Workerin secret

Hae client secret samalta client-sivulta (`GOCSPX-…`) ja tallenna se Workerin
secretiksi `GOOGLE_CLIENT_SECRET`:

- **Komentorivi:** `cd tools/r2-auth-worker && npx wrangler secret put GOOGLE_CLIENT_SECRET`
- **Dashboard (ilman komentoriviä):** [dash.cloudflare.com](https://dash.cloudflare.com)
  → Workers & Pages → worker → **Settings → Variables and Secrets** → Add →
  Type **Secret** → `GOOGLE_CLIENT_SECRET` → Save/Deploy.

Tämä on ainoa pakollinen uusi secret — session-salausavain johdetaan siitä,
joten KV:tä tai erillistä avainta ei tarvita.

### 4. Workerin deploy

Yksinkertaisinta on kytkeä Worker deployaamaan Gitistä: dash.cloudflare.com →
worker → **Settings → Build → Connect** → repo, **Root directory** =
`tools/r2-auth-worker`. Tämän jälkeen push julkaisee Workerin automaattisesti.
Vaihtoehtoisesti `npx wrangler deploy` `tools/r2-auth-worker/`-hakemistossa.

### Tarkistuslista

- [ ] Audience: **In production**
- [ ] Redirect URI `…/auth/callback` lisätty
- [ ] `GOOGLE_CLIENT_SECRET` Workerin secrettinä
- [ ] Worker deployattu (Git-yhteys tai `wrangler deploy`)
- [ ] `js/config.js`: `GOOGLE_CLIENT_ID`, `AUTH_BASE_URL`, `R2_DEFAULT_BASE_URL`
- [ ] Workerin `CORS_ALLOWED_ORIGINS` sisältää sovelluksen originin
