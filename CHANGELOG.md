# Changelog

Merkittävät muutokset, uusin ensin. Tarkka historia: git- ja PR-loki.

## 2026-10

- **Sisällysluettelo näyttää kuunnellut luvut**: luku, jonka loppuun
  yhtäjaksoinen kuuntelu (*kuunneltu asti*) on edennyt, saa vihreän
  ruksin ja himmennetyn nimen. Moniosaisissa kirjoissa sama tiedostoittain.
  Lista vierittyy nyt myös oikeasti nykyisen luvun kohdalle.
- **Luku ja sisällysluettelo yhdistetty**: kirjan nimen alla oleva luvun
  nimi on nyt nappi (⌄), jonka alla näkyy luvun numero, eteneminen luvun
  sisällä ja luvusta jäljellä oleva aika. Napautus avaa sisällysluettelon
  alhaalta nousevana paneelina (sulkeutuu taustaa napauttamalla, alas
  vetämällä tai Esc). Paneelissa: kuunneltu/jäljellä-yhteenveto, luvun
  pituus, soivan luvun taajuuspalkit ja etenemisviiva. Kelluva
  *kappaletta*-nappi, joka peitti nopeusvalinnan, on poistettu
  kuuntelutilasta.

- **USB-C-kuulokkeiden herätys asetuksiin, oletuksena 10 Hz / −30 dB**:
  ryhmä *USB-C-kuulokkeet* on sekä *Asetuksissa* että toiston aikana
  avattavissa *Lukuasetuksissa* (taso Pois / −40 / −30 / −20 dB, taajuus
  10 Hz / 20 Hz / 20 kHz); soittimen pikavalinta poistettu. EarPods USB-C:llä
  −30 dB riitti, mutta 20 Hz surisi (kuulokkeen särökomponentit 40/60/80 Hz);
  10 Hz siirtää ne oktaavin alemmas, 20 kHz ei liikuta kalvoa juuri lainkaan.
  Päällä oletuksena: selain ei voi tunnistaa kytkettyjä kuulokkeita ilman
  mikrofonilupaa, ja kuulumaton signaali ei haittaa muilla laitteilla.
- **USB-C-herätys säädettäväksi**: soittimessa nopeuden vieressä valinta
  *Pois / −40 / −30 / −20 dB* (oletus −30). Kuulokkeiden mykistysraja
  vaihtelee adapterikohtaisesti, eikä kiinteä −40 dBFS riittänyt EarPods
  USB-C:lle. Diagnostiikan laskuri näyttää signaalin tilan. Diagnostiikan
  mittaus *Suon villi laulu* -kirjasta: katkoista vain ~6 % osui
  segmenttisaumoihin (sattumanvarainen osuus), eli segmentit eivät ole syy;
  kirjassa on paljon digitaalista hiljaisuutta. Sama oire on raportoitu
  Samsung-yhteisössä USB-C-kuulokkeilla BookBeatissa ja Spotifyssa, ja siellä
  toimivaksi kiertotieksi kerrotaan rinnalla soiva kuulumaton (10 Hz) ääni.
- **Äänidiagnostiikka** (*Asetukset → Tietoja*, oletuksena pois): mittaa
  puhelimella toistettavasta äänestä lyhyet katkot (ja ovatko ne
  HLS-segmenttien saumoissa), digitaalisen hiljaisuuden ja
  puskurointipysähdykset. Toisto ei muutu (ääni luetaan
  `captureStream()`-kopiosta). Tulos säilyy kirjasta poistuttaessa, ja
  soittimessa näkyy laskuri mittauksen ollessa päällä.
- Taustasignaali nostettu −50 → −40 dBFS (edelleen 20 Hz); −50 dBFS
  vähensi häivytyksiä mutta ei poistanut niitä.
- **Versio ja päivitykset**: *Asetukset → Tietoja* näyttää käytössä
  olevan version ja tarkistaa, onko julkaistu uudempi (*Päivitä
  uusimpaan*). Sovellus tarkistaa saman myös käynnistyessä ja palatessaan
  taustalta (enintään 30 min välein) ja tarjoaa päivitystä ilmoituksella.
- **USB-C-DAC:n sisäänhäivytys (Apple EarPods USB-C)**: soitin sekoittaa
  toiston ajan ääneen kuulumattoman 20 Hz:n signaalin, jotta kuulokkeiden
  DAC ei koskaan näe digitaalista hiljaisuutta eikä mykisty ja häivytä
  seuraavaa ääntä sisään. Hiljaisuutta syntyy, kun äänikanava katkeaa
  (tiedostonvaihto, puskurointikatko, virhepalautus) ja kun äänessä itsessään
  on lähes hiljaisia kohtia, jotka Androidin äänenvoimakkuuden skaalaus
  pyöristää nollaksi. Taso nostettiin ensimmäisestä versiosta (−74 →
  −50 dBFS), koska −74 dBFS saattoi pyöristyä nollaan; alku ja loppu
  liukuvat. Lähtö vapautetaan tauolla, kirjan lopussa ja 60 s jälkeen jos
  toisto ei jatku. Ei käytössä iOS:llä.
- **`tools/upload-to-r2/check-segment-gaps.py`**: tarkistaa, onko HLS-kirjan
  segmenttien saumoissa katkoja (segmentit koodattu erikseen → ~20–50 ms
  lähes hiljainen kohta ~10 s välein). Ks.
  [docs/uploading-books.md](docs/uploading-books.md#common-mistakes).

## 2026-09

- **Kuuntelukohdan palautus**: kirjakohtainen *kuunneltu asti* -kohta
  (vihreä merkki + "Jatka kuunnellusta" -painike) ja *paikkahistoria*
  (kohdat ennen isoja hyppyjä + 5 min välitallennukset; lisäksi
  *keskeytynyt* = kuunneltu kohta jota ei tallennettu nykyiseksi, ja
  *tallennettu kohta* = korvautunut tai palauttamatta jäänyt tallennus),
  molemmat synkronoituvat. Tallennus ei enää hyväksy ohimenevää 0:aa tai
  isoa siirtoa taaksepäin ilman käyttäjän toimintoa (mm. HLS-virhepalautuksen
  aikana tai ennen palautushypyn valmistumista). Sovelluksen avauksessa
  (synkronoinnin alustus) data yhdistetään kentittäin (kohta: uusin voittaa;
  kuunneltu asti: suurin; historia: yhdiste); käytön aikaiset lataukset
  korvaavat etätiedoston. Tallennus ~5 s välein toiston aikana. Ks.
  [docs/usage.md](docs/usage.md#kuunneltu-asti-ja-paikkahistoria).
- **Arkisto**: R2-kirjat voi arkistoida (ylläpitäjä) — kirjastossa
  *Aktiiviset | Arkistoidut* -valinta, arkistointipainike kortissa, rivillä
  ja soittimessa, "Äänet poistettu" -merkki kirjoille joiden äänet on
  poistettu. Workerissa admin-only `POST /_api/archive` (vain Bearer +
  JSON, etag-ehdollinen `index.json`-kirjoitus). Ks.
  [docs/usage.md](docs/usage.md#arkisto).
- **Content-Security-Policy** kaikilla sivuilla: yhteydet vain omaan
  originiin, Workeriin, käytettyihin Google-endpointeihin ja versioon
  lukittuihin CDN-kirjastoihin. Oma (ei-oletus) R2-URL ei siksi toimi.

## 2026-07

- **Paluu edelliseen kuuntelukohtaan**: kun toistokohta hyppää yhtäkkiä
  kauas (esim. vahinkonapautus lukitusnäytön edistymispalkkiin), soittimen
  edistymispalkkiin ilmestyy oranssi merkki edelliseen kohtaan ja sen alle
  "Palaa kohtaan" -painike. Napautus palauttaa kuuntelun siihen, missä
  olit — ja paluun voi myös perua. Ks. [docs/usage.md](docs/usage.md).

## 2026-06

- **Kirjautuminen uusittu** OAuth Authorization Code + PKCE -malliin, jossa
  Cloudflare Worker säilyttää refresh tokenin ja antaa selaimelle salatun
  session-tokenin. Korjaa iOS Safarin toistuvan uudelleenkirjautumisen ja
  R2-toiston katkeamisen. Scopet kaksiportaiset (kevyt perus-login; Drive
  vasta erikseen pyydettäessä), R2 oletuslähteenä. Malli:
  [docs/authentication.md](docs/authentication.md).
- Dokumentaatio jaettu tiiviiseen README:hen + aihekohtaisiin `docs/`-tiedostoihin.
