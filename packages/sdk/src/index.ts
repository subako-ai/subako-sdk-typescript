export { AgentConfigError, type AgentVersionConfig, readAgentConfig } from "./agent-config.js";
export { SubakoClient } from "./client.js";
export type {
	ClientOptions,
	Credential,
	RequestOptions,
	SkillArchive,
	SubakoClientOptions,
	TokenSource,
} from "./core.js";
export {
	ClientOutdatedError,
	ConflictError,
	ForbiddenError,
	InternalError,
	InvalidRequestError,
	NotFoundError,
	SubakoConnectionError,
	SubakoError,
	type SubakoErrorInit,
	SubakoTimeoutError,
	toSubakoError,
	UnauthorizedError,
} from "./errors.js";
export {
	type ApprovalState,
	isRunning,
	type PendingApproval,
	pendingApprovals,
	type ToolCallResult,
	transcript,
	type TranscriptMessage,
	type TranscriptToolCall,
} from "./events.js";
export { Page } from "./pagination.js";
export type { IdCursor, IdPaged, PreviousPage } from "./pagination.js";
export { SubakoSessionClient, type SubakoSessionClientOptions } from "./session-client.js";
export {
	checkSkillFiles,
	packSkill,
	SKILL_MAX_FILE_BYTES,
	SKILL_MAX_FILES,
	SKILL_MAX_TOTAL_BYTES,
	SKILL_MD,
	SkillArchiveError,
	SkillBundleError,
	type SkillBundleProblem,
	type SkillFile,
	unpackSkill,
} from "./skill-bundle.js";
// A Standard Schema is a protocol, not a library: these read one and are what the client
// itself runs, so a tool built by hand describes and refuses arguments exactly as it does.
export { describesItself, jsonSchemaOf, type Validated, validateSchema } from "./schema.js";
export type {
	ApprovalDecision,
	ConnectionStatus,
	ConnectOptions,
	HistoryWindow,
	SessionConnection,
	SessionState,
} from "./session.js";
// A tool's own `parameters`, or the ones its schema writes: with either spelling allowed,
// this is what the client publishes and what a caller should read.
export { parametersOf } from "./tool-client.js";
export type {
	ParsedTool,
	SchemaTool,
	ToolAnswer,
	ToolArguments,
	ToolCall,
	ToolCallState,
	ToolClient,
	ToolClientOptions,
	ToolClientState,
	ToolClientStatus,
	ToolDefinition,
	ToolParameters,
} from "./tool-client.js";
export { type ToolOrigin, toolOrigin, type ToolSource } from "./tool-origin.js";
export { VERSION } from "./version.js";

export type { Agents, ListAgentsParams, ListAgentVersionsParams } from "./resources/agents.js";
export type { ApiKeys, ListApiKeysParams } from "./resources/api-keys.js";
export type { Me } from "./resources/me.js";
export type { ListModelProvidersParams, ModelProviders } from "./resources/model-providers.js";
export type {
	ListInvitationsParams,
	ListMembersParams,
	ListUsageParams,
	Organization,
} from "./resources/organization.js";
// `SessionApi` is the half both clients bind: code that takes either a `SubakoClient`'s
// `sessions` or a whole `SubakoSessionClient` names this.
export type { ListSessionEventsParams, ListSessionsParams, SessionApi, Sessions } from "./resources/sessions.js";
export type { ListSkillsParams, ListSkillVersionsParams, Skills } from "./resources/skills.js";
export type { ListCredentialsParams, ListVaultsParams, Vaults } from "./resources/vaults.js";
export type {
	ListWorkspaceMembersParams,
	ListWorkspacesParams,
	ListWorkspaceUsageParams,
	Workspaces,
} from "./resources/workspaces.js";

// Request and response bodies stay the generated ones: the spec is their source
// of truth, and renaming them here would only invite drift.
export type {
	AddCredentialBody,
	AddWorkspaceMemberBody,
	AgentBody,
	AgentConfigBody,
	AgentSecurityBody,
	AgentVersionBody,
	AllowanceBody,
	AnthropicModelBody,
	AnthropicPriceBody,
	AnthropicThinkingBody,
	AnthropicUsageBody,
	ApiKeyBody,
	ApiKeyReceiptBody,
	ApprovalDecisionForm,
	CancelOutcomeBody,
	ChangeMemberRoleBody,
	ChangeWorkspaceMemberRoleBody,
	ClientCallResultBody,
	ClientLifetimeForm,
	ClientPingBody,
	ClientToolBody,
	ContentBlockBody,
	CreateAgentBody,
	CreatedSessionBody,
	CreatedSessionReceiptBody,
	CreditLotBody,
	CreditsBody,
	CreateInvitationBody,
	CreateSessionBody,
	CreateVaultBody,
	CreateWorkspaceBody,
	CreateWorkspaceModelProviderBodyWritable,
	CredentialBody,
	CredentialCreated,
	EnvironmentRefBody,
	ErrorBody,
	ErrorDetail,
	InvitationBody,
	McpGrantBody,
	MeBody,
	MemberRemovedBody,
	MessageBody,
	MintApiKeyBody,
	MintedApiKeyBody,
	ModelConfigBody,
	ModelPriceBody,
	ModelProviderBody,
	ModelProviderDetailsBody,
	ModelUsageBody,
	OpenaiResponsesModelBody,
	OpenaiResponsesPriceBody,
	OpenaiResponsesUsageBody,
	OrganizationBody,
	OrganizationPlanBody,
	OrgMemberBody,
	OrphanedApiKeyBody,
	PlanBody,
	PlanLimitBody,
	PlanListBody,
	PlatformModelBody,
	PostSessionEventBody,
	PublishAgentVersionBody,
	PutAgentSecurityBody,
	RegisterClientBody,
	RegisteredClientBody,
	RenameAgentBody,
	RenameOrganizationBody,
	RenameSkillBody,
	RenameWorkspaceBody,
	SandboxArchiveBody,
	SandboxGrantBody,
	SandboxNetworkBody,
	SessionBody,
	SessionEventBody,
	SessionEventPayloadBody,
	SessionSandboxBody,
	SessionSandboxListBody,
	SessionTokenBody,
	SessionTokenReceiptBody,
	SkillBody,
	SkillGrantBody,
	SkillVersionBody,
	SubmitOutcomeBody,
	ToolRuleBody,
	UpdateClientToolsBody,
	UpdateModelProviderBody,
	UpdateModelProviderBodyWritable,
	UpdateVaultBody,
	UsageEventBody,
	UsageResourceBody,
	VaultBody,
	VaultCreated,
	VersionPinBody,
	WorkspaceBody,
	WorkspaceMemberBody,
} from "./generated/index.js";
// Every enum the spec declares, without exception. Which of them a caller wants to
// compare a field against is the caller's business, not ours, and a list picked by
// hand would only answer "why that one and not this one". A new enum in the spec
// belongs here too: `spec-contract.test.ts` fails until it is added.
export {
	AnthropicEffortBody,
	ApprovalDecisionBody,
	AuthSchemeBody,
	ClientCallFailureBody,
	ClientLeaveReasonBody,
	CredentialCheckResult,
	CredentialStatusBody,
	CreditSourceBody,
	ErrorCode,
	InputSourceBody,
	KeyPermissionSchema,
	ModelProviderFormatBody,
	ModelProviderOwnerBody,
	ModelProviderTypeParam,
	OrderParam,
	OrgRoleBody,
	PlanResourceBody,
	PolicyActionBody,
	ProtocolBody,
	ReasoningEffortBody,
	RoleBody,
	SessionSandboxStatusBody,
	SessionStatusBody,
	SubmitKindBody,
	WorkspaceRoleBody,
} from "./generated/index.js";
