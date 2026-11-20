// Watch-party room client: one WebSocket to /api/rooms/{code}/ws with reconnects and keep-alive.

// Host keys for rooms this browser created (code → key). Rooms expire after 24 h idle, so keep only recent ones.
const KEYS = "betteryts.roomkeys.v1";
const KEY_TTL = 7 * 24 * 60 * 60 * 1000;

export const hostKeys = {
	all() {
		try {
			const raw = JSON.parse(localStorage.getItem(KEYS) || "{}");
			return raw && typeof raw === "object" ? raw : {};
		} catch {
			return {};
		}
	},
	get(code) {
		const e = hostKeys.all()[code];
		return e && typeof e.key === "string" ? e.key : null;
	},
	set(code, key) {
		const now = Date.now();
		const keep = Object.fromEntries(Object.entries(hostKeys.all()).filter(([, e]) => e && now - e.at < KEY_TTL));
		keep[code] = { key, at: now };
		try {
			localStorage.setItem(KEYS, JSON.stringify(keep));
		} catch {
			/* storage blocked: you won't be host after a reload */
		}
	},
};

export class RoomClient {
	constructor(code, { onState, onMembers, onStatus, onRole, onDenied }) {
		this.code = code;
		this.onState = onState;
		this.onMembers = onMembers;
		this.onStatus = onStatus;
		this.onRole = onRole;
		this.onDenied = onDenied;
		this.key = hostKeys.get(code); // set if this browser created the room
		this.isHost = false;
		this.hasHost = false;
		this.ws = null;
		this.closed = false;
		this.retry = 0;
		this.clockOffset = 0; // serverTime - localTime
		this.synced = false; // true once a timestamped pong has set clockOffset
		this.samples = []; // recent { rtt, offset } from pongs
		this.rtt = null;
		this.name = "Guest";
		this.ping = null;
	}

	/**
	 * NTP-style clock sync. Each pong carries our send time (c) and the server's time (s);
	 * the server's clock read happens about halfway through the round trip, so
	 * offset ≈ s − (c + rtt/2). The sample with the smallest round trip is the least distorted
	 * by network queuing, so that one wins.
	 */
	onPong(msg) {
		const now = Date.now();
		if (typeof msg.c !== "number" || typeof msg.s !== "number") return;
		const rtt = now - msg.c;
		if (rtt < 0 || rtt > 10_000) return;
		this.samples.push({ rtt, offset: msg.s - (msg.c + rtt / 2) });
		if (this.samples.length > 8) this.samples.shift();
		const best = this.samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
		this.clockOffset = best.offset;
		this.rtt = best.rtt;
		this.synced = true;
	}

	/** A few quick pings right after connecting, so the clock is accurate before the first play. */
	syncBurst() {
		for (let i = 0; i < 5; i++) setTimeout(() => this.send({ t: "ping", c: Date.now() }), i * 120);
	}

	/** The server's clock, now. */
	serverNow() {
		return Date.now() + this.clockOffset;
	}

	/** Ms until a scheduled change (state.at) takes effect; ≤ 0 once it has. */
	msUntil(state) {
		return state ? state.at - this.serverNow() : 0;
	}

	connect() {
		if (this.closed) return;
		const proto = location.protocol === "https:" ? "wss:" : "ws:";
		const ws = new WebSocket(`${proto}//${location.host}/api/rooms/${this.code}/ws`);
		this.ws = ws;
		this.onStatus?.("connecting");
		ws.onopen = () => {
			this.retry = 0;
			this.onStatus?.("connected");
			this.hello();
			this.samples = [];
			this.syncBurst();
			clearInterval(this.ping);
			// Doubles as keep-alive; keeps the clock estimate fresh as network conditions change.
			this.ping = setInterval(() => this.send({ t: "ping", c: Date.now() }), 10000);
		};
		ws.onmessage = (e) => {
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				return;
			}
			if (msg.t === "pong") {
				this.onPong(msg);
			} else if (msg.t === "state") {
				// Rough fallback until the first timestamped pong (an older server sends none).
				if (!this.synced && typeof msg.serverTime === "number") this.clockOffset = msg.serverTime - Date.now();
				this.onState?.(msg.state);
			} else if (msg.t === "members") {
				this.onMembers?.(msg);
			} else if (msg.t === "you") {
				this.isHost = msg.host === true;
				this.hasHost = msg.hasHost === true;
				this.onRole?.(this.isHost);
			} else if (msg.t === "denied") {
				this.onDenied?.(msg.reason);
			}
		};
		ws.onclose = (e) => {
			clearInterval(this.ping);
			if (this.closed) return;
			if (e.code === 1008 || e.reason === "Room is full") {
				this.onStatus?.("full");
				return;
			}
			this.onStatus?.("reconnecting");
			const delay = Math.min(15000, 500 * 2 ** this.retry++);
			setTimeout(() => this.connect(), delay);
		};
		ws.onerror = () => {
			/* onclose follows */
		};
	}

	send(msg) {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	hello() {
		this.send(this.key ? { t: "hello", name: this.name, key: this.key } : { t: "hello", name: this.name });
	}

	setName(name) {
		this.name = String(name || "Guest").slice(0, 32);
		this.hello();
	}

	/** True if this member may change playback or the queue right now. */
	canControl(state) {
		return !state?.locked || this.isHost;
	}

	/** Where the room's playback is now, in seconds, corrected for clock skew. */
	positionOf(state) {
		if (!state) return 0;
		if (!state.playing) return state.position;
		return state.position + Math.max(0, this.serverNow() - state.at) / 1000;
	}

	close() {
		this.closed = true;
		clearInterval(this.ping);
		try {
			this.ws?.close(1000, "leave");
		} catch {
			/* ignore */
		}
	}
}
