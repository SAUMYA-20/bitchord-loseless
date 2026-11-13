/**
 * BitChord Lossless — a free, auto-updating lossless + Dolby Atmos addon
 * for BitChord (https://bitchord.kushagrasingh.in).
 *
 * BitChord's addon protocol is three GET routes returning JSON, and nothing
 * the app executes ever comes from here. This process implements exactly that:
 *
 *   GET /manifest.json        what this addon is and what it can do
 *   GET /search?q=…           the catalogue, for one query
 *   GET /stream/{id}          one playable rendition of one track
 *   GET /media/…              audio bytes (local library, or PROXY=1)
 *   GET /health               for humans, not for BitChord
 *   GET /sources              per-source status, token-gated
 *
 * Sources (all free, all credential-free unless you opt into a local library):
 *
 *   tidal     Tidal 16-bit/44.1k FLAC via public Monochrome indices,
 *             auto-discovered and auto-failed-over through a live public
 *             instance tracker (see lib/tracker.js). No account, no token.
 *   archive   Internet Archive freely-licensed FLAC (live tapes, public
 *             domain, classical/jazz sets). No account.
 *   gdstudio  NetEase (and any other catalogue the GDStudio gateway currently
 *             serves) as FLAC, 24-bit where it exists. No account.
 *   local     Your own FLAC library — the only always-free path to true
 *             Dolby Atmos (Atmos masters in multichannel FLAC). Optional:
 *             enabled by setting LOCAL_FLAC_DIR.
 *
 * Design rules, each learned from a real failure mode:
 *
 *  - A source that fails must not fail the search. settleAll collects
 *    errors rather than propagating; a partially-answered search is useful.
 *  - Quality claims are read, not asserted. /stream is preceded by a range
 *    request for 42 bytes and a parse of the FLAC header; sampleRate and
 *    bitDepth are the file's own, or absent.
 *  - Atmos is never claimed without evidence (a multichannel FLAC, an "atmos"
 *    filename hint, or an upstream immersive tag). Otherwise you get honest
 *    lossless stereo, and the device's own spatializer is a user setting.
 *  - Dead indices fail over automatically. The Tidal base list is the
 *    configured primary plus whatever the live public instance tracker says
 *    is healthy right now — no redeploy needed when a host dies.
 *
 * Environment:
 *   PORT                 listen port                          (default 8787)
 *   HOST                 bind address                         (default 0.0.0.0)
 *   SOURCES              tidal,archive,gdstudio,local        (default tidal,archive,gdstudio)
 *   PROXY                '1' to proxy upstream audio through this process (default 0)
 *   ADDON_TOKEN          if set, required as ?token= on every route except /health
 *   TIDAL_BASE_URL       primary Tidal-compatible base       (default https://tracks.monochrome.st)
 *   HIFI_AUTO            '0' disables tracker-based auto-discovery of Tidal instances (default 1)
 *   HIFI_TRACKER_URL     override the instance-health tracker URL
 *   HIFI_TRACKER_REFRESH_MS  tracker poll interval            (default 30 min, min 5)
 *   GDSTUDIO_SOURCES     comma-separated GDStudio catalogues (default netease)
 *   GDSTUDIO_BR          preferred bitrate tier 999|740      (default 999)
 *   LOCAL_FLAC_DIR       path to your FLAC library            (unset = local source off)
 *   LOCAL_RESCAN_MS      local library re-index interval      (default 10 min)
 *   LOCAL_SCAN_LIMIT     max files indexed                    (default 30000)
 */

import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';

import { settleAll, parseTier, NotFound, UpstreamError } from './lib/http.js';
import { parseTrackId } from './lib/trackid.js';
import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps, describeQuality } from './lib/flac.js';
import { createTracker } from './lib/tracker.js';
import { createTidalSource } from './lib/sources/tidal.js';
import { archive, parseArchiveId } from './lib/sources/archive.js';
import { gdstudio } from './lib/sources/gdstudio.js';
import { createLocalSource } from './lib/sources/local.js';

const PORT = Number(process.env.PORT ?? 8787);
const HOST = process.env.HOST ?? '0.0.0.0';
const PROXY_AUDIO = process.env.PROXY === '1';
const TOKEN = process.env.ADDON_TOKEN ?? '';
const HIFI_AUTO = (process.env.HIFI_AUTO ?? '1') !== '0';
const MAX_ROWS = 40;
const SEARCH_TIMEOUT_MS = 15_000;
const VERSION = '1.0.0';
const STARTED = Date.now();

const log = (level, message, fields = {}) =>
  console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg: message, ...fields }));

// ── Auto-updating pieces ─────────────────────────────────────────────────
const tracker = createTracker(log);
const localSource = process.env.LOCAL_FLAC_DIR ? createLocalSource(log) : null;
const tidal = createTidalSource(
  () => (HIFI_AUTO ? tracker.monochromeBases(process.env.TIDAL_BASE_URL ?? 'https://tracks.monochrome.st')
                   : [process.env.TIDAL_BASE_URL ?? 'https://tracks.monochrome.st']),
  log,
);

const REGISTRY = new Map([
  [tidal.id, tidal],
  [archive.id, archive],
  [gdstudio.id, gdstudio],
  ...(localSource ? [[localSource.id, localSource]] : []),
]);

const ACTIVE = (process.env.SOURCES ?? 'tidal,archive,gdstudio')
  .split(',')
  .map((name) => name.trim().toLowerCase())
  .filter((name) => REGISTRY.has(name))
  .map((name) => REGISTRY.get(name));

if (!ACTIVE.length) {
  console.error('[addon] SOURCES named no known source. Known:', [...REGISTRY.keys()].join(', '));
  process.exit(1);
}

// ── Small helpers ───────────────────────────────────────────────────────────

function json(res, status, value, extraHeaders = {}) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    ...extraHeaders,
  });
  res.end(body);
}

function notFound(res, message) {
  // A 404 is the protocol's "not in this addon" — tells BitChord to move on
  // to the next source. It is a success signal, not an error.
  json(res, 404, { error: 'NOT_FOUND', message });
}

function tokenOk(provided) {
  if (!TOKEN) return true;
  if (typeof provided !== 'string' || provided.length !== TOKEN.length) return false;
  let diff = 0;
  for (let i = 0; i < TOKEN.length; i++) diff |= provided.charCodeAt(i) ^ TOKEN.charCodeAt(i);
  return diff === 0;
}

function logReq(level, msg, fields) {
  log(level, msg, fields);
}

// ── Manifest ───────────────────────────────────────────────────────────────

const MANIFEST = {
  id: 'app.bitchord.lossless',
  name: `Lossless · ${ACTIVE.map((s) => s.label).join(' + ')}`,
  version: VERSION,
  resources: ['search', 'stream'],
  // BitChord renders the picker for `quality` only; the values here match its
  // matchTier vocabulary: first option wins for the lossless tier, LOW maps
  // to `low`, and HIGH falls back to the first (lossless) — which is what an
  // addon that only holds lossless should send anyway.
  settings: [
    {
      key: 'quality',
      type: 'select',
      default: 'lossless',
      options: [
        { label: 'Lossless (FLAC, always free)', value: 'lossless' },
        { label: 'Low (data saver, still FLAC)', value: 'low' },
      ],
    },
  ],
  // BitChord's own lossless check is honest about downloads: everything this
  // addon serves is verified FLAC (see the STREAMINFO probe in /stream).
  checkValidLossless: true,
};

// ── Search ───────────────────────────────────────────────────────────────────

async function search(query, limit, signal) {
  const results = await settleAll(
    ACTIVE.map((source) => async () => ({ source, rows: await source.search(query, limit, signal) })),
    ACTIVE.length,
  );

  const rows = [];
  const failures = [];
  const perSource = [];
  for (const entry of results) {
    if (entry.ok) perSource.push(entry.value.rows);
    else {
      perSource.push([]);
      failures.push({ source: entry.value?.source?.id ?? '?', error: entry.error?.message });
    }
  }

  // Round-robin across sources: without this the biggest catalogue fills the
  // whole row budget and the others never reach the listener. Interleaving
  // keeps every source visible from the first page.
  const interleaved = [];
  for (let i = 0; ; i++) {
    let added = false;
    for (const list of perSource) {
      if (i < list.length) {
        interleaved.push(list[i]);
        added = true;
      }
    }
    if (!added) break;
  }

  // De-duplicate on id, keeping the earliest occurrence.
  const seen = new Set();
  const unique = interleaved.filter((row) => (seen.has(row.id) ? false : (seen.add(row.id), true)));

  return { rows: unique.slice(0, limit), failures };
}

/**
 * Reduces a row to the wire shape BitChord reads — including the Atmos
 * signalling fields (`audioMode`, `audioModes`, `atmos`) that make the
 * immersive mix recognisable to the app.
 */
function wireRow(row) {
  return {
    id: row.id,
    title: row.title,
    artist: row.artist ?? '',
    album: row.album ?? '',
    duration: row.duration ?? undefined,
    artworkURL: row.artworkURL ?? undefined,
    albumArtworkURL: row.albumArtworkURL ?? undefined,
    format: row.format ?? 'flac',
    audioQuality: row.audioQuality ?? 'LOSSLESS',
    audioMode: row.audioMode ?? undefined,
    audioModes: Array.isArray(row.audioModes) ? row.audioModes : undefined,
    atmos: row.atmos ?? undefined,
  };
}

// ── Stream ───────────────────────────────────────────────────────────────────

async function resolveTrack(id, tier, atmosWanted, signal) {
  const parsed = parseTrackId(id);
  if (!parsed) throw new NotFound('not an id this addon issued');

  if (parsed.source === 'archive') {
    const parts = parseArchiveId(id);
    if (!parts) throw new NotFound('malformed archive id');
    return { source: 'archive', result: await archive.resolve(parts.filename, tier, signal, parts) };
  }
  if (parsed.source === 'local' && localSource) {
    return { source: 'local', result: await localSource.resolve(parsed.nativeId, tier, signal, null, { atmos: atmosWanted }) };
  }
  const source = REGISTRY.get(parsed.source);
  if (!source) throw new NotFound(`unknown source "${parsed.source}"`);
  return { source: source.id, result: await source.resolve(parsed.nativeId, tier, signal, null, { atmos: atmosWanted }) };
}

function idFromPath(pathname, prefix) {
  const raw = pathname.slice(prefix.length);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

const STREAM_MEDIA_RETRIES = 3;

async function proxyMedia(req, res, upstreamUrl, rangeHeader, idForLog) {
  let upstream = null;
  for (let attempt = 0; attempt <= STREAM_MEDIA_RETRIES; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, 250 * attempt));
    try {
      const candidate = await fetch(upstreamUrl, {
        headers: {
          'User-Agent': 'BitChord-Lossless/1.0',
          ...(rangeHeader ? { Range: rangeHeader } : {}),
        },
        signal: AbortSignal.timeout(30_000), // time to first byte, not the transfer
      });
      if (candidate.ok) {
        upstream = candidate;
        break;
      }
      candidate.body?.cancel?.().catch(() => {});
      if (candidate.status < 500) {
        return json(res, 502, {
          error: 'UPSTREAM_REJECTED',
          message: `the source answered HTTP ${candidate.status}`,
        });
      }
    } catch {
      /* fall through to the retry */
    }
  }

  if (!upstream) {
    return json(res, 502, {
      error: 'UPSTREAM_UNAVAILABLE',
      message: 'the source did not return the audio',
    });
  }

  const headers = {
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  };
  for (const name of ['content-length', 'content-range', 'etag', 'last-modified']) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }

  // Read the signature before committing to a content type. Only for ranges
  // starting at byte zero — the only range containing the fLaC magic; a seek
  // mid-file is passed straight through so scrubbing is never refused.
  const wantsStart = !rangeHeader || /^\s*bytes\s*=\s*0-/i.test(rangeHeader);
  let first = Buffer.alloc(0);
  const reader = upstream.body?.getReader?.();
  if (reader && wantsStart) {
    const chunk = await reader.read();
    first = chunk.value ? Buffer.from(chunk.value) : Buffer.alloc(0);
    if (first.subarray(0, 4).toString('ascii') !== 'fLaC') {
      reader.cancel().catch(() => {});
      return json(res, 502, { error: 'NOT_FLAC', message: 'the source served something that is not a FLAC file' });
    }
  }

  headers['Content-Type'] = 'audio/flac';
  res.writeHead(upstream.status, headers);
  try {
    if (first.length) res.write(first);
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.write(value)) await new Promise((r) => res.once('drain', r));
      }
    }
    res.end();
  } catch (error) {
    logReq('info', 'media transfer ended early', { id: idForLog, error: error.message });
    res.destroy();
  }
}

async function serveLocalFile(res, relB64, rangeHeader) {
  if (!localSource) return json(res, 404, { error: 'NOT_FOUND', message: 'local source disabled' });
  const info = await localSource.fileStat(relB64);
  if (!info) return json(res, 404, { error: 'NOT_FOUND', message: 'no such file in the library' });

  const size = info.size;
  let start = 0;
  let end = size - 1;
  let status = 200;
  const headers = {
    'Content-Type': 'audio/flac',
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=60',
  };

  const match = /^\s*bytes\s*=\s*(\d*)-(\d*)/i.exec(rangeHeader ?? '');
  if (match && (match[1] !== '' || match[2] !== '')) {
    if (match[1] === '') {
      // suffix range: last N bytes
      const suffix = Number(match[2]);
      start = Math.max(0, size - suffix);
      end = size - 1;
    } else {
      start = Number(match[1]);
      end = match[2] === '' ? size - 1 : Math.min(Number(match[2]), size - 1);
    }
    if (start > end || start >= size) {
      res.writeHead(416, { 'Content-Range': `bytes */${size}` });
      return res.end();
    }
    status = 206;
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  }

  headers['Content-Length'] = String(end - start + 1);
  res.writeHead(status, headers);
  createReadStream(info.path, { start, end }).pipe(res);
}

function publicOrigin(req) {
  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0] || 'http';
  const forwardedHost = req.headers['x-forwarded-host'];
  const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host || `localhost:${PORT}`;
  return `${proto}://${host}`;
}

// ── Routes ───────────────────────────────────────────────────────────────────

async function handleSearch(req, res, url) {
  const query = (url.searchParams.get('q') ?? '').trim();
  if (!query) return json(res, 200, { tracks: [] });

  const tier = parseTier(url.searchParams.get('quality'));
  const limit = Math.min(Math.max(Number(url.searchParams.get('limit')) || MAX_ROWS, 1), MAX_ROWS);

  const started = Date.now();
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let outcome;
  try {
    outcome = await search(query, limit, deadline);
  } catch (error) {
    log('error', 'search threw', { query, error: error.message });
    return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: 'every source failed' });
  }

  if (outcome.failures.length) {
    log('warn', 'partial search', { query, tier, failed: outcome.failures, rows: outcome.rows.length });
  }

  log('info', 'search', { query, tier, rows: outcome.rows.length, ms: Date.now() - started });
  return json(res, 200, { tracks: outcome.rows.map(wireRow) });
}

async function handleStream(req, res, url) {
  const id = idFromPath(url.pathname, '/stream/');
  if (!id) return notFound(res, 'no track id in path');

  const tier = parseTier(url.searchParams.get('quality'));
  const atmosWanted = ['auto', '1', 'true'].includes(String(url.searchParams.get('atmos') ?? '').toLowerCase());
  const deadline = AbortSignal.timeout(SEARCH_TIMEOUT_MS);

  let resolved;
  try {
    resolved = await resolveTrack(id, tier, atmosWanted, deadline);
  } catch (error) {
    if (error instanceof NotFound) return notFound(res, error.message);
    if (error instanceof UpstreamError) {
      log('warn', 'stream upstream failure', { id, status: error.status, error: error.message });
      return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: error.message });
    }
    throw error;
  }

  const answer = resolved.result;
  const isLocal = typeof answer.url === 'string' && answer.url.startsWith('local://');
  const proxied = PROXY_AUDIO || isLocal;
  const origin = publicOrigin(req);
  const tokenQs = TOKEN ? `?token=${encodeURIComponent(TOKEN)}` : '';

  let mediaUrl;
  if (isLocal) {
    const rel = answer.url.slice('local://'.length);
    mediaUrl = `${origin}/media/local/${rel}${tokenQs}`;
  } else if (proxied) {
    mediaUrl = `${origin}/media/${encodeURIComponent(id)}.flac${tokenQs}`;
  } else {
    mediaUrl = answer.url;
  }

  const atmos = Boolean(answer.audioModes?.includes?.('DOLBY_ATMOS')) || answer.audioMode === 'DOLBY_ATMOS';
  const channels = answer.channels ?? null;

  log('info', 'stream', {
    id,
    tier,
    atmosWanted,
    source: resolved.source,
    proxied,
    probed: answer.probed,
    sampleRate: answer.sampleRate,
    bitDepth: answer.bitDepth,
    channels,
    atmos,
  });

  return json(res, 200, {
    url: mediaUrl,
    format: 'flac',
    codec: answer.codec ?? 'flac',
    container: answer.container ?? 'flac',
    manifest: 'none',
    encrypted: false,
    sampleRate: answer.sampleRate ?? undefined,
    bitDepth: answer.bitDepth ?? undefined,
    bitrate: answer.bitrate ?? undefined,
    audioQuality: answer.audioQuality ?? (atmos ? 'DOLBY_ATMOS' : 'LOSSLESS'),
    audioMode: answer.audioMode ?? undefined,
    audioModes: answer.audioModes ?? undefined,
    quality:
      answer.qualityNote ??
      describeQuality({ sampleRate: answer.sampleRate, bitDepth: answer.bitDepth, channels, atmos }),
  });
}

async function healthPayload(req) {
  const sources = await Promise.all(
    ACTIVE.map(async (source) => ({
      id: source.id,
      label: source.label,
      ...(await source.health().catch((e) => ({ ok: false, detail: e.message }))),
    })),
  );
  return {
    addon: MANIFEST.name,
    id: MANIFEST.id,
    version: VERSION,
    protocol: 'bitchord-addon',
    routes: ['/manifest.json', '/search', '/stream/{id}'],
    optionalRoutes: ['/media/{id}.flac', '/media/local/{rel}'],
    proxyAudio: PROXY_AUDIO,
    atmos: {
      note:
        'Remote catalogues serve lossless stereo today; the free Atmos path is your own library via LOCAL_FLAC_DIR (Atmos masters in multichannel FLAC). BitChord sends ?atmos=auto when your device wants immersive audio — this addon honours it with evidence, never hope.',
      localLibrary: Boolean(localSource),
    },
    autoUpdating: {
      sourceDiscovery: HIFI_AUTO ? tracker.status() : { disabled: true },
      localRescanMs: process.env.LOCAL_FLAC_DIR ? Number(process.env.LOCAL_RESCAN_MS ?? 600000) : null,
      note: 'Deploy via Docker/GHCR + Watchtower, or Render/Railway with auto-deploy on git push — see README.',
    },
    uptimeSec: Math.round((Date.now() - STARTED) / 1000),
    node: process.version,
    tokenRequired: Boolean(TOKEN),
    sources,
  };
}

// ── The server ─────────────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const requestId = randomUUID().slice(0, 8);
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  const started = Date.now();

  res.setHeader('X-Request-Id', requestId);

  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      });
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return json(res, 405, { error: 'METHOD_NOT_ALLOWED', message: 'every route is a GET' });
    }

    if (!tokenOk(url.searchParams.get('token')) && url.pathname !== '/health') {
      return json(res, 401, { error: 'UNAUTHORIZED', message: 'a ?token= is required' });
    }

    const path = url.pathname.replace(/\/+$/, '') || '/';

    if (path === '/manifest.json' || path === '/manifest') {
      return json(res, 200, MANIFEST);
    }

    if (path === '/search') return await handleSearch(req, res, url);
    if (path.startsWith('/stream/')) return await handleStream(req, res, url);

    if (path.startsWith('/media/local/')) {
      return await serveLocalFile(res, idFromPath(url.pathname, '/media/local/'), req.headers.range);
    }

    if (path.startsWith('/media/')) {
      // PROXY mode (or a local file reached through the generic proxy id).
      const id = idFromPath(url.pathname, '/media/').replace(/\.flac$/i, '');
      let resolved;
      try {
        resolved = await resolveTrack(id, parseTier(url.searchParams.get('quality')), false, undefined);
      } catch (error) {
        if (error instanceof NotFound) return notFound(res, error.message);
        return json(res, 502, { error: 'UPSTREAM_UNAVAILABLE', message: error.message });
      }
      const upstreamUrl = resolved.result.url;
      if (upstreamUrl.startsWith('local://')) {
        return await serveLocalFile(res, upstreamUrl.slice('local://'.length), req.headers.range);
      }
      return await proxyMedia(req, res, upstreamUrl, req.headers.range, id);
    }

    if (path === '/' || path === '/health' || path === '/sources') {
      const payload = await healthPayload(req);
      if (path === '/sources' && TOKEN) {
        payload.detail = 'token-gated source status';
      }
      return json(res, 200, payload);
    }

    return json(res, 404, { error: 'NOT_FOUND', message: 'see GET /health for the routes this addon serves' });
  } catch (error) {
    log('error', 'unhandled', { requestId, path: url.pathname, error: error.stack ?? error.message });
    if (!res.headersSent) {
      return json(res, 500, { error: 'INTERNAL', message: error.message, requestId });
    }
    res.destroy();
  } finally {
    if (res.headersSent) {
      log('info', 'request', {
        requestId,
        method: req.method,
        path: url.pathname,
        status: res.statusCode,
        ms: Date.now() - started,
      });
    }
  }
});

server.headersTimeout = 20_000;
server.requestTimeout = 0; // a long proxied FLAC must not be cut off mid-stream

async function main() {
  if (localSource) await localSource.start();
  tracker.start();

  server.listen(PORT, HOST, () => {
    log('info', 'listening', {
      url: `http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`,
      sources: ACTIVE.map((s) => s.id),
      proxyAudio: PROXY_AUDIO,
      tokenRequired: Boolean(TOKEN),
      version: VERSION,
    });
    console.log('');
    console.log(`  Addon manifest:   http://<this-host>:${PORT}/manifest.json`);
    console.log(`  Health check:     http://<this-host>:${PORT}/health`);
    console.log('');
  });
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    log('info', 'shutting down', { signal });
    tracker.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5_000).unref();
  });
}

main().catch((error) => {
  console.error('[addon] failed to start:', error);
  process.exit(1);
});

export { server, MANIFEST, search, resolveTrack, describeQuality };
