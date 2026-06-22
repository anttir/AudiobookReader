# Arkkitehtuuri

Sovellus on rakenteeltaan kevyt: staattinen PWA (vanilla JS, ei
build-vaihetta) tarjoiltuna GitHub Pagesilta, plus yksi Cloudflare Worker
joka hoitaa autentikoinnin ja R2-sisällön välityksen.

```
Selain (PWA, GitHub Pages)                 Cloudflare Worker            Google
  js/app.js        UI + näkymät              /auth/*  OAuth-backend  ──▶  OAuth / Drive API
  js/auth.js       sessio + token            /<key>   R2-proxy       ──▶  R2 bucket
  js/providers/*   tallennuslähteet
  js/audioplayer   hls.js / <audio>
```

## Tallennuslähteet (providers)

Jokainen lähde on oma luokka `js/providers/`-hakemistossa, joka toteuttaa
yhteisen **`ProviderBase`**-rajapinnan: `getLibraryStructure`,
`getStreamUrl`, `downloadAsBlob`, sekä kapasiteettiliput `supportsHLS` /
`supportsByteRange` / `supportsBrowsing`.

| Provider | Lähde | Toisto | Selailu |
|---|---|---|---|
| `R2Provider` | Cloudflare R2 (`index.json`-manifesti) | HLS (hls.js) tai natiivi byte-range | ei (manifesti) |
| `DriveProvider` | Google Drive | lataa blob → toistaa | kansiopicker |

`registry.js` pitää kirjaa rekisteröidyistä providereista ja aktiivisesta
lähteestä. **Uuden lähteen lisääminen:** uusi tiedosto
`js/providers/`-hakemistoon + yksi rivi `registry.js`:ään. Rekisteröinti­-
järjestys määrää myös välilehtien järjestyksen (R2 ensin = oletus).

## Kirjautuminen ja tietoturva

Selain käyttää OAuth **Authorization Code + PKCE** -flow'ta, jossa Cloudflare
Worker on luottamuksellinen osapuoli: se vaihtaa coden tokeneiksi, säilyttää
refresh tokenin (sinetöitynä session-tokeniin) ja mintaa tuoreita
access-tokeneita `/auth/token`-endpointista. Tämä toimii myös iOS Safarissa,
jossa vanha selainpohjainen hiljainen uusinta ei toiminut.

Scopet ovat kaksiportaiset: kevyt perus-login (R2) ja erikseen pyydettävät
Drive-oikeudet. Koko malli, perustelut ja setup-runbook:
**[auth-redesign.md](auth-redesign.md)**.

## Edistyminen ja synkronointi

Edistyminen tallennetaan `localStorage`en lähdekohtaisilla avaimilla
(`drive:fileId`, `r2:bookId`), jotta sama nimi ei törmää eri lähteissä.
Laitteiden välinen synkronointi (`js/sync.js`) käyttää Google Driven
`appDataFolder`-kansiota ja on käytössä vasta kun Drive-lupa on myönnetty.

## R2-sisältö

R2-bucket on yksityinen, ja Worker välittää objektit vasta kun pyytäjän
Google-token on voimassa ja sähköposti on `ALLOWED_EMAILS`-listalla
(`Range`-tuki säilyy, joten HLS toimii). Bucketin rakenne ja manifesti:
**[uploading-books.md](uploading-books.md)**. Worker-toteutus:
[tools/r2-auth-worker/](../tools/r2-auth-worker/). Upload-referenssi:
[tools/upload-to-r2/](../tools/upload-to-r2/).
