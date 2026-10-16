import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListWorkspacesParams = IdPaged<NonNullable<api.ListWorkspacesData["query"]>>;
export type ListWorkspaceMembersParams = IdPaged<NonNullable<api.ListWorkspaceMembersData["query"]>>;
export type ListWorkspaceUsageParams = IdPaged<NonNullable<api.ListWorkspaceUsageData["query"]>>;
export type UsageReportParams = api.UsageReportData["query"];

/** Workspaces in the caller's organization, and their members. */
export class Workspaces {
	constructor(private readonly core: Core) {}

	/**
	 * Lists the organization's workspaces, newest first; `order: "asc"` walks the
	 * other way, and `search` keeps those whose name holds it, ignoring case, or
	 * whose id does.
	 */
	list(params?: ListWorkspacesParams, options?: RequestOptions) {
		return this.core.page(api.listWorkspaces, { query: params }, BY_ID, options);
	}

	/** Creates a workspace in the caller's organization. */
	create(params: api.CreateWorkspaceBody, options?: RequestOptions) {
		return this.core.call(api.createWorkspace, { body: params }, options);
	}

	/**
	 * Lists usage events in one workspace, newest first. Walking it forward can
	 * miss an event committed behind the cursor, so account usage with
	 * `usageReport` instead.
	 */
	listUsage(workspaceId: string, params?: ListWorkspaceUsageParams, options?: RequestOptions) {
		return this.core.page(
			api.listWorkspaceUsage,
			{ path: { workspace_id: workspaceId }, query: params },
			BY_ID,
			options,
		);
	}

	/**
	 * Reads one page of the workspace's usage report: usage summed per bucket
	 * of the span and per value of each `group_by` dimension. A row whose
	 * `ending_at` is at or before the page's `finalized_before` never changes
	 * again. The next page is the same parameters with `after` set to the
	 * page's `next_cursor`.
	 */
	usageReport(workspaceId: string, params: UsageReportParams, options?: RequestOptions) {
		return this.core.call(api.usageReport, { path: { workspace_id: workspaceId }, query: params }, options);
	}

	/** Reads one workspace. */
	get(workspaceId: string, options?: RequestOptions) {
		return this.core.call(api.getWorkspace, { path: { workspace_id: workspaceId } }, options);
	}

	/** Renames a workspace. */
	rename(workspaceId: string, params: api.RenameWorkspaceBody, options?: RequestOptions) {
		return this.core.call(api.renameWorkspace, { path: { workspace_id: workspaceId }, body: params }, options);
	}

	/** Deletes a workspace and everything it holds; the ledgers its sessions left behind stay. */
	delete(workspaceId: string, options?: RequestOptions) {
		return this.core.call(api.deleteWorkspace, { path: { workspace_id: workspaceId } }, options);
	}

	/** Lists a workspace's members, newest first. */
	listMembers(workspaceId: string, params?: ListWorkspaceMembersParams, options?: RequestOptions) {
		return this.core.page(
			api.listWorkspaceMembers,
			{ path: { workspace_id: workspaceId }, query: params },
			BY_ID,
			options,
		);
	}

	/** Adds an organization member to the workspace. */
	addMember(workspaceId: string, params: api.AddWorkspaceMemberBody, options?: RequestOptions) {
		return this.core.call(api.addWorkspaceMember, { path: { workspace_id: workspaceId }, body: params }, options);
	}

	/** Changes a member's workspace role. */
	changeMemberRole(
		workspaceId: string,
		userId: string,
		params: api.ChangeWorkspaceMemberRoleBody,
		options?: RequestOptions,
	) {
		return this.core.call(
			api.changeWorkspaceMemberRole,
			{ path: { workspace_id: workspaceId, user_id: userId }, body: params },
			options,
		);
	}

	/** Removes a member from the workspace. */
	removeMember(workspaceId: string, userId: string, options?: RequestOptions) {
		return this.core.call(api.removeWorkspaceMember, { path: { workspace_id: workspaceId, user_id: userId } }, options);
	}
}
