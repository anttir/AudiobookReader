# Käyttö

## Perustoiminta

1. Avaa sovellus ja **kirjaudu Google-tilillä** (kevyt consent: nimi + sähköposti).
2. Oletuksena näkyy **Cloudflare R2** -kirjasto. Vaihda halutessasi
   **Google Drive** -välilehteen (kysyy Drive-luvan ensimmäisellä kerralla,
   ks. [auth-redesign.md](auth-redesign.md)).
3. Napauta kirjaa aloittaaksesi lukemisen tai kuuntelun. Sovellus muistaa
   missä kohtaa olit, ja näyttää "Jatka lukemista" -kortin.

## Tuetut tiedostomuodot

**E-kirjat:** PDF (`.pdf`), EPUB (`.epub`)

**Äänitiedostot:** MP3, M4A, M4B (audiobook), WAV, OGG, FLAC, AAC, OPUS,
WebM Audio — sekä **HLS**-soittolistat (`.m3u8`, R2-streaming).

## Kirjojen järjestely (Google Drive)

Sovellus tunnistaa rakenteen automaattisesti:

**Kansio = kirja** (suositeltu moniosaisille):
```
📁 Minun Kirjani/
   📄 Osa 1.pdf
   🎵 Luku 01.mp3
   🎵 Luku 02.mp3
```
Näytetään yhtenä kirjana, jonka osien välillä voi navigoida.

**Yksittäiset tiedostot:**
```
📁 Kirjasto/
   📄 Kirja1.pdf
   🎵 Podcast.mp3
```
Jokainen tiedosto näytetään erikseen. Molempia voi myös yhdistää samassa
kansiossa.

R2-puolella kirjat määritellään `index.json`-manifestissa — ks.
[uploading-books.md](uploading-books.md).

## Näppäinkomennot

| Näppäin | Toiminto |
|---------|----------|
| `←` / `→` | Edellinen/seuraava sivu (PDF/EPUB) |
| `Space` | Toista/pysäytä (audio) |
| `←` / `→` | Kelaa 10 s (audio-tilassa) |

## Mobiilieleet

- **Pyyhkäise vasemmalle/oikealle** — vaihda sivua.

## Vianmääritys

### Kirjautuminen näyttää "Google ei ole vahvistanut sovellusta"
Jos olet käyttänyt sovellusta aiemmin ja myöntänyt Drive-luvan, Google
muistaa sen ja näyttää varoituksen. Poista oikeudet kerran:
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
→ AudioBook Reader → poista käyttöoikeus → kirjaudu uudelleen. Sama ohje on
sovelluksen kirjautumisnäkymässä. Tausta: [auth-redesign.md](auth-redesign.md).

### R2-äänikirjat eivät näy
R2-sisältö on auth-workerin takana ja avoinna vain allowlist-sähköposteille.
Varmista että tilisi on listalla (omassa kopiossa: Workerin `ALLOWED_EMAILS`).

### PDF/EPUB ei lataudu (Google Drive)
- Varmista lukuoikeus tiedostoon Drivessä.
- Tarkista selaimen konsoli (F12) virheviesteistä.

### Ääni ei toistu
- Jotkin selaimet vaativat käyttäjän interaktion ennen äänentoistoa — paina play.

### Edistyminen ei tallennu
- Salli `localStorage`. Incognito/yksityinen selaus ei säilytä dataa.
- Laitteiden välinen synkronointi vaatii Google Drive -luvan (käyttää
  `drive.appdata`-kansiota).
