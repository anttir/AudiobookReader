# Changelog

Merkittävät muutokset, uusin ensin. Tarkka historia: git- ja PR-loki.

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
