import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { startYouTube } from '../src/platforms/youtube.js';
import { loadConfig } from '../src/config.js';
import { fixture, log } from './helpers.js';
async function until(fn) { for (let i = 0; i < 300; i++) { if (fn()) return; await delay(10); } throw new Error('Condition not observed.'); }
const msg = (id, text, extra = {}) => ({ id, type: 'text', text, author: { name: 'alice', channelId: 'UCaliceaaaaaaaaaaaaaaaaa' }, ...extra });

test('chat Worker: history is skipped, new commands become requests, nameless authors are ignored', async () => {
  const f = fixture(); const urls = []; let polls = 0;
  const fetchImpl = async (url) => {
    urls.push(url);
    if (url.includes('/v1/live')) return Response.json({ videoId: 'vid12345678', continuation: 'c0', clientVersion: '2.20261125.00.00', pollMs: 1, messages: [msg('old', '!sr Old Song')] });
    polls++;
    const messages = polls === 1 ? [msg('old', '!sr Old Song'), msg('new', '!sr Test Song'), { ...msg('anon', '!sr Nope'), author: { name: 'x', channelId: '' } }] : [];
    return Response.json({ messages, deleted: [], continuation: `c${polls}`, pollMs: 1, ended: polls >= 3 });
  };
  const { commands } = loadConfig({ DRY_RUN: 'true' });
  const yt = startYouTube({ channelId: 'UCchannelcccccccccccccccc', api: 'https://chat.test', commands, queue: f.queue, skipAllowlist: [], log, fetchImpl });
  await until(() => polls >= 3);
  yt.stop();
  assert.deepEqual(f.calls.filter((c) => c[0] === 'findFirstSong').map((c) => c[1]), ['Test Song']);
  assert.equal(urls[0], 'https://chat.test/v1/live?target=UCchannelcccccccccccccccc');
  assert.match(urls[1], /^https:\/\/chat\.test\/v1\/chat\?continuation=c0&clientVersion=2\.20261125\.00\.00$/);
});

test('not live: retries quietly and stop() ends the loop', async () => {
  let calls = 0; const info = [];
  const fetchImpl = async () => { calls++; return Response.json({ error: { status: 404, message: 'not live' } }, { status: 404 }); };
  const yt = startYouTube({ channelId: '@someone', commands: loadConfig({ DRY_RUN: 'true' }).commands, queue: fixture().queue, log: { ...log, info: (m) => info.push(m) }, fetchImpl });
  await until(() => calls === 1 && info.some((m) => /not live/.test(m)));
  yt.stop(); await delay(30); assert.equal(calls, 1);
});

test('YOUTUBE_CHAT_API must be https (or local http) without credentials', () => {
  assert.equal(loadConfig({ DRY_RUN: 'true' }).youtubeChatApi, 'https://ytchat.foulfoxhacks.dev');
  assert.equal(loadConfig({ DRY_RUN: 'true', YOUTUBE_CHAT_API: 'http://127.0.0.1:8787/' }).youtubeChatApi, 'http://127.0.0.1:8787');
  for (const bad of ['http://example.com', 'https://u:p@example.com', 'https://example.com/?x=1', 'nope']) assert.throws(() => loadConfig({ DRY_RUN: 'true', YOUTUBE_CHAT_API: bad }));
});
