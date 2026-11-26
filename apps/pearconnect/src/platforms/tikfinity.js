// TikFinity -> Streamer.bot -> this local JSON POST API -> Pear Desktop.
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { parseJson } from '@foulfoxhacks/ametherian-schema';
import { InputError, validatePayload } from '../validation.js';

const digest = (value) => createHash('sha256').update(value).digest();
const MAX_BODY = 64 * 1024;
const LOCAL_HOSTS = ['127.0.0.1', 'localhost', '[::1]'];
const hostname = (host = '') => (host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.split(':')[0]).toLowerCase();
const send = (res, status, data, headers = {}) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers });
  res.end(JSON.stringify(data));
};
const BAD_JSON = { ok: false, code: 'invalid_json', message: 'Supply a valid, uncompressed JSON object smaller than 64 KiB.' };

/** Reads an uncompressed body up to MAX_BODY bytes; null when it's larger (the rest is drained, not kept). */
async function readBody(req) {
  const chunks = []; let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size <= MAX_BODY) chunks.push(chunk);
  }
  return size > MAX_BODY ? null : Buffer.concat(chunks);
}

/** A request handler for http.createServer (the bridge's whole local API). */
export function createTikfinityApp({ secret = '', queue, skipAllowlist = [], log = console, dryRun = false, now = Date.now, getStatus, getDiagnostics }) {
  const expectedSecret = digest(secret);
  const cache = new Map();
  let active = 0;
  const paths = new Map([
    ['/tikfinity', 'request'], ['/tikfinity/np', 'np'], ['/tikfinity/queue', 'queue'],
    ['/tikfinity/skip', 'skip'], ['/tikfinity/test', 'test'],
  ]);

  async function command(req, res, path, name) {
    if (req.method !== 'POST') return send(res, 405, { ok: false, code: 'method_not_allowed', message: 'Use POST with application/json.' }, { Allow: 'POST' });
    if ((req.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json') return send(res, 415, { ok: false, code: 'content_type', message: 'Content-Type must be application/json.' });
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') return send(res, 415, BAD_JSON);
    const raw = await readBody(req);
    if (!raw) return send(res, 413, BAD_JSON);
    let body;
    try { body = parseJson(new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), { maxBytes: MAX_BODY, maxDepth: 8 }); } catch { return send(res, 400, BAD_JSON); }
    const payload = validatePayload(body);
    if (name === 'test') return send(res, 200, { ok: true, code: 'validated', dryRun: true, message: 'Payload validated. No player or quota state was changed.', payload });
    const key = req.headers['idempotency-key'];
    if (key && !/^[a-zA-Z0-9_-]{8,100}$/.test(key)) throw new InputError('Idempotency-Key must contain 8-100 letters, digits, hyphens or underscores.');
    const fingerprint = digest(JSON.stringify([path, payload])).toString('hex');
    for (const [id, entry] of cache) if (entry.expires <= now() && entry.done) cache.delete(id);
    let entry = key && cache.get(key);
    if (entry && entry.fingerprint !== fingerprint) return send(res, 409, { ok: false, code: 'idempotency_conflict', message: 'This key was already used for a different request.' });
    if (!entry) {
      if (active >= 32 || (key && cache.size >= 1000)) return send(res, 503, { ok: false, code: 'busy', message: 'Bridge is busy. Try later.' });
      entry = { fingerprint, expires: now() + 300000, done: false };
      active++;
      entry.promise = (async () => {
        try {
          const data = { ...payload, platform: 'tiktok' };
          switch (name) {
            case 'request': return await queue.handleRequest(data);
            case 'np': return await queue.handleNowPlaying(data);
            case 'queue': return await queue.handleQueuePeek(data);
            case 'skip': return await queue.handleSkip({ ...data, allowlist: skipAllowlist });
          }
        } catch {
          log.error('[webhook] Unexpected handler failure.');
          return { ok: false, code: 'internal_error', message: 'The bridge could not process this request.' };
        } finally { active--; entry.done = true; }
      })();
      if (key) cache.set(key, entry);
    }
    const result = await entry.promise;
    send(res, { invalid_input: 400, upstream_error: 502, upstream_timeout: 504, internal_error: 500 }[result.code] || 200, result);
  }

  async function route(req, res) {
    // Native local clients do not need browser CORS. Reject browser origins and DNS rebinding.
    if (req.headers.origin || !LOCAL_HOSTS.includes(hostname(req.headers.host))) return send(res, 403, { ok: false, code: 'forbidden', message: 'Use a native localhost client.' });
    if (secret && !timingSafeEqual(expectedSecret, digest(req.headers['x-webhook-secret'] || ''))) return send(res, 403, { ok: false, code: 'forbidden', message: 'Webhook authentication failed.' });
    const path = (req.url || '/').split('?')[0];
    const name = paths.get(path);
    if (name) return command(req, res, path, name);
    if (req.method === 'GET' || req.method === 'HEAD') {
      if (path === '/healthz') return send(res, 200, { ok: true, mode: dryRun ? 'dry-run' : 'live' });
      if (path === '/status' && getStatus) return send(res, 200, getStatus());
      if (path === '/diagnostics' && getDiagnostics) return send(res, 200, getDiagnostics());
      if (path === '/readyz') {
        if (dryRun) return send(res, 200, { ok: true, mode: 'dry-run', pearDesktop: 'not_checked' });
        try {
          await queue.ytmd.getCurrentSong();
          return send(res, 200, { ok: true, mode: 'live', pearDesktop: 'reachable' });
        } catch {
          return send(res, 503, { ok: false, code: 'not_ready', message: 'Pear Desktop is unavailable or unauthorized.' });
        }
      }
    }
    send(res, 404, { ok: false, code: 'not_found', message: 'Unknown endpoint.' });
  }

  return (req, res) => route(req, res).catch((error) => {
    if (res.headersSent) return res.destroy();
    if (error instanceof InputError) return send(res, 400, { ok: false, code: 'invalid_input', message: error.message });
    send(res, 500, { ok: false, code: 'internal_error', message: 'Internal bridge error.' });
  });
}

export async function startTikfinity(options) {
  if (options.port === 0) {
    options.log.info('[tikfinity] disabled (TIKFINITY_PORT=0)');
    return null;
  }
  const server = http.createServer(createTikfinityApp(options));
  return new Promise((resolve, reject) => {
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject);
      server.on('error', () => options.log.error('[tikfinity] HTTP server error.'));
      options.log.info(`[tikfinity] webhook listening on http://127.0.0.1:${server.address().port}`);
      resolve(server);
    });
    server.requestTimeout = 15000;
    server.headersTimeout = 10000;
    server.on('error', reject);
  });
}
