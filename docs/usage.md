# Käyttö

## Perustoiminta

1. Avaa sovellus ja **kirjaudu Google-tilillä** (kevyt consent: nimi + sähköposti).
2. Oletuksena näkyy **Cloudflare R2** -kirjasto. Vaihda halutessasi
   **Google Drive** -välilehteen (kysyy Drive-luvan ensimmäisellä kerralla,
   ks. [authentication.md](authentication.md)).
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

## Paluu edelliseen kuuntelukohtaan

Jos toistokohta hyppää yhtäkkiä kauas — esimerkiksi vahinkonapautus
puhelimen lukitusnäytön edistymispalkkiin tai sovelluksen omaan palkkiin —
soitin muistaa, missä olit:

- Edistymispalkkiin ilmestyy **oranssi merkki** kohtaan, jossa olit ennen
  hyppyä.
- Palkin alle ilmestyy **"Palaa kohtaan h:mm:ss"** -painike.

Napauta painiketta tai merkkiä palataksesi. Paluun jälkeen merkki näyttää
kohdan, josta palasit — joten paluunkin voi perua. Merkki nollautuu, kun
vaihdat tiedostoa tai kirjaa. Pienet siirtymät (alle minuutin, esim.
30 sekunnin kelauspainikkeet) eivät aktivoi merkkiä.

## Kuunneltu asti ja paikkahistoria

Soitin muistaa kirjakohtaisesti (synkronoituu laitteiden välillä):

- **Kuunneltu asti** — pisin kohta, johon on kuunneltu yhtäjaksoisesti.
  Näkyy **vihreänä kolmiona** edistymispalkin yläpuolella. Etenee vain
  normaalilla toistolla: hyppy eteenpäin hyväksytään vasta, kun siitä on
  kuunneltu 2 minuuttia. Ei koskaan pienene.
- **"Jatka kuunnellusta h:mm:ss"** -painike näkyy, kun olet yli 30 s
  jäljessä tästä kohdasta — myös jos tallennettu kohta on kirjaa
  avattaessa nollautunut (lisäksi ilmoitus *Jatka kohdasta …*). Ei näy,
  jos kohta on tiedoston viimeisillä 5 sekunnilla (kirja kuunneltu loppuun).
- **Paikkahistoria** (kellokuvake painikkeiden vieressä) — ~20 viimeisintä
  kohtaa: paikka ennen jokaista isoa hyppyä + välitallennus 5 min
  toiston välein. Rivillä kellonaika, luku ja kohta; napautus siirtää sinne.
  Merkintä **tallennettu kohta** = aiemmin tallennettu kuuntelukohta, joka
  korvautui tai jota ei saatu palautettua kirjaa avattaessa.

Tallennettu kuuntelukohta ei siirry yli minuutin taaksepäin ilman omaa
toimintoa (palkki, kelaus, luku, historia, paluu-painikkeet) — virheen tai
verkkokatkon aiheuttama "0:00" ei siis korvaa oikeaa kohtaa. Muualta tullut
siirto taaksepäin (esim. lukitusnäytön palkki) tallentuu, kun siitä on
kuunneltu 2 minuuttia. Jos pysäytät tai suljet sitä ennen, kohta jää
paikkahistoriaan merkinnällä **keskeytynyt**.

## Arkisto

R2-kirjaston työkalupalkissa on valinta **Aktiiviset | Arkistoidut**
(näkyy vain, kun kirjastossa on R2-kirjoja; valinta muistetaan).
Arkistoidut kirjat eivät näy aktiivisessa listassa eivätkä "Jatka
lukemista" -kortissa, mutta ne voi avata Arkistoidut-näkymästä.

- **Arkistoi / Palauta arkistosta** — ylläpitäjät (`CONFIG.ARCHIVE_ADMIN_EMAILS`,
  Workerin `ADMIN_EMAILS`) näkevät painikkeen kirjakortissa, listarivillä
  ja soittimen yläpalkissa. Onnistumisilmoituksessa on **Kumoa**.
- **"Äänet poistettu"** -merkki: kirjan äänitiedostot on poistettu R2:sta
  (purge). Kirjaa ei voi enää kuunnella eikä palauttaa aktiivisiin.

Tekninen spec (manifestin kentät, Workerin endpoint):
[uploading-books.md](uploading-books.md#archiving--purging).

## Näppäinkomennot

| Tila | Näppäin | Toiminto |
|---|---|---|
| PDF/EPUB | `←` / `→` | Edellinen/seuraava sivu |
| Audio | `Space` | Toista/pysäytä |
| Audio | `←` / `→` | Kelaa 10 s |

## Mobiilieleet

- **Pyyhkäise vasemmalle/oikealle** — vaihda sivua.

## Vianmääritys

### Kirjautuminen näyttää "Google ei ole vahvistanut sovellusta"
Jos olet käyttänyt sovellusta aiemmin ja myöntänyt Drive-luvan, Google
muistaa sen ja näyttää varoituksen. Poista oikeudet kerran:
[myaccount.google.com/permissions](https://myaccount.google.com/permissions)
→ AudioBook Reader → poista käyttöoikeus → kirjaudu uudelleen. Sama ohje on
sovelluksen kirjautumisnäkymässä. Tausta: [authentication.md](authentication.md).

### R2-äänikirjat eivät näy
R2-sisältö on auth-workerin takana ja avoinna vain allowlist-sähköposteille.
Varmista että tilisi on listalla (omassa kopiossa: Workerin `ALLOWED_EMAILS`).

### PDF/EPUB ei lataudu (Google Drive)
- Varmista lukuoikeus tiedostoon Drivessä.
- Tarkista selaimen konsoli (F12) virheviesteistä.

### Ääni ei toistu
- Jotkin selaimet vaativat käyttäjän interaktion ennen äänentoistoa — paina play.

### Ääni häivyttyy sisään toistuvasti (USB-C-kuulokkeet)
Kuulokkeet, joissa on oma DAC (esim. Apple EarPods USB-C), mykistyvät
digitaalisesta hiljaisuudesta ja häivyttävät seuraavan äänen sisään.
Soitin sekoittaa toiston ajan ääneen kuulumattoman 20 Hz:n signaalin, ettei
näin käy. Tarkista ensin, että käytössä on uusin versio (*Asetukset →
Tietoja*). Jos häivytys toistuu tasaisesti ~10 s välein R2-kirjassa, syy on
todennäköisesti kirjan HLS-segmenteissä. Selvitä puhelimella: *Asetukset →
Tietoja → Äänidiagnostiikka* päälle, kuuntele kirjaa muutama minuutti ja
katso tulos samasta kohdasta. Jos lyhyet katkot ovat lähes kaikki
*segmenttisaumoissa*, kirjan segmentit on koodattu erikseen ja kirja pitää
koodata uudelleen yhtenäisenä (koneella:
[`check-segment-gaps.py`](../tools/upload-to-r2/check-segment-gaps.py), ks.
[uploading-books.md](uploading-books.md#common-mistakes)). Paljon
*digitaalista hiljaisuutta* = kirjan tauot on leikattu nollaan.
Tauon jälkeen jatkaessa lyhyt häivytys on normaalia: lähtö suljetaan tauon
ajaksi akun säästämiseksi.

### Onko käytössä uusin versio?
*Asetukset → Tietoja* näyttää version ja kertoo, onko julkaistu uudempi;
*Päivitä uusimpaan* lataa sen. Sovellus ilmoittaa uudesta versiosta myös
itse käynnistyessä ja taustalta palatessa.

### Edistyminen ei tallennu
- Salli `localStorage`. Incognito/yksityinen selaus ei säilytä dataa.
- Laitteiden välinen synkronointi vaatii Google Drive -luvan (käyttää
  `drive.appdata`-kansiota).
