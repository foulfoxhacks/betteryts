// A small QR code encoder (byte mode, error correction level M, versions 1-40), so pairing
// codes can be drawn without a third-party script. Follows ISO/IEC 18004; structure after
// Project Nayuki's reference implementation. qrSvg() returns an <svg> element.

const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28];
const NUM_BLOCKS = [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49];
const ECL_M_BITS = 0; // format-info bits for level M

function rawModules(ver) {
	let n = (16 * ver + 128) * ver + 64;
	if (ver >= 2) {
		const align = Math.floor(ver / 7) + 2;
		n -= (25 * align - 10) * align - 55;
		if (ver >= 7) n -= 36;
	}
	return n;
}

const dataCodewords = (ver) => Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

// ---- Reed-Solomon over GF(2^8), polynomial 0x11D ----
function gfMul(x, y) {
	let z = 0;
	for (let i = 7; i >= 0; i--) {
		z = (z << 1) ^ ((z >>> 7) * 0x11d);
		z ^= ((y >>> i) & 1) * x;
	}
	return z;
}

function rsDivisor(degree) {
	const result = new Array(degree).fill(0);
	result[degree - 1] = 1;
	let root = 1;
	for (let i = 0; i < degree; i++) {
		for (let j = 0; j < result.length; j++) {
			result[j] = gfMul(result[j], root);
			if (j + 1 < result.length) result[j] ^= result[j + 1];
		}
		root = gfMul(root, 0x02);
	}
	return result;
}

function rsRemainder(data, divisor) {
	const result = divisor.map(() => 0);
	for (const b of data) {
		const factor = b ^ result.shift();
		result.push(0);
		divisor.forEach((coef, i) => (result[i] ^= gfMul(coef, factor)));
	}
	return result;
}

const bit = (x, i) => ((x >>> i) & 1) !== 0;

/** Encodes text as a QR code: { size, dark(x, y) }. Throws if it's too long (about 2.3 KB). */
export function qrEncode(text) {
	const bytes = new TextEncoder().encode(text);
	let ver = 1;
	for (; ver <= 40; ver++) {
		const countBits = ver <= 9 ? 8 : 16;
		if (4 + countBits + bytes.length * 8 <= dataCodewords(ver) * 8) break;
	}
	if (ver > 40) throw new Error("Too long for a QR code");

	// Data bits: byte mode, length, bytes, terminator, padding.
	const bits = [];
	const push = (val, len) => {
		for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1);
	};
	push(0b0100, 4);
	push(bytes.length, ver <= 9 ? 8 : 16);
	for (const b of bytes) push(b, 8);
	const capacity = dataCodewords(ver) * 8;
	push(0, Math.min(4, capacity - bits.length));
	push(0, (8 - (bits.length % 8)) % 8);
	for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
	const data = [];
	for (let i = 0; i < bits.length; i += 8) data.push(bits.slice(i, i + 8).reduce((a, b) => (a << 1) | b, 0));

	// Error correction, split into blocks and interleaved.
	const numBlocks = NUM_BLOCKS[ver];
	const eccLen = ECC_PER_BLOCK[ver];
	const raw = Math.floor(rawModules(ver) / 8);
	const numShort = numBlocks - (raw % numBlocks);
	const shortLen = Math.floor(raw / numBlocks);
	const divisor = rsDivisor(eccLen);
	const blocks = [];
	for (let i = 0, k = 0; i < numBlocks; i++) {
		const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
		k += dat.length;
		const ecc = rsRemainder(dat, divisor);
		if (i < numShort) dat.push(0);
		blocks.push(dat.concat(ecc));
	}
	const codewords = [];
	for (let i = 0; i < blocks[0].length; i++) {
		blocks.forEach((block, j) => {
			if (i !== shortLen - eccLen || j >= numShort) codewords.push(block[i]);
		});
	}

	// Matrix.
	const size = ver * 4 + 17;
	const mod = Array.from({ length: size }, () => new Array(size).fill(false));
	const fn = Array.from({ length: size }, () => new Array(size).fill(false));
	const set = (x, y, dark) => {
		mod[y][x] = dark;
		fn[y][x] = true;
	};

	for (let i = 0; i < size; i++) {
		set(6, i, i % 2 === 0);
		set(i, 6, i % 2 === 0);
	}
	const finder = (cx, cy) => {
		for (let dy = -4; dy <= 4; dy++) {
			for (let dx = -4; dx <= 4; dx++) {
				const x = cx + dx;
				const y = cy + dy;
				if (x < 0 || x >= size || y < 0 || y >= size) continue;
				const d = Math.max(Math.abs(dx), Math.abs(dy));
				set(x, y, d !== 2 && d !== 4);
			}
		}
	};
	finder(3, 3);
	finder(size - 4, 3);
	finder(3, size - 4);

	const align = [];
	if (ver > 1) {
		const n = Math.floor(ver / 7) + 2;
		const step = Math.floor((ver * 8 + n * 3 + 5) / (n * 4 - 4)) * 2;
		align.push(6);
		for (let pos = size - 7; align.length < n; pos -= step) align.splice(1, 0, pos);
	}
	const last = align.length - 1;
	for (let i = 0; i < align.length; i++) {
		for (let j = 0; j < align.length; j++) {
			if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
			for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) set(align[i] + dx, align[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
		}
	}

	const drawFormat = (mask) => {
		const d = (ECL_M_BITS << 3) | mask;
		let rem = d;
		for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
		const b = ((d << 10) | rem) ^ 0x5412;
		for (let i = 0; i <= 5; i++) set(8, i, bit(b, i));
		set(8, 7, bit(b, 6));
		set(8, 8, bit(b, 7));
		set(7, 8, bit(b, 8));
		for (let i = 9; i < 15; i++) set(14 - i, 8, bit(b, i));
		for (let i = 0; i < 8; i++) set(size - 1 - i, 8, bit(b, i));
		for (let i = 8; i < 15; i++) set(8, size - 15 + i, bit(b, i));
		set(8, size - 8, true); // the dark module
	};
	drawFormat(0); // reserve the area; redrawn with the chosen mask

	if (ver >= 7) {
		let rem = ver;
		for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
		const b = (ver << 12) | rem;
		for (let i = 0; i < 18; i++) {
			const a = size - 11 + (i % 3);
			const c = Math.floor(i / 3);
			set(a, c, bit(b, i));
			set(c, a, bit(b, i));
		}
	}

	// Codewords in the zigzag.
	let i = 0;
	for (let right = size - 1; right >= 1; right -= 2) {
		if (right === 6) right = 5;
		for (let vert = 0; vert < size; vert++) {
			for (let j = 0; j < 2; j++) {
				const x = right - j;
				const upward = ((right + 1) & 2) === 0;
				const y = upward ? size - 1 - vert : vert;
				if (!fn[y][x] && i < codewords.length * 8) {
					mod[y][x] = bit(codewords[i >>> 3], 7 - (i & 7));
					i++;
				}
			}
		}
	}

	const MASKS = [
		(x, y) => (x + y) % 2 === 0,
		(x, y) => y % 2 === 0,
		(x) => x % 3 === 0,
		(x, y) => (x + y) % 3 === 0,
		(x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
		(x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
		(x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
		(x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
	];
	const applyMask = (m) => {
		for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && MASKS[m](x, y)) mod[y][x] = !mod[y][x];
	};

	// Pick the mask with the lowest penalty (runs, 2x2 blocks, finder look-alikes, balance).
	const penalty = () => {
		let p = 0;
		let dark = 0;
		const line = (get) => {
			let run = 1;
			let s = 0;
			for (let k = 1; k <= size; k++) {
				if (k < size && get(k) === get(k - 1)) run++;
				else {
					if (run >= 5) s += 3 + run - 5;
					run = 1;
				}
			}
			const pat = [true, false, true, true, true, false, true];
			for (let k = 0; k + 7 <= size; k++) {
				if (!pat.every((v, n) => get(k + n) === v)) continue;
				const before = k >= 4 && [1, 2, 3, 4].every((n) => !get(k - n));
				const after = k + 11 <= size && [7, 8, 9, 10].every((n) => !get(k + n));
				if (before || after) s += 40;
			}
			return s;
		};
		for (let y = 0; y < size; y++) p += line((x) => mod[y][x]);
		for (let x = 0; x < size; x++) p += line((y) => mod[y][x]);
		for (let y = 0; y < size - 1; y++) {
			for (let x = 0; x < size - 1; x++) {
				const c = mod[y][x];
				if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) p += 3;
			}
		}
		for (const row of mod) for (const c of row) if (c) dark++;
		const total = size * size;
		p += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
		return p;
	};
	let best = 0;
	let bestScore = Infinity;
	for (let m = 0; m < 8; m++) {
		applyMask(m);
		drawFormat(m);
		const score = penalty();
		if (score < bestScore) {
			best = m;
			bestScore = score;
		}
		applyMask(m); // undo (XOR)
	}
	applyMask(best);
	drawFormat(best);

	return { size, version: ver, mask: best, dark: (x, y) => mod[y][x] };
}

/** An <svg> of the code with a 4-module quiet zone, dark modules in currentColor on white. */
export function qrSvg(text, { label = "QR code" } = {}) {
	const q = qrEncode(text);
	const n = q.size + 8;
	let d = "";
	for (let y = 0; y < q.size; y++) for (let x = 0; x < q.size; x++) if (q.dark(x, y)) d += `M${x + 4} ${y + 4}h1v1h-1z`;
	const ns = "http://www.w3.org/2000/svg";
	const svg = document.createElementNS(ns, "svg");
	svg.setAttribute("viewBox", `0 0 ${n} ${n}`);
	svg.setAttribute("role", "img");
	svg.setAttribute("aria-label", label);
	svg.setAttribute("shape-rendering", "crispEdges");
	svg.setAttribute("class", "qr");
	const bg = document.createElementNS(ns, "rect");
	bg.setAttribute("width", String(n));
	bg.setAttribute("height", String(n));
	bg.setAttribute("fill", "#fff");
	const path = document.createElementNS(ns, "path");
	path.setAttribute("d", d);
	path.setAttribute("fill", "#000");
	svg.append(bg, path);
	return svg;
}
