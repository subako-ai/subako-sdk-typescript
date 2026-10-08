import { describe, expect, it } from "vitest";
import {
	checkSkillFiles,
	packSkill,
	SKILL_MAX_FILE_BYTES,
	SKILL_MAX_FILES,
	SkillArchiveError,
	SkillBundleError,
	type SkillFile,
	unpackSkill,
} from "../src/index.js";

const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);
const file = (path: string, content: string | Uint8Array = ""): SkillFile => ({
	path,
	content: typeof content === "string" ? utf8(content) : content,
});
const skillMd = file("SKILL.md", "---\nname: demo\ndescription: d\n---\nbody\n");
const base64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
const gzip = async (bytes: Uint8Array<ArrayBuffer>): Promise<Uint8Array<ArrayBuffer>> =>
	new Uint8Array(
		await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer(),
	);

const longName = `${"x".repeat(120)}.md`;

// `tar --format=gnu -czf - -C dir .` over SKILL.md, scripts/run.sh, and a file
// whose 125-byte name GNU tar spells through a `././@LongLink` entry. Every
// path leads with `./`, and the directories have entries of their own.
const GNU_TAR =
	"H4sIAAAAAAAAA+3XwU6EMBQF0K77FTWuaWkpbeLKrbE7v2BmIEIcWgNMon8vo4sJREUTCzHcsymhJH3JzXsNXJDo0oHN8/d1MF0/ebYmV4Tl8Usj5NT1u5Yx0obQf/fd3P4/xcXD/Z1zvCninXEO1Wj9df7ajvOXMs0zwtJ4JV1sPP8kSajfNeUNK8om0KLsDm393NfBD2/oeXcfile6dpkQCRcfgXcR74Ffz38pMy0x/5dwyb89ed5VMc6Ynf9KTfJX2mL+L+L6SuxrL7qKlocqsKrGqN8ULri4dcE/uto/RTpjrv+lNdP5b1JLmItUz8jG+5+Ll5VE/eWAH1oi/9n7P9Xj/s+MUQb3/xKOw+hfuwYAAAAAAAAAAAAA+Htv3gaj8QAoAAA=";

// The same tree as `tar --format=pax`, which spells the long name through an
// extended header.
const PAX_TAR =
	"H4sIAAAAAAAAA+3X0WqDMBQGYK99ipRdm5iYVBjsfmW9GOwJ0hqmME0xFtzbL90YZbJNBkvc6P/dRIyQgz85UcqS4HKvVOp19KbjJ9dlyUVCVPjSkuToBt37JXtrh++em5v/pyh7uNtst7Stwq1xCnUt5df5y/Jj/twrEpKHK+nswvPPsiztdGuuSWVam1bG7fvmMDS283fS0+zOVs/p0mVCIJS9Be4CngM/7v+cy5yj/8dwzr8/dtTVIdaY7f9CTPIXqkD/j+JqxXZNx1ydmn1tSd2g1V8Uyu71eGt0ZXrHxjDm9r/IJ99/hVT+k5CMMV7A+/6PsdYfxAtFDnqob2io9Gf5fw80naXEiH32/M/lZP+vPZz/MTzZ7nHpGgAAAAAAAAAAAADg970ARD9c3wAoAAA=";

const unpacked = [
	{ path: "SKILL.md", content: utf8("---\nname: demo\ndescription: d\n---\nbody\n") },
	{ path: "scripts/run.sh", content: utf8("#!/bin/sh\necho hi\n") },
	{ path: longName, content: utf8("long") },
];

describe("packSkill and unpackSkill", () => {
	it("round-trip a bundle's files, in path order", async () => {
		const binary = Uint8Array.from({ length: 1500 }, (_, i) => (i * 7) % 256);
		const files = [
			file("scripts/run.sh", "#!/bin/sh\n"),
			skillMd,
			file("assets/logo.png", binary),
			file("empty.txt"),
			file("références/guide.md", "é"),
			// Too long for a ustar name, short enough to split at a "/" into its prefix.
			file(`${"d".repeat(80)}/${"f".repeat(90)}.md`, "split"),
			// Too long for either, so it travels in an extended header.
			file(`${"n".repeat(200)}.md`, "pax"),
		];

		const archive = await packSkill(files);

		await expect(unpackSkill(archive)).resolves.toEqual(
			[...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
		);
	});

	it("pack the same files to the same bytes", async () => {
		const files = [skillMd, file("b.md", "b"), file("a.md", "a")];

		const first = await packSkill(files);
		const second = await packSkill([...files].reverse());

		expect(second).toEqual(first);
	});

	it("read an archive from a Blob or a stream", async () => {
		const archive = await packSkill([skillMd]);

		await expect(unpackSkill(new Blob([archive]))).resolves.toEqual([skillMd]);
		await expect(unpackSkill(new Blob([archive]).stream())).resolves.toEqual([skillMd]);
	});
});

describe("unpackSkill", () => {
	it("reads GNU tar's archive, dropping ./ and skipping directories", async () => {
		await expect(unpackSkill(base64(GNU_TAR))).resolves.toEqual(unpacked);
	});

	it("reads a PAX archive's extended paths", async () => {
		await expect(unpackSkill(base64(PAX_TAR))).resolves.toEqual(unpacked);
	});

	it("refuses bytes that are not gzipped", async () => {
		await expect(unpackSkill(utf8("not an archive"))).rejects.toThrow(
			new SkillArchiveError("the archive is not gzipped"),
		);
	});

	it("refuses a gzip that holds no tar", async () => {
		await expect(unpackSkill(await gzip(new Uint8Array(512).fill(1)))).rejects.toBeInstanceOf(SkillArchiveError);
	});

	it("refuses a tar cut short", async () => {
		const tar = new Uint8Array(
			await new Response(
				new Blob([await packSkill([skillMd])]).stream().pipeThrough(new DecompressionStream("gzip")),
			).arrayBuffer(),
		);

		await expect(unpackSkill(await gzip(tar.subarray(0, 512)))).rejects.toThrow(
			"the archive is not a tar: an entry runs past its end",
		);
		await expect(unpackSkill(await gzip(tar.subarray(0, 1024)))).rejects.toThrow(
			"the archive is not a tar: it ends before its end-of-archive marker",
		);
	});

	it("refuses an archive that unpacks past what a bundle may hold", async () => {
		await expect(unpackSkill(await gzip(new Uint8Array(12 * 1024 * 1024)))).rejects.toThrow(
			"the archive unpacks to more than a skill bundle may hold",
		);
	});
});

describe("checkSkillFiles", () => {
	it("passes a bundle with SKILL.md at its root", () => {
		expect(checkSkillFiles([skillMd, file("scripts/run.sh")])).toEqual([]);
	});

	it("names every rule a set of files breaks", () => {
		const big = new Uint8Array(SKILL_MAX_FILE_BYTES + 1);

		expect(
			checkSkillFiles([
				file("notes.md"),
				file(""),
				file("/etc/passwd"),
				file("a//b"),
				file("./a"),
				file("a/../b"),
				file("notes.md"),
				file("scripts"),
				file("scripts/deep/run.sh"),
				file("big.bin", big),
			]),
		).toEqual([
			{ kind: "invalidPath", path: "" },
			{ kind: "invalidPath", path: "/etc/passwd" },
			{ kind: "invalidPath", path: "a//b" },
			{ kind: "invalidPath", path: "./a" },
			{ kind: "invalidPath", path: "a/../b" },
			{ kind: "duplicatePath", path: "notes.md" },
			{ kind: "fileTooLarge", path: "big.bin", bytes: SKILL_MAX_FILE_BYTES + 1 },
			{ kind: "pathConflict", path: "scripts" },
			{ kind: "missingSkillMd" },
			{ kind: "tooLarge", bytes: SKILL_MAX_FILE_BYTES + 1 },
		]);
	});

	it("counts the files", () => {
		const files = [skillMd, ...Array.from({ length: SKILL_MAX_FILES }, (_, i) => file(`f${i}`))];

		expect(checkSkillFiles(files)).toEqual([{ kind: "tooManyFiles", count: SKILL_MAX_FILES + 1 }]);
	});

	it("is what packSkill refuses with", async () => {
		const refusal = packSkill([file("notes.md")]);

		await expect(refusal).rejects.toBeInstanceOf(SkillBundleError);
		await expect(refusal).rejects.toMatchObject({ problems: [{ kind: "missingSkillMd" }] });
		await expect(refusal).rejects.toThrow("not a skill bundle: no SKILL.md at the root");
	});
});
