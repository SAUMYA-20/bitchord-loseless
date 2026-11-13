/**
 * Tidal, through public Monochrome-compatible indices.
 *
 * This is the source that makes the addon worth deploying: real commercial
 * FLAC with no account, no token and no developer credentials. It serves
 * 16-bit / 44.1 kHz lossless (verified against the bytes, not assumed).
 *
 *   GET {base}/search/tracks?q=…&limit=N   → metadata, JSON, fast
 *   GET {base}/track/{id}                  → the FLAC bytes themselves
 *
 * There is no URL-resolution step, no signature to obtain and nothing that
 * expires between `/search` and `/stream`.
 *
 * Availability past one host is handled by the tracker (see tracker.js): the
 * Lossless Sources probe publishes every public instance known to serve real
 * audio, and this source fans searches across the primary plus every healthy
 * discovered instance, preferring the primary. A dead index degrades to the
 * next one instead of taking playback down with it.
 *
 * Atmos note: Monochrome indices serve the stereo lossless rendition only —
 * `?quality=DOLBY_ATMOS` returns the same 16/44.1 stereo file. This source
 * therefore never labels rows or streams as Atmos. True Atmos in this addon
 * comes from the local library source (see local.js).
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound, UpstreamError } from '../http.js';

const DEFAULT_BASE = process.env.TIDAL_BASE_URL ?? 'https://tracks.monochrome.st';

/** Per-base budget on the search path. Fast, or the next base is tried. */
const SEARCH_TIMEOUT_MS = 6_000;
const STREAM_TIMEOUT_MS = 15_000;

/** STREAMINFO for a given file never changes; cache for the process life. */
const probeCache = new TtlCache(4_000);
const searchCache = new TtlCache(500);
const SEARCH_TTL_MS = 5 * 60 * 1000;

const artwork = (url) => (String(url ?? '').startsWith('http') ? String(url) : undefined);

/** Tidal durations arrive in milliseconds; BitChord reads seconds as a double. */
const seconds = (ms) => {
  const value = Number(ms);
  if (!Number.isFinite(value) || value <= 0) return undefined;
  return Math.round(value / 100) / 10;
};

async function searchBase(base, text, limit, signal) {
  const url =
    `${base}/search/tracks?q=${encodeURIComponent(text)}` +
    `&limit=${Math.min(Math.max(limit, 1), 50)}`;
  const payload = await httpJson(url, { timeoutMs: SEARCH_TIMEOUT_MS, signal, retries: 0 });
  const tracks = Array.isArray(payload?.tracks) ? payload.tracks : [];
  return tracks
    .filter((t) => t && t.playable !== false)
    .map((t) => ({
      id: `tidal:${t.id}`,
      title: String(t.title ?? '').trim(),
      artist: Array.isArray(t.artistNames) ? t.artistNames.join(', ') : String(t.artistNames ?? ''),
      album: '',
      duration: seconds(t.duration),
      artworkURL: artwork(t.artwork),
      format: 'flac',
      audioQuality: 'LOSSLESS',
      audioMode: 'STEREO',
      _source: 'tidal',
      _nativeId: String(t.id),
      _isrc: t.isrc,
      _base: base,
    }))
    .filter((row) => row.title.length > 0);
}

/**
 * Creates the source. `getBases()` returns the live, ordered base list
 * (primary first) — supplied by the tracker so failover works without a deploy.
 */
export function createTidalSource(getBases = () => [DEFAULT_BASE], log = () => {}) {
  return {
    id: 'tidal',
    label: 'Tidal',
    lossless: true,
    atmos: false,

    async search(query, limit = 20, signal) {
      const text = String(query ?? '').trim();
      if (!text) return [];

      return searchCache.wrap(`tidal:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
        const bases = getBases();
        let lastError = null;
        let answered = 0;
        // Try bases in order: primary first, then whatever the tracker
        // currently reports healthy. First base with rows wins; a base that
        // answers with zero rows is a valid answer, not an error. Only a
        // total failure — every base threw — is an error worth reporting.
        for (const base of bases) {
          try {
            const rows = await searchBase(base, text, limit, signal);
            answered += 1;
            if (rows.length || bases.length === 1) return rows;
            lastError = new Error(`${base} returned zero rows`);
          } catch (error) {
            lastError = error;
            log('warn', 'tidal base failed, trying next', { base, error: error.message });
          }
        }
        if (answered === 0 && lastError) {
          throw new UpstreamError(`every Tidal instance failed: ${lastError.message}`, {
            status: 502,
            retryable: true,
          });
        }
        return [];
      });
    },

    /** Resolves one native id to a verified FLAC URL plus what is known about it. */
    async resolve(nativeId, _tier, signal) {
      const id = String(nativeId ?? '').trim();
      if (!id) throw new NotFound('no track id');

      const bases = getBases();
      let firstWorking = null;
      let firstProbe = null;

      for (const base of bases) {
        const url = `${base}/track/${encodeURIComponent(id)}`;
        const probe = await this.probe(url, `probe:${base}:${id}`, signal).catch(() => null);
        if (probe) {
          firstWorking = url;
          firstProbe = probe;
          break;
        }
        // Keep the first base's URL as a fallback candidate even if the probe
        // could not run (e.g. Range blocked) — a 206 is what we verified, but
        // a plain 200 from a known-good host is still worth handing over.
        if (!firstWorking) firstWorking = url;
      }

      if (!firstWorking) {
        throw new UpstreamError('no Tidal base could serve this track', {
          status: 502,
          retryable: true,
        });
      }

      const info = firstProbe;
      const channels = info?.channels ?? null;
      return {
        url: firstWorking,
        codec: 'flac',
        container: 'flac',
        manifest: 'none',
        encrypted: false,
        sampleRate: info?.sampleRate ?? null,
        bitDepth: info?.bitDepth ?? null,
        bitrate: info ? flacKbps(info.byteLength, info.durationSec) : null,
        channels,
        audioMode: channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO',
        audioModes: [channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO'],
        probed: Boolean(info),
        error: info ? undefined : 'served, but the FLAC header could not be read',
      };
    },

    /**
     * Reads the first bytes of the media URL and parses STREAMINFO.
     * Returns null when the bytes are not FLAC — the signal that this URL
     * must not be labelled lossless.
     */
    async probe(url, cacheKey, signal) {
      return probeCache.wrap(cacheKey, Number.MAX_SAFE_INTEGER, async () => {
        let response;
        try {
          response = await httpGet(url, {
            timeoutMs: STREAM_TIMEOUT_MS,
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

    mediaUrl(nativeId) {
      return `${getBases()[0]}/track/${encodeURIComponent(String(nativeId))}`;
    },

    async health() {
      const bases = getBases();
      const checks = await Promise.allSettled(
        bases.slice(0, 4).map(async (base) => {
          const payload = await httpJson(
            `${base}/search/tracks?q=music&limit=1`,
            { timeoutMs: 8_000, retries: 0 },
          );
          const n = Array.isArray(payload?.tracks) ? payload.tracks.length : 0;
          return { base, ok: true, detail: `${n} result(s) for a probe query` };
        }),
      );
      const report = checks.map((c, i) =>
        c.status === 'fulfilled'
          ? c.value
          : { base: bases[i], ok: false, detail: c.reason?.message ?? 'unreachable' },
      );
      const healthy = report.filter((r) => r.ok).length;
      return { ok: healthy > 0, detail: `${healthy}/${report.length} instance(s) healthy`, instances: report };
    },
  };
}
