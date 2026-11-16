// Chapters from a video's description ("0:00 Intro") or SponsorBlock community chapters.

const TS = String.raw`((?:\d{1,2}:)?\d{1,2}:\d{2})`;
const LEADING = new RegExp(String.raw`^\s*[\[(]?${TS}[\])]?\s*[-–—:|.)]*\s*(.+?)\s*$`);
const TRAILING = new RegExp(String.raw`^\s*(.+?)\s*[-–—:|(\[]*\s*${TS}[\])]?\s*$`);

export function toSeconds(ts) {
	return ts.split(":").reduce((acc, p) => acc * 60 + Number(p), 0);
}

/** Description chapters: needs at least two timestamps, in increasing order. */
export function chaptersFromDescription(description) {
	if (!description) return [];
	const out = [];
	for (const line of description.split(/\r?\n/)) {
		let m = LEADING.exec(line);
		let start;
		let title;
		if (m) {
			start = toSeconds(m[1]);
			title = m[2];
		} else if ((m = TRAILING.exec(line))) {
			start = toSeconds(m[2]);
			title = m[1];
		} else continue;
		title = title.replace(/^[-–—:|.\s]+|[-–—:|\s]+$/g, "").trim();
		if (!title || title.length > 140) continue;
		if (out.length && start <= out[out.length - 1].start) continue;
		out.push({ start, title });
	}
	return out.length >= 2 ? out : [];
}

export function chaptersFromSegments(segments) {
	return (segments || [])
		.filter((s) => s.action === "chapter" && s.description)
		.map((s) => ({ start: s.start, end: s.end, title: s.description }))
		.sort((a, b) => a.start - b.start);
}

export function bestChapters(description, segments) {
	const fromDesc = chaptersFromDescription(description);
	if (fromDesc.length) return { source: "description", chapters: fromDesc };
	const fromSb = chaptersFromSegments(segments);
	return { source: fromSb.length ? "sponsorblock" : null, chapters: fromSb };
}
