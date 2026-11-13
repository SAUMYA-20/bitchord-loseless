/**
 * Internet Archive, as a catalogue Tidal can never be: freely-licensed
 * recordings — live tapes, bootlegs, public-domain transfers, classical and
 * jazz sets, label anthologies — served as genuine FLAC with no account.
 *
 * The Archive indexes items (releases), not tracks. A search returns albums;
 * turning one into playable rows means listing the files inside it, so a
 * search here is a search followed by a bounded fan-out.
 *
 * Also the source most likely to still be reachable when everything else is.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, settleAll, NotFound } from '../http.js';

const BASE = process.env.ARCHIVE_BASE_URL ?? 'https://archive.org';

/** Keep the Archive to audio that already holds a FLAC. */
const QUERY = 'mediatype:(audio) AND format:(Flac)';

/** How many items to consider, and how many of those to open. */
const ITEM_LIMIT = 12;
const EXPAND_LIMIT = 5;

/**
 * What this source is allowed to spend on one search. The Archive is the slow
 * source — one query plus a bounded fan-out over item file listings — and
 * BitChord reads `/search` on the path that decides whether a track starts.
 * Whatever rows were gathered in time are returned.
 */
const SEARCH_BUDGET_MS = 5_000;
const ITEM_TIMEOUT_MS = 5_000;

const MIN_SECONDS = 20;
const MAX_SECONDS = 45 * 60;

const probeCache = new TtlCache(4_000);
const searchCache = new TtlCache(500);
const itemCache = new TtlCache(4_000);
const SEARCH_TTL_MS = 10 * 60 * 1000;
const ITEM_TTL_MS = 30 * 60 * 1000;

/** A track number at the front of a filename: `03 - Title`, `3. Title`. */
const LEADING_TRACK_NUMBER = /^\s*\d{1,3}\s*[-._)\]]*\s+/;

function titleFromFilename(name) {
  let title = String(name ?? '')
    .replace(/\.flac$/i, '')
    .replace(/_/g, ' ')
    .replace(LEADING_TRACK_NUMBER, '')
    .trim();
  if (!title) title = String(name ?? '').replace(/\.flac$/i, '');
  return title;
}

const seconds = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n * 10) / 10;
};

/** A stable id for one file inside one item. */
function rowId(identifier, filename) {
  return `archive:${identifier}:${Buffer.from(filename, 'utf8').toString('base64url')}`;
}

export function parseArchiveId(id) {
  const raw = String(id ?? '');
  const rest = raw.startsWith('archive:') ? raw.slice('archive:'.length) : raw;
  const cut = rest.indexOf(':');
  if (cut < 1) return null;
  const identifier = rest.slice(0, cut);
  const encoded = rest.slice(cut + 1);
  try {
    return { identifier, filename: Buffer.from(encoded, 'base64url').toString('utf8') };
  } catch {
    return null;
  }
}

export const archive = {
  id: 'archive',
  label: 'Internet Archive',
  lossless: true,
  atmos: false,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    const fanout = Math.min(Math.max(limit, 1), 40);
    return searchCache.wrap(`archive:${text.toLowerCase()}:${fanout}`, SEARCH_TTL_MS, async () => {
      const budget = AbortSignal.timeout(SEARCH_BUDGET_MS);
      const scoped = signal ? AbortSignal.any([budget, signal]) : budget;

      const params = new URLSearchParams({
        q: `${QUERY} AND (${text})`,
        rows: String(ITEM_LIMIT),
        page: '1',
        output: 'json',
        'sort[]': 'downloads desc',
      });
      for (const field of ['identifier', 'title', 'creator']) params.append('fl[]', field);

      const payload = await httpJson(`${BASE}/advancedsearch.php?${params}`, {
        timeoutMs: 6_000,
        signal: scoped,
      });
      const docs = Array.isArray(payload?.response?.docs) ? payload.response.docs : [];
      const items = docs.slice(0, EXPAND_LIMIT);

      const expanded = await settleAll(
        items.map((doc) => async () => ({ doc, rows: await this.expand(doc, scoped) })),
        items.length,
      );

      const rows = [];
      for (const entry of expanded) {
        if (!entry.ok) continue;
        rows.push(...entry.value.rows);
      }
      return rows.slice(0, fanout);
    });
  },

  /** One item's FLAC files, as rows. A miss here is ordinary. */
  async expand(doc, signal) {
    const identifier = String(doc?.identifier ?? '');
    if (!identifier) return [];

    const metadata = await itemCache.wrap(`item:${identifier}`, ITEM_TTL_MS, async () => {
      const payload = await httpJson(`${BASE}/metadata/${encodeURIComponent(identifier)}`, {
        timeoutMs: ITEM_TIMEOUT_MS,
        retries: 0,
        signal,
      });
      return payload ?? {};
    });

    const files = Array.isArray(metadata?.files) ? metadata.files : [];
    if (!files.length) return [];

    const meta = metadata?.metadata ?? {};
    const album = String(doc?.title ?? meta.title ?? '').trim();
    const rawCreator = doc?.creator ?? meta.creator;
    const artist = (Array.isArray(rawCreator) ? rawCreator[0] : rawCreator) ?? '';

    const flacs = files.filter((file) => {
      const name = String(file?.name ?? '');
      if (!/\.flac$/i.test(name)) return false;
      // Derived artefacts nobody meant to listen to.
      if (/^(__|spectrogram)/i.test(name)) return false;
      const length = seconds(file.length);
      return length !== null && length >= MIN_SECONDS && length <= MAX_SECONDS;
    });

    return flacs.map((file) => {
      const name = String(file.name ?? '');
      const base = name.split('/').pop() ?? name;
      return {
        id: rowId(identifier, name),
        title: titleFromFilename(base),
        artist: String(artist).trim(),
        album,
        duration: seconds(file.length) ?? undefined,
        format: 'flac',
        audioQuality: 'LOSSLESS',
        audioMode: 'STEREO',
        _source: 'archive',
        _nativeId: name,
        _identifier: identifier,
      };
    });
  },

  /** Resolves one file to a verified FLAC URL. */
  async resolve(nativeId, _tier, signal, parts = null) {
    // The server routes /stream/{id} here with the parsed parts. nativeId is
    // the filename; parts carries {identifier, filename}.
    const identifier = parts?.identifier;
    const filename = parts?.filename ?? nativeId;
    if (!identifier || !filename) throw new NotFound('malformed archive id');

    const url = `${BASE}/download/${encodeURIComponent(identifier)}/${filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;

    const probe = await this.probe(url, `probe:${identifier}:${filename}`, signal);

    const channels = probe?.channels ?? null;
    return {
      url,
      codec: 'flac',
      container: 'flac',
      manifest: 'none',
      encrypted: false,
      sampleRate: probe?.sampleRate ?? null,
      bitDepth: probe?.bitDepth ?? null,
      bitrate: probe ? flacKbps(probe.byteLength, probe.durationSec) : null,
      channels,
      audioMode: channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO',
      audioModes: [channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO'],
      probed: Boolean(probe),
      error: probe ? undefined : 'served, but the FLAC header could not be read',
    };
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(cacheKey, Number.MAX_SAFE_INTEGER, async () => {
      let response;
      try {
        response = await httpGet(url, {
          timeoutMs: 15_000,
          retries: 1,
          range: `bytes=0-${STREAMINFO_BYTES - 1}`,
          signal,
        });
      } catch {
        return null;
      }
      const head = Buffer.from(await response.arrayBuffer());
      const info = parseFlacStreamInfo(head);
      if (!info) return null;

      const contentRange = response.headers.get('content-range') ?? '';
      const slash = contentRange.lastIndexOf('/');
      const total = slash >= 0 ? Number(contentRange.slice(slash + 1)) : NaN;

      return {
        ...info,
        byteLength: Number.isFinite(total) && total > 0 ? total : null,
      };
    });
  },

  mediaUrl(nativeId, parts = null) {
    const identifier = parts?.identifier;
    const filename = parts?.filename ?? nativeId;
    if (!identifier) return null;
    return `${BASE}/download/${encodeURIComponent(identifier)}/${filename
      .split('/')
      .map(encodeURIComponent)
      .join('/')}`;
  },

  async health() {
    try {
      const payload = await httpJson(`${BASE}/advancedsearch.php?q=mediatype:(audio)+AND+format:(Flac)&rows=1&output=json&fl[]=identifier`, {
        timeoutMs: 8_000,
        retries: 0,
      });
      const n = payload?.response?.numFound ?? 0;
      return { ok: true, detail: `${n.toLocaleString()} FLAC items indexed` };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
