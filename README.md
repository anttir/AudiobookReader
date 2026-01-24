# AudioBook Reader

Web-sovellus PDF-kirjojen lukemiseen ja äänikirjojen kuunteluun suoraan Google Drivestä.

## Ominaisuudet

- **Google-kirjautuminen** - Kirjaudu sisään Google-tililläsi
- **Google Drive -integraatio** - Lue tiedostoja suoraan Drivestäsi
- **PDF-lukija** - Lue PDF-kirjoja selaimessa
- **Äänisoitin** - Kuuntele äänikirjoja (MP3, M4A, WAV, OGG, FLAC)
- **Edistymisen tallennus** - Sovellus muistaa missä kohtaa olit
- **Tumma/vaalea teema** - Valitse mieleisesi ulkoasu
- **Mobiiliystävällinen** - Toimii myös puhelimella
- **PWA-tuki** - Voit "asentaa" sovelluksen puhelimeesi

## Asennus ja käyttöönotto

### 1. Luo Google Cloud -projekti

1. Mene [Google Cloud Console](https://console.cloud.google.com/)
2. Luo uusi projekti (tai käytä olemassa olevaa)
3. Anna projektille nimi, esim. "AudioBook Reader"

### 2. Ota käyttöön tarvittavat API:t

1. Mene **APIs & Services** → **Library**
2. Etsi ja ota käyttöön:
   - **Google Drive API**
   - **Google Identity Services** (ei tarvitse erikseen ottaa käyttöön)

### 3. Luo OAuth 2.0 -tunnukset

1. Mene **APIs & Services** → **Credentials**
2. Klikkaa **+ CREATE CREDENTIALS** → **OAuth client ID**
3. Jos et ole vielä määrittänyt OAuth consent screen:
   - Valitse **External** (tai Internal jos sinulla on Workspace)
   - Täytä sovelluksen nimi: "AudioBook Reader"
   - Lisää oma sähköpostisi käyttäjäksi
   - Lisää scopet:
     - `https://www.googleapis.com/auth/drive.readonly`
     - `https://www.googleapis.com/auth/userinfo.profile`
     - `https://www.googleapis.com/auth/userinfo.email`
   - Tallenna

4. Palaa **Credentials** ja luo OAuth client ID:
   - Application type: **Web application**
   - Name: "AudioBook Reader Web"
   - Authorized JavaScript origins:
     - `http://localhost:8000` (kehitykseen)
     - `https://your-domain.com` (tuotantoon)
   - Tallenna ja kopioi **Client ID**

### 4. Luo API-avain (valinnainen)

1. Klikkaa **+ CREATE CREDENTIALS** → **API key**
2. Kopioi avain
3. (Suositeltavaa) Rajoita avain:
   - Application restrictions: HTTP referrers
   - Lisää sallitut domainit
   - API restrictions: Valitse "Google Drive API"

### 5. Päivitä config.js

Avaa `js/config.js` ja päivitä:

```javascript
const CONFIG = {
    GOOGLE_CLIENT_ID: 'YOUR_CLIENT_ID.apps.googleusercontent.com',
    GOOGLE_API_KEY: 'YOUR_API_KEY',
    // ...
};
```

## Hostaus

### Vaihtoehto 1: GitHub Pages (ilmainen)

1. Pushaa koodi GitHubiin
2. Mene repositoryn **Settings** → **Pages**
3. Valitse branch: `main`, folder: `/ (root)`
4. Lisää GitHub Pages URL OAuth consent screenille ja Credentialseihin

### Vaihtoehto 2: Firebase Hosting (ilmainen)

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
   - Valitse projektisi
   - Public directory: `.` (nykyinen hakemisto)
   - Single-page app: No
   - Älä ylikirjoita index.html

4. Julkaise:
   ```bash
   firebase deploy
   ```

5. Lisää Firebase URL OAuth consent screenille ja Credentialseihin

### Vaihtoehto 3: Paikallinen kehityspalvelin

```bash
# Python 3
python -m http.server 8000

# Node.js (npx)
npx serve .

# PHP
php -S localhost:8000
```

Avaa selaimessa: http://localhost:8000

## Käyttö

1. Avaa sovellus selaimessa
2. Kirjaudu Google-tililläsi
3. Valitse Google Drive -kansio, jossa kirjasi ovat
4. Napauta tiedostoa aloittaaksesi lukemisen/kuuntelun

## Tuetut tiedostomuodot

- **PDF** - Kirjat PDF-muodossa
- **Audio** - MP3, M4A, WAV, OGG, FLAC, AAC

## Teknologiat

- **PDF.js** - PDF-näyttö selaimessa
- **Google Identity Services** - Kirjautuminen
- **Google Drive API** - Tiedostojen lukeminen
- **Web Audio API** - Äänentoisto
- **LocalStorage** - Edistymisen tallennus

## Tietoturva

- Sovellus käyttää vain `drive.readonly` -oikeutta (ei voi muokata tiedostojasi)
- Access token tallennetaan vain selaimen localStorageen
- Kaikki data pysyy omassa Google Drivessasi

## Vianmääritys

### "Kirjautuminen epäonnistui"
- Varmista että Client ID on oikein
- Tarkista että domain on lisätty OAuth credentialseihin
- Poista evästeet ja yritä uudelleen

### "PDF:n lataaminen epäonnistui"
- Varmista että tiedosto on PDF-muodossa
- Tarkista että sinulla on lukuoikeus tiedostoon

### "Ääni ei toistu"
- Tarkista selaimen ääniasetukset
- Kokeile eri selaimella

## Lisenssi

MIT License

## Tekijä

AudioBook Reader - Web-pohjainen e-kirja- ja äänikirjalukija
