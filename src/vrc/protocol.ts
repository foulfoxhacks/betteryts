// Shared constants and types for the in-world protocol (docs/vrchat-protocol.md).
// Kept free of runtime imports so it can be used from Node tests.

export const PROTOCOL_VERSION = 1;
export const POOL_SIZE = 20000;

export type SlotKind = "video" | "sheet" | "page";

export interface SlotEntry {
	kind: SlotKind;
	/** Dedupe key: the same key always gets the same slot while it's still in the ring. */
	key: string;
	/** Kind-specific data: video ID, JSON list of IDs, or a JSON page cursor. */
	payload: string;
}
