// src/platforms/twitch.js — Twitch chat over IRC-on-WebSocket (replaces tmi.js; uses the existing ws package).
import WebSocket from 'ws';
import { dispatchChat } from '../commands.js';

export const TWITCH_IRC = 'wss://irc-ws.chat.twitch.tv:443';
const MAX_LINE = 16 * 1024;

/** Parses one IRC line: { tags, nick, command, params }. Tags are unescaped (IRCv3). */
export function parseIrc(line) {
  let rest = line; const tags = {};
  if (rest.startsWith('@')) {
    const end = rest.indexOf(' ');
    for (const pair of rest.slice(1, end).split(';')) {
      const eq = pair.indexOf('='); const key = eq < 0 ? pair : pair.slice(0, eq);
      tags[key] = eq < 0 ? '' : pair.slice(eq + 1).replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', r: '\r', n: '\n' })[c] ?? c);
    }
    rest = rest.slice(end + 1);
  }
  let nick = '';
  if (rest.startsWith(':')) {
    const end = rest.indexOf(' ');
    nick = rest.slice(1, end).split('!')[0];
    rest = rest.slice(end + 1);
  }
  const colon = rest.indexOf(' :');
  const params = (colon < 0 ? rest : rest.slice(0, colon)).split(' ').filter(Boolean);
  const command = params.shift() || '';
  if (colon >= 0) params.push(rest.slice(colon + 2));
  return { tags, nick, command, params };
}

export function startTwitch({ channel, username, oauth, commands, queue, skipAllowlist, log, url = TWITCH_IRC, WebSocketImpl = WebSocket }) {
  if (!channel) {
    log.info('[twitch] disabled (TWITCH_CHANNEL is empty)');
    return null;
  }
  if (!username || !oauth) {
    log.warn('[twitch] TWITCH_USERNAME or TWITCH_OAUTH missing - skipping');
    return null;
  }
  const room = '#' + channel.replace(/^#/, '').toLowerCase();
  const login = username.toLowerCase();
  const pass = oauth.startsWith('oauth:') ? oauth : `oauth:${oauth}`;
  let socket = null; let stopped = false; let attempt = 0; let timer = null;

  const send = (line) => { if (socket?.readyState === WebSocketImpl.OPEN) socket.send(line.replace(/[\r\n]+/g, ' ')); };
  const say = async (msg) => {
    if (socket?.readyState !== WebSocketImpl.OPEN) throw new Error('not connected');
    send(`PRIVMSG ${room} :${msg}`);
  };

  const onLine = async (line) => {
    const { tags, nick, command, params } = parseIrc(line);
    if (command === 'PING') return send(`PONG :${params[0] ?? 'tmi.twitch.tv'}`);
    if (command === '001') { attempt = 0; return log.info(`[twitch] connected as ${login} -> ${room}`); }
    if (command === 'RECONNECT') return socket?.close();
    if (command === 'NOTICE' && /authentication failed|improperly formatted auth/i.test(params[1] ?? '')) {
      stopped = true; log.error('[twitch] Connection failed. Check credentials and connectivity.'); return socket?.close();
    }
    if (command !== 'PRIVMSG' || params[0]?.toLowerCase() !== room || !nick) return;
    const reply = (msg) => say(msg).catch(() => log.error('[twitch.say] Reply delivery failed.'));
    try { await dispatchChat({ message: params[1] ?? '', commands, queue, skipAllowlist, user: nick.toLowerCase(), userId: tags['user-id'] || '', platform: 'twitch', reply }); }
    catch { log.error('[twitch] Command processing failed.'); }
  };

  const connect = () => {
    if (stopped) return;
    const ws = new WebSocketImpl(url, { maxPayload: 1024 * 1024 });
    socket = ws;
    ws.on('open', () => {
      for (const line of ['CAP REQ :twitch.tv/tags twitch.tv/commands', `PASS ${pass}`, `NICK ${login}`, `JOIN ${room}`]) ws.send(line);
    });
    ws.on('message', (data) => {
      for (const line of data.toString('utf8').split('\r\n')) if (line && line.length <= MAX_LINE) onLine(line);
    });
    ws.on('error', () => {});
    ws.on('close', () => {
      if (socket !== ws) return;
      socket = null;
      if (stopped) return;
      log.warn('[twitch] disconnected.');
      const delay = Math.min(60000, 1000 * 2 ** Math.min(attempt++, 6));
      timer = setTimeout(connect, delay); timer.unref?.();
    });
  };
  connect();

  return {
    say: (_chan, msg) => say(msg),
    async disconnect() {
      stopped = true; clearTimeout(timer);
      const ws = socket; socket = null;
      if (ws && ws.readyState !== WebSocketImpl.CLOSED) await new Promise((resolve) => { ws.once('close', resolve); ws.close(); setTimeout(resolve, 2000).unref?.(); });
    },
  };
}
