import test from 'node:test';
import assert from 'node:assert/strict';
import { BetterYTSStream, streamSettings } from '../src/betteryts-stream.js';
import { log } from './helpers.js';

const CODE = 'ABCDEFGH', TOKEN = 'a'.repeat(64);
function harness(responses) {
  const sent = [];
  const fetcher = async (url, init) => {
    const path = url.replace(`https://yts.foulfoxhacks.dev/api/stream/v1/sessions/${CODE}`, '');
    sent.push({ path, body: init.body ? JSON.parse(init.body) : null, auth: init.headers.Authorization });
    const data = responses[path]?.(sent.at(-1).body) ?? { ok: true };
    return new Response(JSON.stringify(data), { status: data.status || 200, headers: { 'Content-Type': 'application/json' } });
  };
  const added = [];
  const player = { addToQueue: async id => { added.push(id); }, getQueue: async () => ({ items: added.map(videoId => ({ playlistPanelVideoRenderer: { videoId, title: { simpleText: 't' } } })) }) };
  const client = new BetterYTSStream({ code: CODE, token: TOKEN, player, logger: log, fetcher, queueCheckDelayMs: 1 });
  return { client, sent, added, player };
}

test('settings: local stays the default backend; betteryts needs a code and credential', () => {
  assert.equal(streamSettings({}), null);
  assert.deepEqual(streamSettings({ STREAM_BACKEND: 'betteryts', BETTERYTS_STREAM_CODE: 'abcdefgh', BETTERYTS_STREAM_TOKEN: TOKEN }), { origin: 'https://yts.foulfoxhacks.dev', code: 'ABCDEFGH', token: TOKEN, destinationToken: undefined });
  assert.throws(() => streamSettings({ STREAM_BACKEND: 'cloud' }), /local or betteryts/);
  assert.throws(() => new BetterYTSStream({ code: 'nope', token: TOKEN }), /session code/);
  assert.throws(() => new BetterYTSStream({ code: CODE, token: TOKEN, origin: 'http://example.com' }), /HTTPS/);
});

test('intake: chat requests become canonical events and the reply carries the BetterYTS outcome', async () => {
  const h = harness({ '/events': () => ({ ok: true, state: 'queued', message: '@alice added: Song - Artist (3:20).' }) });
  const replies = [];
  const r = await h.client.submit({ user: 'alice', userId: '42', query: 'a song', platform: 'twitch', reply: m => replies.push(m) });
  assert.equal(r.state, 'queued');
  assert.deepEqual(replies, ['@alice added: Song - Artist (3:20).']);
  const event = h.sent[0].body;
  assert.equal(event.schemaVersion, '1');
  assert.deepEqual(event.source, { platform: 'twitch' });
  assert.deepEqual(event.actor, { platformUserId: '42', displayName: 'alice' });
  assert.equal(h.sent[0].auth, `Bearer ${TOKEN}`);
});

test('intake: rejections are relayed, network failures fail closed', async () => {
  const h = harness({ '/events': () => ({ ok: false, state: 'rejected', code: 'cooldown', message: '@bob slow down - try again in 30s.' }) });
  assert.equal((await h.client.submit({ user: 'bob', query: 'x' })).code, 'cooldown');
  const down = new BetterYTSStream({ code: CODE, token: TOKEN, player: {}, logger: log, fetcher: async () => { throw new Error('offline'); } });
  const r = await down.submit({ user: 'bob', query: 'x' });
  assert.equal(r.ok, false); assert.match(r.message, /unreachable/);
});

test('playback: a claimed request is added to Pear Desktop, verified and reported once', async () => {
  const h = harness({});
  await h.client.dispatch({ id: 'r1', media: { id: 'dQw4w9WgXcQ' } });
  assert.deepEqual(h.added, ['dQw4w9WgXcQ']);
  assert.deepEqual(h.sent.map(s => [s.path, s.body.state, s.body.code]), [['/destination/report', 'completed', 'added']]);
});

test('playback: an unconfirmed or failed write is reported as uncertain, never retried', async () => {
  const h = harness({});
  h.player.getQueue = async () => ({ items: [] });
  await h.client.dispatch({ id: 'r2', media: { id: 'dQw4w9WgXcQ' } });
  assert.equal(h.added.length, 1, 'one write only');
  assert.deepEqual([h.sent[0].body.state, h.sent[0].body.outcomeUncertain], ['failed', true]);
  const bad = harness({});
  await bad.client.dispatch({ id: 'r3', media: { id: 'not a video' } });
  assert.equal(bad.added.length, 0);
  assert.equal(bad.sent[0].body.code, 'destination_failed');
});

// ---- engine wiring: STREAM_BACKEND=betteryts ----------------------------------------------------
import { loadConfig } from '../src/config.js';
import { PearConnectEngine } from '../src/engine.js';
import { fixture } from './helpers.js';

const STREAM_ENV = { STREAM_BACKEND: 'betteryts', BETTERYTS_STREAM_CODE: CODE, BETTERYTS_STREAM_TOKEN: TOKEN, BETTERYTS_STREAM_DESTINATION_TOKEN: 'b'.repeat(64) };
async function streamEngine(t, env = {}) {
  const f = fixture();
  const submitted = []; let started = null, stopped = false;
  class FakeStream { constructor(o) { this.options = o; this.state = 'connected'; }
    start(ready) { started = ready; } stop() { stopped = true; }
    async submit(r) { submitted.push(r); return r.query === 'nope' ? { ok: false, state: 'rejected', code: 'blocked', message: 'blocked' } : { ok: true, state: 'queued', message: '@x added' }; } }
  const e = new PearConnectEngine(loadConfig({ YTMD_TOKEN: 'private-token', TIKFINITY_PORT: '0', REQUESTS_ENABLED: 'true', ...STREAM_ENV, ...env }, { allowUnconfigured: true }), {
    player: f.ytmd, logger: log, lock: async () => async () => {}, connectPlatforms: false, startSocket: () => ({ stop() {} }), StreamClient: FakeStream });
  await e.start(); t.after(() => e.stop());
  return { ...f, e, submitted, started: () => started, stopped: () => stopped };
}

test('engine: Stream backend takes !sr, keeps !np/!skip local, never searches Pear Desktop itself', async t => {
  const s = await streamEngine(t);
  assert.equal(s.e.status().backend.name, 'betteryts');
  const r = await s.e.execute('request', { user: 'alice', userId: '1', query: 'a song', platform: 'twitch' }, 'advanced');
  assert.deepEqual([r.ok, r.code], [true, 'stream_queued']);
  assert.deepEqual(s.submitted.map(x => [x.platform, x.user, x.query]), [['twitch', 'alice', 'a song']]);
  assert.equal(s.calls.some(c => c[0] === 'findFirstSong' || c[0] === 'addToQueue'), false, 'only the destination loop writes to Pear');
  assert.equal((await s.e.execute('request', { user: 'bob', query: 'nope' }, 'advanced')).code, 'blocked');
  assert.equal((await s.e.execute('nowPlaying', { user: 'alice' }, 'advanced')).code, 'read');
  assert.equal(typeof s.started(), 'function', 'destination loop started');
  assert.throws(() => s.e.setWebFallback(true), /stream page/);
});

test('engine: pause and dry run never reach BetterYTS; credentials stay out of status', async t => {
  const s = await streamEngine(t);
  s.e.pauseRequests();
  assert.equal((await s.e.execute('request', { user: 'a', query: 'x' }, 'advanced')).code, 'requests_paused');
  assert.equal(s.submitted.length, 0);
  assert.equal(JSON.stringify(s.e.status()).includes(TOKEN), false);
  await s.e.stop(); assert.equal(s.stopped(), true);
  const dry = await streamEngine(t, { DRY_RUN: 'true' });
  assert.equal(dry.e.stream, null, 'dry run keeps the local no-op path');
});

test('connector: separate destination credential is used only for playback calls', async () => {
  const h = harness({});
  const c = new BetterYTSStream({ code: CODE, token: TOKEN, destinationToken: 'b'.repeat(64), player: h.player, logger: log, fetcher: async (url, init) => { h.sent.push({ path: url.split(CODE)[1], auth: init.headers.Authorization }); return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } }); }, queueCheckDelayMs: 1 });
  await c.submit({ user: 'a', query: 'x' });
  await c.dispatch({ id: 'r', media: { id: 'dQw4w9WgXcQ' } });
  assert.deepEqual(h.sent.map(s => [s.path, s.auth.slice(-1)]), [['/events', 'a'], ['/destination/report', 'b']]);
});
