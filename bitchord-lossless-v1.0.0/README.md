# BitChord Lossless

**One-time setup. Always free. Verified lossless — and real Dolby Atmos if you own it.**

A [BitChord](https://bitchord.kushagrasingh.in) addon that serves real FLAC from every
free, account-free source on the public internet — Tidal's catalogue via public
Monochrome indices, the Internet Archive's freely-licensed recordings, NetEase and
other catalogues via the GDStudio gateway, plus your own local library — with **automatic
source failover**, **live FLAC verification**, and **self-updating source discovery**.

> Lossless is the floor here, not the ceiling. Everything this addon serves is probed
> against the actual FLAC header before it is handed to your phone. A label it cannot
> verify, it does not send.

---

## What you get

| Requirement | How it's met |
|---|---|
| **Always free** | Every source works credential-free. No account, no trial, no card, no expiry. |
| **Lossless (bare minimum)** | Tidal 16-bit/44.1k FLAC · Internet Archive up to **24-bit/96k Hi-Res FLAC** · NetEase **24-bit FLAC** where available · your own library any bit depth. |
| **Dolby Atmos** | True Atmos via your own library (Atmos masters in multichannel FLAC) — see [The honest Atmos story](#the-honest-atmos-story). |
| **All sources in the world** | tidal · archive · gdstudio · local. The Tidal layer **auto-discovers** public instances from a continuously-probed public health tracker, so when a host dies another is promoted with no deploy. |
| **Always live & stable** | Per-source deadlines, bounded fan-out, round-robin interleave, fail-silent-then-fail-over, optional Watchtower self-update, `min_machines_running = 1` on Fly. |
| **One-time setup** | Deploy once → paste one URL into BitChord → done. It keeps itself working. |
| **Auto-updating** | Three layers: live instance discovery (30 min), CI rebuild + GHCR push on every commit and weekly, Watchtower/Render auto-deploy. |
| **Ready to use (MVP)** | `node server.js` and it's running. 16/16 smoke checks pass against the live internet. |

---

## Install (one-time setup)

Pick **one**. All end with the same step: paste `https://<your-host>/manifest.json`
into BitChord.

### Option A — Docker (any VPS, NAS, Raspberry Pi, home server)

```bash
docker run -d --name bitchord-lossless \
  --restart unless-stopped \
  -p 8787:8787 \
  ghcr.io/your-github-user/bitchord-lossless:latest
```

Expose it on the public internet with HTTPS (BitChord requires HTTPS on some builds):
Cloudflare Tunnel, Tailscale Funnel, Caddy, or nginx — anything that gives you a TLS URL.

**Auto-updating with Watchtower** (do this once):

```bash
docker compose up -d
# → Watchtower pulls the latest image every 6 h. You never touch it again.
```

### Option B — Render.com (free, zero ops)

1. Fork/push this repo to GitHub.
2. render.com → **New +** → **Blueprint** → select the repo → **Apply**.
   (`render.yaml` is already in this repo; `autoDeploy: true` and
   `healthCheckPath: /health` are wired in.)
3. Every `git push` redeploys automatically. Your URL looks like
   `https://bitchord-lossless.onrender.com`.

### Option C — Railway / Fly.io

```bash
# Railway: New Project → Deploy from GitHub → done (auto-deploys on push).
# Fly.io:
fly launch --now
fly scale count 1   # keeps 1 machine always on — never cold
```

### Option D — Plain node (any box with Node ≥ 18.17)

```bash
git clone <this-repo> && cd bitchord-lossless
node server.js            # or: pm2 start server.js --name bitchord-lossless
```

### Option E — Docker Compose from source

```bash
docker compose up -d --build
```

### Then, in BitChord (Android/Windows/Linux/macOS/TV)

**Settings → Sources → Add an addon → paste:**

```
https://<your-host>/manifest.json
```

Done. That's the whole setup. Play any song — when BitChord asks for lossless,
this addon answers with verified FLAC.

> **Tip:** paste the bare host URL (`https://<your-host>/`) instead of the manifest
> path — BitChord normalizes it — but the explicit `manifest.json` URL is the
> most reliable across app versions.

---

## The sources, verified

All three remote sources were queried live while building this addon; bytes were
inspected, not just headers.

| Source | Catalogue | Best quality (verified) | Credentials | Notes |
|---|---|---|---|---|
| **tidal** | The commercial Tidal catalogue | 16-bit / 44.1 kHz FLAC | none | Served via public Monochrome indices. Primary: `tracks.monochrome.st`. **Auto-failover** to every instance the public Lossless Sources probe currently lists as healthy. |
| **archive** | Freely-licensed recordings: live tapes, bootlegs, public-domain transfers, classical, jazz, label anthologies | **Up to 24-bit / 96 kHz FLAC** (verified) | none | ~1,100+ "radiohead" items; popularity-ranked, FLAC-only index. |
| **gdstudio** | NetEase (+ anything the GDStudio gateway currently serves) | 24-bit FLAC where the master exists | none | 24-bit request preferred, 16-bit fallback; rate-limited ≈60 req/5 min per IP → cached aggressively. |
| **local** | **Your** library | any (incl. **multichannel Atmos FLAC**) | none | Set `LOCAL_FLAC_DIR`. Re-indexes itself every 10 min. |

What is deliberately **not** in here, and why:

- **Tidal/Qobuz/Apple Music/Amazon Atmos** — real Atmos streams exist only behind
  paid subscriptions (or stolen proxy credentials). Shipping somebody else's paid
  account repackaged as "free" is not a feature; it's a liability and a takedown.
- **monochrome-tidal's static index of 8 hard-coded hosts** — 7 of 8 are dead or
  broken today. This addon discovers live hosts dynamically instead of rotting.
- **Jamendo / Free Music Archive / Bandcamp / Musopen** — free and legal, but their
  APIs either need registration keys (not one-step setup) or have no direct FLAC
  stream URLs. The Archive covers the same freely-licensed territory with zero
  friction. Welcome to PR them in (see Development).
- **Soulseek / BitTorrent** — works (see the P2PChord pattern) but needs an account,
  long-lived connections and often a VPN-friendlier setup; the opposite of
  one-step "always live". Left out by design.

---

## The honest Atmos story

Dolby Atmos in a streaming service is a licensing product, not a metadata flag.
Three facts, checked against BitChord's own playback code and every free source:

1. **BitChord already speaks Atmos.** Rows tagged `audioModes: ["DOLBY_ATMOS"]`
   (or `atmos: true`) are ranked above stereo rows for listeners who enabled
   immersive audio, and `/stream` requests carry `?atmos=auto` when the device
   and user both want it. Playback goes to the device's Atmos renderer.
2. **No free, credential-free remote catalogue serves Atmos.** Apple Music, Tidal
   and Amazon ship Atmos behind paid subscriptions; Spotify/Qobuz/Deezer carry none.
   The public Monochrome index serves stereo 16/44.1 even when asked for Atmos
   (verified byte-for-byte).
3. **Your own library does carry it.** Atmos masters ripped to **multichannel
   FLAC** play bit-perfectly everywhere FLAC plays. Set `LOCAL_FLAC_DIR`:

   ```bash
   export LOCAL_FLAC_DIR=/srv/music        # "Artist/Album/Track.flac" layout
   ```

   FLACs whose filename mentions `atmos`/`dolby`/`ec3`/`joc` (or that probe as
   **more than 2 channels**) are labelled `DOLBY_ATMOS`/`MULTICHANNEL` with
   `audioModes: ["DOLBY_ATMOS"]` — only ever on that evidence, never by hope.
   A plain 5.1 FLAC is labelled `MULTICHANNEL` honestly, not sold as Atmos.

**So:** free + Atmos = your own rips today, and this addon serves and labels them
truthfully. Free + remote = verified lossless stereo/Hi-Res everywhere else. Anything
"free Atmos catalogue on the internet" beyond that is a subscription with the payment
worked around — not something this addon ships.

BitChord on devices without an Atmos decoder still gets the lossless multichannel
PCM, which most AV receivers and soundbars render correctly over HDMI/eARC.

---

## How "auto-updating" actually works

| Layer | What updates | How often | You do |
|---|---|---|---|
| Source discovery | The list of live public Tidal replicas | every 30 min, in-process | nothing |
| Local library index | New files you copy in are indexed | every 10 min, in-process | nothing |
| Container image | Base image security patches | weekly (cron CI) + every push | nothing (Watchtower/Render picks it up) |
| BitChord itself | The app | on every launch (checks GitHub releases) | keep the app updated |

The discovery list comes from the public
[Lossless Sources probe](https://github.com/kipavy/spotube-plugin-lossless-sources),
a GitHub-hosted service that continuously verifies which public instances actually
serve audio right now — this addon polls it (`HIFI_TRACKER_URL` overridable, disable
with `HIFI_AUTO=0`).

---

## Behaviour details an audiophile notices

- **Quality claims are read, not asserted.** `/stream` issues a 42-byte range
  request and parses the FLAC STREAMINFO block. `sampleRate`, `bitDepth`,
  `channels`, `duration` and `bitrate` you see in BitChord are the file's own —
  including "Hi-Res FLAC · 24-bit / 96 kHz" on Archive items that truly are.
  If the header can't be read, those fields are **absent**, never guessed.
- **Lossless is never faked.** A URL that serves MP3/AAC labelled "FLAC" is
  rejected at the proxy layer and simply never plays — BitChord falls back to
  the next source (YouTube) rather than handing you a lossy lie.
- **Search never hard-fails.** Each source has a hard deadline; if Tidal is slow,
  Archive answers instead, and the rows from every healthy source are
  round-robin interleaved so no catalogue starves the list.
- **Seeking works.** Upstream URLs are handed to BitChord directly (default) or
  proxied with correct `206 Partial Content` ranges; the local library speaks
  full HTTP Range semantics.
- **Your token, your rules.** Set `ADDON_TOKEN` and every route except `/health`
  requires `?token=…` — good for a LAN addon or a public URL you'd rather not
  leak to the world.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| BitChord shows the addon host instead of a name | You pasted a URL whose `/manifest.json` doesn't answer. Open `https://<host>/manifest.json` in a browser — it must be JSON. |
| "Could not fetch manifest" | Your host isn't publicly reachable or TLS is broken. `curl -i https://<host>/manifest.json` must return `200`. |
| Searches return 0 tracks | Some sources may be rate-limiting you; check `https://<host>/health` — it shows per-source status live. |
| Track starts then stalls | Enable proxy mode: `PROXY=1` (routes bytes through the addon with retries + FLAC verification). |
| Local library "0 files indexed" | `LOCAL_FLAC_DIR` must contain `.flac` files; check the path inside the container (`docker exec bitchord-lossless ls /music`). |
| Download as lossless fails | Everything served is FLAC; enable `checkValidLossless` is already on — if BitChord still refuses, update the app. |

Check live status any time:

```
https://<your-host>/health     → uptime, per-source health, tracker state
https://<your-host>/sources    → same, token-gated when ADDON_TOKEN is set
```

---

## Environment reference

See [.env.example](.env.example) — every knob is documented there. The only
ones you ever need: `PORT`, `SOURCES`, and for local Atmos `LOCAL_FLAC_DIR`.

## Development

```bash
npm run smoke     # 16 live-network checks: manifest, search, stream, real fLaC bytes
npm start         # run the server
```

Layout:

```
server.js            routes, fan-out search, stream resolution, media proxy, local-file serving
lib/http.js          fetch with deadlines/retries, TTL cache, settleAll, parseTier
lib/flac.js          STREAMINFO parser · quality descriptions
lib/trackid.js       path-safe opaque ids
lib/tracker.js       live public instance discovery (the auto-updating part)
lib/atmos.js         immersive-audio detection (evidence only)
lib/sources/tidal.js      Tidal via Monochrome indices + tracker failover
lib/sources/archive.js    Internet Archive
lib/sources/gdstudio.js   GDStudio → NetEase etc. (24-bit preferred)
lib/sources/local.js      your library — index, search, Atmos labelling, Range serving
test/smoke.mjs       the live-network smoke suite
```

PRs welcome for new **free, credential-free** catalogues with direct FLAC URLs.

---

## Legal

This addon is a neutral client. It serves what freely-licensed catalogues
(Internet Archive), community-funded public indices (Tidal via Monochrome),
public community gateways (GDStudio), and **your own files** publish. No accounts
are shared, no DRM is bypassed (there is no DRM on any of these paths), and no
paywall is defeated. You are responsible for the laws in your jurisdiction and
for the licenses of the material you stream or sync. If you are a rights holder
and want an item gone from a catalogue the addon can reach, it will disappear
automatically — the addon has no index of its own.

MIT-licensed. Not affiliated with BitChord, Tidal, the Internet Archive, NetEase,
GDStudio, or Monochrome.
