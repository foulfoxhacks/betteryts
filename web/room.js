// Watch-party room client: one WebSocket to /api/rooms/{code}/ws with reconnects and keep-alive.

export class RoomClient {
	constructor(code, { onState, onMembers, onStatus }) {
		this.code = code;
		this.onState = onState;
		this.onMembers = onMembers;
		this.onStatus = onStatus;
		this.ws = null;
		this.closed = false;
		this.retry = 0;
		this.clockOffset = 0; // serverTime - localTime
		this.name = "Guest";
		this.ping = null;
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
			this.send({ t: "hello", name: this.name });
			clearInterval(this.ping);
			this.ping = setInterval(() => this.send({ t: "ping" }), 25000);
		};
		ws.onmessage = (e) => {
			let msg;
			try {
				msg = JSON.parse(e.data);
			} catch {
				return;
			}
			if (msg.t === "state") {
				if (typeof msg.serverTime === "number") this.clockOffset = msg.serverTime - Date.now();
				this.onState?.(msg.state);
			} else if (msg.t === "members") {
				this.onMembers?.(msg);
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

	setName(name) {
		this.name = String(name || "Guest").slice(0, 32);
		this.send({ t: "hello", name: this.name });
	}

	/** Where the room's playback is now, in seconds, corrected for clock skew. */
	positionOf(state) {
		if (!state) return 0;
		if (!state.playing) return state.position;
		return state.position + Math.max(0, Date.now() + this.clockOffset - state.at) / 1000;
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
