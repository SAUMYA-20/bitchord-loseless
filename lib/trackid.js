/**
 * Track ids, and making them safe to put in a URL path segment.
 *
 * BitChord takes the `id` from a `/search` row and puts it straight into
 * `/stream/{id}` as a single path segment. OkHttp percent-encodes on the way
 * out, which means a `/` inside an id becomes `%2F` on the wire and many HTTP
 * servers decode it back to a `/` before routing sees it. So ids are encoded
 * so that no byte a name may contain can act as a delimiter.
 *
 * The encoding is deliberately conditional: an id already made of safe
 * characters is passed through verbatim, because a readable id is worth a
 * great deal in a log line. Only the rest are base64url'd behind a `~`.
 */

/** RFC 4648 §5: URL-safe, no padding, so it survives a path segment. */
const SAFE = /^[A-Za-z0-9._~-]+$/;

export function encodePart(value) {
  const text = String(value ?? '');
  if (SAFE.test(text) && text.length > 0) return text;
  return `~${Buffer.from(text, 'utf8').toString('base64url')}`;
}

export function decodePart(value) {
  const text = String(value ?? '');
  if (!text.startsWith('~')) return text;
  try {
    return Buffer.from(text.slice(1), 'base64url').toString('utf8');
  } catch {
    return text;
  }
}

/** Builds the opaque id BitChord will hold for one row. */
export function makeTrackId(source, nativeId) {
  return `${source}:${encodePart(nativeId)}`;
}

/**
 * Splits an id back into the source and its native handle.
 * Returns null for anything that is not one of ours — BitChord only echoes
 * back ids it was given, so an unrecognised one is a stale row.
 */
export function parseTrackId(id) {
  const raw = String(id ?? '');
  const cut = raw.indexOf(':');
  if (cut < 1) return null;
  const source = raw.slice(0, cut);
  const nativeId = decodePart(raw.slice(cut + 1));
  if (!source || !nativeId) return null;
  return { source, nativeId };
}
