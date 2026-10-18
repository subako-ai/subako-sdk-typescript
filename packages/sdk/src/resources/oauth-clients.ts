import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListOAuthClientsParams = IdPaged<NonNullable<api.ListOauthClientsData["query"]>>;

/**
 * The workspace's own OAuth clients: ones created at a provider that registers no client on the
 * spot, which a vault connects credentials through with {@link Vaults.startOAuth}. A client's
 * secret goes in and never comes back out.
 */
export class OAuthClients {
	constructor(private readonly core: Core) {}

	/** Lists the workspace's clients, newest first; `order: "asc"` walks the other way. */
	list(params?: ListOAuthClientsParams, options?: RequestOptions) {
		return this.core.page(api.listOauthClients, { query: params }, BY_ID, options);
	}

	/**
	 * Registers a client: the provider's endpoints, the client id it issued, how the client
	 * authenticates at the token endpoint, and the scopes and extra authorization parameters to
	 * ask for. The provider must send the browser back to the page each connection starts from, so
	 * that page's URL is registered there as a redirect URI.
	 */
	create(params: api.CreateOAuthClientBodyWritable, options?: RequestOptions) {
		return this.core.call(api.createOauthClient, { body: params }, options);
	}

	/** Reads one client, without its secret. */
	get(oauthClientId: string, options?: RequestOptions) {
		return this.core.call(api.getOauthClient, { path: { oauth_client_id: oauthClientId } }, options);
	}

	/**
	 * Changes a client in place; an absent field is left as it stands, and a present list replaces
	 * the stored one whole. A new `token_endpoint_auth` replaces the method and the secret
	 * together, and every credential connected through the client refreshes with it from then on.
	 */
	update(oauthClientId: string, params: api.UpdateOAuthClientBodyWritable, options?: RequestOptions) {
		return this.core.call(api.updateOauthClient, { path: { oauth_client_id: oauthClientId }, body: params }, options);
	}

	/** Deletes a client; one a credential was connected through is refused until that credential is deleted. */
	delete(oauthClientId: string, options?: RequestOptions) {
		return this.core.call(api.deleteOauthClient, { path: { oauth_client_id: oauthClientId } }, options);
	}
}
