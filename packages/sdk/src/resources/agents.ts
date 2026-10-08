import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListAgentsParams = IdPaged<NonNullable<api.ListAgentsData["query"]>>;
export type ListAgentVersionsParams = IdPaged<NonNullable<api.ListAgentVersionsData["query"]>>;

/** Agents and the versions published on them. */
export class Agents {
	constructor(private readonly core: Core) {}

	/** Lists the workspace's agents, newest first; `order: "asc"` walks the other way. */
	list(params?: ListAgentsParams, options?: RequestOptions) {
		return this.core.page(api.listAgents, { query: params }, BY_ID, options);
	}

	/** Creates an agent. */
	create(params: api.CreateAgentBody, options?: RequestOptions) {
		return this.core.call(api.createAgent, { body: params }, options);
	}

	/** Reads one agent. */
	get(agentId: string, options?: RequestOptions) {
		return this.core.call(api.getAgent, { path: { agent_id: agentId } }, options);
	}

	/** Renames an agent. */
	rename(agentId: string, params: api.RenameAgentBody, options?: RequestOptions) {
		return this.core.call(api.renameAgent, { path: { agent_id: agentId }, body: params }, options);
	}

	/** Deletes an agent, its versions and its sessions with it; the ledgers a session left behind stay. */
	delete(agentId: string, options?: RequestOptions) {
		return this.core.call(api.deleteAgent, { path: { agent_id: agentId } }, options);
	}

	/** Lists an agent's versions, newest first; `order: "asc"` walks the other way. */
	listVersions(agentId: string, params?: ListAgentVersionsParams, options?: RequestOptions) {
		return this.core.page(api.listAgentVersions, { path: { agent_id: agentId }, query: params }, BY_ID, options);
	}

	/** Publishes a version, which becomes the one new sessions run. */
	publishVersion(agentId: string, params: api.PublishAgentVersionBody, options?: RequestOptions) {
		return this.core.call(api.publishVersion, { path: { agent_id: agentId }, body: params }, options);
	}

	/** Reads the agent's security document: the browser origins its sessions answer. */
	getSecurity(agentId: string, options?: RequestOptions) {
		return this.core.call(api.getAgentSecurity, { path: { agent_id: agentId } }, options);
	}

	/** Replaces the security document; an omitted field takes its default, so `{}` refuses every browser. */
	setSecurity(agentId: string, params: api.PutAgentSecurityBody, options?: RequestOptions) {
		return this.core.call(api.setAgentSecurity, { path: { agent_id: agentId }, body: params }, options);
	}
}
