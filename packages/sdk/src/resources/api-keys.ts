import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListApiKeysParams = IdPaged<NonNullable<api.ListApiKeysData["query"]>>;

/** Workspace API keys. */
export class ApiKeys {
	constructor(private readonly core: Core) {}

	/** Lists the workspace's keys, newest first; revoked keys are included. */
	list(params?: ListApiKeysParams, options?: RequestOptions) {
		return this.core.page(api.listApiKeys, { query: params }, BY_ID, options);
	}

	/** Mints a key; the secret is returned once, and a replay answers with the receipt alone. */
	mint(params: api.MintApiKeyBody, options?: RequestOptions) {
		return this.core.call(api.mintApiKey, { body: params }, options);
	}

	/** Revokes a key; repeating it returns the same revocation. */
	revoke(apiKeyId: string, options?: RequestOptions) {
		return this.core.call(api.revokeApiKey, { path: { api_key_id: apiKeyId } }, options);
	}
}
