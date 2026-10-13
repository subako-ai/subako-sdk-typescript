import type { Core, FunctionArchive, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListFunctionsParams = IdPaged<NonNullable<api.ListFunctionsData["query"]>>;
export type ListFunctionVersionsParams = IdPaged<NonNullable<api.ListFunctionVersionsData["query"]>>;

/**
 * Function packages and their versions. Archives are gzipped tars holding
 * subako-package.json and module.wasm at the root.
 */
export class Functions {
	constructor(private readonly core: Core) {}

	/** Lists the workspace's packages, newest first; `order: "asc"` walks the other way. */
	list(params?: ListFunctionsParams, options?: RequestOptions) {
		return this.core.page(api.listFunctions, { query: params }, BY_ID, options);
	}

	/** Lists the packages the deployment ships, which an agent version grants by name. */
	platform(options?: RequestOptions) {
		return this.core.call(api.listPlatformFunctions, {}, options);
	}

	/** Creates a package from an archive and returns its first version. */
	create(archive: FunctionArchive, options?: RequestOptions) {
		return this.core.upload(api.createFunction, {}, archive, options);
	}

	/** Reads one package. */
	get(functionId: string, options?: RequestOptions) {
		return this.core.call(api.getFunction, { path: { function_id: functionId } }, options);
	}

	/** Deletes a package and every version of it. */
	delete(functionId: string, options?: RequestOptions) {
		return this.core.call(api.deleteFunction, { path: { function_id: functionId } }, options);
	}

	/** Renames a package. */
	rename(functionId: string, params: api.RenameFunctionBody, options?: RequestOptions) {
		return this.core.call(api.renameFunction, { path: { function_id: functionId }, body: params }, options);
	}

	/** Lists a package's versions, newest first; `order: "asc"` walks the other way. */
	listVersions(functionId: string, params?: ListFunctionVersionsParams, options?: RequestOptions) {
		return this.core.page(
			api.listFunctionVersions,
			{ path: { function_id: functionId }, query: params },
			BY_ID,
			options,
		);
	}

	/** Pushes a new version from an archive. */
	pushVersion(functionId: string, archive: FunctionArchive, options?: RequestOptions) {
		return this.core.upload(api.pushFunctionVersion, { path: { function_id: functionId } }, archive, options);
	}

	/** Reads one version by its number, counting from 1. */
	getVersion(functionId: string, version: number, options?: RequestOptions) {
		return this.core.call(api.getFunctionVersion, { path: { function_id: functionId, version } }, options);
	}
}
