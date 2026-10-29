import type { Core, RequestOptions } from "../core.js";
import { BY_ID } from "../core.js";
import * as api from "../generated/index.js";
import type { IdPaged } from "../pagination.js";

export type ListInvitationsParams = IdPaged<NonNullable<api.ListInvitationsData["query"]>>;
export type ListMembersParams = IdPaged<NonNullable<api.ListMembersData["query"]>>;
export type ListUsageParams = IdPaged<NonNullable<api.ListUsageData["query"]>>;
export type ListAuditLogsParams = IdPaged<NonNullable<api.ListAuditLogsData["query"]>>;

/** The caller's organization: its members, invitations, plan, credits, usage, and audit log. */
export class Organization {
	constructor(private readonly core: Core) {}

	/** Reads the caller's organization. */
	get(options?: RequestOptions) {
		return this.core.call(api.getOrganization, {}, options);
	}

	/** Renames the organization. */
	rename(params: api.RenameOrganizationBody, options?: RequestOptions) {
		return this.core.call(api.renameOrganization, { body: params }, options);
	}

	/** Lists invitations, newest first; `order: "asc"` walks the other way. */
	listInvitations(params?: ListInvitationsParams, options?: RequestOptions) {
		return this.core.page(api.listInvitations, { query: params }, BY_ID, options);
	}

	/** Invites an email address to the organization. */
	createInvitation(params: api.CreateInvitationBody, options?: RequestOptions) {
		return this.core.call(api.createInvitation, { body: params }, options);
	}

	/** Revokes a pending invitation. */
	revokeInvitation(invitationId: string, options?: RequestOptions) {
		return this.core.call(api.revokeInvitation, { path: { invitation_id: invitationId } }, options);
	}

	/** Lists organization members, newest first. */
	listMembers(params?: ListMembersParams, options?: RequestOptions) {
		return this.core.page(api.listMembers, { query: params }, BY_ID, options);
	}

	/** Changes a member's organization role. */
	changeMemberRole(userId: string, params: api.ChangeMemberRoleBody, options?: RequestOptions) {
		return this.core.call(api.changeMemberRole, { path: { user_id: userId }, body: params }, options);
	}

	/** Removes a member; keys they minted stay live and are listed in the answer. */
	removeMember(userId: string, options?: RequestOptions) {
		return this.core.call(api.removeMember, { path: { user_id: userId } }, options);
	}

	/** Reads the organization's plan, and how much of each resource it holds against the plan's caps. */
	getPlan(options?: RequestOptions) {
		return this.core.call(api.getOrganizationPlan, {}, options);
	}

	/** Lists every plan the deployment offers, in the order its catalog declares them, each with its caps. */
	listPlans(options?: RequestOptions) {
		return this.core.call(api.listPlans, {}, options);
	}

	/** Reads the credit balance and the lots behind it. */
	getCredits(options?: RequestOptions) {
		return this.core.call(api.getCredits, {}, options);
	}

	/** Lists usage events across the organization, newest first. */
	listUsage(params?: ListUsageParams, options?: RequestOptions) {
		return this.core.page(api.listUsage, { query: params }, BY_ID, options);
	}

	/**
	 * Lists the organization's audit log, newest first: what was done over the last year, by which
	 * credential, and whether it was allowed. Needs `org.audit.read`, which organization admins hold.
	 * {@link auditEventOf} reads an entry's action and details.
	 */
	listAuditLogs(params?: ListAuditLogsParams, options?: RequestOptions) {
		return this.core.page(api.listAuditLogs, { query: params }, BY_ID, options);
	}
}
