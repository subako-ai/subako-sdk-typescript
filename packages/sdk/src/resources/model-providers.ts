import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListModelProvidersParams = IdPaged<NonNullable<api.ListModelProvidersData["query"]>>;

/** The model providers the workspace reaches: the platform's own, and the BYOK bindings it holds. */
export class ModelProviders {
	constructor(private readonly core: Core) {}

	/** Lists the providers, newest first; `type` says whether one is `platform` or `byok`. */
	list(params?: ListModelProvidersParams, options?: RequestOptions) {
		return this.core.page(api.listModelProviders, { query: params }, BY_ID, options);
	}

	/**
	 * Binds a provider to the workspace, by an API key (`api_key`, never
	 * returned) or by `auth`: an `aws_web_identity` names a role in your own AWS
	 * account that Subako assumes as the workspace, so no key is handed over.
	 */
	create(params: api.CreateWorkspaceModelProviderBodyWritable, options?: RequestOptions) {
		return this.core.call(api.createWorkspaceModelProvider, { body: params }, options);
	}

	/**
	 * What a cloud account registers and trusts so that a provider can reach it
	 * as this workspace: the issuer, the workspace's subject, and the audience
	 * AWS checks.
	 */
	workloadIdentity(options?: RequestOptions) {
		return this.core.call(api.getWorkloadIdentity, {}, options);
	}

	/** Reads one provider. */
	get(modelProviderId: string, options?: RequestOptions) {
		return this.core.call(api.getModelProvider, { path: { model_provider_id: modelProviderId } }, options);
	}

	/**
	 * Changes a BYOK provider's name, description, endpoint, or credential; an
	 * absent field is left as it stands. A new `api_key` or `auth` replaces the
	 * stored credential under the same id, so agents using the provider keep
	 * resolving it; no response carries a key.
	 */
	update(modelProviderId: string, params: api.UpdateModelProviderBodyWritable, options?: RequestOptions) {
		return this.core.call(
			api.updateModelProvider,
			{ path: { model_provider_id: modelProviderId }, body: params },
			options,
		);
	}

	/** Deletes a BYOK provider; a platform provider is refused, since every workspace reaches it. */
	delete(modelProviderId: string, options?: RequestOptions) {
		return this.core.call(api.deleteModelProvider, { path: { model_provider_id: modelProviderId } }, options);
	}
}
