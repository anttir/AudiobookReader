# AudioBook Reader

Web-sovellus PDF- ja EPUB-kirjojen lukemiseen sekä äänikirjojen kuunteluun. Tukee useita
tallennuslähteitä: **Google Drive** (kokonaislataus, kaikki tuetut formaatit) ja
**Cloudflare R2** (HLS-streaming + natiivit audiotiedostot, valinnaisesti Google-SSO -suojattu).

## 🌐 Live

**Käytössä osoitteessa: [https://anttir.github.io/AudiobookReader/](https://anttir.github.io/AudiobookReader/)**

Julkaistu GitHub Pagesilla suoraan `main`-branchista — jokainen `git push origin main` triggaa
automaattisen uudelleenjulkaisun (~30 s). Live-versiossa R2-lähde toimii heti Google-loginin
jälkeen, koska oletusarvoinen Worker-URL on hardkoodattu `js/config.js`:ään (`R2_DEFAULT_BASE_URL`).
R2-sisältö on auth-workerin takana ja vain allowlist-sähköposteille avoinna.

## Ominaisuudet

- **Google-kirjautuminen** - Kirjaudu sisään Google-tililläsi
- **Monilähdetuki** - Vaihda lähde-tabista Google Drive ↔ Cloudflare R2 ↔ (jatkossa) muut
- **Google Drive -integraatio** - Lue tiedostoja suoraan Drivestäsi
- **Cloudflare R2 + HLS-streaming** - Pitkät äänikirjat alkavat soida ~1 s sisällä ilman
  koko tiedoston esi-latausta; valinnainen [auth-worker](tools/r2-auth-worker) sitoo
  pääsyn Google-tiliin
- **PDF-lukija** - Lue PDF-kirjoja selaimessa
- **EPUB-lukija** - Lue EPUB-muotoisia e-kirjoja
- **Äänisoitin** - Kuuntele äänikirjoja (MP3, M4A, M4B, WAV, OGG, FLAC, AAC, OPUS, HLS)
- **Moniosainen kirja -tuki** - Kansio = yksi kirja, jossa voi olla useita osia
- **Edistymisen tallennus** - Sovellus muistaa missä kohtaa olit (TÄRKEIN TOIMINTO!),
  lähdekohtaisilla avaimilla (`drive:fileId`, `r2:bookId`) jotta sama nimi ei törmää eri
  lähteissä
- **Jatka lukemista** - Näyttää viimeksi luetun kirjan kirjastossa
- **Kuuntelunopeus** - Säädä toiston nopeutta (0.5x - 2x)
- **Tumma/vaalea/seepia teema** - Valitse mieleisesi ulkoasu
- **Mobiiliystävällinen** - Toimii myös puhelimella
- **PWA-tuki** - Voit "asentaa" sovelluksen puhelimeesi

## Tallennuslähteet & arkkitehtuuri

Jokainen lähde on yksittäinen luokka `js/providers/`-hakemistossa joka toteuttaa
yhteisen `ProviderBase`-rajapinnan (`getLibraryStructure`, `getStreamUrl`,
`downloadAsBlob`, kapasiteettiliput `supportsHLS` / `supportsByteRange`). Uuden
lähteen lisääminen on uusi tiedosto providers-hakemistoon ja yksi rivi
`registry.js`:ään.

### Kirjojen lisääminen R2:een

📖 **[docs/uploading-books.md](docs/uploading-books.md)** on kanoninen spec:
bucket-rakenne, `index.json`-manifestin skeema, HLS-playlistin vaatimukset,
S3-credentiaalit, content-typet ja yleiset operaatiot (lisäys, uudelleennimeäminen,
poisto). Linkitä tähän kun ohjeistat tooleja tai toisia agentteja.

Referenssitoteutus uploadille: [tools/upload-to-r2/](tools/upload-to-r2/)
(Python + boto3). Referenssitoteutus suojatulle luvulle:
[tools/r2-auth-worker/](tools/r2-auth-worker/) (Cloudflare Worker, Google-token-validointi).

## Tuetut tiedostomuodot

### E-kirjat
- PDF (.pdf)
- EPUB (.epub)

### Äänitiedostot
- MP3 (.mp3)
- M4A (.m4a)
- M4B (.m4b) - Audiobook-muoto
- WAV (.wav)
- OGG (.ogg)
- FLAC (.flac)
- AAC (.aac)
- OPUS (.opus)
- WebM Audio (.webm)

## Kirjarakenne Google Drivessa

Sovellus tunnistaa automaattisesti miten kirjat on järjestetty:

### Vaihtoehto 1: Kansio = Kirja (suositeltu moniosaisille kirjoille)
```
📁 Minun Kirjani/
   📄 Osa 1.pdf
   📄 Osa 2.pdf
   📄 Osa 3.pdf
   🎵 Luku 01.mp3
   🎵 Luku 02.mp3
```
Sovellus näyttää tämän yhtenä kirjana "Minun Kirjani" ja osien välillä voi navigoida.

### Vaihtoehto 2: Yksittäiset tiedostot
```
📁 Kirjasto/
   📄 Kirja1.pdf
   📄 Kirja2.epub
   🎵 Podcast.mp3
```
Jokainen tiedosto näytetään erikseen.

### Vaihtoehto 3: Sekalainen
Voit myös yhdistää molempia - kansiot tunnistetaan kirjoiksi ja yksittäiset tiedostot näytetään erikseen.

---

## Asennus ja käyttöönotto

> Tämä osio on **fork-ohjeet**: omat Google OAuth -credentiaalit, oma R2-bucket, oma Pages-URL.
> Jos vain haluat käyttää valmista versiota, mene
> [https://anttir.github.io/AudiobookReader/](https://anttir.github.io/AudiobookReader/) ja
> kirjaudu Googlella. R2-äänikirjat näkyvät vain `[antti.rasi, anuhynninen2]@gmail.com`
> -tileille (auth-workerin allowlist).

### Vaihe 1: Luo Google Cloud -projekti

1. Mene [Google Cloud Console](https://console.cloud.google.com/)
2. Klikkaa yläpalkissa projektin nimeä → **New Project**
3. Anna nimi: `AudioBook Reader`
4. Klikkaa **Create**
5. Odota että projekti luodaan ja valitse se aktiiviseksi

### Vaihe 2: Ota käyttöön Google Drive API

1. Mene vasemmasta valikosta **APIs & Services** → **Library**
2. Etsi hakukentällä: `Google Drive API`
3. Klikkaa tulosta ja paina **Enable**

### Vaihe 3: Määritä OAuth consent screen

1. Mene **APIs & Services** → **OAuth consent screen**
2. Valitse **External** (ellei sinulla ole Google Workspace)
3. Klikkaa **Create**

4. **App information:**
   - App name: `AudioBook Reader`
   - User support email: (valitse oma sähköpostisi)
   - Developer contact: (oma sähköpostisi)

5. Klikkaa **Save and Continue**

6. **Scopes:** Klikkaa **Add or Remove Scopes** ja lisää:
   - `https://www.googleapis.com/auth/drive.readonly`
   - `https://www.googleapis.com/auth/userinfo.profile`
   - `https://www.googleapis.com/auth/userinfo.email`
   - Klikkaa **Update** ja sitten **Save and Continue**

7. **Test users:** Klikkaa **Add Users** ja lisää oma Gmail-osoitteesi
   - Klikkaa **Save and Continue**

8. Klikkaa **Back to Dashboard**

### Vaihe 4: Luo OAuth 2.0 Client ID

1. Mene **APIs & Services** → **Credentials**
2. Klikkaa **+ Create Credentials** → **OAuth client ID**
3. Application type: **Web application**
4. Name: `AudioBook Reader Web`

5. **Authorized JavaScript origins** - lisää:
   - `http://localhost:8000` (kehitykseen)
   - `http://127.0.0.1:8000`
   - Myöhemmin lisää myös tuotanto-URL (esim. `https://username.github.io`)

6. Klikkaa **Create**

7. **Kopioi Client ID** talteen - se näyttää tältä:
   ```
   123456789-abcdefg.apps.googleusercontent.com
   ```

### Vaihe 5: Päivitä config.js

Avaa `js/config.js` ja korvaa placeholder oikealla Client ID:llä:

```javascript
const CONFIG = {
    GOOGLE_CLIENT_ID: '123456789-abcdefg.apps.googleusercontent.com',
    // ...
};
```

---

## Hostaus

> **Tämä repo on jo julkaistu osoitteessa
> [https://anttir.github.io/AudiobookReader/](https://anttir.github.io/AudiobookReader/)**.
> Allaolevat ohjeet ovat sinulle, joka haluaa forkata oman kopion. Pushaaminen `main`:iin
> deployaa uuden version Pagesiin ~30 s sisällä — ei manuaalista deploy-stepiä.

### Vaihtoehto A: Paikallinen kehityspalvelin (testaus)

```bash
# Python 3
python -m http.server 8000

# Node.js
npx serve .

# PHP
php -S localhost:8000
```

Avaa selaimessa: http://localhost:8000

### Vaihtoehto B: GitHub Pages (ilmainen, suositeltu)

1. Luo uusi repository GitHubissa
2. Pushaa koodi:
   ```bash
   git remote add origin https://github.com/USERNAME/audiobook-reader.git
   git push -u origin main
   ```

3. Mene repositoryn **Settings** → **Pages**
4. Source: **Deploy from a branch**
5. Branch: **main**, folder: **/ (root)**
6. Klikkaa **Save**

7. **Tärkeää:** Lisää GitHub Pages URL Google Cloud Consoleen:
   - Mene **APIs & Services** → **Credentials**
   - Klikkaa OAuth Client ID:täsi
   - Lisää **Authorized JavaScript origins**:
     - `https://USERNAME.github.io`

Sovellus on käytettävissä: `https://USERNAME.github.io/audiobook-reader/`

### Vaihtoehto C: Firebase Hosting

1. Asenna Firebase CLI:
   ```bash
   npm install -g firebase-tools
   ```

2. Kirjaudu sisään:
   ```bash
   firebase login
   ```

3. Alusta projekti:
   ```bash
   firebase init hosting
   ```
   - Valitse: **Use an existing project** → valitse projektisi
   - Public directory: `.`
   - Single-page app: **No**
   - Älä ylikirjoita index.html

4. Julkaise:
   ```bash
   firebase deploy
   ```

5. Lisää Firebase URL Google Cloud Consoleen OAuth-asetuksiin.

---

## Käyttö

1. Avaa sovellus selaimessa
2. Klikkaa **Kirjaudu Google-tilillä**
3. Hyväksy käyttöoikeudet
4. Valitse **Google Drive -kansio**, jossa kirjasi ovat
5. Napauta kirjaa aloittaaksesi lukemisen/kuuntelun

### Näppäinkomennot

| Näppäin | Toiminto |
|---------|----------|
| `←` / `→` | Edellinen/seuraava sivu (PDF/EPUB) |
| `Space` | Toista/pysäytä (audio) tai seuraava sivu |
| `←` / `→` | Kelaa 10s (audio-tilassa) |

### Mobiilieleet

- **Pyyhkäise vasemmalle/oikealle** - Vaihda sivua

---

## Vianmääritys

### "Sign in with Google" -nappi ei toimi
- Varmista että `GOOGLE_CLIENT_ID` on oikein `js/config.js`:ssä
- Tarkista että domain on lisätty **Authorized JavaScript origins** -listaan
- Jos käytät `http://localhost`, kokeile `http://127.0.0.1`

### "Access blocked: This app's request is invalid"
- OAuth consent screen ei ole konfiguroitu oikein
- Varmista että olet lisännyt itsesi Test Users -listaan

### PDF/EPUB ei lataudu
- Varmista että sinulla on lukuoikeus tiedostoon Google Drivessa
- Tarkista selaimen konsolista virheviestit (F12)

### Ääni ei toistu
- Tarkista selaimen ääniasetukset
- Jotkut selaimet vaativat käyttäjän interaktiota ennen äänentoistoa

### Edistyminen ei tallennu
- Varmista että selaimesi sallii localStorage:n
- Incognito/yksityinen selaus ei tallenna dataa

---

## Teknologiat

- **PDF.js** - PDF-näyttö selaimessa
- **EPUB.js** - EPUB-näyttö selaimessa
- **Google Identity Services** - Kirjautuminen
- **Google Drive API** - Tiedostojen lukeminen
- **Web Audio API** - Äänentoisto
- **LocalStorage** - Edistymisen tallennus

## Tietoturva ja kirjautuminen

Kirjautuminen on kaksiportainen (**incremental authorization**), jotta
suurin osa käyttäjistä ei joudu Googlen "sovellusta ei ole vahvistettu"
-varoituksen läpi:

- **Sisäänkirjautuminen** pyytää vain ei-arkaluonteiset `userinfo.profile`-
  ja `userinfo.email` -oikeudet. Tämä riittää sekä kirjautumiseen että
  Cloudflare R2 -kuunteluun (auth-worker tarkistaa vain että token on
  voimassa ja sähköposti on allowlistilla). Consent on pelkkä tilin valinta.
- **Google Drive -oikeudet** (`drive.readonly` + `drive.appdata`) pyydetään
  vasta kun käyttäjä avaa Drive-lähteen ensimmäisen kerran. Nämä ovat
  Googlen arkaluonteisia scopeja, joten vasta tässä vaiheessa näkyy
  vahvistamattoman sovelluksen varoitus / test-user -vaatimus. R2:ta vain
  käyttävät eivät kohtaa tätä koskaan.
- `drive.readonly` on read-only — sovellus ei voi muokata tiedostojasi.
- Access token tallennetaan vain selaimen localStorageen.
- Drive-data pysyy omassa Google Drivessasi; mitään ei lähetetä omille
  palvelimille (R2-sisältö kulkee oman auth-workerin kautta).

> **Huom (cross-device sync):** laitteiden välinen edistymisen synkronointi
> käyttää `drive.appdata`-kansiota, joten se on käytössä vasta kun Drive-lupa
> on myönnetty. Pelkät R2-käyttäjät saavat edistymisen tallennettua
> paikallisesti (localStorage), mutta eivät laitteiden välillä.

## Lisenssi

MIT License

---

## Tekijä

AudioBook Reader - Web-pohjainen e-kirja- ja äänikirjalukija
