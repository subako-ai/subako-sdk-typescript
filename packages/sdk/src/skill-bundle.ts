/**
 * A skill bundle as files: packing them into the gzipped tar the push routes
 * take, and reading the files back out of one. The archive is plain ustar,
 * gzipped by the platform's `CompressionStream`, so none of it is a
 * dependency. Core unpacks and repacks every upload into its own canonical
 * archive, so these bytes need not match that one.
 */
import type { SkillArchive } from "./core.js";

/** A file in a skill bundle, under its "/"-joined path from the bundle root. */
export interface SkillFile {
	readonly path: string;
	readonly content: Uint8Array;
}

/** The most one file of a bundle may hold, in bytes. */
// CODESYNC(skill-bundle-caps)
export const SKILL_MAX_FILE_BYTES = 10 * 1024 * 1024;
/** The most a bundle's files may hold together, in bytes. */
// CODESYNC(skill-bundle-caps)
export const SKILL_MAX_TOTAL_BYTES = 10 * 1024 * 1024;
/** The most files a bundle may hold. */
// CODESYNC(skill-bundle-caps)
export const SKILL_MAX_FILES = 1000;

/** The file every bundle carries at its root. */
// CODESYNC(skill-manifest-file)
export const SKILL_MD = "SKILL.md";

/**
 * Why a set of files cannot be packed as a bundle. These are the rules about
 * the files as a set; what `SKILL.md` says is Core's to judge, and its
 * refusal names what is wrong with it.
 */
export type SkillBundleProblem =
	| { readonly kind: "missingSkillMd" }
	/** Empty, absolute, or carrying an empty, `.` or `..` segment. */
	| { readonly kind: "invalidPath"; readonly path: string }
	| { readonly kind: "duplicatePath"; readonly path: string }
	/** A file whose path is another file's directory. */
	| { readonly kind: "pathConflict"; readonly path: string }
	| { readonly kind: "fileTooLarge"; readonly path: string; readonly bytes: number }
	| { readonly kind: "tooLarge"; readonly bytes: number }
	| { readonly kind: "tooManyFiles"; readonly count: number };

/** Files that break a bundle rule were handed to {@link packSkill}. */
export class SkillBundleError extends Error {
	readonly problems: readonly SkillBundleProblem[];

	constructor(problems: readonly SkillBundleProblem[]) {
		super(`not a skill bundle: ${problems.map(describeProblem).join("; ")}`);
		this.name = new.target.name;
		this.problems = problems;
	}
}

/** An archive {@link unpackSkill} could not read as a gzipped tar of a bundle. */
export class SkillArchiveError extends Error {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.name = new.target.name;
	}
}

/** Every bundle rule `files` breaks, in the order the files came; none for a packable set. */
export function checkSkillFiles(files: readonly SkillFile[]): SkillBundleProblem[] {
	const problems: SkillBundleProblem[] = [];
	const paths = new Set<string>();
	for (const file of files) {
		if (!isBundlePath(file.path)) {
			problems.push({ kind: "invalidPath", path: file.path });
		} else if (paths.has(file.path)) {
			problems.push({ kind: "duplicatePath", path: file.path });
		} else {
			paths.add(file.path);
		}
		if (file.content.byteLength > SKILL_MAX_FILE_BYTES) {
			problems.push({ kind: "fileTooLarge", path: file.path, bytes: file.content.byteLength });
		}
	}
	const conflicts = new Set([...paths].flatMap(ancestors).filter((ancestor) => paths.has(ancestor)));
	for (const path of conflicts) {
		problems.push({ kind: "pathConflict", path });
	}
	if (!paths.has(SKILL_MD)) {
		problems.push({ kind: "missingSkillMd" });
	}
	const bytes = files.reduce((sum, file) => sum + file.content.byteLength, 0);
	if (bytes > SKILL_MAX_TOTAL_BYTES) {
		problems.push({ kind: "tooLarge", bytes });
	}
	if (files.length > SKILL_MAX_FILES) {
		problems.push({ kind: "tooManyFiles", count: files.length });
	}
	return problems;
}

/**
 * Packs `files` into an archive `skills.create` and `skills.pushVersion`
 * take. Entries go in path order with mtime zeroed and mode fixed, so the
 * same files always pack to the same bytes.
 *
 * @throws {SkillBundleError} when the files break a bundle rule.
 */
export async function packSkill(files: readonly SkillFile[]): Promise<Uint8Array<ArrayBuffer>> {
	const problems = checkSkillFiles(files);
	if (problems.length > 0) {
		throw new SkillBundleError(problems);
	}
	const sorted = [...files].sort((a, b) => compare(a.path, b.path));
	const tar = concat([...sorted.flatMap((file) => entry(file.path, file.content)), new Uint8Array(BLOCK * 2)]);
	return readAll(new Blob([tar]).stream().pipeThrough(new CompressionStream("gzip")), Number.POSITIVE_INFINITY);
}

/**
 * Reads the files out of a gzipped tar, in archive order. Directories,
 * links, and other entries that hold no file content are skipped; a `./`
 * leading a path is dropped, as an archive made with `tar -C dir .` has it.
 *
 * @throws {SkillArchiveError} when the archive is not a gzipped tar, names a
 * path outside the bundle, or unpacks to more than a bundle may hold.
 */
export async function unpackSkill(archive: SkillArchive): Promise<SkillFile[]> {
	const compressed = await blobOf(archive);
	let tar: Uint8Array;
	try {
		tar = await readAll(compressed.stream().pipeThrough(new DecompressionStream("gzip")), UNPACK_BYTE_CAP);
	} catch (error) {
		if (error instanceof SkillArchiveError) throw error;
		throw new SkillArchiveError("the archive is not gzipped", { cause: error });
	}
	return readTar(tar);
}

const BLOCK = 512;

/**
 * The most decompressed tar bytes an unpack reads before giving up: the files
 * a bundle may hold, plus a header and padding's worth per file.
 */
const UNPACK_BYTE_CAP = SKILL_MAX_TOTAL_BYTES + SKILL_MAX_FILES * 2 * BLOCK + 2 * BLOCK;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function describeProblem(problem: SkillBundleProblem): string {
	switch (problem.kind) {
		case "missingSkillMd":
			return `no ${SKILL_MD} at the root`;
		case "invalidPath":
			return `${JSON.stringify(problem.path)} is not a path inside the bundle`;
		case "duplicatePath":
			return `${problem.path} appears more than once`;
		case "pathConflict":
			return `${problem.path} is both a file and a directory`;
		case "fileTooLarge":
			return `${problem.path} is ${problem.bytes} bytes, over the ${SKILL_MAX_FILE_BYTES}-byte file limit`;
		case "tooLarge":
			return `the files hold ${problem.bytes} bytes, over the ${SKILL_MAX_TOTAL_BYTES}-byte bundle limit`;
		case "tooManyFiles":
			return `${problem.count} files, over the ${SKILL_MAX_FILES}-file limit`;
		default:
			return problem satisfies never;
	}
}

function isBundlePath(path: string): boolean {
	return (
		path !== "" &&
		!path.includes("\0") &&
		path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..")
	);
}

/** Every directory above `path`: `a` and `a/b` for `a/b/c`. */
function ancestors(path: string): string[] {
	const segments = path.split("/");
	return segments.slice(1).map((_, i) => segments.slice(0, i + 1).join("/"));
}

/** Orders paths by their UTF-8 bytes, as Core sorts its manifest. */
function compare(a: string, b: string): number {
	const left = encoder.encode(a);
	const right = encoder.encode(b);
	const length = Math.min(left.length, right.length);
	for (let i = 0; i < length; i++) {
		const diff = left[i]! - right[i]!;
		if (diff !== 0) return diff;
	}
	return left.length - right.length;
}

/** One file's header and padded content, preceded by a PAX header when its path outgrows ustar's. */
function entry(path: string, content: Uint8Array): Uint8Array[] {
	const name = encoder.encode(path);
	const split = name.length <= 100 ? undefined : splitPath(name);
	if (name.length > 100 && split === undefined) {
		const record = paxRecord("path", path);
		return [
			header({ name: encoder.encode("PaxHeader"), prefix: undefined, size: record.length, type: "x" }),
			...padded(record),
			header({ name: name.subarray(0, 100), prefix: undefined, size: content.length, type: "0" }),
			...padded(content),
		];
	}
	return [
		header({ name: split?.name ?? name, prefix: split?.prefix, size: content.length, type: "0" }),
		...padded(content),
	];
}

/** ustar's own long paths: a prefix of up to 155 bytes and a name of up to 100, split at a "/". */
function splitPath(name: Uint8Array): { prefix: Uint8Array; name: Uint8Array } | undefined {
	for (let i = Math.min(155, name.length - 1); i > 0; i--) {
		if (name[i] === 0x2f && name.length - i - 1 <= 100) {
			return { prefix: name.subarray(0, i), name: name.subarray(i + 1) };
		}
	}
	return undefined;
}

/** One `"<length> <key>=<value>\n"` record, whose length counts its own digits. */
function paxRecord(key: string, value: string): Uint8Array {
	const body = encoder.encode(` ${key}=${value}\n`);
	let length = body.length + 1;
	while (String(length).length + body.length !== length) length++;
	return encoder.encode(`${length} ${key}=${value}\n`);
}

function header(fields: { name: Uint8Array; prefix: Uint8Array | undefined; size: number; type: string }): Uint8Array {
	const block = new Uint8Array(BLOCK);
	block.set(fields.name, 0);
	writeOctal(block, 100, 8, 0o644);
	writeOctal(block, 108, 8, 0);
	writeOctal(block, 116, 8, 0);
	writeOctal(block, 124, 12, fields.size);
	writeOctal(block, 136, 12, 0);
	block.set(encoder.encode(fields.type), 156);
	block.set(encoder.encode("ustar\u000000"), 257);
	if (fields.prefix !== undefined) block.set(fields.prefix, 345);
	block.fill(0x20, 148, 156);
	writeOctal(block, 148, 7, checksum(block));
	return block;
}

/** A zero-padded octal number filling `width - 1` digits, then a NUL. */
function writeOctal(block: Uint8Array, offset: number, width: number, value: number): void {
	block.set(encoder.encode(value.toString(8).padStart(width - 1, "0")), offset);
	block[offset + width - 1] = 0;
}

function checksum(block: Uint8Array): number {
	let sum = 0;
	for (let i = 0; i < BLOCK; i++) {
		sum += i >= 148 && i < 156 ? 0x20 : block[i]!;
	}
	return sum;
}

function padded(content: Uint8Array): Uint8Array[] {
	const rest = content.length % BLOCK;
	return rest === 0 ? [content] : [content, new Uint8Array(BLOCK - rest)];
}

/** The archive as a Blob, its bytes copied into a buffer of its own where they are not one already. */
async function blobOf(archive: SkillArchive): Promise<Blob> {
	if (archive instanceof Blob) return archive;
	if (archive instanceof ReadableStream) return new Blob([await readAll(archive, UNPACK_BYTE_CAP)]);
	return new Blob([new Uint8Array(archive)]);
}

/** Reads a stream to its end, refusing one longer than `cap` bytes. */
async function readAll(stream: ReadableStream<Uint8Array>, cap: number): Promise<Uint8Array<ArrayBuffer>> {
	const chunks: Uint8Array[] = [];
	let length = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return concat(chunks);
		length += value.length;
		if (length > cap) {
			await reader.cancel();
			throw new SkillArchiveError("the archive unpacks to more than a skill bundle may hold");
		}
		chunks.push(value);
	}
}

function concat(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
	const out = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0));
	let offset = 0;
	for (const chunk of chunks) {
		out.set(chunk, offset);
		offset += chunk.length;
	}
	return out;
}

/** What the extension headers before an entry say about it. */
interface Pending {
	path: string | undefined;
}

function readTar(tar: Uint8Array): SkillFile[] {
	const files: SkillFile[] = [];
	let pending: Pending = { path: undefined };
	let offset = 0;
	while (offset + BLOCK <= tar.length) {
		const block = tar.subarray(offset, offset + BLOCK);
		if (block.every((byte) => byte === 0)) return files;
		if (readOctal(block, 148, 8) !== checksum(block)) {
			throw new SkillArchiveError("the archive is not a tar: a header's checksum does not match");
		}
		const size = readOctal(block, 124, 12);
		const start = offset + BLOCK;
		const end = start + size;
		if (end > tar.length) {
			throw new SkillArchiveError("the archive is not a tar: an entry runs past its end");
		}
		const content = tar.slice(start, end);
		const type = String.fromCharCode(block[156]!);
		switch (type) {
			case "0":
			case "\0":
			case "7": {
				const path = normalize(pending.path ?? headerPath(block));
				if (path !== "") files.push({ path, content });
				pending = { path: undefined };
				break;
			}
			case "L":
				pending = { path: cString(content) };
				break;
			case "x":
				pending = { path: paxPath(content) ?? pending.path };
				break;
			default:
				// A directory, a link, a global PAX header: nothing a bundle holds as a file.
				pending = { path: undefined };
				break;
		}
		offset = start + Math.ceil(size / BLOCK) * BLOCK;
	}
	throw new SkillArchiveError("the archive is not a tar: it ends before its end-of-archive marker");
}

/** A NUL- or space-terminated octal number; an empty field is zero. */
function readOctal(block: Uint8Array, offset: number, width: number): number {
	const text = cString(block.subarray(offset, offset + width)).trim();
	if (text === "") return 0;
	if (!/^[0-7]+$/.test(text)) {
		throw new SkillArchiveError("the archive is not a tar: a header holds a malformed number");
	}
	return Number.parseInt(text, 8);
}

/** The path a header spells: its name, after the ustar prefix when the header is ustar's own. */
function headerPath(block: Uint8Array): string {
	const name = cString(block.subarray(0, 100));
	const ustar = cString(block.subarray(257, 263)) === "ustar" && block[262] === 0;
	const prefix = ustar ? cString(block.subarray(345, 500)) : "";
	return prefix === "" ? name : `${prefix}/${name}`;
}

function cString(bytes: Uint8Array): string {
	const end = bytes.indexOf(0);
	return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end));
}

function paxPath(records: Uint8Array): string | undefined {
	let path: string | undefined;
	let offset = 0;
	while (offset < records.length) {
		const space = records.indexOf(0x20, offset);
		const length = Number.parseInt(decoder.decode(records.subarray(offset, space)), 10);
		if (space === -1 || !Number.isSafeInteger(length) || length <= 0) {
			throw new SkillArchiveError("the archive is not a tar: an extended header is malformed");
		}
		const record = decoder.decode(records.subarray(space + 1, offset + length - 1));
		const equals = record.indexOf("=");
		if (record.slice(0, equals) === "path") path = record.slice(equals + 1);
		offset += length;
	}
	return path;
}

/** Drops a leading `./` and a trailing `/`, and refuses a path leaving the bundle. */
function normalize(path: string): string {
	const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
	if (path.startsWith("/") || segments.includes("..")) {
		throw new SkillArchiveError(`the archive names a path outside the bundle: ${path}`);
	}
	return segments.join("/");
}
