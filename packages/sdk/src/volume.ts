import type { VolumeAreaParam } from "./generated/index.js";

/** Where a function finds its session tree's volume; the areas sit directly beneath it. */
// CODESYNC(volume-mount)
export const VOLUME_MOUNT = "/volume";

/** A path in a session tree's volume: the area it sits in, and the path inside that area, segments joined by `/` (empty for the area itself). */
export interface VolumePath {
	area: VolumeAreaParam;
	path: string;
}

const AREAS: ReadonlySet<string> = new Set<VolumeAreaParam>(["tmp", "data"]);

const isArea = (area: string): area is VolumeAreaParam => AREAS.has(area);

/** How a function sees `volumePath`, e.g. `/volume/tmp/notes/a.txt`. */
export function formatVolumePath({ area, path }: VolumePath): string {
	return path === "" ? `${VOLUME_MOUNT}/${area}` : `${VOLUME_MOUNT}/${area}/${path}`;
}

/** Reads a path as a function sees it, such as one an agent names; `undefined` for one in no area of the volume. */
export function parseVolumePath(seen: string): VolumePath | undefined {
	if (!seen.startsWith(`${VOLUME_MOUNT}/`)) return undefined;
	const relative = seen.slice(VOLUME_MOUNT.length + 1);
	const slash = relative.indexOf("/");
	const area = slash === -1 ? relative : relative.slice(0, slash);
	const path = slash === -1 ? "" : relative.slice(slash + 1);
	if (!isArea(area) || (slash !== -1 && path === "")) return undefined;
	return { area, path };
}
