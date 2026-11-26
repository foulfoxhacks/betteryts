// src/platforms/youtube.js
// YouTube Live chat, read-only, through the BetterYTS chat Worker (workers/youtube-chat, built on
// @foulfoxhacks/ametherian-youtube-chat). The Worker finds the stream and polls YouTube; this side
// only carries the continuation between polls. YouTube replies can't be posted, so they're logged.
import { setTimeout as delay } from 'node:timers/promises';
import { dispatchChat } from '../commands.js';

const MAX_BODY = 2 * 1024 * 1024;

export function startYouTube({ channelId, api = 'https://ytchat.foulfoxhacks.dev', commands, queue, skipAllowlist, log, fetchImpl = fetch }) {
  if (!channelId) {
    log.info('[youtube] disabled (YOUTUBE_CHANNEL_ID is empty)');
    return null;
  }
  const stop = new AbortController();

  async function get(path) {
    const res = await fetchImpl(api + path, { signal: AbortSignal.any([stop.signal, AbortSignal.timeout(20000)]), redirect: 'error' });
    const raw = await res.text();
    if (raw.length > MAX_BODY) throw Object.assign(new Error('response too large'), { status: 502 });
    const body = JSON.parse(raw);
    if (!res.ok) throw Object.assign(new Error(body?.error?.message || `HTTP ${res.status}`), { status: res.status });
    return body;
  }

  async function handle(messages) {
    for (const m of messages) {
      if (m.type !== 'text' && m.type !== 'superchat') continue;
      const user = m.author?.name; const userId = m.author?.channelId || '';
      if (!user || !userId) continue; // Never use a non-unique display name for YouTube accounting.
      const reply = (msg) => log.info(`[youtube reply -> ${user}] ${msg}`);
      try { await dispatchChat({ message: String(m.text || '').trim(), commands, queue, skipAllowlist, user, userId, platform: 'youtube', reply }); }
      catch { log.error('[youtube] Command processing failed.'); }
    }
  }

  async function run() {
    let failures = 0;
    while (!stop.signal.aborted) {
      try {
        // Messages already in chat when we join are history, not new commands.
        const live = await get(`/v1/live?target=${encodeURIComponent(channelId)}`);
        log.info(`[youtube] connected to live chat ${live.videoId}`);
        let state = { continuation: live.continuation, clientVersion: live.clientVersion, pollMs: live.pollMs };
        const seen = new Set(live.messages.map((m) => m.id));
        failures = 0;
        while (!stop.signal.aborted) {
          await delay(Math.min(Math.max(state.pollMs || 5000, 1000), 30000), null, { signal: stop.signal });
          const page = await get(`/v1/chat?continuation=${encodeURIComponent(state.continuation)}&clientVersion=${encodeURIComponent(state.clientVersion)}`);
          const fresh = page.messages.filter((m) => !seen.has(m.id));
          for (const m of fresh) seen.add(m.id);
          if (seen.size > 5000) seen.clear();
          await handle(fresh);
          if (page.ended) { log.warn('[youtube] live chat ended'); break; }
          state = { ...state, continuation: page.continuation, pollMs: page.pollMs };
        }
      } catch (error) {
        if (stop.signal.aborted) return;
        failures++;
        if (error.status === 404) log.info('[youtube] Channel is not live yet; checking again shortly.');
        else log.error('[youtube] Connection error. Check channel and connectivity.');
      }
      // Not live, ended or failing: look again later, backing off up to 5 minutes.
      await delay(Math.min(300000, 15000 * 2 ** Math.min(failures, 4)), null, { signal: stop.signal }).catch(() => {});
    }
  }
  run().catch(() => {});

  return { stop() { stop.abort(); } };
}
