// Shared types for the BetterYTS API.

export type ResultType = "video" | "short" | "channel" | "playlist" | "mix";

export interface Channel {
	name: string;
	id: string | null;
	url: string | null;
	handle: string | null;
	verified: boolean;
	avatar: string | null;
}

export interface VideoItem {
	type: "video" | "short";
	id: string;
	url: string;
	title: string;
	thumbnail: string;
	duration: string | null;
	durationSeconds: number | null;
	views: string | null;
	viewCount: number | null;
	published: string | null;
	description: string | null;
	channel: Channel | null;
	badges: string[];
	live: boolean;
	upcoming: boolean;
	isShort: boolean;
	shelf?: string;
	branding?: Branding | null;
}

export interface ChannelItem {
	type: "channel";
	id: string;
	url: string;
	title: string;
	handle: string | null;
	thumbnail: string | null;
	subscribers: string | null;
	description: string | null;
	verified: boolean;
	shelf?: string;
}

export interface PlaylistItem {
	type: "playlist" | "mix";
	id: string;
	url: string;
	title: string;
	thumbnail: string | null;
	videoCount: string | null;
	channel: Channel | null;
	firstVideoId: string | null;
	shelf?: string;
}

export type Item = VideoItem | ChannelItem | PlaylistItem;

export interface ParsedSearch {
	results: Item[];
	next: string | null;
	estimatedResults: number | null;
	correctedQuery: string | null;
	blocked: { ads: number };
}

export interface Segment {
	category: string;
	action: string;
	start: number;
	end: number;
	uuid: string;
	votes: number;
	locked: boolean;
	videoDuration: number | null;
	description?: string;
}

export interface Votes {
	likes: number;
	dislikes: number;
	rating: number | null;
	viewCount: number | null;
	deleted: boolean;
}

export interface Branding {
	title: string | null;
	thumbnail: string | null;
	thumbnailTime: number | null;
}

export interface SearchFilters {
	type?: "all" | "video" | "channel" | "playlist" | "movie";
	sort?: "relevance" | "rating" | "date" | "views";
	duration?: "short" | "medium" | "long";
	upload?: "hour" | "today" | "week" | "month" | "year";
	features?: string[];
}

export interface ClientOptions {
	hl: string;
	gl: string;
	clientVersion: string;
}
