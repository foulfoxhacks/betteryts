// OpenAPI 3.1 description of the BetterYTS API, served at /api/openapi.json so integrations can
// generate clients. Kept next to the routes it describes: add an entry here with every new endpoint
// (test/openapi.test.ts checks that /api lists nothing this file is missing).

type Param = { name: string; in: "query" | "path"; required?: boolean; description: string; schema: Record<string, unknown> };

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: "string", description, ...extra });
const q = (name: string, description: string, schema: Record<string, unknown> = { type: "string" }, required = false): Param => ({ name, in: "query", required, description, schema });
const p = (name: string, description: string, pattern?: string): Param => ({ name, in: "path", required: true, description, schema: pattern ? { type: "string", pattern } : { type: "string" } });

const VIDEO_ID = "^[A-Za-z0-9_-]{11}$";
const ROOM = "^[A-HJ-NP-Z2-9]{6}$";
const options = [
	q("type", "Result type", { type: "string", enum: ["all", "video", "channel", "playlist", "movie"] }),
	q("sort", "Sort order", { type: "string", enum: ["relevance", "rating", "date", "views"] }),
	q("duration", "Under 4 min, 4–20 min, over 20 min", { type: "string", enum: ["short", "medium", "long"] }),
	q("upload", "Upload date", { type: "string", enum: ["hour", "today", "week", "month", "year"] }),
	q("features", "Comma-separated: 4k, hd, hdr, cc, subtitles, live, 360, vr180, 3d, location, purchased"),
	q("hl", "Interface language, e.g. en"),
	q("gl", "Region, e.g. US"),
];
const json = (description: string, schema: Record<string, unknown> = { type: "object" }) => ({ description, content: { "application/json": { schema } } });
const redirect = (description: string) => ({ description, headers: { Location: { schema: { type: "string" } } } });
const err = { $ref: "#/components/responses/Error" };

function op(summary: string, parameters: Param[], responses: Record<string, unknown>, tag: string, description?: string) {
	return { get: { summary, ...(description ? { description } : {}), tags: [tag], parameters, responses: { ...responses, "4XX": err, "5XX": err } } };
}

export function openapi(origin: string, version: string) {
	return {
		openapi: "3.1.0",
		info: {
			title: "BetterYTS API",
			version,
			description:
				"Ad-free YouTube search and video data as JSON, VRChat-ready redirects, ProTV playlists and watch-party rooms. Free to use within the fair-use notes in the docs. Search queries accept operators like channel:@name, -word, -shorts, duration:long, after:2026-01-01.",
			contact: { name: "FoulFoxHacks", url: "https://github.com/foulfoxhacks/betteryts/issues" },
			license: { name: "See repository", url: "https://github.com/foulfoxhacks/betteryts" },
		},
		externalDocs: { description: "Docs", url: `${origin}/docs` },
		servers: [{ url: origin }],
		tags: [
			{ name: "Search" },
			{ name: "Videos" },
			{ name: "Browse" },
			{ name: "Add-ons", description: "SponsorBlock, Return YouTube Dislike, DeArrow, lyrics" },
			{ name: "Import", description: "Spotify playlists to YouTube" },
			{ name: "VRChat", description: "Redirects and files for in-world video players" },
			{ name: "Rooms", description: "Watch parties" },
			{ name: "Meta" },
		],
		paths: {
			"/api/search": op("Search YouTube (no ads, optional Shorts/shelf filtering)", [q("q", "Search query (operators allowed)", { type: "string", maxLength: 200 }, true), ...options, q("shorts", "Include Shorts", { type: "boolean", default: true }), q("shelves", "Include shelf rows", { type: "boolean", default: false }), q("dearrow", "Add DeArrow branding to the first 25 videos", { type: "boolean", default: false }), q("page", "Continuation token from `next`")], { 200: json("Results", { $ref: "#/components/schemas/SearchResponse" }) }, "Search"),
			"/api/suggest": op("Search autocomplete", [q("q", "Partial query", { type: "string" }, true)], { 200: json("Suggestions") }, "Search"),
			"/api/video/{id}": op("Video details with SponsorBlock, Return YouTube Dislike and DeArrow", [p("id", "Video ID", VIDEO_ID)], { 200: json("Video") }, "Videos"),
			"/api/transcript/{id}": op("Captions as timed lines", [p("id", "Video ID", VIDEO_ID), q("lang", 'Language code; "xx:asr" for the auto-generated track')], { 200: json("Transcript", { $ref: "#/components/schemas/Transcript" }) }, "Videos"),
			"/api/playlist/{id}": op("A playlist's videos", [p("id", "Playlist ID"), q("page", "Continuation token")], { 200: json("Playlist page") }, "Browse"),
			"/api/channel/{ref}": op("A channel's details and videos", [p("ref", "Channel ID (UC…) or @handle"), q("tab", "Tab", { type: "string", enum: ["videos", "live", "shorts", "playlists"] }), q("page", "Continuation token")], { 200: json("Channel page") }, "Browse"),
			"/api/segments/{id}": op("SponsorBlock segments", [p("id", "Video ID", VIDEO_ID), q("categories", "Comma-separated SponsorBlock categories")], { 200: json("Segments", { type: "array" }) }, "Add-ons"),
			"/api/dislikes/{id}": op("Return YouTube Dislike votes", [p("id", "Video ID", VIDEO_ID)], { 200: json("Votes") }, "Add-ons"),
			"/api/branding/{id}": op("DeArrow title and thumbnail", [p("id", "Video ID", VIDEO_ID)], { 200: json("Branding") }, "Add-ons", "Batch form: /api/branding?ids=a,b,c"),
			"/api/lyrics": op("Synced lyrics from LRCLIB", [q("title", "Video title"), q("channel", "Uploader"), q("track", "Song title"), q("artist", "Artist"), q("duration", "Seconds", { type: "integer" })], { 200: json("Lyrics") }, "Add-ons"),
			"/api/spotify": op("A public Spotify playlist or album's tracks (up to 100)", [q("url", "open.spotify.com link, spotify: URI or ID", { type: "string" }, true)], { 200: json("Collection") }, "Import", "Also /api/spotify/{playlist|album}/{id}."),
			"/api/match": op("The YouTube video that best matches a song", [q("track", "Song title", { type: "string" }, true), q("artist", "Artist"), q("duration", "Seconds", { type: "integer" })], { 200: json("Match with confidence high|low|none") }, "Import"),
			"/api/rooms/new": op("Create a watch-party room", [], { 200: json("{ code, hostKey }: keep the hostKey to be the host") }, "Rooms"),
			"/api/rooms/{code}": op("Room state", [p("code", "Room code", ROOM)], { 200: json("State, position, queue, member count") }, "Rooms", "Join with a WebSocket at /api/rooms/{code}/ws (messages documented in /docs#rooms)."),
			"/api/ecosystem": op("Every BetterYTS project and its version", [], { 200: json("Projects") }, "Meta"),
			"/api/health": op("Service health and build", [], { 200: json("{ ok, version, build }") }, "Meta"),
			"/api/openapi.json": op("This document", [], { 200: json("OpenAPI 3.1") }, "Meta"),
			"/search": op("VRChat / media players: redirect to the top video (browsers get the results page)", [q("q", "Search query (operators allowed)", { type: "string" }, true), ...options], { 302: redirect("To the video") }, "VRChat"),
			"/lucky": op("Always redirect to a matching video", [q("q", "Search query (operators allowed)", { type: "string" }, true), q("n", "Pick the nth result", { type: "integer", minimum: 1, maximum: 20 }), q("shorts", "Allow Shorts", { type: "boolean" }), q("live", "Allow live", { type: "boolean" }), q("minlen", "Minimum seconds", { type: "integer" }), q("maxlen", "Maximum seconds", { type: "integer" }), q("to", "Target", { type: "string", enum: ["watch", "youtu.be", "embed", "music", "page"] }), ...options], { 302: redirect("To the video"), 404: { description: "No results" } }, "VRChat"),
			"/v/{id}": op("Redirect to a video by ID", [p("id", "Video ID", VIDEO_ID), q("to", "Target", { type: "string", enum: ["watch", "youtu.be", "embed", "music"] })], { 302: redirect("To the video") }, "VRChat"),
			"/room/{code}": op("Redirect to what a room is playing now, at the current time", [p("code", "Room code", ROOM)], { 302: redirect("To the video") }, "VRChat"),
			"/vrc/protv.playlist": op("ProTV playlist file", [q("q", "Search query"), q("list", "Playlist ID"), q("n", "Entries (1–500)", { type: "integer" })], { 200: { description: "ProTV playlist", content: { "text/plain": { schema: { type: "string" } } } } }, "VRChat"),
			"/vrc/search": op("In-world search for VRChat worlds", [q("q", "Search query", { type: "string" }, true)], { 200: { description: "See docs/vrchat-protocol.md" } }, "VRChat"),
		},
		components: {
			responses: { Error: json("Error", { type: "object", properties: { error: { type: "object", properties: { message: str("What went wrong"), status: { type: "integer" } } } } }) },
			schemas: {
				Video: {
					type: "object",
					properties: {
						type: { enum: ["video", "short"] },
						id: str("Video ID"),
						title: str("Title"),
						url: str("Watch URL"),
						thumbnail: str("Thumbnail URL"),
						duration: { type: ["string", "null"] },
						durationSeconds: { type: ["integer", "null"] },
						views: { type: ["string", "null"] },
						published: { type: ["string", "null"], description: 'Relative, e.g. "3 weeks ago"' },
						channel: { type: ["object", "null"], properties: { name: { type: "string" }, id: { type: ["string", "null"] }, handle: { type: ["string", "null"] } } },
						live: { type: "boolean" },
						isShort: { type: "boolean" },
					},
				},
				SearchResponse: {
					type: "object",
					properties: {
						query: str("The query as sent"),
						count: { type: "integer" },
						results: { type: "array", items: { oneOf: [{ $ref: "#/components/schemas/Video" }, { type: "object", description: "Channel or playlist" }] } },
						next: { type: ["string", "null"], description: "Pass as ?page= for more" },
						blocked: { type: "object", description: "How many ads, Shorts, shelf items and operator mismatches were removed" },
						operators: { type: ["object", "null"], description: "Parsed search operators, if any" },
					},
				},
				Transcript: {
					type: "object",
					properties: {
						id: str("Video ID"),
						language: { type: ["object", "null"], properties: { code: { type: "string" }, name: { type: "string" }, auto: { type: "boolean" } } },
						languages: { type: "array", items: { type: "object" } },
						lines: { type: "array", items: { type: "object", properties: { start: { type: "number" }, dur: { type: "number" }, text: { type: "string" } } } },
					},
				},
			},
		},
	};
}
