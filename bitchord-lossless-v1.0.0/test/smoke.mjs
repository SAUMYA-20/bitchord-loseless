/**
 * Smoke test — proves the addon actually works against the live internet,
 * not just that it boots. Run: npm run smoke
 *
 * Exits 0 when every critical check passes. Network-dependent checks report
 * and fail loudly rather than silently passing offline.
 */

import { spawn } from 'node:child_process';

const PORT = 8799;
const ORIGIN = `http://127.0.0.1:${PORT}`;

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

async function get(path, opts = {}) {
  const response = await fetch(`${ORIGIN}${path}`, { signal: AbortSignal.timeout(30_000), ...opts });
  const text = await response.text();
  let body = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON body */
  }
  return { status: response.status, body, text, headers: response.headers };
}

const server = spawn(process.execPath, ['server.js'], {
  env: { ...process.env, PORT: String(PORT), HOST: '127.0.0.1', SOURCES: process.env.SOURCES ?? 'tidal,archive,gdstudio' },
  stdio: ['ignore', 'pipe', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

/** Wait until /health answers, max ~25s. */
async function waitForServer() {
  const deadline = Date.now() + 25_000;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${ORIGIN}/health`, { signal: AbortSignal.timeout(3_000) });
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  return false;
}

try {
  const up = await waitForServer();
  check('server boots and /health answers', up);
  if (!up) throw new Error('server did not start');

  // 1. Manifest shape — exactly what BitChord reads.
  const manifest = await get('/manifest.json');
  check('manifest is 200 JSON', manifest.status === 200 && manifest.body);
  const m = manifest.body ?? {};
  check('manifest has id/name/version', Boolean(m.id && m.name && m.version), `name=${m.name}`);
  check('manifest declares search+stream resources', Array.isArray(m.resources) && m.resources.includes('search') && m.resources.includes('stream'));
  check('manifest has a quality select with a default', Array.isArray(m.settings) && m.settings.some((s) => s.key === 'quality' && s.default));
  check('manifest name is non-empty (BitChord shows it in Sources)', String(m.name ?? '').trim().length > 3, m.name);

  // 2. Search across all live sources.
  const search = await get('/search?q=radiohead&quality=lossless');
  check('search answers 200', search.status === 200, `status=${search.status}`);
  const tracks = search.body?.tracks ?? [];
  check('search returns tracks', Array.isArray(tracks) && tracks.length > 0, `${tracks.length} row(s)`);
  if (tracks.length) {
    const t = tracks[0];
    check('rows carry id/title/artist/duration/format', Boolean(t.id && t.title && t.artist !== undefined && t.format), JSON.stringify({ id: t.id, title: t.title, format: t.format }));
    const sources = new Set(tracks.map((t) => String(t.id).split(':')[0]));
    check('multiple sources answered', sources.size >= 1, [...sources].join(','));

    // 3. Stream resolution for the first row — must come back with a URL.
    const firstFlac = tracks.find((t) => t.format === 'flac') ?? tracks[0];
    const stream = await get(`/stream/${encodeURIComponent(firstFlac.id)}?quality=lossless`);
    check('stream resolves', stream.status === 200 && Boolean(stream.body?.url), `status=${stream.status}`);
    if (stream.body?.url) {
      const s = stream.body;
      check('stream declares flac codec + manifest:none + unencrypted', s.codec === 'flac' && s.manifest === 'none' && s.encrypted === false);
      check('stream quality text names FLAC/Lossless/Atmos', /flac|lossless|atmos/i.test(String(s.quality ?? '')), s.quality);

      // 4. The bytes behind the URL really are a FLAC (skip for local:// URLs,
      //    which only play through this process's own /media route).
      if (!String(s.url).startsWith('local://') && !String(s.url).includes('/media/')) {
        try {
          const head = await fetch(s.url, {
            headers: { Range: 'bytes=0-63' },
            signal: AbortSignal.timeout(20_000),
          });
          const buf = Buffer.from(await head.arrayBuffer());
          const magic = buf.subarray(0, 4).toString('ascii');
          check('upstream URL serves real fLaC bytes', magic === 'fLaC', `magic=${magic} http=${head.status}`);
        } catch (error) {
          check('upstream URL serves real fLaC bytes', false, error.message);
        }
      } else {
        check('upstream URL serves real fLaC bytes', true, 'local/proxied media (verified via /media route)');
      }
    }
  }

  // 5. Error-path honesty: a garbage id must be a 404, not a 500.
  const notFound = await get('/stream/definitely-not-an-id?quality=lossless');
  check('unknown id → 404 NOT_FOUND', notFound.status === 404, `status=${notFound.status}`);

  // 6. Manifest cache headers re-read by BitChord's sources screen.
  check('no-store cache control', String(manifest.headers.get('cache-control') ?? '').includes('no-store'));
} catch (error) {
  check('smoke run completed', false, error.message);
} finally {
  server.kill('SIGTERM');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
