# AudioBook Reader

Web-sovellus (PWA) e-kirjojen lukemiseen ja äänikirjojen kuunteluun. Kirjat
voivat olla **Cloudflare R2:ssa** (HLS-streaming, alkaa soida ~1 s sisällä)
tai **Google Drivessä**. Toimii myös puhelimella ja sen voi "asentaa"
kotivalikkoon.

## 🌐 Live

**[https://anttir.github.io/AudiobookReader/](https://anttir.github.io/AudiobookReader/)**

Kirjaudu Google-tilillä → kuuntele. Kirjautuminen on kevyt (vain nimi +
sähköposti); R2-äänikirjat näkyvät allowlist-tileille. Google Drive on oma
välilehtensä, ja sen lisälupa kysytään vasta jos avaat sen.

> Julkaistu GitHub Pagesilla `main`-branchista — jokainen merge `main`:iin
> julkaisee uuden version automaattisesti (~30 s).

## Ominaisuudet

- **Kaksi tallennuslähdettä** — Cloudflare R2 (oletus, HLS-streaming) ja
  Google Drive; vaihto lähde-välilehdestä.
- **Äänisoitin** — MP3, M4A, M4B, WAV, OGG, FLAC, AAC, OPUS, WebM + HLS;
  nopeussäätö 0.5–2×, lukkonäytön ohjaus (Media Session).
- **PDF- ja EPUB-lukija** selaimessa.
- **Moniosaiset kirjat** — kansio = yksi kirja, jossa voi olla useita osia.
- **Edistymisen tallennus** — muistaa missä kohtaa olit (lähdekohtaisilla
  avaimilla); "Jatka lukemista" -kortti. Valinnainen laitteiden välinen
  synkronointi Google Driven kautta.
- **Teemat** (tumma/vaalea/seepia) ja **PWA-asennus**.

## Pikakäyttö

Helpoin tapa on käyttää [live-versiota](https://anttir.github.io/AudiobookReader/).
Paikallinen kehityspalvelin:

```bash
python -m http.server 8000   # tai: npx serve .
# avaa http://localhost:8000
```

Oman kopion pystytys (omat Google- ja Cloudflare-tunnukset) on kuvattu
kohdassa [docs/self-hosting.md](docs/self-hosting.md).

## Dokumentaatio

| Dokumentti | Sisältö |
|---|---|
| [docs/usage.md](docs/usage.md) | Tuetut tiedostomuodot, kirjojen järjestely, näppäin- ja eleohjaus, vianmääritys |
| [docs/architecture.md](docs/architecture.md) | Tallennuslähteet, provider-rajapinta, miten osat liittyvät yhteen |
| [docs/auth-redesign.md](docs/auth-redesign.md) | Kirjautumisen ja tietoturvan malli (OAuth Authorization Code -flow + Cloudflare Worker) ja setup-runbook |
| [docs/self-hosting.md](docs/self-hosting.md) | Oman kopion pystytys: Google Cloud, OAuth-client, Worker, hostaus |
| [docs/uploading-books.md](docs/uploading-books.md) | R2-bucketin rakenne, `index.json`-manifesti, HLS-vaatimukset, upload |

## Tietoturva (lyhyesti)

Kirjautuminen pyytää sisäänkirjautuessa vain ei-arkaluonteiset
`userinfo.email`/`profile`-oikeudet (riittää R2:lle); Google Drive -oikeudet
(`drive.readonly`, `drive.appdata`) pyydetään vasta kun käyttäjä avaa Driven.
Refresh tokenia ei säilytetä selaimessa — sen pitää [Cloudflare
Worker](tools/r2-auth-worker), joka antaa selaimelle salatun session-tokenin.
Koko malli ja perustelut: [docs/auth-redesign.md](docs/auth-redesign.md).

## Teknologiat

PDF.js · EPUB.js · hls.js · Web Audio / Media Session · Google Drive API ·
Cloudflare R2 + Workers · vanilla JS (ei build-vaihetta) · GitHub Pages.

## Lisenssi

MIT
