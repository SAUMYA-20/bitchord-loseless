/**
 * Local FLAC library — your own disk, indexed live.
 *
 * This source exists for two reasons:
 *
 *  1. **Real Dolby Atmos.** There is no free, credential-free Atmos catalogue
 *     on the internet (the Atmos storefronts all sit behind a subscription).
 *     The one honest, always-free way to get true immersive audio into
 *     BitChord is files you own: Atmos masters ripped to multichannel FLAC.
 *     This source serves them with `audioModes: ["DOLBY_ATMOS"]` when the
 *     filename says so, or as multichannel lossless when the FLAC STREAMINFO
 *     says more than two channels.
 *  2. **A library that works with no network at all**, on a LAN, forever —
 *     the definition of "always live".
 *
 * Enable by setting LOCAL_FLAC_DIR=/path/to/your/music. Files are re-indexed
 * every LOCAL_RESCAN_MS (default 10 minutes), so files copied in while the
 * addon runs appear without a restart — this source is auto-updating too.
 *
 * Expected layout (any depth works; the parser reads the path backwards):
 *
 *   Artist/Album/03 - Title.flac
 *   Artist - Title.flac
 *   Title.flac
 *
 * Atmos hints recognised in filenames: atmos, dolby, ec3, eac3, joc, 360ra.
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps, describeQuality } from '../flac.js';
import { nameSaysAtmos } from '../atmos.js';
import { NotFound } from '../http.js';
import { encodePart, decodePart } from '../trackid.js';

const ROOT = process.env.LOCAL_FLAC_DIR ? path.resolve(process.env.LOCAL_FLAC_DIR) : null;
const RESCAN_MS = Math.max(60_000, Number(process.env.LOCAL_RESCAN_MS ?? 10 * 60 * 1000) || 600_000);
const MAX_FILES = Math.max(100, Number(process.env.LOCAL_SCAN_LIMIT ?? 30_000) || 30_000);

const LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*[-._)\]]*\s+/;
const EXT = /\.flac$/i;
const BITDEPTH_HINT = /(\d{1,2})\s*[-_]?\s*bit/i;
const RATE_HINT = /(\d{2,3})\s*(k|kHz|hz)\b/i;

export function createLocalSource(log = () => {}) {
  /** @type {Map<string, {rel:string, title:string, artist:string, album:string, duration?:number, size:number, atmosHint:boolean, mtimeMs:number}>} */
  let index = new Map();
  let scanning = null;

  async function walk(dir, out) {
    if (out.length >= MAX_FILES) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        await walk(full, out);
      } else if (entry.isFile() && EXT.test(entry.name)) {
        out.push(full);
      }
    }
  }

  function parseName(rel) {
    const base = path.basename(rel, path.extname(rel));
    const dirParts = path.dirname(rel).split(path.sep).filter((p) => p && p !== '.');

    let artist = '';
    let album = '';
    if (dirParts.length >= 2) {
      artist = dirParts[dirParts.length - 2];
      album = dirParts[dirParts.length - 1];
    } else if (dirParts.length === 1) {
      artist = '';
      album = dirParts[0];
    }

    let title = base.replace(LEADING_TRACK_NUMBER, '').replace(/_/g, ' ').trim();
    const dash = title.match(/^(.{1,80}?)\s+-\s+(.+)$/);
    if (dash && !artist) {
      artist = dash[1].trim();
      title = dash[2].trim();
    }
    return {
      title: title || base,
      artist,
      album,
      atmosHint: nameSaysAtmos(rel),
      hiresHint: BITDEPTH_HINT.test(rel) || /(hires|hi-res|master)/i.test(rel),
    };
  }

  async function probeFile(full) {
    try {
      const handle = await fs.open(full, 'r');
      try {
        const buf = Buffer.alloc(STREAMINFO_BYTES);
        await handle.read(buf, 0, STREAMINFO_BYTES, 0);
        const info = parseFlacStreamInfo(buf);
        return info;
      } finally {
        await handle.close();
      }
    } catch {
      return null;
    }
  }

  async function rescan() {
    if (!ROOT) return;
    if (scanning) return scanning; // single-flight
    scanning = (async () => {
      const started = Date.now();
      const found = [];
      await walk(ROOT, found);

      const next = new Map();
      let probed = 0;
      // Probe in bounded parallelism; STREAMINFO gives duration + channels.
      const PROBE_LIMIT = 16;
      let cursor = 0;
      const workers = Array.from({ length: PROBE_LIMIT }, async () => {
        while (cursor < found.length) {
          const i = cursor++;
          const full = found[i];
          const rel = path.relative(ROOT, full);
          let size = 0;
          let mtimeMs = 0;
          try {
            const st = await fs.stat(full);
            size = st.size;
            mtimeMs = st.mtimeMs;
          } catch {
            continue;
          }
          const previous = index.get(rel);
          // Re-probing a 40 MB library on every rescan is wasteful; STREAMINFO
          // is immutable for a given mtime, so reuse it until the file changes.
          const info =
            previous && previous.mtimeMs === mtimeMs && previous.info
              ? previous.info
              : await probeFile(full);
          const parsed = parseName(rel);
          probed += 1;
          next.set(rel, {
            rel,
            full,
            title: parsed.title,
            artist: parsed.artist,
            album: parsed.album,
            duration: info?.durationSec ?? undefined,
            channels: info?.channels ?? undefined,
            sampleRate: info?.sampleRate ?? undefined,
            bitDepth: info?.bitDepth ?? undefined,
            size,
            mtimeMs,
            info,
            atmosHint: parsed.atmosHint,
            hiresHint: parsed.hiresHint,
          });
        }
      });
      await Promise.all(workers);

      index = next;
      log('info', 'local library rescanned', {
        files: next.size,
        probed,
        ms: Date.now() - started,
        root: ROOT,
      });
      scanning = null;
    })().catch((error) => {
      scanning = null;
      log('warn', 'local library rescan failed', { error: error.message });
    });
    return scanning;
  }

  function search(query, limit = 20) {
    const text = String(query ?? '').trim().toLowerCase();
    if (!text) return [];
    const tokens = text.split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    const scored = [];
    for (const entry of index.values()) {
      const hay = `${entry.artist} ${entry.album} ${entry.title}`.toLowerCase();
      let hits = 0;
      for (const token of tokens) if (hay.includes(token)) hits += 1;
      if (hits < tokens.length) continue;
      // Rank: all tokens hit in the title, then artist, then album.
      const titleHits = tokens.filter((t) => entry.title.toLowerCase().includes(t)).length;
      const artistHits = tokens.filter((t) => entry.artist.toLowerCase().includes(t)).length;
      scored.push({ entry, score: titleHits * 4 + artistHits * 2 + hits });
    }
    scored.sort((a, b) => b.score - a.score);

    return scored.slice(0, limit).map(({ entry }) => {
      // Atmos strictly on evidence: a name/tag hint. Multichannel alone is
      // labelled MULTICHANNEL — immersive, but not claimed to be Atmos.
      const multichannel = (entry.channels ?? 2) > 2;
      const atmos = entry.atmosHint;
      return {
        id: `local:${encodePart(entry.rel)}`,
        title: entry.title,
        artist: entry.artist,
        album: entry.album,
        duration: entry.duration,
        format: 'flac',
        audioQuality: entry.hiresHint || (entry.bitDepth ?? 16) > 16 ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
        audioMode: atmos ? 'DOLBY_ATMOS' : multichannel ? 'MULTICHANNEL' : 'STEREO',
        audioModes: atmos ? ['DOLBY_ATMOS'] : multichannel ? ['MULTICHANNEL'] : ['STEREO'],
        atmos: atmos || undefined,
        _source: 'local',
        _nativeId: entry.rel,
      };
    });
  }

  function resolveLocal(nativeId, atmosWanted) {
    // nativeId is the rel path (decoded by trackid layer? no — we encode it
    // ourselves in rows, so decode here).
    let rel = String(nativeId ?? '');
    try {
      rel = decodePart(rel);
    } catch {
      /* already plain */
    }
    const entry = index.get(rel) ?? index.get(String(nativeId));
    if (!entry) throw new NotFound('file not in the local index (library may have changed; rescan pending)');

    // Containment: the rel path must stay inside ROOT.
    const full = path.resolve(ROOT, entry.rel);
    if (!full.startsWith(ROOT + path.sep) && full !== ROOT) {
      throw new NotFound('path escapes the library root');
    }

    const multichannel = (entry.channels ?? 2) > 2;
    const atmos = entry.atmosHint;
    const hiRes =
      entry.hiresHint ||
      Boolean(info && (info.bitDepth > 16 || info.sampleRate > 48000));
    const info = entry.info;

    return {
      // Handled internally by the /media route — never leaves this process.
      url: `local://${encodePart(entry.rel)}`,
      localFile: full,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: info?.sampleRate ?? null,
      bitDepth: info?.bitDepth ?? null,
      bitrate: info ? flacKbps(entry.size, info.durationSec) : null,
      channels: info?.channels ?? null,
      audioQuality: atmos ? 'DOLBY_ATMOS' : hiRes ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
      audioMode: atmos ? 'DOLBY_ATMOS' : multichannel ? 'MULTICHANNEL' : 'STEREO',
      audioModes: atmos ? ['DOLBY_ATMOS'] : multichannel ? ['MULTICHANNEL'] : ['STEREO'],
      qualityNote: describeQuality({ ...(info ?? {}), atmos }),
      probed: Boolean(info),
    };
  }

  const api = {
    id: 'local',
    label: 'Local Library',
    lossless: true,
    atmos: true,

    async start() {
      if (!ROOT) return;
      await rescan();
      const timer = setInterval(() => void rescan(), RESCAN_MS);
      timer.unref?.();
    },

    async search(query, limit = 20) {
      return search(query, limit);
    },

    async resolve(nativeId, _tier, _signal, _parts, opts = {}) {
      return resolveLocal(nativeId, Boolean(opts.atmos));
    },

    /** Stats a local file by its encoded rel path. Used by the /media route. */
    async fileStat(relB64) {
      const rel = decodePart(String(relB64 ?? ''));
      const full = ROOT ? path.resolve(ROOT, rel) : null;
      if (!full || (!full.startsWith(ROOT + path.sep) && full !== ROOT)) return null;
      try {
        const st = await fs.stat(full);
        return { size: st.size, path: full, rel };
      } catch {
        return null;
      }
    },

    async health() {
      if (!ROOT) return { ok: true, detail: 'disabled (set LOCAL_FLAC_DIR to enable)' };
      return { ok: true, detail: `${index.size} file(s) indexed from ${ROOT}` };
    },
  };

  return api;
}
