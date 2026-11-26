import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocketServer } from 'ws';
import { parseIrc, startTwitch } from '../src/platforms/twitch.js';
import { loadConfig } from '../src/config.js';
import { fixture, log } from './helpers.js';
async function until(fn) { for (let i = 0; i < 200; i++) { if (fn()) return; await delay(10); } throw new Error('Condition not observed.'); }

test('IRC lines parse with unescaped IRCv3 tags', () => {
  const m = parseIrc('@badges=;display-name=Alice;user-id=42;msg=a\\sb\\:c :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :!sr Björk: Jóga 🦊');
  assert.equal(m.command, 'PRIVMSG'); assert.equal(m.nick, 'alice'); assert.deepEqual(m.params, ['#chan', '!sr Björk: Jóga 🦊']);
  assert.equal(m.tags['user-id'], '42'); assert.equal(m.tags.msg, 'a b;c');
  assert.deepEqual(parseIrc('PING :tmi.twitch.tv'), { tags: {}, nick: '', command: 'PING', params: ['tmi.twitch.tv'] });
});

test('chat commands become requests; PING, replies, reconnect and disconnect work', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => server.close());
  const received = []; let connections = 0; let current;
  server.on('connection', ws => { connections++; current = ws; ws.on('message', d => received.push(d.toString())); });
  const f = fixture();
  const { commands } = loadConfig({ DRY_RUN: 'true' });
  const client = startTwitch({ channel: 'Chan', username: 'Bot', oauth: 'secret', commands, queue: f.queue, skipAllowlist: [], log, url: `ws://127.0.0.1:${server.address().port}` });
  await until(() => received.includes('JOIN #chan'));
  assert.deepEqual(received.slice(0, 4), ['CAP REQ :twitch.tv/tags twitch.tv/commands', 'PASS oauth:secret', 'NICK bot', 'JOIN #chan']);
  current.send(':tmi.twitch.tv 001 bot :Welcome\r\nPING :tmi.twitch.tv\r\n');
  await until(() => received.includes('PONG :tmi.twitch.tv'));
  current.send('@user-id=42 :alice!alice@alice.tmi.twitch.tv PRIVMSG #chan :!sr Test Song\r\n');
  await until(() => f.calls.some(c => c[0] === 'addToQueue') && received.some(l => l.startsWith('PRIVMSG #chan :')));
  assert.equal(f.calls.find(c => c[0] === 'findFirstSong')[1], 'Test Song');
  current.send(':tmi.twitch.tv RECONNECT\r\n');
  await until(() => connections === 2 && received.filter(l => l === 'JOIN #chan').length === 2);
  await client.disconnect();
  await delay(50); assert.equal(connections, 2);
});

test('failed authentication stops instead of reconnecting', async t => {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' }); await once(server, 'listening');
  t.after(() => server.close());
  let connections = 0; const errors = [];
  server.on('connection', ws => { connections++; ws.on('message', d => { if (String(d).startsWith('NICK')) ws.send(':tmi.twitch.tv NOTICE * :Login authentication failed\r\n'); }); });
  const f = fixture();
  startTwitch({ channel: 'chan', username: 'bot', oauth: 'oauth:bad', commands: loadConfig({ DRY_RUN: 'true' }).commands, queue: f.queue, log: { ...log, error: m => errors.push(m) }, url: `ws://127.0.0.1:${server.address().port}` });
  await until(() => errors.length === 1);
  await delay(1300); assert.equal(connections, 1);
});
