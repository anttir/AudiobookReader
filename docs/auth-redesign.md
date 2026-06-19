# Kirjautumisen lopullinen korjaus — suunnitelma

> Tila: **suunnitelma / design** (ei vielä toteutettu). Tämä dokumentti
> kuvaa miten kirjautumisongelma ratkaistaan lopullisesti, myös iOS
> Safarissa, jossa nykyinen hiljainen token-refresh ei toimi.

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
4. Worker **säilyttää refresh tokenin palvelimella** (Cloudflare KV,
   salattuna) ja antaa selaimelle **oman opaakin session-tokenin**.
5. Kun sovellus tarvitsee tuoreen Google-access-tokenin, se kutsuu Workerin
   `/auth/token`-endpointtia session-tokenilla; Worker uusii tokenin
   refresh tokenilla palvelin-palvelin-kutsuna ja palauttaa sen.

Tämä poistaa iOS-ongelman, koska uusinta **ei enää nojaa kolmannen
osapuolen evästeisiin eikä piiloiframeen** — se on tavallinen
fetch-kutsu, jossa kredentiaali kulkee `Authorization`-headerissa.

### Miksi session-token localStoragessa eikä eväste?

Sovellus on `anttir.github.io` ja Worker `*.workers.dev` — **eri sitet**.
Workerin domainille asetettu istuntoeväste olisi github.io:sta katsottuna
*kolmannen osapuolen eväste*, jonka iOS ITP estää cross-site-fetchissä.
Sama ongelma eri kuoressa.

Siksi: Worker antaa **opaakin random session-tokenin**, jonka SPA tallentaa
`localStorage`en ja lähettää `Authorization: Bearer <session>` -headerina.
`localStorage` on first-party SPA:n originiin nähden eikä kuulu ITP:n
eväste­sääntöjen piiriin → toimii cross-domain myös iOS:llä.

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
| `GET /auth/login` | Luo PKCE-verifier + `state`, tallentaa ne lyhytikäiseen KV-merkintään, redirect Googlen authorization-endpointtiin. Parametrit: `access_type=offline`, `prompt=consent` (jotta refresh token saadaan), `scope`, `code_challenge`, `redirect_uri=<worker>/auth/callback`, `state`. Tukee `?add=drive` → scope = base+drive, `include_granted_scopes=true`. `?return=<app-url>` muistetaan staten kautta. |
| `GET /auth/callback` | Vahvistaa `state`, vaihtaa coden (PKCE-verifier + client_secret) Googlen token-endpointissa → access+refresh token. Tarkistaa että `email` on allowlistilla (muuten 403, ei sessiota). Tallentaa session KV:hen. Redirect takaisin appiin: `<app-url>#auth=<session-token>`. |
| `POST /auth/token` | Lukee `Authorization: Bearer <session-token>`. Palauttaa tuoreen Google-access-tokenin (`{ access_token, expires_in, scopes, email, name, picture }`). Uusii refresh tokenilla jos välimuistissa oleva access token on vanha. invalid_grant → 401 (käyttäjä kirjautuu uudelleen). Voi rotatoida session-tokenin. |
| `POST /auth/upgrade` | (Valinnainen kuori) palauttaa 401/redirect-ohjeen jos Drive-scope puuttuu; käytännössä Drive-laajennus tehdään uudella `/auth/login?add=drive`-kierroksella. |
| `POST /auth/logout` | Revokoi Googlen refresh tokenin, poistaa session KV:stä. |

### 4.2 Session-säilö (Cloudflare KV)

```
key:   sha256(sessionToken)          // ei talleteta tokenia itseään
value: {
  refreshTokenEnc,   // AES-GCM-salattu Worker-secretillä
  scopes,            // myönnetyt scopet (base / base+drive)
  email, sub, name, picture,
  createdAt, lastUsedAt
}
```

- Access tokenin välimuisti: erillinen KV-merkintä TTL:llä (= tokenin
  `expires_in − 60s`), tai Workerin in-memory cache per pyyntö. Vältetään
  Googlen token-endpointin kutsuminen joka kerta.
- Vaihtoehto vahvalle konsistenssille: Durable Object KV:n sijaan.

### 4.3 Workerin uudet salaisuudet/varsit

| Nimi | Tyyppi | Selitys |
|---|---|---|
| `GOOGLE_CLIENT_SECRET` | secret | OAuth Web-clientin secret (Console → Credentials). |
| `SESSION_ENC_KEY` | secret | 32-tavuinen avain refresh tokenin AES-GCM-salaukseen. |
| `SESSIONS` (KV namespace) | binding | Session-säilö. |
| `APP_ORIGINS` | var | Sallitut app-originit redirect/postMessage-tarkistukseen. |

`GOOGLE_CLIENT_ID` on jo olemassa. `wrangler secret put GOOGLE_CLIENT_SECRET`.

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
- **PKCE** suojaa coden; **state** estää CSRF:n callbackissa.
- Session-token: kryptografisesti satunnainen (32 tavua, base64url).
  KV:hen talletetaan vain **hash** (sha256) → KV-vuoto ei paljasta
  käyttökelpoisia tokeneita.
- Refresh token **salataan levossa** (AES-GCM, `SESSION_ENC_KEY`).
- Session-tokenin **rotaatio** jokaisella `/auth/token`-kutsulla (race-grace)
  → varastetun tokenin elinikä lyhenee.
- **CORS**: `/auth/token` sallii vain app-originit; bearer-header, ei
  evästeitä, joten `credentials:'include'` ei tarvita.
- **Allowlist** tarkistetaan jo `/auth/callback`issa (ei sessiota
  ei-sallitulle) ja edelleen R2-fetchissä.
- **XSS-huomio:** session-token localStoragessa on pitkäikäinen bearer-
  kredentiaali → sama vahinkosäde kuin nykyisellä access tokenilla, mutta
  pidempi. Mitigoidaan rotaatiolla, absoluuttisella maksimi-iällä ja
  revokoinnilla. (Eväste-HttpOnly-malli vaihe-2-vaihtoehtona poistaa tämän,
  ks. §2.)

## 7. Manuaaliset Google Cloud Console -askeleet (käyttäjä)

1. **OAuth consent screen → Publishing status → Publish app (In
   production).** (Tämä ikuistaa refresh tokenit.)
2. **Credentials → OAuth Web client → Authorized redirect URIs → lisää**
   `https://<worker-domain>/auth/callback`.
3. **Kopioi client secret** samasta clientistä → `wrangler secret put
   GOOGLE_CLIENT_SECRET`.
4. Luo KV namespace (`wrangler kv namespace create SESSIONS`) ja bindaa
   `wrangler.toml`:iin. Aseta `SESSION_ENC_KEY` secret.
5. (Drive API on jo päällä.)

## 8. Vaiheistus / rollout

- **Vaihe 0 (manuaalinen):** julkaisutila → production, redirect URI,
  client secret, KV, enc-key.
- **Vaihe 1 (Worker):** `/auth/*`-endpointit + KV-sessiot. Deploy. Testaa
  curlilla / desktop-selaimella.
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
   kohdassa 4 (`wrangler secret put GOOGLE_CLIENT_SECRET`).
3. **Älä** laita sitä git-repoon tai SPA-koodiin — vain Workerin secretiksi.

### Kohta 4 — Cloudflare: KV-namespace + secretit

Aja komennot **`tools/r2-auth-worker/`-hakemistossa** (siellä on
`wrangler.toml`). Tarvitset Wranglerin (`npm i -g wrangler` tai `npx
wrangler`) ja `wrangler login` kerran.

**4a. Luo KV-namespace sessioille:**

```bash
cd tools/r2-auth-worker
npx wrangler kv namespace create SESSIONS
```

Komento tulostaa esim.:

```
[[kv_namespaces]]
binding = "SESSIONS"
id = "a1b2c3d4e5f6...."
```

Kopioi tämä lohko `wrangler.toml`-tiedostoon. (Halutessasi
paikalliskehitykseen myös: `npx wrangler kv namespace create SESSIONS
--preview` ja lisää `preview_id` samaan lohkoon.)

**4b. Generoi ja tallenna session-salausavain (32 tavua):**

```bash
openssl rand -base64 32
npx wrangler secret put SESSION_ENC_KEY
# liitä yllä generoitu base64-arvo kun se kysyy
```

**4c. Tallenna Googlen client secret:**

```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET
# liitä kohdassa 3 kopioitu GOCSPX-... arvo
```

**4d. Lisää tarvittaessa app-originit varsiin** (`wrangler.toml`,
`[vars]`-lohkoon — jos halutaan erottaa redirect/CORS-tarkistus):

```toml
APP_ORIGINS = "https://anttir.github.io,http://localhost:8000"
```

`CORS_ALLOWED_ORIGINS` on jo olemassa ja kattaa nämä originit.

**4e. Lopullinen `wrangler.toml` (lisätyt osat) näyttää suunnilleen:**

```toml
[[kv_namespaces]]
binding = "SESSIONS"
id = "a1b2c3d4e5f6...."        # 4a:n tuloste
# preview_id = "...."           # valinnainen

# Secretit EI tähän tiedostoon — ne ovat:
#   wrangler secret put GOOGLE_CLIENT_SECRET
#   wrangler secret put SESSION_ENC_KEY
```

### Tarkistuslista ennen toteutusvaihetta

- [ ] Audience: **In production**
- [ ] Redirect URI lisätty: `.../auth/callback`
- [ ] `GOOGLE_CLIENT_SECRET` tallennettu Workerin secretiksi
- [ ] `SESSION_ENC_KEY` tallennettu Workerin secretiksi
- [ ] `SESSIONS` KV-namespace luotu ja bindattu `wrangler.toml`:iin

Kun nämä viisi ovat valmiit, vaiheiden 1–2 koodi (Worker `/auth/*` +
SPA) voidaan toteuttaa ja deployata.
