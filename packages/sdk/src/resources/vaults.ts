import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListVaultsParams = IdPaged<NonNullable<api.ListVaultsData["query"]>>;
export type ListCredentialsParams = IdPaged<NonNullable<api.ListCredentialsData["query"]>>;

/** Vaults and the credentials they hold. */
export class Vaults {
	constructor(private readonly core: Core) {}

	/**
	 * Lists the workspace's vaults, newest first; `order: "asc"` walks the other way. `external_id`
	 * finds the one vault holding it, and `metadata` keeps the vaults holding every pair it names.
	 */
	list(params?: ListVaultsParams, options?: RequestOptions) {
		return this.core.page(api.listVaults, { query: params }, BY_ID, options);
	}

	/** Creates a vault. */
	create(params: api.CreateVaultBody, options?: RequestOptions) {
		return this.core.call(api.createVault, { body: params }, options);
	}

	/** Reads one vault. */
	get(vaultId: string, options?: RequestOptions) {
		return this.core.call(api.getVault, { path: { vault_id: vaultId } }, options);
	}

	/**
	 * Renames a vault, sets or removes (`null`) its external id, or replaces its metadata; an absent
	 * field is left as it stands.
	 */
	update(vaultId: string, params: api.UpdateVaultBody, options?: RequestOptions) {
		return this.core.call(api.updateVault, { path: { vault_id: vaultId }, body: params }, options);
	}

	/** Deletes a vault, along with every credential in it. */
	delete(vaultId: string, options?: RequestOptions) {
		return this.core.call(api.deleteVault, { path: { vault_id: vaultId } }, options);
	}

	/** Lists a vault's credential metadata, newest first; payloads are never returned. */
	listCredentials(vaultId: string, params?: ListCredentialsParams, options?: RequestOptions) {
		return this.core.page(api.listCredentials, { path: { vault_id: vaultId }, query: params }, BY_ID, options);
	}

	/** Adds a credential to a vault. */
	addCredential(vaultId: string, params: api.AddCredentialBody, options?: RequestOptions) {
		return this.core.call(api.addCredential, { path: { vault_id: vaultId }, body: params }, options);
	}

	/**
	 * Starts connecting a credential through OAuth, as a "Sign in with ..." button would, and
	 * answers the `authorization_url` to send the browser to. An `mcp` credential connects through
	 * the workspace OAuth client `oauth_client_id` names, or else Core discovers the server's
	 * authorization server and registers itself there for `redirect_uri`. An `http` credential
	 * always connects through a workspace OAuth client, and is sent to its `origins` as
	 * `authorization: Bearer`. The provider sends the browser back to `redirect_uri` with `code` and
	 * `state` in its query (or `error`), and the page there finishes with
	 * {@link Vaults.completeOAuth} under the same credentials. A replay answers with the receipt
	 * alone: the URL carries the connection's `state`.
	 */
	startOAuth(vaultId: string, params: api.StartOAuthBody, options?: RequestOptions) {
		return this.core.call(api.startCredentialOauth, { path: { vault_id: vaultId }, body: params }, options);
	}

	/**
	 * Finishes a connection {@link Vaults.startOAuth} began, with the `state` and `code` the browser
	 * came back with: Core redeems the code and stores an `oauth` credential for the target or
	 * origins. Only
	 * the caller that started the connection can finish it, once, within ten minutes.
	 */
	completeOAuth(vaultId: string, params: api.CompleteOAuthBody, options?: RequestOptions) {
		return this.core.call(api.completeCredentialOauth, { path: { vault_id: vaultId }, body: params }, options);
	}

	/**
	 * Starts reconnecting an `oauth` credential whose provider no longer takes it — one listed with
	 * `status: "reconnect_required"` — through the same browser round trip as
	 * {@link Vaults.startOAuth}, for the credential's own target or origins, name, and client.
	 * Finishing it with
	 * {@link Vaults.completeOAuth} replaces the credential's payload in place: the answer carries
	 * the same id, and the credential is `active` again. A bearer credential cannot be reconnected.
	 */
	reconnectOAuth(vaultId: string, credentialId: string, params: api.ReconnectOAuthBody, options?: RequestOptions) {
		return this.core.call(
			api.reconnectCredentialOauth,
			{ path: { vault_id: vaultId, credential_id: credentialId }, body: params },
			options,
		);
	}

	/**
	 * Sends the credential's server an MCP `initialize` with it, as a session would — refreshing an
	 * OAuth credential first when its token is about to lapse — and answers what the server said:
	 * `connected`, `rejected` (a bearer credential refused), or `reconnect_required` (an OAuth
	 * credential its provider no longer refreshes, which is then marked so).
	 */
	checkCredential(vaultId: string, credentialId: string, options?: RequestOptions) {
		return this.core.call(api.checkCredential, { path: { vault_id: vaultId, credential_id: credentialId } }, options);
	}

	/** Deletes a credential. */
	deleteCredential(vaultId: string, credentialId: string, options?: RequestOptions) {
		return this.core.call(api.deleteCredential, { path: { vault_id: vaultId, credential_id: credentialId } }, options);
	}
}
