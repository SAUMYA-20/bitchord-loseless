# Research: BitChord & how its addons work

*Everything learned while building this — app, code, protocol, sources, deployment reality.*

## 1. The app

**BitChord** (`github.com/kushagrasinghx/BitChord`) — a free, open-source (GPLv3),
Kotlin/Jetpack-Compose YouTube Music client for Android (min SDK 26), plus official
builds for Windows/Linux/macOS and an Android TV APK. ~6.5k GitHub stars, 1.3M+
downloads, active releases (v1.9.x as of 2026). By Kushagra Singh (`kushagrasingh.in`).

Architecture:
- **InnerTube** (YouTube Music's unofficial web API, `WEB_REMIX` client) fetched via
  OkHttp with signed `SAPISIDHASH` auth for the catalog/search/lyrics/artist/album graph.
- **NewPipeExtractor** for stream signature deciphering + URL resolution fallbacks.
- **Media3 / ExoPlayer** for playback (DASH/HLS/progressive, extractors auto-selected,
  offload to device codec), on-device decode, scrobbling (Last.fm/ListenBrainz),
  Discord RPC, Cast/Android Auto, Musixmatch synced lyrics, in-app replay stats.
- **Auto-update**: `AppUpdateChecker` hits the GitHub releases API
  (`/repos/kushagrasinghx/BitChord/releases/latest`) on launch and prompts the user.
- **Module/source system**: pluggable *sources*. Legacy in-process modules (Java/Kotlin)
  exist upstream (Tidal/Qobuz modules shipped but largely inert — they need credentials
  they don't have), and current out-of-process **addons** (HTTP JSON) which is what this
  project implements.

## 2. The addon protocol (v1, `SourceRegistry` + `AddonClient`)

An addon is **any HTTPS base URL** exposing three GET routes returning JSON. Nothing is
downloaded, nothing executes on device; BitChord calls the host directly.

### `GET /manifest.json`
```json
{
  "id": "app.bitchord.lossless",
  "name": "Lossless · Tidal + Internet Archive + NetEase (GDStudio)",
  "version": "1.0.0",
  "resources": ["search", "stream"],
  "settings": [ { "key": "quality", "type": "select", "default": "lossless",
                  "options": [ { "label": "...", "value": "lossless" } ] } ],
  "checkValidLossless": true
}
```
- `name` is what appears in **Settings → Sources** (`SourceRegistry.identify` copies it
  into the stored label; blank degrades silently to the hostname).
- BitChord re-reads the manifest on the sources screen (10-min cache) and hands back
  **declared setting defaults** on every request, overriding `quality` with the requested
  tier via `matchTier` — word-matched: HIGH→`high|320|normal|standard`,
  LOW→`low|96|128|min`, LOSSLESS→the listener's picked option (first-listed by default).
- No form is rendered for other settings; only `quality` is ever shown and only
  defaults are sent.
- Manifest flags: `allowDownloads` (default **true**), `checkValidLossless`
  (default **false** — app rejects a non-lossless download), `bitchordAuth` (signed
  auth for downloads, e.g. P2PChord uses it).

### `GET /search?q=Artist Title&quality=lossless[&limit=40]`
Returns `{ "tracks": [ AddonTrack... ] }`. Rows:
```
id, title, artist, album, duration (SECONDS, float),
artworkURL, albumArtworkURL, format ("flac"), audioQuality ("LOSSLESS" | "HI_RES_LOSSLESS"),
audioMode ("STEREO" | "MULTICHANNEL" | "DOLBY_ATMOS"),
audioModes: [...], atmos: true, streamURL
```
- `streamURL` on a row lets BitChord **skip the `/stream` call entirely** (one round trip
  saved) — deliberately unused here because our URLs are signed/expiring and must be
  resolved fresh, and because `/stream` is where FLAC verification happens.
- Zero rows = a valid "not held here" answer (**not** an error). A source that fails must
  not fail the whole search — BitChord races all sources and picks by quality.
- **Atmos detection (both rows and streams)** = regex `atmos|dolby|eac3[_-]?joc|ec-?3`
  over `audioQuality + audioMode(s) + format`, or `atmos: true` / `DOLBY_ATMOS` in
  `audioModes`. Atmos rows outrank stereo rows on devices with an Atmos renderer.

### `GET /stream/{id}?quality=lossless[&atmos=auto]`
Returns the playable rendition:
```
url (required)         — handed to Media3 ProgressiveMediaSource
codec, container       — read first; `flac` implies self-describing container
manifest               — `none` = the URL is the audio itself; `hls`/`dash` selects
                         the matching MediaSource (a DASH url with no manifest field
                         reaches a progressive extractor and dies as PARSING_CONTAINER)
encrypted              — anything but false → refused (DRM never sent without ?drm=)
sampleRate, bitDepth   — read first from these, fall back to the `quality` text
                         (`24-bit`, `96 kHz`, `... kbps` regexes)
bitrate                — kbps (>3000 read as bps)
quality / streamQuality / audioQuality / audioMode / audioModes
                       — free text, parsed for the badge
format                 — `dash`/`hls` here also selects the transport
```
- **`?atmos=auto`** is sent exactly when the device *and* user opted into immersive
  audio (`DeviceCodecs.atmosWanted`) and the listener didn't pick a specific stereo
  row (`stereoOnly`). An addon gates its immersive branch on it. Value is exactly
  `auto` (try-atmos-then-stereo). Never `1`/`true` — those mean *strict* and would
  error on every ordinary track.
- Unknown fields are ignored by older builds; `error` (non-spec) carries a reason
  string to logs.

### `/health`
Not part of the protocol — an operator/BitChord-debug convenience. Installed sources
in BitChord show addon `name`, and this server exposes per-source health there.

### Install path in the app
`Settings → Sources → Add an addon → paste <host>/manifest.json`
→ **Audio Quality** setting per-addon appears (`Handled by manifest defaults`),
**Lossless** category lists the addon's rows; the app races it against YouTube Music and
hot-swaps the background load (YouTube Opus starts in <200 ms; FLAC swaps in when
resolved, else falls back to YouTube HQ).

## 3. Verified free source landscape (November 2026)

| Source | Auth | What it serves | Reality check |
|---|---|---|---|
| `tracks.monochrome.st` | none | Tidal catalogue, 16/44.1 FLAC | Search `/search/tracks` JSON; stream `/track/{id}` is the FLAC itself (`fLaC` magic verified, HTTP 206 + `Content-Range`). Asking `quality=HI_RES_LOSSLESS`/`DOLBY_ATMOS` returns the **same 16/44.1 stereo file** — no Hi-Res index, no Atmos. (Community Tidal pulls ≈28M ;/track requests/day.) |
| Internet Archive | none | Freely-licensed FLAC (~1M items; 1112 "radiohead") | `advancedsearch.php` (sort downloads desc) → `metadata/{id}` file list → `/download/{id}/{file}`. Verified **24-bit / 96 kHz** FLAC on a real Radiohead-adjacent live item. Fully legal: ETree live concerts, public-domain transfers, CC. |
| GDStudio gateway (`music-api.gdstudio.xyz`) | none | NetEase (stable), Tencent/Kuwo/Joox (flaky), TIDAL/Qobuz (intermittently "not supported") | `types=search` → ids/albums; `types=url&br=999` → CDN FLAC (24-bit where masters exist; 16-bit else; ~60 req/5 min per IP). Verified real `fLaC` bytes from `m8.music.126.net`. Search rows carry **no duration**; artwork endpoint returns JSON, not an image. Tidal/Qobuz catalogue access requires the track to exist there w/o login cookies — treat as bonus, not baseline. |
| Lossless Sources probe (`raw.githubusercontent.com/kipavy/spotube-plugin-lossless-sources/main/sources.json`) | none | List of public instances that **currently serve real audio**, refreshed by CI | 2026-11-13: only `tracks.monochrome.st` (type `monochrome`) marked healthy; 8 `hifi-api` hosts (binimum fork, FastAPI/Python + host Tidal accounts) listed as candidates, all dead/unreachable from the test network. This is the **auto-updating discovery feed** this addon polls. |
| hifi-api instances | none (host pays/holds tokens) | Tidal 16/44.1, rare 24-bit & `DOLBY_ATMOS` via `trackManifests` | Untestable end-to-end today (all probed hosts down/blocked; requires host Tidal account they *choose* to run; account bans en masse since ~2025). Wired in as auto-discovery candidates only. |
| Local FLAC library | none | your files | Only **always-free** path to true immersive audio: Atmos masters as multichannel FLAC; served with `audioModes: ["DOLBY_ATMOS"]` when the name says so, `MULTICHANNEL` when STREAMINFO says >2ch. |
| Jamendo / FMA / ccMixter / Musopen / Bandcamp / YouTube Audio Library | registration or page-scraped | MP3/OGG free, FLAC rare/absent | Key required (not one-step) or no direct FLAC URLs → excluded from MVP to keep "paste one URL and it works". |
| Tidal/Qobuz/Amazon/Apple (official) | paid account | Hi-Res + true Atmos EC-3/JOC | Rejected: not free, not open to redistribute. |
| SpotiFLAC `.sflx` extensions | — | — | Incompatible: JS extensions for another app; BitChord executes nothing remotely, uses HTTP only. |
| monochrome static host index (8 hard-coded hosts) | — | — | 7/8 dead/auth-broken today → replaced by live discovery. |
| P2PChord (Soulseek + torrents) | account + signed auth | true Atmos/FLAC | Great for homelab crawlers; not one-step & needs `bitchordAuth` + app ≥1.9.1 → out of MVP scope. |

**Atmos verdict**: true Atmos exists only behind Apple Music (ALAC/EC-3), Tidal
(EC-3/JOC via HiRes endpoint) or Amazon Music Unlimited — all paid, none redistributable.
Free Atmos ≠ a network endpoint; it is *your files* (multichannel FLAC) or nothing.
The addon labels Atmos **only with evidence** (name hint / >2ch STREAMINFO / explicit
upstream tag) and passes `?atmos=auto` semantics straight through.

## 4. Stability/operational lessons baked into the code

- Hard deadlines on **every** upstream call (`AbortSignal.timeout`); a hung source must
  never hold BitChord's source-resolution slot.
- `settleAll` — a failed source never fails the search; partial answers are useful.
- Round-robin interleave + dedupe so the biggest catalogue can't starve the rows.
- Round-trip **STREAMINFO verification** on every `/stream` (42-byte range probe, cached
  per-id for process life): labels are read from the file, never asserted from the catalog.
- Proxy mode (`PROXY=1`) with 520/5xx retries and an `fLaC` magic check before any byte
  is committed to an `audio/flac` content type — never hand a player an HTML error page.
- Failover without deploys: `lib/tracker.js` polls the public health list every 30 min;
  stale-if-error; primary always retained; `/health` exposes the whole picture.
- `checkValidLossless: true` in the manifest — BitChord itself verifies downloads are
  genuinely lossless, matching everything this addon serves.
- Seeking: upstream URLs handed out directly (no bandwidth through the addon); the local
  library serves full HTTP Range 206 semantics; proxy mode forwards Range too.

## 5. App-side trust model

`AddonClient` caches addon responses (manifest 10 min, search 10 min, stream 5 min),
retries 2× with capped backoff, treats 404 as "miss" (not error), refuses anything
`DRM`/`encrypted`, and gates Atmos acceptance behind the device decoder + the listener's
immersive setting. A BitChord addon is *trusted with URLs only* — but those URLs can
exfiltrate nothing by themselves; still: self-host for best privacy or use `ADDON_TOKEN`.

## 6. Deployment reality (one-time setup)

- **Docker/GHCR + Watchtower**: `docker run … ghcr.io/you/bitchord-lossless`, watchtower
  polls every 6 h; CI rebuilds weekly off `node:20-alpine` → self-patching.
- **Render.com blueprint** (`render.yaml`): free plan, `healthCheckPath: /health`,
  `autoDeploy` on push → paste URL once, never touch again.
- **Fly.io** (`fly.toml`): `min_machines_running = 1` avoids free-tier cold starts.
- **Railway**: deploy-from-GitHub button equivalent; auto-deploy on push.
- Any VPS: `pm2 start server.js` behind Caddy/nginx/Cloudflare Tunnel for TLS.
- BitChord re-reads the manifest (10-min cache) → addon updates propagate to clients
  without re-adding the source.
