import type { Core, RequestOptions, SkillArchive } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListSkillsParams = IdPaged<NonNullable<api.ListSkillsData["query"]>>;
export type ListSkillVersionsParams = IdPaged<NonNullable<api.ListSkillVersionsData["query"]>>;

/** Skills and their versions. Archives are gzipped tars with SKILL.md at the root. */
export class Skills {
	constructor(private readonly core: Core) {}

	/** Lists the workspace's skills, newest first; `order: "asc"` walks the other way. */
	list(params?: ListSkillsParams, options?: RequestOptions) {
		return this.core.page(api.listSkills, { query: params }, BY_ID, options);
	}

	/** Creates a skill from an archive and returns its first version. */
	create(archive: SkillArchive, options?: RequestOptions) {
		return this.core.upload(api.createSkill, {}, archive, options);
	}

	/** Reads one skill. */
	get(skillId: string, options?: RequestOptions) {
		return this.core.call(api.getSkill, { path: { skill_id: skillId } }, options);
	}

	/** Deletes a skill and every version of it. */
	delete(skillId: string, options?: RequestOptions) {
		return this.core.call(api.deleteSkill, { path: { skill_id: skillId } }, options);
	}

	/** Renames a skill. */
	rename(skillId: string, params: api.RenameSkillBody, options?: RequestOptions) {
		return this.core.call(api.renameSkill, { path: { skill_id: skillId }, body: params }, options);
	}

	/** Lists a skill's versions, newest first; `order: "asc"` walks the other way. */
	listVersions(skillId: string, params?: ListSkillVersionsParams, options?: RequestOptions) {
		return this.core.page(api.listSkillVersions, { path: { skill_id: skillId }, query: params }, BY_ID, options);
	}

	/** Pushes a new version from an archive. */
	pushVersion(skillId: string, archive: SkillArchive, options?: RequestOptions) {
		return this.core.upload(api.pushSkillVersion, { path: { skill_id: skillId } }, archive, options);
	}

	/** Reads one version by its number, counting from 1. */
	getVersion(skillId: string, version: number, options?: RequestOptions) {
		return this.core.call(api.getSkillVersion, { path: { skill_id: skillId, version } }, options);
	}

	/**
	 * Reads one version's archive: where to fetch it, how large it is, and when
	 * that URL lapses. `unpackSkill` reads the files out of what it serves.
	 */
	getBundle(skillId: string, version: number, options?: RequestOptions) {
		return this.core.call(api.getSkillBundle, { path: { skill_id: skillId, version } }, options);
	}
}
