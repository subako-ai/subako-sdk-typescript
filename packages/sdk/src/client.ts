import { clientCredential, Core, type SubakoClientOptions } from "./core.js";
import { Agents } from "./resources/agents.js";
import { ApiKeys } from "./resources/api-keys.js";
import { Functions } from "./resources/functions.js";
import { Me } from "./resources/me.js";
import { ModelProviders } from "./resources/model-providers.js";
import { OAuthClients } from "./resources/oauth-clients.js";
import { Organization } from "./resources/organization.js";
import { Sessions } from "./resources/sessions.js";
import { Skills } from "./resources/skills.js";
import { Vaults } from "./resources/vaults.js";
import { Workspaces } from "./resources/workspaces.js";

/**
 * The whole Subako API, under an API key, an access token, or a credential attached outside the
 * SDK: one instance per credential and workspace.
 */
export class SubakoClient {
	readonly agents: Agents;
	readonly apiKeys: ApiKeys;
	readonly functions: Functions;
	readonly me: Me;
	readonly modelProviders: ModelProviders;
	readonly oauthClients: OAuthClients;
	readonly organization: Organization;
	readonly sessions: Sessions;
	readonly skills: Skills;
	readonly vaults: Vaults;
	readonly workspaces: Workspaces;

	constructor(options: SubakoClientOptions) {
		const core = new Core({ ...options, credential: clientCredential(options) });
		this.agents = new Agents(core);
		this.apiKeys = new ApiKeys(core);
		this.functions = new Functions(core);
		this.me = new Me(core);
		this.modelProviders = new ModelProviders(core);
		this.oauthClients = new OAuthClients(core);
		this.organization = new Organization(core);
		this.sessions = new Sessions(core);
		this.skills = new Skills(core);
		this.vaults = new Vaults(core);
		this.workspaces = new Workspaces(core);
	}
}
