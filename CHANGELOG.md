# Changelog

Merkittävät muutokset, uusin ensin. Tarkka historia: git- ja PR-loki.

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
