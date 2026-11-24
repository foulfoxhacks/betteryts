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
  assert.deepEqual(streamSettings({ STREAM_BACKEND: 'betteryts', BETTERYTS_STREAM_CODE: 'abcdefgh', BETTERYTS_STREAM_TOKEN: TOKEN }), { origin: 'https://yts.foulfoxhacks.dev', code: 'ABCDEFGH', token: TOKEN });
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
