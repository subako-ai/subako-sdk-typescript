import { describe, expect, it } from "vitest";

import { formatVolumePath, parseVolumePath, VOLUME_MOUNT } from "../src/index.js";

describe("a volume path", () => {
	it("is spelled as a function sees it, under the mount", () => {
		expect(VOLUME_MOUNT).toBe("/volume");
		expect(formatVolumePath({ area: "tmp", path: "notes/a.txt" })).toBe("/volume/tmp/notes/a.txt");
		expect(formatVolumePath({ area: "data", path: "" })).toBe("/volume/data");
	});

	it("reads back from that spelling", () => {
		expect(parseVolumePath("/volume/tmp/notes/a.txt")).toEqual({ area: "tmp", path: "notes/a.txt" });
		expect(parseVolumePath("/volume/data")).toEqual({ area: "data", path: "" });
	});

	it("is not read from a string naming no area", () => {
		for (const seen of [
			"/tmp/a.txt",
			"/volume",
			"/volume/",
			"/volume/etc/passwd",
			"/volume/tmp/",
			"/volumes/tmp/a",
			"tmp/a",
		]) {
			expect(parseVolumePath(seen), seen).toBeUndefined();
		}
	});
});
