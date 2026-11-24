import { randomUUID } from 'node:crypto';
import { InputError } from './validation.js';
import { playerQueue, findQueueAddition } from './player-queue.js';
import { setTimeout as delay } from 'node:timers/promises';

// BetterYTS Stream connector (opt-in: STREAM_BACKEND=betteryts). The BetterYTS queue becomes the
// authority for requests, policy and moderation; this desktop keeps two jobs:
//   1. intake  - forward chat requests from the existing Twitch / YouTube / TikFinity adapters as
//                canonical song_request events (POST /events, owner or intake token).
//   2. playback - act as the Pear Desktop playback destination: claim the next approved request,
//                add its resolved video to Pear Desktop, verify the queue, report the outcome.
// The local QueueManager path is untouched and stays the default, so this is reversible by config.

export const STREAM_ORIGIN = 'https://yts.foulfoxhacks.dev';
const CODE = /^[A-HJ-NP-Z2-9]{8}$/;
const TOKEN = /^[a-f0-9]{64}$/;
const VIDEO = /^[\w-]{11}$/;

export class BetterYTSStream {
  #token; #destinationToken;
  constructor({ origin = STREAM_ORIGIN, code, token, destinationToken, player, logger = console, fetcher = fetch, intervalMs = 2000, queueCheckDelayMs = 500 }) {
    if (!CODE.test(code || '')) throw new InputError('BETTERYTS_STREAM_CODE must be an 8-character session code.');
    if (!TOKEN.test(token || '')) throw new InputError('BETTERYTS_STREAM_TOKEN must be the 64-character session credential.');
    if (destinationToken && !TOKEN.test(destinationToken)) throw new InputError('BETTERYTS_STREAM_DESTINATION_TOKEN must be a 64-character credential.');
    const url = new URL(origin);
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new InputError('BETTERYTS_STREAM_ORIGIN must use HTTPS.');
    this.base = `${url.origin}/api/stream/v1/sessions/${code}`;
    // Least privilege: an intake credential for chat, a destination credential for playback. Owner works for both.
    this.#token = token; this.#destinationToken = destinationToken || token; this.player = player; this.log = logger; this.fetcher = fetcher;
    this.intervalMs = intervalMs; this.queueCheckDelayMs = queueCheckDelayMs;
    this.stopped = true; this.ready = () => true; this.state = 'disconnected';
  }

  async call(path, body, method = 'POST', credential = this.#token) {
    let response;
    try {
      response = await this.fetcher(`${this.base}${path}`, { method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { Authorization: `Bearer ${credential}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    } catch { throw new InputError('BetterYTS Stream is unreachable. Check the previous result before retrying.'); }
    if (!response.headers.get('content-type')?.includes('application/json')) throw new InputError('BetterYTS Stream returned an unexpected response.');
    const text = await response.text();
    if (text.length > 262144) throw new InputError('BetterYTS Stream response is too large.');
    let data; try { data = JSON.parse(text); } catch { throw new InputError('BetterYTS Stream returned invalid JSON.'); }
    if (!response.ok || data.ok === false && data.code && !data.state) {
      const error = new InputError(typeof data.message === 'string' ? data.message.slice(0, 1200) : 'BetterYTS Stream rejected the call.');
      error.code = data.code; throw error;
    }
    return data;
  }

  /** Chat adapters call this in place of QueueManager.handleRequest when the backend is BetterYTS. */
  async submit({ user, userId = '', query = '', platform = 'tiktok', reply }) {
    const event = { schemaVersion: '1', eventId: `pc-${randomUUID()}`, eventType: 'song_request.submitted',
      source: { platform }, actor: { platformUserId: userId || String(user).toLowerCase(), displayName: user },
      request: { input: query, inputType: 'text' }, occurredAt: new Date().toISOString() };
    let result;
    try { result = await this.call('/events', event); }
    catch (error) { result = { ok: false, code: error.code || 'unavailable', message: error.message }; }
    // A failed chat reply never changes the request outcome.
    try { Promise.resolve(reply?.(result.message)).catch(() => {}); } catch { /* ignore */ }
    return result;
  }

  start(ready = () => true) {
    this.ready = ready; this.stopped = false; this.tick();
  }

  async tick() {
    if (this.stopped) return;
    try {
      const data = await this.call('/destination/claim', { ready: !!this.ready() }, 'POST', this.#destinationToken);
      this.state = 'connected';
      if (data.request) await this.dispatch(data.request);
    } catch (error) {
      this.state = error.code === 'session_expired' ? 'expired' : 'disconnected';
      if (this.state === 'expired') { this.stopped = true; return; }
    } finally {
      if (!this.stopped) { this.timer = setTimeout(() => this.tick(), this.intervalMs); this.timer.unref?.(); }
    }
  }

  /** Add a claimed request to Pear Desktop. Never retries a write that may have succeeded. */
  async dispatch(request) {
    const id = request.id, videoId = request.media?.id;
    const report = body => this.call('/destination/report', { id, ...body }, 'POST', this.#destinationToken).catch(() =>
      this.log.warn('[stream] Result delivery failed. BetterYTS will show this request as dispatching; it will not be sent again.'));
    if (!VIDEO.test(videoId || '')) return report({ state: 'failed', code: 'destination_failed', message: 'The request had no playable video.' });
    let writeStarted = false;
    try {
      const before = playerQueue(await this.player.getQueue());
      writeStarted = true;
      await this.player.addToQueue(videoId);
      let added = null;
      for (let attempt = 0; attempt < 5 && !added; attempt++) {
        if (attempt) await delay(this.queueCheckDelayMs * attempt);
        try { added = findQueueAddition(before, playerQueue(await this.player.getQueue()), videoId); } catch { break; }
      }
      // Pear Desktop owns playback from here, so a verified hand-off completes the Stream request.
      if (added) return report({ state: 'completed', code: 'added', message: `Added to Pear Desktop at queue position ${added.position}.` });
      return report({ state: 'failed', code: 'outcome_uncertain', outcomeUncertain: true, message: 'Pear Desktop accepted the command but its queue did not confirm a new entry. Check the end of the player queue.' });
    } catch {
      return report({ state: 'failed', code: writeStarted ? 'outcome_uncertain' : 'destination_failed', outcomeUncertain: writeStarted,
        message: 'Pear Desktop could not take the request. Check the player before retrying.' });
    }
  }

  stop() { this.stopped = true; clearTimeout(this.timer); this.state = 'disconnected'; }
}

/** Reads the opt-in settings; returns null when the local backend (default) is selected. */
export function streamSettings(env = process.env) {
  const backend = (env.STREAM_BACKEND || 'local').trim().toLowerCase();
  if (backend === 'local') return null;
  if (backend !== 'betteryts') throw new InputError('STREAM_BACKEND must be local or betteryts.');
  return { origin: (env.BETTERYTS_STREAM_ORIGIN || STREAM_ORIGIN).trim(), code: (env.BETTERYTS_STREAM_CODE || '').trim().toUpperCase(), token: (env.BETTERYTS_STREAM_TOKEN || '').trim(),
    destinationToken: (env.BETTERYTS_STREAM_DESTINATION_TOKEN || '').trim() || undefined };
}
