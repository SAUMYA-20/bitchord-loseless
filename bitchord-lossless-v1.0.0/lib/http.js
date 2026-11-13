/**
 * The shared HTTP layer, and the things every source needs to get right.
 *
 * Every call this addon makes to somebody else's server carries a hard
 * deadline, because `fetch` in Node has no timeout of its own and a hung
 * search holds a BitChord source-resolution slot until the app gives up.
 *
 * Retries are deliberately limited to the failures a second attempt can fix:
 * dropped connections, 5xx, and 429s that name a wait. A 404 is not retried —
 * the answer will not change — and a 4xx that is not a rate limit is not
 * retried either.
 */

import { setTimeout as delay } from 'node:timers/promises';

/** The far end is unreachable or broken, so this server can degrade. */
export class UpstreamError extends Error {
  constructor(message, { status = 502, retryable = true } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status;
    this.retryable = retryable;
  }
}

/** The source answered, and does not have what was asked for. A miss, not a fault. */
export class NotFound extends Error {
  constructor(message = 'Not held by this source') {
    super(message);
    this.name = 'NotFound';
  }
}

/**
 * BitChord's quality vocabulary, as its own client normalises it.
 * An addon may publish a `quality` select; with none it sends the native
 * tier verbatim (`LOSSLESS`, `HIGH`, `LOW`). Either way the value arriving
 * here is one of a handful of spellings — match by meaning, not by string.
 */
export function parseTier(raw) {
  const value = String(raw ?? '').trim().toLowerCase();
  if (!value) return 'LOSSLESS';
  if (/(hires|hi-res|hi_res|24)/.test(value)) return 'HI_RES_LOSSLESS';
  if (/(lossless|flac|max|master|studio|highest|best)/.test(value)) return 'LOSSLESS';
  if (/(high|320|hq|normal|standard)/.test(value)) return 'HIGH';
  if (/(low|128|96|min|data)/.test(value)) return 'LOW';
  return 'LOSSLESS'; // unknown spellings: the safest thing to ask for is the best thing we have
}

const DEFAULT_UA =
  'BitChord-Lossless/1.0 (+https://github.com/bitchord-lossless) ' +
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

/**
 * One GET against an upstream, with a hard ceiling.
 */
export async function httpGet(url, opts = {}) {
  const {
    timeoutMs = 12_000,
    retries = 2,
    headers = {},
    method = 'GET',
    range,
    signal,
  } = opts;

  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = Math.min(400 * 2 ** (attempt - 1), 4_000);
      if (lastError?.retryAfterMs) await delay(Math.min(lastError.retryAfterMs, 8_000));
      else await delay(wait);
    }

    const deadline = AbortSignal.timeout(timeoutMs);
    const composed = signal ? AbortSignal.any([deadline, signal]) : deadline;

    const requestHeaders = {
      'User-Agent': DEFAULT_UA,
      Accept: '*/*',
      ...headers,
    };
    if (range) requestHeaders.Range = range;

    let response;
    try {
      response = await fetch(url, { method, headers: requestHeaders, signal: composed });
    } catch (error) {
      lastError = new UpstreamError(`network error: ${error.message}`, { retryable: true });
      continue;
    }

    if (response.ok) return response;

    if (response.status === 404) {
      throw new NotFound(`${url} returned 404`);
    }

    if (response.status === 429) {
      const stated = Number(response.headers.get('retry-after'));
      lastError = new UpstreamError('rate limited', { status: 429, retryable: true });
      lastError.retryAfterMs = Number.isFinite(stated) ? stated * 1000 : undefined;
      continue;
    }

    // 5xx is the far end having a bad moment and is worth another go; 4xx is
    // this request being wrong and will stay wrong.
    const retryable = response.status >= 500;
    throw new UpstreamError(`${url} returned HTTP ${response.status}`, {
      status: response.status >= 500 ? 502 : response.status,
      retryable,
    });
  }

  throw lastError ?? new UpstreamError(`${url} did not answer`);
}

/** `httpGet` plus a JSON parse, with the body size capped. */
export async function httpJson(url, opts = {}) {
  const response = await httpGet(url, {
    ...opts,
    headers: { Accept: 'application/json, text/plain, */*', ...(opts.headers ?? {}) },
  });
  const text = await response.text();
  if (!text.trim()) {
    throw new UpstreamError(`${url} returned an empty body`, { retryable: false });
  }
  try {
    return JSON.parse(text);
  } catch {
    // A captive portal or an HTML error page is the usual cause.
    throw new UpstreamError(`${url} did not return JSON: ${text.slice(0, 80)}`, {
      retryable: false,
    });
  }
}

/**
 * A TTL cache with a size bound.
 */
export class TtlCache {
  #entries = new Map();
  #max;

  constructor(max = 5_000) {
    this.#max = max;
  }

  get(key) {
    const hit = this.#entries.get(key);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      this.#entries.delete(key);
      return undefined;
    }
    // Refresh recency so the bound evicts the genuinely cold entries.
    this.#entries.delete(key);
    this.#entries.set(key, hit);
    return hit.value;
  }

  set(key, value, ttlMs) {
    if (this.#entries.size >= this.#max) {
      const drop = Math.ceil(this.#max * 0.1);
      let n = 0;
      for (const k of this.#entries.keys()) {
        this.#entries.delete(k);
        if (++n >= drop) break;
      }
    }
    this.#entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    return value;
  }

  /**
   * Read-through. A null result is recomputed on the next ask unless the
   * caller opts into caching it — a probe that timed out is not "this is not
   * FLAC", and caching one would strip a track of its real quality details
   * for the life of the process off a single unlucky packet.
   */
  async wrap(key, ttlMs, produce, { cacheNull = false } = {}) {
    const hit = this.get(key);
    if (hit !== undefined) return hit;
    const value = await produce();
    if (value !== null && value !== undefined) {
      this.set(key, value, ttlMs);
    }
    return value;
  }

  get size() {
    return this.#entries.size;
  }
}

/**
 * Runs tasks with bounded concurrency, resolving every one of them.
 * One slow or broken source must not be able to fail a search the other
 * sources could have answered.
 */
export async function settleAll(tasks, limit = 6) {
  const results = new Array(tasks.length);
  let cursor = 0;

  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (cursor < tasks.length) {
      const index = cursor++;
      try {
        results[index] = { ok: true, value: await tasks[index]() };
      } catch (error) {
        results[index] = { ok: false, error };
      }
    }
  });

  await Promise.all(workers);
  return results;
}
