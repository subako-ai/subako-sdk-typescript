import type { Core, RequestOptions } from "../core.js";
import * as api from "../generated/index.js";

/** The caller behind the credential. */
export class Me {
	constructor(private readonly core: Core) {}

	/** Reads the authenticated caller's identity. */
	get(options?: RequestOptions) {
		return this.core.call(api.getMe, {}, options);
	}

	/** Sets the caller's own name, or clears it with `display_name: null`. */
	rename(params: api.RenameMeBody, options?: RequestOptions) {
		return this.core.call(api.renameMe, { body: params }, options);
	}
}
