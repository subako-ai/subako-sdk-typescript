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

	/** Binds a provider to the workspace; the key is never returned. */
	create(params: api.CreateWorkspaceModelProviderBodyWritable, options?: RequestOptions) {
		return this.core.call(api.createWorkspaceModelProvider, { body: params }, options);
	}

	/** Reads one provider. */
	get(modelProviderId: string, options?: RequestOptions) {
		return this.core.call(api.getModelProvider, { path: { model_provider_id: modelProviderId } }, options);
	}

	/**
	 * Changes a BYOK provider's name, description, endpoint, or API key; an
	 * absent field is left as it stands. A new `api_key` replaces the stored one
	 * under the same id, so agents using the provider keep resolving it; no
	 * response carries the key.
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
