/**
 * Auto-updating source discovery.
 *
 * The single biggest operational risk for a free community addon is a public
 * instance dying behind a fixed code path — the addon breaks for everyone
 * until somebody ships a patch and redeploys. This module removes that
 * failure mode for the Tidal-compatible layer.
 *
 * The Lossless Sources project (https://github.com/kipavy/spotube-plugin-lossless-sources)
 * runs a continuous probe — a GitHub Action on a schedule — over every known
 * public Monochrome/hifi instance on the internet, and publishes the result as
 * a machine-readable list: entries that actually served real audio at the last
 * probe, in preference order. This addon polls that list on an interval and
 * promotes whatever it says is healthy, without any deploy.
 *
 * What it does:
 *   1. Fetches `sources.json` at startup and then every REFRESH_MS (default 30 min).
 *   2. Keeps only entries of a type this addon can speak:
 *        - "monochrome": speaks /search/tracks + /track/{id} (same as tracks.monochrome.st)
 *   3. Maintains a live, ordered list of usable Tidal bases. The first entry is
 *      always the configured primary (TIDAL_BASE_URL), then healthy tracker
 *      entries that are not duplicates.
 *   4. Exposes health for /health so an operator can see it working.
 *
 * Failure model: if the tracker is unreachable, the last good list is kept
 * (stale is better than empty). If the tracker says nothing is healthy, the
 * configured primary is still tried. Nothing here can take the addon down.
 */

const TRACKER_URL =
  process.env.HIFI_TRACKER_URL ??
  'https://raw.githubusercontent.com/kipavy/spotube-plugin-lossless-sources/main/sources.json';

const REFRESH_MS = Math.max(
  5 * 60 * 1000,
  Number(process.env.HIFI_TRACKER_REFRESH_MS ?? 30 * 60 * 1000) || 30 * 60 * 1000,
);

export function createTracker(log = () => {}) {
  /** @type {{updated: string|null, sources: Array<{type:string, base:string}>, fetchedAt: number|null, error: string|null}} */
  let state = { updated: null, sources: [], fetchedAt: null, error: null };
  let timer = null;

  async function refresh() {
    try {
      const response = await fetch(TRACKER_URL, {
        headers: { Accept: 'application/json', 'User-Agent': 'BitChord-Lossless/1.0' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!response.ok) throw new Error(`tracker returned HTTP ${response.status}`);
      const json = await response.json();
      const sources = Array.isArray(json?.sources) ? json.sources : [];
      const cleaned = [];
      const seen = new Set();
      for (const entry of sources) {
        const base = String(entry?.base ?? '').trim().replace(/\/+$/, '');
        const type = String(entry?.type ?? '').trim().toLowerCase();
        if (!base.startsWith('https://') || seen.has(base)) continue;
        if (type !== 'monochrome') continue; // the only schema we verify end-to-end
        seen.add(base);
        cleaned.push({ type, base });
      }
      state = {
        updated: json?.updated ?? null,
        sources: cleaned,
        fetchedAt: Date.now(),
        error: null,
      };
      log('info', 'source tracker refreshed', {
        healthy: cleaned.length,
        trackerUpdated: state.updated,
        bases: cleaned.map((s) => s.base),
      });
    } catch (error) {
      // Keep the last good list — stale is better than empty.
      state = { ...state, error: error.message };
      log('warn', 'source tracker refresh failed (keeping last known)', { error: error.message });
    }
  }

  function start() {
    refresh();
    timer = setInterval(refresh, REFRESH_MS);
    timer.unref?.();
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  /**
   * The live, ordered list of monochrome-compatible bases to try, primary
   * first. Always contains the primary at least once.
   */
  function monochromeBases(primary) {
    const norm = (b) => String(b).trim().replace(/\/+$/, '');
    const out = [norm(primary)];
    const seen = new Set(out);
    for (const entry of state.sources) {
      const base = norm(entry.base);
      if (!seen.has(base)) {
        seen.add(base);
        out.push(base);
      }
    }
    return out;
  }

  function status() {
    return {
      trackerUrl: TRACKER_URL,
      refreshMs: REFRESH_MS,
      updated: state.updated,
      fetchedAt: state.fetchedAt ? new Date(state.fetchedAt).toISOString() : null,
      healthyList: state.sources.map((s) => s.base),
      error: state.error,
    };
  }

  return { start, stop, refresh, monochromeBases, status };
}
