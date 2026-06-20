# Kirjautumisen lopullinen korjaus — suunnitelma

> Tila: **toteutettu branchissa `claude/ios-auth-audiobook-bugs-yguiks`**,
> odottaa (a) sinun manuaaliset askeleet (Liite A, kohdat 1–4) ja (b)
> branchin yhdistämistä `main`:iin (jolloin SPA → GitHub Pages ja Worker →
> Cloudflare deployautuvat). Worker (`/auth/*`) ja SPA (`js/auth.js`
> redirect + `/auth/token`) ovat valmiina. Tämä dokumentti kuvaa miten
> kirjautumisongelma ratkaistaan lopullisesti, myös iOS Safarissa.

## 1. Mistä ongelma johtuu (juurisyy)

Sovellus käyttää Google Identity Servicesin (GIS) **token clientiä** eli
OAuthin *implicit / token flow* -varianttia:

- Selain saa suoraan **access tokenin** (~60 min voimassa). **Refresh
  tokenia ei koskaan anneta selaimelle** — token flow ei tue sitä.
- Tokenin "hiljainen" uusinta tehdään GIS:n piilotetulla iframella
  (`requestAccessToken({ prompt: '' })`). Se nojaa Googlen
  istuntoevästeeseen `accounts.google.com`-domainilla **kolmannen
  osapuolen kontekstissa**.
- **iOS Safarin ITP** (Intelligent Tracking Prevention) estää kolmannen
  osapuolen evästeet ja tämän iframe-pohjaisen uusinnan. → uusinta
  epäonnistuu → token vanhenee ~tunnissa → `softSignOut` → uudelleen­
  kirjautuminen. R2-äänikirja katkeaa kun seuraava segmenttipyyntö saa
  401:n.

Tätä **ei voi korjata pelkällä front-endillä** tässä flow'ssa, koska
selaimessa ei ole refresh tokenia eikä luotettavaa hiljaista uusintaa
iOS:llä.

Lisäksi on toinen, erillinen rajoite:

- Kun OAuth-sovelluksen **julkaisutila on "Testing"**, Google antaa
  refresh tokeneita jotka **vanhenevat 7 vrk:ssa** — riippumatta
  scopeista. Tämä on tukiasema "miksi pitää kirjautua uudelleen viikoittain
  vaikka olisi refresh token".

Lopullinen ratkaisu vaatii **molempien** rajoitteiden poistamisen.

## 2. Ratkaisun ydin

Siirrytään selaimen implicit-flow'sta **Authorization Code + PKCE**
-flow'hun, jossa **Cloudflare Worker** (laajennettu nykyisestä
r2-auth-workerista) toimii luottamuksellisena backendinä:

1. Selain käynnistää kirjautumisen → Google näyttää suostumusruudun.
2. Google palauttaa **authorization coden** Workerin callback-osoitteeseen.
3. Worker vaihtaa coden Googlen token-endpointissa (client secret + PKCE)
   **access tokeniksi + refresh tokeniksi**.
4. Worker **sinetöi refresh tokenin selaimelle annettavaan
   session-tokeniin** (AES-GCM, avain johdettu `GOOGLE_CLIENT_SECRET`:stä).
   Session on **tilaton** — refresh token kulkee sinetöitynä itse
   tokenissa, ei palvelimen KV-säilössä (ks. §4.2).
5. Kun sovellus tarvitsee tuoreen Google-access-tokenin, se kutsuu Workerin
   `/auth/token`-endpointtia session-tokenilla; Worker purkaa sinetin,
   uusii tokenin refresh tokenilla palvelin-palvelin-kutsuna ja palauttaa
   sen.

Tämä poistaa iOS-ongelman, koska uusinta **ei enää nojaa kolmannen
osapuolen evästeisiin eikä piiloiframeen** — se on tavallinen
fetch-kutsu, jossa kredentiaali kulkee `Authorization`-headerissa.

### Miksi session-token localStoragessa eikä eväste?

Sovellus on `anttir.github.io` ja Worker `*.workers.dev` — **eri sitet**.
Workerin domainille asetettu istuntoeväste olisi github.io:sta katsottuna
*kolmannen osapuolen eväste*, jonka iOS ITP estää cross-site-fetchissä.
Sama ongelma eri kuoressa.

Siksi: Worker antaa **session-tokenin** (AES-GCM-sinetöity blob, joka
sisältää refresh tokenin — ks. §4.2), jonka SPA tallentaa `localStorage`en
ja lähettää `Authorization: Bearer <session>` -headerina. `localStorage` on
first-party SPA:n originiin nähden eikä kuulu ITP:n eväste­sääntöjen piiriin
→ toimii cross-domain myös iOS:llä. (Huom: session-token on pitkäikäinen
bearer-kredentiaali — uhkamallinnus §6.)

> **Vaihtoehto (jos halutaan HttpOnly-eväste):** hostataan sekä sovellus
> että Worker **saman rekisteröidyn domainin alle** (esim. sovellus
> `app.example.com`, API `app.example.com/api/*` Cloudflare Pages +
> Functions). Silloin eväste on same-site ja ITP sallii sen. Tämä on
> "puhtain" malli, mutta vaatii custom-domainin ja hostingin siirron
> Cloudflareen. **Suositus: aloitetaan bearer-token-mallilla** (ei vaadi
> domain-muutosta), ja siirrytään eväste­malliin vain jos halutaan eroon
> localStorage-bearer-tokenista.

## 3. Refresh tokenin ikuistaminen (Google-puolen pakollinen askel)

7 vrk:n refresh token -vanheneminen johtuu **julkaisutilasta "Testing"**,
ei scopeista. Korjaus:

- **Aseta OAuth consent screenin julkaisutila → "In production"
  (Publish app).**
  - **BASE_SCOPES** (`userinfo.email` + `userinfo.profile`) ovat
    ei-arkaluonteisia → tuotantotila **ei vaadi Google-verifiointia**.
    R2-vain-käyttäjille tämä tarkoittaa: ei varoitusruutua **eikä**
    refresh tokenin vanhenemista → **kirjaudutaan kerran, ei enää
    uudelleen** (ellei käyttäjä peru lupaa).
  - **DRIVE_SCOPES** (`drive.readonly` restricted, `drive.appdata`
    sensitive) ovat arkaluonteisia. Tuotantotilassa ilman verifiointia:
    käyttäjä näkee "Google ei ole vahvistanut sovellusta" -varoituksen
    (jonka voi ohittaa Advanced-linkistä), ja sovelluksessa on ~100
    käyttäjän katto. **Mutta refresh tokenit eivät vanhene** — eli
    Drive-käyttäjäkin kirjautuu vain kerran ja näkee varoituksen vain
    suostumusvaiheessa.

Verifioinnin (brändi + restricted-scopejen CASA-tietoturva-arvio) tarvitsee
vain jos sovellus halutaan julkiseksi ilman varoitusta ja ilman 100
käyttäjän kattoa. Tämän käyttäjäkunnan (allowlist, 2 tiliä) kannalta
**tuotantotila ilman verifiointia riittää** ja on ilmainen.

## 4. Komponentit ja rajapinnat

### 4.1 Worker — uudet endpointit (laajennetaan `tools/r2-auth-worker`)

Kaikki `/auth/*`-polut; nykyinen R2-proxy jää `/`-juureen ennalleen.

| Endpoint | Tehtävä |
|---|---|
| `GET /auth/login` | Luo PKCE-verifier + `state`, tallentaa ne **lyhytikäiseen first-party-evästeeseen** (`abr_login`, HttpOnly, Path=/auth), redirect Googlen authorization-endpointtiin. Parametrit: `access_type=offline`, `prompt=consent` (jotta refresh token saadaan), `scope`, `code_challenge`, `redirect_uri=<worker>/auth/callback`, `state`. Tukee `?add=drive` → scope = base+drive, `include_granted_scopes=true`. `?return=<app-url>` muistetaan eväste­tilan kautta. |
| `GET /auth/callback` | Lukee `abr_login`-evästeen, vahvistaa `state`, vaihtaa coden (PKCE-verifier + client_secret) Googlen token-endpointissa → access+refresh token. Tarkistaa että `email` on allowlistilla (muuten redirect `#auth_error=forbidden`). **Sinetöi session-tokenin** (sis. refresh tokenin) ja redirect appiin: `<app-url>#auth=<session-token>`. Ei KV:tä. |
| `POST /auth/token` | Lukee `Authorization: Bearer <session-token>`, purkaa sinetin, uusii refresh tokenilla → palauttaa `{ access_token, expires_in, scopes, email, name, picture }` (`Cache-Control: no-store`). 401/403 = sessio mitätön (käyttäjä kirjautuu uudelleen); muut virheet ohimeneviä. |
| `POST /auth/logout` | Purkaa session-tokenin ja revokoi Googlen refresh tokenin (`/revoke`). Ei palvelinpuolen tilaa poistettavana. |

### 4.2 Session — tilaton (stateless), ei KV:tä tarvita

Jotta puhelimella (ilman komentoriviä) ei tarvitse luoda KV-namespacea,
sessiot ovat **tilattomia**: selaimelle annettava "session-token" on
**salattu + allekirjoitettu blob**, joka sisältää itse refresh tokenin ja
käyttäjätiedot:

```
session-token = base64url( AES-GCM-encrypt(
   key = HKDF(GOOGLE_CLIENT_SECRET),       // johdetaan, ei omaa secretiä
   payload = { refreshToken, email, sub, scopes, name, picture, iat }
))
```

- `/auth/token` purkaa blobin, käyttää refresh tokenia uuden access tokenin
  hakuun Googlelta, ja palauttaa access tokenin selaimelle.
- **Salausavain johdetaan `GOOGLE_CLIENT_SECRET`:stä** (HKDF) → ei erillistä
  `SESSION_ENC_KEY`-secretiä, ei `openssl`-komentoa.
- **Login-kierroksen** (PKCE-verifier + `state`) väliaikaistila tallennetaan
  lyhytikäiseen, allekirjoitettuun **HttpOnly-evästeeseen Workerin
  domainilla**. Tämä toimii, koska `/auth/login → Google → /auth/callback`
  on top-level-navigaatio Workerin originiin → eväste on first-party (ITP
  sallii). Ei vaadi KV:tä.
- **Uloskirjautuminen/revokointi:** `/auth/logout` revokoi refresh tokenin
  Googlella (= kuolee kaikkialla). Yksittäisen laitteen erillis­revokointi
  ei tilattomassa mallissa onnistu ilman serverivarastoa — riittää tälle
  käyttäjäkunnalle.
- Absoluuttinen maksimi-ikä payloadin `iat`-kentästä (esim. 90 vrk) → sen
  jälkeen pakotettu uudelleenkirjautuminen.

> **Valinnainen päivitys myöhemmin:** jos halutaan per-laite-revokointi,
> lisätään Cloudflare KV ja talletetaan sessiot sinne (key =
> `sha256(token)`). Ei tarpeen aluksi.

### 4.3 Workerin uudet salaisuudet/varsit

| Nimi | Tyyppi | Selitys |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | **secret** | OAuth Web-clientin secret. **Ainoa pakollinen uusi secret.** Tästä johdetaan myös session-salausavain (HKDF). |
| `APP_ORIGINS` | var (valinn.) | Sallitut app-originit redirect-tarkistukseen. Oletus = `CORS_ALLOWED_ORIGINS`. |

`GOOGLE_CLIENT_ID` on jo olemassa. **Ei KV:tä, ei erillistä enc-keytä.**
Secretin voi asettaa **Cloudflare-dashboardista** (ei vaadi komentoriviä —
ks. Liite A, B-vaihtoehto).

## 5. SPA-muutokset (`js/auth.js` ym.)

Hyvä uutinen: **suuri osa nykyisestä koneistosta säilyy.** Vain
*mekanismi* `refreshToken()`- ja `signIn()`-funktioiden sisällä vaihtuu.
Wake-listener (`visibilitychange`/`pageshow`), `_scheduleAutoRefresh`,
R2/HLS-401-retryt ja Drive-401-retry **toimivat sellaisenaan** — ja nyt
uusinta oikeasti onnistuu iOS:llä, koska se on first-party bearer-fetch.

Konkreettiset muutokset:

1. **`signIn()`** → full-page redirect `<worker>/auth/login?return=<app>`
   (redirect on iOS:llä popupia robustimpi, myös home-screen-PWA:ssa).
2. **Callback-paluun käsittely app-bootissa:** lue `#auth=<token>`
   fragmentista, talleta `localStorage`en, putsaa fragmentti
   `history.replaceState`illa. Hae käyttäjäprofiili `/auth/token`-vastauksesta.
3. **`refreshToken()`** → `fetch('<worker>/auth/token', { headers:{
   Authorization: 'Bearer '+session }})`. Palauttaa access tokenin +
   expiryn; tallentaa muistiin kuten ennen. 401 → `softSignOut`.
4. **`getAccessToken()`** pysyy synkronisena (palauttaa muistissa olevan
   access tokenin); proaktiivinen + reaktiivinen uusinta hoituu samoilla
   poluilla kuin nyt.
5. **`ensureDriveAccess()`** → redirect `<worker>/auth/login?add=drive`.
   Paluussa session kattaa base+drive; `hasDriveAccess()` lukee
   `/auth/token`-vastauksen `scopes`-kentästä (tallennetaan kuten nykyinen
   granted-scopes-lista).
6. **`signOut()`** → `POST /auth/logout` + tyhjennä localStorage.
7. **Google Picker** (`drive-provider.pickFolder`) saa OAuth-tokenin
   edelleen `Auth.getAccessToken()`-kautta — ei muutosta.
8. **GIS-skripti** (`accounts.google.com/gsi/client`) **voidaan poistaa**
   `index.html`:stä; auth ei enää tarvitse sitä. `gapi` (Picker) jää.
9. **Kahden tason scopet** (base vs drive) säilyvät täysin — ne vain
   pyydetään code-flow'ssa.

### R2-streamauksen yksinkertaistus (valinnainen, vaihe 3)

Nyt R2-pyynnöt vievät Google-access-tokenin (`Bearer` / `?_token=`).
Koska Worker tuntee sessionin (→ email), R2:n voi autentikoida **suoraan
session-tokenilla** (`?_token=<session>`), jolloin R2-toisto **ei riipu
lainkaan Google-tokenin tuoreudesta**. Worker resolvoi session→email ja
tarkistaa allowlistin. Tämä poistaa viimeisenkin "token vanheni kesken
kuuntelun" -reunatapauksen. Tehdään omana vaiheenaan.

## 6. Tietoturva

- **client_secret** vain Workerin secrettinä — ei koskaan repoon tai SPA:han.
- **PKCE** suojaa coden; **state** estää CSRF:n callbackissa (verifier +
  state lyhytikäisessä HttpOnly-evästeessä, ei URL:ssa).
- **Session-token = sinetöity blob**, ei satunnainen viittaus: refresh token
  on AES-GCM-salattuna itse tokenissa. Salausavain **johdetaan
  `GOOGLE_CLIENT_SECRET`:stä HKDF:llä** — ei erillistä avainta, ei KV:tä.
  AES-GCM-tunniste estää peukaloinnin (väärä/muokattu token hylätään).
- **`/auth/token` palauttaa `Cache-Control: no-store`** — access tokenia ei
  tallenneta välimuisteihin.
- **CORS**: `/auth/token` sallii vain app-originit; bearer-header, ei
  evästeitä, joten `credentials:'include'` ei tarvita.
- **Allowlist** tarkistetaan jo `/auth/callback`issa (ei sessiota
  ei-sallitulle) ja edelleen R2-fetchissä.
- **Absoluuttinen maksimi-ikä:** session-tokenin `iat` rajaa eliniän (90
  vrk), minkä jälkeen pakotettu uudelleenkirjautuminen.
- **Revokointi:** `/auth/logout` revokoi refresh tokenin Googlella (kuolee
  kaikkialla). Tilattomassa mallissa **ei per-laite-revokointia** — se
  vaatisi KV-session-säilön (valinnainen päivitys, §4.2).
- **XSS-huomio:** session-token localStoragessa on pitkäikäinen bearer-
  kredentiaali (sisältää sinetöidyn refresh tokenin). Vahinkosäde on
  suurempi kuin pelkällä access tokenilla; jos XSS on uhkamallissa, harkitse
  §2:n HttpOnly-eväste­mallia (vaatii saman domainin hostingin).

## 7. Manuaaliset askeleet (kaikki puhelimen selaimella, ei komentoriviä)

Tarkat klikkausohjeet Liitteessä A.

1. **Google Auth Platform → Audience → Publish app (In production).**
   (Ikuistaa refresh tokenit.)
2. **Google Auth Platform → Clients → OAuth Web client → Authorized
   redirect URIs → lisää** `https://<worker>/auth/callback`.
3. **Kopioi client secret** ja tallenna se **Cloudflare-dashboardista**
   Workerin secretiksi `GOOGLE_CLIENT_SECRET` (Liite A, kohta 4B).
4. **Workerin deploy** Git-yhteydellä dashboardista (Liite B).
5. (Drive API on jo päällä; ei KV:tä eikä erillistä enc-keytä.)

## 8. Vaiheistus / rollout

- **Vaihe 0 (manuaalinen, puhelin):** julkaisutila → production, redirect
  URI, `GOOGLE_CLIENT_SECRET` dashboardiin, worker-deploy Gitistä.
- **Vaihe 1 (Worker):** `/auth/*`-endpointit, tilattomat sessiot. Deploy.
  Testaa desktop-selaimella.
- **Vaihe 2 (SPA):** vaihda `signIn`/`refreshToken`/`ensureDriveAccess`
  redirect+`/auth/token`-malliin; lue callback-fragmentti; poista GIS-
  skripti. Säilytä kahden tason scopet. Bumppaa `?v=`.
- **Vaihe 3 (valinnainen):** R2-autentikointi session-tokenilla → täysi
  riippumattomuus Google-tokenin tuoreudesta.
- **Yhteensopivuus:** vanhoilla käyttäjillä on GIS-token localStoragessa;
  uusi versio huomaa session-tokenin puuttuvan → ohjaa kertaalleen uuteen
  kirjautumiseen. Kertaluontoinen kustannus.

## 9. Lopputulos

| Käyttäjä | Ennen | Jälkeen |
|---|---|---|
| iOS, vain R2 | uudelleenkirjautuminen ~45–60 min välein + monivaiheinen varoitusruutu | **kirjautuu kerran**, ei varoitusta, ei uusintaa (refresh palvelimella, ei ITP-riippuvuutta, refresh token ei vanhene) |
| iOS, Drive-käyttö | sama kuin yllä, joka kerta | varoitus **kerran** Drive-luvan kohdalla, sen jälkeen ei uudelleenkirjautumista |
| Työpöytä | toimi jo, mutta uusinta GIS-iframella | sama UX, vakaampi uusinta |

## 10. Avoimet rajoitteet (rehellisyyden vuoksi)

- **Unverified + restricted Drive-scope tuotannossa:** 100 käyttäjän katto
  + varoitusruutu Drive-luvalle, kunnes (jos koskaan) Google-verifiointi
  tehdään. Ei estä tätä käyttäjäkuntaa.
- **iOS localStorage-eviktio:** jos sovellusta ei avata ~7 vrk:aan
  (Safari, ei home-screen-PWA), script-writable storage voidaan tyhjentää
  → yksi uudelleenkirjautuminen. Home-screen-PWA-asennus välttää tämän.
  (Tämä on nykyinenkin tilanne progress-datalle, ei regressio.)
- **Drive-pickerin** OAuth-token tulee `/auth/token`-kautta; pickerin
  istunto on lyhytikäinen joten ei lisäongelmia.

---

## Liite A: Tarkat setup-ohjeet (kohdat 1–4)

Projektisi tunnistat OAuth-clientista
`524735149839-e3pfcqlji0ij1f45tpf3af2ivqkosdgg.apps.googleusercontent.com`
(projektinumero **524735149839**). Valitse Consolen ylä­palkista oikea
projekti ennen kuin teet alla olevat.

### Kohta 1 — Julkaise sovellus tuotantoon (refresh tokenit lakkaavat vanhenemasta)

Linkki: <https://console.cloud.google.com/auth/audience>
(vanha polku ohjaa tähän: APIs & Services → OAuth consent screen → Audience)

1. Avaa **Audience**-sivu.
2. Kohdassa **Publishing status** lukee nyt **Testing**.
3. Klikkaa **Publish app** → vahvista **Confirm**.
4. Status muuttuu muotoon **In production**. (Et tarvitse "Prepare for
   verification" -vaihetta — restricted Drive-scope näyttää käyttäjille
   varoituksen, mutta sovellus toimii ja refresh tokenit eivät enää vanhene.)

### Kohta 2 — Lisää redirect URI OAuth-clientiin

Linkki: <https://console.cloud.google.com/auth/clients>
(vanha polku: APIs & Services → Credentials → OAuth 2.0 Client IDs)

1. Klikkaa clientia **"AudioBook Reader Web"** (ID alkaa `524735149839-`).
2. Etsi osio **Authorized redirect URIs** (eri kuin "Authorized JavaScript
   origins" — älä sekoita näitä).
3. Klikkaa **+ Add URI** ja liitä **täsmälleen**:

   ```
   https://audiobookreader-r2.audiobooks.workers.dev/auth/callback
   ```

   - Ei loppukauttaviivaa, `https`, polku `/auth/callback`.
   - Lisää halutessasi myös paikalliskehitystä varten:
     `http://localhost:8787/auth/callback` (wrangler dev -portti).
4. **Save**. (Muutos voi näkyä muutaman minuutin viiveellä Googlessa.)

### Kohta 3 — Hae client secret

Samalla client-sivulla (kohta 2) on **Client secret** -kenttä oikealla.

1. Klikkaa **silmä-ikoni / Show** tai lataa JSON (**Download**).
2. Kopioi `client_secret`-arvo (muotoa `GOCSPX-...`). Tarvitset sen
   kohdassa 4.
3. **Älä** laita sitä git-repoon tai SPA-koodiin — vain Workerin secretiksi.

### Kohta 4 — Cloudflare: tallenna client secret

Tilattoman mallin (§4.2) ansiosta **ei tarvita KV:tä eikä erillistä
salausavainta** — ainoa Cloudflaren puolen asetus on yksi secret:
`GOOGLE_CLIENT_SECRET`. Sen voi tehdä joko komentoriviltä **tai
dashboardista** (B-vaihtoehto sopii puhelimelle).

**A) Komentorivi (jos koneella on wrangler):**

```bash
cd tools/r2-auth-worker
npx wrangler secret put GOOGLE_CLIENT_SECRET   # liitä GOCSPX-... arvo
```

**B) Dashboard, ilman komentoriviä (kännykkä):**

1. Avaa <https://dash.cloudflare.com> → **Workers & Pages** → worker
   **`audiobookreader-r2`**.
2. **Settings** → **Variables and Secrets** (tai "Environment variables").
3. **+ Add** → Type: **Secret** → Name: `GOOGLE_CLIENT_SECRET`, Value:
   `GOCSPX-...` → **Save / Deploy**.

> Huom: jos worker deployataan Git-yhteyden kautta (ks. Liite B), aseta
> secret **Production-ympäristöön** dashboardissa.

### Liite B — Workerin deploy ilman komentoriviä (kännykkä)

Koska et voi ajaa `wrangler deploy`-komentoa, kytketään worker
**deployaamaan Gitistä automaattisesti** (kuten GitHub Pages tekee
SPA:lle). Tämä on kertaluontoinen dashboard-asetus, minkä jälkeen jokainen
agentin pushaama muutos deployaa workerin itsestään.

1. <https://dash.cloudflare.com> → **Workers & Pages**.
2. Worker `audiobookreader-r2` → **Settings** → **Build** → **Connect**
   (Workers Builds / "Connect to Git").
3. Valitse repo **anttir/AudiobookReader**, branch (esim. `main`),
   **Root directory** = `tools/r2-auth-worker`, build command tyhjä,
   deploy command oletus (`npx wrangler deploy`).
4. Tallenna. Jatkossa push → automaattinen worker-deploy.

> Vaihtoehto (jos Git-yhteys ei toimi): worker on **yksi tiedosto**
> (`src/index.js`), joten sen voi myös liittää dashboardin koodieditoriin
> (worker → **Edit code** → liitä → **Deploy**). Työläämpää puhelimella.

### Tarkistuslista ennen toteutusvaihetta

- [ ] Audience: **In production** (kohta 1)
- [ ] Redirect URI lisätty: `.../auth/callback` (kohta 2)
- [ ] `GOOGLE_CLIENT_SECRET` tallennettu Workerin secretiksi (kohta 4)
- [ ] Workerin deploy-tapa valittu (Liite B: Git-yhteys tai editori)

Kaikki nämä onnistuvat puhelimen selaimella. Kun ne ovat valmiit (tai
rinnakkain agentin koodatessa), Worker `/auth/*` + SPA-muutokset
deployataan.
