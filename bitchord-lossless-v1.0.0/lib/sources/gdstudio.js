/**
 * GDStudio, the community's aggregated free music gateway.
 *
 *   https://music-api.gdstudio.xyz/api.php
 *
 * One search endpoint that fans out to real catalogues and one url endpoint
 * that hands back a CDN URL. With `br=999` it returns 24-bit FLAC where the
 * track has it and 16-bit otherwise; `br=740` is the guaranteed-16-bit tier.
 * No account, no key, no registration. Verified live against the fLaC bytes.
 *
 * Reality checks, learned by probing it:
 *  - The url call is rate-limited per IP (≈50–60 requests per 5 minutes), so
 *    this source is search-first and probe-on-demand, with caching, and the
 *    24-bit request is attempted before the 16-bit one.
 *  - Tidal/Qobuz sources are intermittently unsupported upstream; NetEase is
 *    the stable one and is the default. Override with GDSTUDIO_SOURCES.
 *  - Search rows carry no duration, so matching in BitChord relies on
 *    title + artist (which it tolerates — duration is optional).
 *  - NetEase CDN URLs are signed and expire; never cache a resolved URL
 *    beyond a few minutes, and let the probe TTL stay short.
 *
 * Atmos: not served by this gateway. Never labelled Atmos here.
 */

import { STREAMINFO_BYTES, parseFlacStreamInfo, flacKbps } from '../flac.js';
import { httpJson, httpGet, TtlCache, NotFound, UpstreamError } from '../http.js';

const BASE = process.env.GDSTUDIO_BASE_URL ?? 'https://music-api.gdstudio.xyz';
const SOURCES = (process.env.GDSTUDIO_SOURCES ?? 'netease')
  .split(',')
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const BR_PREFERRED = process.env.GDSTUDIO_BR ?? '999'; // 999 = 24-bit where present

const searchCache = new TtlCache(500);
const probeCache = new TtlCache(500);
const SEARCH_TTL_MS = 10 * 60 * 1000;
const PROBE_TTL_MS = 10 * 60 * 1000; // signed URLs expire; keep this short

const artwork = () => undefined; // the pic endpoint returns JSON, not an image

export const gdstudio = {
  id: 'gdstudio',
  label: 'NetEase (GDStudio)',
  lossless: true,
  atmos: false,
  baseUrl: BASE,

  async search(query, limit = 20, signal) {
    const text = String(query ?? '').trim();
    if (!text) return [];

    return searchCache.wrap(`gd:${SOURCES.join(',')}:${text.toLowerCase()}:${limit}`, SEARCH_TTL_MS, async () => {
      const perSource = Math.max(4, Math.ceil(Math.min(limit, 20) / SOURCES.length));
      const rows = [];
      for (const source of SOURCES) {
        try {
          const url =
            `${BASE}/api.php?types=search&source=${encodeURIComponent(source)}` +
            `&name=${encodeURIComponent(text)}&count=${perSource}&pages=1`;
          const payload = await httpJson(url, { timeoutMs: 8_000, retries: 0, signal });
          if (!Array.isArray(payload)) continue;
          for (const t of payload) {
            if (!t || t.id == null || !t.name) continue;
            rows.push({
              id: `gdstudio:${source}:${t.id}`,
              title: String(t.name).trim(),
              artist: Array.isArray(t.artist) ? t.artist.join(', ') : String(t.artist ?? ''),
              album: t.album ? String(t.album) : '',
              duration: undefined, // not published by the gateway
              artworkURL: artwork(),
              format: 'flac',
              audioQuality: 'LOSSLESS',
              audioMode: 'STEREO',
              _source: 'gdstudio',
              _nativeId: `${source}:${t.id}`,
            });
            if (rows.length >= limit) return rows;
          }
        } catch (error) {
          // One catalogue in the gateway being down is not the source being down.
          void error;
        }
      }
      return rows;
    });
  },

  /** Resolves one `source:id` handle to a verified FLAC URL. */
  async resolve(nativeId, _tier, signal) {
    const raw = String(nativeId ?? '').trim();
    const cut = raw.indexOf(':');
    if (cut < 1) throw new NotFound('malformed gdstudio id');
    const source = raw.slice(0, cut);
    const trackId = raw.slice(cut + 1);
    if (!trackId) throw new NotFound('malformed gdstudio id');

    // 24-bit first, then the guaranteed-16-bit tier. br=999 is tried first
    // because the gateway returns exactly what the track has: 999 for Hi-Res
    // masters, lower for CD-quality. This costs one extra call only when the
    // preferred tier fails outright.
    const candidates = [BR_PREFERRED, ...(BR_PREFERRED !== '740' ? ['740'] : [])];
    let lastError = null;
    for (const br of candidates) {
      try {
        const payload = await httpJson(
          `${BASE}/api.php?types=url&source=${encodeURIComponent(source)}` +
            `&id=${encodeURIComponent(trackId)}&br=${br}`,
          { timeoutMs: 12_000, retries: 0, signal },
        );
        const url = payload?.url;
        if (!url || typeof url !== 'string') {
          throw new NotFound(`gateway returned no url for br=${br}`);
        }

        const probe = await this.probe(url, `probe:${source}:${trackId}:${br}`, signal);
        const info = probe;
        const channels = info?.channels ?? null;
        const hires = info ? info.sampleRate > 48000 || info.bitDepth > 16 : null;

        // The gateway reports what it actually served in `br`; anything below
        // 740 kbps is not lossless, and we refuse to label it so.
        const servedBr = Number(payload?.br);
        if (Number.isFinite(servedBr) && servedBr > 0 && servedBr < 740) {
          throw new NotFound(`gateway served only ${servedBr} kbps — not lossless, refusing`);
        }

        const sizeKb = Number(payload?.size); // gateway reports the file in KB
        const byteLength =
          info?.byteLength ?? (Number.isFinite(sizeKb) && sizeKb > 0 ? sizeKb * 1000 : null);

        return {
          url,
          codec: 'flac',
          container: 'flac',
          manifest: 'none',
          encrypted: false,
          sampleRate: info?.sampleRate ?? null,
          bitDepth: info?.bitDepth ?? null,
          bitrate: byteLength && info?.durationSec ? flacKbps(byteLength, info.durationSec) : null,
          channels,
          audioQuality: hires ? 'HI_RES_LOSSLESS' : 'LOSSLESS',
          audioMode: channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO',
          audioModes: [channels && channels > 2 ? 'MULTICHANNEL' : 'STEREO'],
          probed: Boolean(info),
          error: info ? undefined : 'served, but the FLAC header could not be read',
        };
      } catch (error) {
        lastError = error;
        if (error instanceof NotFound) break; // a genuine miss — do not hammer the gateway
      }
    }
    throw new UpstreamError(lastError?.message ?? 'gateway did not return a lossless url', {
      status: 502,
      retryable: true,
    });
  },

  async probe(url, cacheKey, signal) {
    return probeCache.wrap(cacheKey, PROBE_TTL_MS, async () => {
      let response;
      try {
        response = await httpGet(url, {
          timeoutMs: 12_000,
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

  // Note: no mediaUrl() — resolved NetEase URLs are signed and expire, so
  // the proxy route must always re-resolve rather than reuse a stale one.

  async health() {
    try {
      const payload = await httpJson(
        `${BASE}/api.php?types=search&source=${encodeURIComponent(SOURCES[0])}&name=test&count=1&pages=1`,
        { timeoutMs: 8_000, retries: 0 },
      );
      const ok = Array.isArray(payload);
      return { ok, detail: ok ? `search answering via ${SOURCES.join('+')}` : 'gateway answered with an unexpected shape' };
    } catch (error) {
      return { ok: false, detail: error.message };
    }
  },
};
