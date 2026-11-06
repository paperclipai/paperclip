import { isDeepStrictEqual } from "node:util";
import { createHash } from "node:crypto";
import { requestConfirmationPayloadSchema, askUserQuestionsPayloadSchema } from "../../packages/shared/src/validators/issue.js";
import type { RequestConfirmationInteraction, AskUserQuestionsInteraction } from "../../packages/shared/src/types/issue.js";
import type { ChatFlowInput, ChatIssue, ChatRun } from "./chat-flow.js";
import type { CredentialName } from "./types.js";
import type { ChatExternalInputRequirement } from "./chat-private-inputs.js";
import type { ChatScenario } from "./chat-feature-cases.js";

/** Lifecycle readiness permits an already-busy worker; this is not run completion proof. */
export function chatCatalogAgentIsReady(value: { lifecycleState?: string | null; status?: string | null; lifecycleError?: unknown }): boolean {
  return value.lifecycleState === "ready" && !value.lifecycleError
    && ["idle", "active", "running"].includes(value.status ?? "");
}

export interface ChatCatalogCheck { id: string; passed: boolean; detail: string }
export interface ChatCatalogGrade { passed: boolean; checks: ChatCatalogCheck[] }
export interface ChatCatalogContext {
  /** Original flow observation deadline; optional opt-in for bounded human followup acts. */
  readonly observationDeadlineAt?: number;
  input: ChatFlowInput;
  scenario: ChatScenario;
  issue(): ChatIssue | undefined;
  allRuns(): Promise<ChatRun[]>;
  refreshIssue(): Promise<void>;
  /** Available only to the two allowlisted native Slack ingress cases. */
  selectSlackSource?(issueId: string): Promise<void>;
}

/** These exact selected OpenCode/local journeys use the original flow clock for
 * native observation phases. Other cases/lanes keep their authored phase caps. */
const originalClockExecutionIds = new Set([
  "chat-features.runner-opencode.local.companies.export-company",
  "chat-features.runner-opencode.local.projects.project-defaults",
  "chat-features.runner-opencode.local.questions-and-approvals.ambiguous-yes",
  "chat-features.runner-opencode.local.questions-and-approvals.review-plan",
  "chat-features.runner-opencode.local.questions-and-approvals.necessary-question",
  "chat-features.runner-opencode.local.task-coordination.block-on-design",
  "chat-features.runner-opencode.local.gateways-profiles.rotate-token",
  "chat-features.runner-opencode.local.gateways-profiles.create-gateway",
  "chat-features.runner-opencode.local.workspaces.preview-service",
  "chat-features.runner-opencode.local.assistant-connections.consent-read-only",
  "chat-features.runner-opencode.local.navigation-preferences.quick-search",
  "chat-features.runner-opencode.local.navigation-preferences.edit-profile",
  "chat-features.runner-opencode.local.navigation-preferences.broken-link",
  "chat-features.runner-opencode.local.navigation-preferences.dismiss-announcement",
  "chat-features.runner-opencode.local.projects.share-project",
  "chat-features.runner-opencode.local.access.cli-authorization",
  "chat-features.runner-opencode.local.access.other-company",
  "chat-features.runner-opencode.local.access.private-resource",
  "chat-features.runner-opencode.local.agent-chat.conference-room",
  "chat-features.runner-opencode.local.agent-chat.track-delegated-work",
  "chat-features.runner-opencode.local.agents.agent-api-key",
  "chat-features.runner-opencode.local.agents.hire-needs-approval",
  "chat-features.runner-opencode.local.agents.pause-agent",
  "chat-features.runner-opencode.local.agents.retire-agent",
  "chat-features.runner-opencode.local.app-permissions.new-quarantined-action",
  "chat-features.runner-opencode.local.app-permissions.read-allowed-write-off",
  "chat-features.runner-opencode.local.app-permissions.test-as-agent",
  "chat-features.runner-opencode.local.assistant-connections.device-login",
  "chat-features.runner-opencode.local.budgets-costs.explain-hard-stop",
  "chat-features.runner-opencode.local.budgets-costs.set-budget",
  "chat-features.runner-opencode.local.cases.case-history",
  "chat-features.runner-opencode.local.inbox-search.archive-without-grant",
  "chat-features.runner-opencode.local.inbox-search.show-my-work",
  "chat-features.runner-opencode.local.tasks.ambiguous-task",
  "chat-features.runner-opencode.local.secrets.secret-proposal",
  "chat-features.runner-opencode.local.developer-labs.long-thread-performance",
  "chat-features.runner-opencode.local.questions-and-approvals.approve-tool-once",
  "chat-features.runner-opencode.local.runs-adapters.reset-session",
  "chat-features.runner-opencode.local.tasks.website-without-project",
  "chat-features.runner-opencode.local.inbox-search.archive-partial-failure",
  "chat-features.runner-opencode.local.cli-operations.feedback-bundle",
  "chat-features.runner-opencode.local.cli-operations.inspect-run-cli",
  "chat-features.runner-opencode.local.cli-operations.owned-dev-instance",
  "chat-features.runner-opencode.local.developer-labs.component-reference",
  "chat-features.runner-opencode.local.developer-labs.gated-lab",
  "chat-features.runner-opencode.local.developer-labs.interaction-fixture",
  "chat-features.runner-opencode.local.recovery.browser-reconnect",
  "chat-features.runner-opencode.local.recovery.controller-restart",
  "chat-features.runner-opencode.local.recovery.explain-stall",
  "chat-features.runner-opencode.local.recovery.retry-exhausted",
  "chat-features.runner-opencode.local.recovery.source-action",
  "chat-features.runner-opencode.local.routines.pause-owned",
  "chat-features.runner-opencode.local.routines.run-now",
  "chat-features.runner-opencode.local.steering.queue-follow-up",
  "chat-features.runner-opencode.local.steering.stop-versus-pause",
  "chat-features.runner-opencode.local.task-coordination.delegate-with-context",
  "chat-features.runner-opencode.local.task-coordination.independent-review",
  "chat-features.runner-opencode.local.task-coordination.pause-tree",
  "chat-features.runner-opencode.local.tasks.edit-properties",
  "chat-features.runner-opencode.local.steering.edit-queued-message",
  "chat-features.runner-opencode.local.steering.discard-queued-message",
  "chat-features.runner-opencode.local.instance-operations.backup-and-restore",
  "chat-features.runner-opencode.local.instance-operations.restart-service",
  "chat-features.runner-opencode.local.routines.webhook-trigger",
  "chat-features.runner-opencode.local.status-cards.explain-card",
  "chat-features.runner-opencode.local.secrets.configure-company-secret",
  "chat-features.runner-opencode.local.teams.configure-team",
  "chat-features.runner-opencode.local.steering.interrupt-with-direction",
  "chat-features.runner-opencode.local.companies.fast-responses",
]);
function usesOriginalNativePhaseClock(ctx: ChatCatalogContext): boolean {
  return originalClockExecutionIds.has(ctx.input?.execution?.id);
}
export function chatCatalogNativePhaseDeadline(ctx: ChatCatalogContext, legacyDeadlineAt: number): number {
  if (!usesOriginalNativePhaseClock(ctx)) return legacyDeadlineAt;
  const deadline = ctx.observationDeadlineAt, now = Date.now();
  if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original native observation budget exhausted or missing");
  return deadline!;
}
/** Recheck the same clock before each declared human send operation. */
export function chatCatalogNativePhaseRemainingBudget(ctx: ChatCatalogContext): (() => number) | undefined {
  if (!usesOriginalNativePhaseClock(ctx)) return undefined;
  return () => {
    const now = Date.now(), deadline = ctx.observationDeadlineAt;
    if (!Number.isFinite(deadline) || deadline! <= now) throw new Error("Original native observation budget exhausted or missing");
    return deadline! - now;
  };
}
/** Only explicitly selected lanes opt identity helpers into the original clock. */
export function chatCatalogOriginalPhaseDeadline(ctx: ChatCatalogContext): number | undefined {
  return usesOriginalNativePhaseClock(ctx) ? chatCatalogNativePhaseDeadline(ctx, 0) : undefined;
}
export function chatCatalogNativePhaseIsTimely(ctx: ChatCatalogContext): boolean {
  return !usesOriginalNativePhaseClock(ctx) || Number.isFinite(ctx.observationDeadlineAt) && Date.now() < ctx.observationDeadlineAt!;
}

export type ChatCatalogTerminalRunStatus = "succeeded" | "cancelled" | "failed" | "timed_out";
export type ChatCatalogRunPolicy =
  | { kind: "terminal-counts"; terminalStatusCounts: Partial<Record<ChatCatalogTerminalRunStatus, number>> }
  | { kind: "source-settled-with-active-work"; maximumActiveWorkerRuns: number;
      expectedWorkerCancellation?: "owned-task-reassignment" };
export interface ChatCatalogExpectedWorkerCancellation {
  runId: string; taskId: string; workerId: string; sourceRunId: string;
}
export interface ChatCatalogSetupPolicy {
  funding?: "standard" | "preserve-scenario";
  readiness?: "all-ready" | "preserve-scenario";
  /** Required independent prerequisite checks when preserving a scenario-specific policy. */
  invariantCheckIds: readonly string[];
}
export type ChatCatalogQueryBinding = { catalogToken: string; stateKey: string } & (
  | { resourceKind: "issue"; valueField: "identifier" }
  | { resourceKind: "project-repository"; valueField: "fullName" }
  | { resourceKind: "agentmail-recipient"; valueField: "email" }
);
export interface ChatCatalogQueryAttachment {
  /** A genuine UI upload receipt returned by setup; never arbitrary body text. */
  stateKey: string;
  filename: string;
}
export interface ChatCompanionSurface { kind: "scoped-external-assistant"; model: string; maximumModelTurns: 6; maximumToolCalls: 4; maximumOutputTokens: 2048 }
export interface ChatCompanionResult {
  query: string; reply: string; model: string; usage: { inputTokens: number; outputTokens: number };
  messages: Array<{ role: "system" | "user" | "assistant" | "tool"; content: string }>;
  providerResponseIds: string[]; toolCalls: Array<{ name: string; arguments: unknown; result: unknown }>; links: string[];
}
export interface ChatSlackIngress { kind: "native-slack-thread"; maximumProviderCalls: 20; ingressTimeoutMs: 120000; setupThread?: "same-agent-distractor" }
export interface ChatSlackIngressReceipt {
  query: string; endpointId: string; conversationId: string; issueId: string; humanCommentId: string; linkedPaperclipUserId: string; providerCalls: number;
  provider: { workspaceId: string; channelId: string; threadId: string; canonicalMessageId: string; senderUserId: string };
}
/** One concrete scenario, with production API setup and a case-specific independent oracle. */
export interface NativeStopBoundaryReceipt { runId: string; issueId: string; intentId: string; intentRecordedAt: string }
export interface ChatCatalogCase {
  /** Only post-stop-message: Stop the genuine same-source setup turn after bookkeeping, then send the unchanged canonical query. */
  canonicalBoundary?: "native-stop-cleanup";
  beforeCanonicalSend?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<NativeStopBoundaryReceipt>;
  scenarioId: string;
  /** Real browser locale context for the canonical person's schedule. */
  browserTimezone?: "America/Chicago";
  respondingAgent?: { kind: "case-primary-owner"; name: "Morgan"; role: "engineer"; canAssignTasks: true };
  requiredCredentials?: readonly CredentialName[];
  externalInput?: ChatExternalInputRequirement;
  installedSource?: "published-global-npm";
  journeyKind?: "agent-chat" | "scoped-external-assistant" | "native-slack-thread";
  slackIngress?: ChatSlackIngress;
  /** Only reply-in-thread: one real other-source setup exchange, included in total native bounds. */
  dispatchSlackOtherThread?(context: ChatCatalogContext, state: Record<string, unknown>, input: { query: string; signal: AbortSignal }): Promise<ChatSlackIngressReceipt & { runId: string }>;
  dispatchSlackQuery?(context: ChatCatalogContext, state: Record<string, unknown>, input: { query: string; signal: AbortSignal }): Promise<ChatSlackIngressReceipt>;
  companionSurface?: ChatCompanionSurface;
  runCompanionSurface?(context: ChatCatalogContext, state: Record<string, unknown>, input: { query: string; signal: AbortSignal }): Promise<ChatCompanionResult>;
  /** Only channel-file: independently settle the supported transfer before a second actual upload. */
  verifySlackSupportedTransfer?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<ChatCatalogGrade>;
  dispatchSlackUnsupportedFile?(context: ChatCatalogContext, state: Record<string, unknown>, input: { query: string; signal: AbortSignal }): Promise<ChatSlackIngressReceipt>;
  authentication?: "local-trusted" | "human-session";
  setupPolicy?: ChatCatalogSetupPolicy;
  runPolicy?: ChatCatalogRunPolicy;
  /** Only edit-properties: independent observation proof of the exact reassigned worker. */
  expectedCancelledWorkerRun?(observation: unknown): ChatCatalogExpectedWorkerCancellation | undefined;
  queryOutcome?: "persisted" | "rejected";
  /** Audited substitution of an incidental catalog fixture token, never other prose. */
  queryBindings?: readonly ChatCatalogQueryBinding[];
  queryAttachments?: readonly ChatCatalogQueryAttachment[];
  /** All case/grader helpers must be listed; the suite also fingerprints its complete source tree. */
  sourceFiles: readonly string[];
  oracleVersion: string;
  /** Known missing catalog conditions keep this executable diagnostic case from acceptance. */
  coverageGaps?: readonly string[];
  expectedRunCount: number;
  /** Persisted human comments; explicit followups must be declared before execution. */
  expectedHumanMessageCount?: number;
  expectedHumanQuestionAnswer?(observation: unknown): ChatCatalogExpectedHumanQuestionAnswer | undefined;
  optionalCompanySecretBindingApproval?: true;
  expectedCompanySecretBindingApproval?(observation: unknown): ChatCatalogExpectedCompanySecretBindingApproval | undefined;
  /** Genuine persisted human setup turns before the canonical query; included in the total above. */
  setupHumanMessageCount?: number;
  minimumRunCount?: number;
  turnTimeoutMs: number;
  attemptTimeoutMs: number;
  verifySetup?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<ChatCatalogGrade>;
  verifyQueryRejection?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<ChatCatalogGrade>;
  setup(context: ChatCatalogContext): Promise<Record<string, unknown>>;
  /** Only explicit scenario user followups/approvals through visible production UI. */
  act?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<void>;
  observe(context: ChatCatalogContext, state: Record<string, unknown>): Promise<unknown>;
  grade(observation: unknown): ChatCatalogGrade;
  /** Open the actual linked result through the browser and verify its identity. */
  verifyResult(context: ChatCatalogContext, state: Record<string, unknown>, observation: unknown): Promise<void>;
  cleanup?(context: ChatCatalogContext, state: Record<string, unknown>): Promise<void>;
}

export function validateChatCatalogGrade(grade: ChatCatalogGrade): ChatCatalogGrade {
  if (!grade || !Array.isArray(grade.checks) || grade.checks.length === 0
    || grade.checks.some(check => !check.id || typeof check.passed !== "boolean" || !check.detail)
    || new Set(grade.checks.map(check => check.id)).size !== grade.checks.length
    || grade.passed !== grade.checks.every(check => check.passed)) {
    throw new Error("Invalid chat catalog oracle result: checks must be nonempty, unique and agree with the verdict");
  }
  return grade;
}

export interface ChatCatalogSetupBoundary { humanCommentIds: string[]; runIds: string[] }
export function validChatCatalogHumanCounts(implementation: Pick<ChatCatalogCase, "setupHumanMessageCount" | "expectedHumanMessageCount" | "queryOutcome"> & Partial<Pick<ChatCatalogCase,"scenarioId"|"optionalCompanySecretBindingApproval">>): boolean {
  const setup = implementation.setupHumanMessageCount ?? 0, total = implementation.expectedHumanMessageCount ?? 1;
  return (!implementation.optionalCompanySecretBindingApproval || implementation.scenarioId==="secrets.configure-company-secret"&&total===2&&setup===0)
    && Number.isSafeInteger(setup) && setup >= 0 && Number.isSafeInteger(total)
    && total >= setup + (implementation.queryOutcome === "rejected" ? 0 : 1);
}
export function chatCatalogAllowsHumanQuestionAnswer(scenarioId: string): boolean {
  return ["secrets.personal-secret", "secrets.configure-company-secret"].includes(scenarioId);
}
export function chatCatalogHumanHistoryMatches(input: {
  implementation: Pick<ChatCatalogCase, "setupHumanMessageCount" | "expectedHumanMessageCount" | "queryOutcome"> & Partial<Pick<ChatCatalogCase, "scenarioId" | "optionalCompanySecretBindingApproval">>;
  questionAnswer?: ChatCatalogVerifiedHumanQuestionAnswer;
  secretApproval?: ChatCatalogVerifiedCompanySecretBindingApproval;
  human: Array<{ id: string; body: string }>; runIds: string[];
  boundary: ChatCatalogSetupBoundary; renderedQuery: string;
}): boolean {
  const count = input.implementation.setupHumanMessageCount ?? 0;
  return (!input.secretApproval || input.implementation.scenarioId === "secrets.configure-company-secret" && input.implementation.optionalCompanySecretBindingApproval === true)
    && (!input.questionAnswer || chatCatalogAllowsHumanQuestionAnswer(input.implementation.scenarioId ?? ""))
    && (!input.questionAnswer?.personalSecretConfirmation || input.implementation.scenarioId === "secrets.personal-secret")
    && (!(input.questionAnswer?.companyEnvironmentNameAnswer||input.questionAnswer?.companySavedSecretNameAnswer) || input.implementation.scenarioId === "secrets.configure-company-secret")
    && validChatCatalogHumanCounts(input.implementation)
    && input.boundary.humanCommentIds.length === count
    && input.boundary.humanCommentIds.every((id, index) => input.human[index]?.id === id)
    && input.boundary.runIds.every(id => input.runIds.includes(id))
    && (input.implementation.queryOutcome === "rejected"
      ? input.human.length === count
      : input.human[count]?.body.trim() === input.renderedQuery.trim()
        && input.human.length + (input.questionAnswer ? 1 : 0) === (input.implementation.expectedHumanMessageCount ?? 1));
}

export function chatCatalogHumanQuestionPolicies(row: { resolverPolicy?: unknown; requestedResolverPolicy?: unknown; effectiveResolverPolicy?: unknown }): boolean {
  return [row.resolverPolicy, row.requestedResolverPolicy ?? row.resolverPolicy, row.effectiveResolverPolicy ?? row.resolverPolicy]
    .every(policy => policy === "anyone" || policy === "human_only");
}

export function chatCatalogHasExactDefinitionId(text: string, definitionId: string): boolean {
  return !!definitionId && new RegExp(`(?<![A-Za-z0-9_-])${definitionId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`).test(text);
}

export function chatCatalogSavedSecretNameIntent(text:string):boolean {
 const prompt=text.replace(/\bnot (?:the )?value\b/gi,"");
 const recipients=[...prompt.replace(/Deployment API key/g,"credential").matchAll(/\b(?:[Ff]or|[Tt]o)\s+(?:[Aa]gent\s+)?([A-Z][A-Za-z0-9_-]*)\b/g)];
 return recipients.every(match=>match[1]==="Morgan")&&prompt.length<=400&&/\b(?:secret|credential|key)\b/i.test(prompt)
  &&(/\b(?:name|alias|identifier|label)\b/i.test(prompt)||/\bkey\b[^.!?]{0,50}\bunder\b/i.test(prompt))
  &&/\b(?:saved?|stored?|created?|added|used?|under)\b/i.test(prompt)
  &&!/\b(?:value|plaintext|password|CEO|Riley|Jordan|another|other person)\b/i.test(prompt);
}
export interface ChatCatalogExpectedHumanQuestionAnswer { interactionId: string; sourceRunId: string; userId: string; personalSecretConfirmation?: { definitionId: string; secretId: string; payloadHash: string }; companyEnvironmentNameAnswer?: { questionId: string; payloadHash: string; value: "DEPLOYMENT_API_KEY" }; companySavedSecretNameAnswer?: { questionId: string; payloadHash: string; value: string; secretId: string } }
export interface ChatCatalogVerifiedHumanQuestionAnswer extends ChatCatalogExpectedHumanQuestionAnswer { continuationRunId: string; resolvedAt: string }
export interface ChatCatalogHumanQuestionAudit {
  companyId?: string; entityId?: string; action?: string; actorType?: string; actorId?: string;
  details?: Record<string, unknown> | null;
}
export function verifyChatCatalogHumanQuestionAnswer(input: {
  expected: ChatCatalogExpectedHumanQuestionAnswer; companyId: string; issueId: string; agentId: string;
  canonicalComment: { id: string; authorUserId?: string };
  personalSecrets?: Array<{ definition: { id: string }; secret: { id: string; companyId: string; scope: string; ownerUserId?: string | null; userSecretDefinitionId?: string | null; status: string; createdAt: string } | null }>;
  companySecrets?: Array<{id:string;companyId:string;scope:string;key:string;status:string;createdByUserId?:string|null;createdAt:string}>;
  interactions: Array<Partial<AskUserQuestionsInteraction>>; activity: ChatCatalogHumanQuestionAudit[];
  runs: Array<{ id: string; companyId?: string; agentId: string; status: string; runtimeMode?: string; startedAt?: string | null; contextSnapshot?: Record<string, unknown> | null }>;
}): ChatCatalogVerifiedHumanQuestionAnswer | undefined {
  if (input.expected.personalSecretConfirmation) {
    const b = input.expected, binding = b.personalSecretConfirmation!, rows = input.interactions.filter(row => row.id === b.interactionId);
    const row = rows[0] as unknown as Partial<RequestConfirmationInteraction> | undefined;
    const source = input.runs.find(run => run.id === b.sourceRunId), continuations = input.runs.filter(run => run.contextSnapshot?.interactionId === b.interactionId), continuation = continuations[0];
    const entries = input.personalSecrets?.filter(entry => entry.definition.id === binding.definitionId), secret = entries?.[0]?.secret;
    const audits = input.activity.filter(event => event.action === "issue.thread_interaction_accepted" && event.details?.interactionId === b.interactionId), audit = audits[0];
    const resolvedAt = Date.parse(String(row?.resolvedAt));
    if (b.companyEnvironmentNameAnswer || b.companySavedSecretNameAnswer || rows.length !== 1 || !row || row.kind !== "request_confirmation" || row.status !== "accepted"
      || row.companyId !== input.companyId || row.issueId !== input.issueId || row.sourceRunId !== b.sourceRunId || row.createdByAgentId !== input.agentId || row.createdByUserId
      || (row.addresseeUserId != null && row.addresseeUserId !== b.userId) || row.addresseeAgentId || !row.originCommentIds?.includes(input.canonicalComment.id)
      || b.userId !== input.canonicalComment.authorUserId || !chatCatalogHumanQuestionPolicies(row) || row.continuationPolicy !== "wake_assignee"
      || row.resolvedByUserId !== b.userId || row.resolvedByAgentId || row.result?.outcome !== "accepted" || row.result.resumeFailure || row.dismissedAt
      || !row.payload || row.payload.target || row.payload.toolAction || row.payload.secretProposal || row.payload.connectionAuthorization || row.payload.qualityReview
      || !chatCatalogHasExactDefinitionId([row.payload.prompt, row.payload.detailsMarkdown].filter(Boolean).join("\n"), binding.definitionId) || createHash("sha256").update(JSON.stringify(row.payload)).digest("hex") !== binding.payloadHash
      || entries?.length !== 1 || !secret || secret.id !== binding.secretId || secret.companyId !== input.companyId || secret.scope !== "user" || secret.status !== "active"
      || secret.ownerUserId !== b.userId || secret.userSecretDefinitionId !== binding.definitionId || !Number.isFinite(Date.parse(secret.createdAt)) || !Number.isFinite(resolvedAt) || Date.parse(secret.createdAt) > resolvedAt || Date.parse(secret.createdAt) < Date.parse(source?.startedAt ?? "")
      || audits.length !== 1 || audit?.companyId !== input.companyId || audit.entityId !== input.issueId || audit.actorType !== "user" || audit.actorId !== b.userId || audit.details?.interactionKind !== "request_confirmation" || audit.details.interactionStatus !== "accepted"
      || !source || source.companyId !== input.companyId || source.agentId !== input.agentId || source.status !== "succeeded" || source.runtimeMode !== "native" || source.contextSnapshot?.issueId !== input.issueId || source.contextSnapshot.commentId !== input.canonicalComment.id
      || !Number.isFinite(Date.parse(source.startedAt ?? "")) || Date.parse(source.startedAt!) > resolvedAt
      || continuations.length !== 1 || !continuation || continuation.id === source.id || continuation.companyId !== input.companyId || continuation.agentId !== input.agentId || continuation.status !== "succeeded" || continuation.runtimeMode !== "native" || continuation.contextSnapshot?.issueId !== input.issueId
      || !Number.isFinite(Date.parse(continuation.startedAt ?? "")) || Date.parse(continuation.startedAt!) < resolvedAt) return;
    return { ...b, continuationRunId: continuation.id, resolvedAt: new Date(resolvedAt).toISOString() };
  }
  const b = input.expected, rows = input.interactions.filter(row => row.id === b.interactionId), row = rows[0];
  if (rows.length !== 1 || !row || b.userId !== input.canonicalComment.authorUserId
    || row.companyId !== input.companyId || row.issueId !== input.issueId || row.sourceRunId !== b.sourceRunId
    || row.createdByAgentId !== input.agentId || row.createdByUserId || row.addresseeUserId !== b.userId || row.addresseeAgentId
    || row.kind !== "ask_user_questions" || row.status !== "answered" || !chatCatalogHumanQuestionPolicies(row)
    || row.resolvedByUserId !== b.userId || row.resolvedByAgentId || row.result?.answers?.length !== 1) return;
  const source = input.runs.find(run => run.id === b.sourceRunId);
  const environmentName = b.companyEnvironmentNameAnswer, savedName=b.companySavedSecretNameAnswer;
  if(environmentName&&savedName)return;
  if (environmentName) {
    const parsed = askUserQuestionsPayloadSchema.safeParse(row.payload), qs = parsed.success ? parsed.data.questionSet : undefined;
    const q = qs?.questions[0], answer = row.result.answers[0];
    if (!qs || qs.questions.length !== 1 || !q || q.id !== environmentName.questionId || q.answerMode !== "text" || !q.required
      || q.options?.length || q.customAnswer?.enabled || q.initialText !== undefined
      || q.textValidation?.pattern !== "^[A-Za-z_][A-Za-z0-9_]*$" || q.textValidation.minLength !== 1
      || !q.textValidation.maxLength || q.textValidation.maxLength > 120 || q.textValidation.maxLength < 18
      || environmentName.value !== "DEPLOYMENT_API_KEY" || answer?.questionId !== q.id || answer.optionIds.length !== 0
      || answer.otherText !== environmentName.value || createHash("sha256").update(JSON.stringify(row.payload)).digest("hex") !== environmentName.payloadHash) return;
  } else if(savedName){
    const parsed=askUserQuestionsPayloadSchema.safeParse(row.payload),qs=parsed.success?parsed.data.questionSet:undefined,q=qs?.questions[0],answer=row.result.answers[0];
    const secrets=input.companySecrets?.filter(secret=>secret.id===savedName.secretId),secret=secrets?.[0];
    if(!qs||qs.questions.length!==1||!q||q.id!==savedName.questionId||q.answerMode!=="text"||!q.required||q.options?.length||q.customAnswer?.enabled||(q.initialText!==undefined&&q.initialText!==""&&!/^[a-zA-Z0-9_.-]{1,120}$/.test(q.initialText))
      ||!chatCatalogSavedSecretNameIntent(q.prompt)
      ||secrets?.length!==1||!secret||secret.companyId!==input.companyId||secret.scope!=="company"||secret.status!=="active"||secret.createdByUserId!==b.userId
      ||!Number.isFinite(Date.parse(String(row.createdAt)))||!Number.isFinite(Date.parse(source?.startedAt??""))||Date.parse(secret.createdAt)<=Math.max(Date.parse(String(row.createdAt)),Date.parse(source?.startedAt??""))
      ||secret.key!==savedName.value||!/^[a-zA-Z0-9_.-]{1,120}$/.test(secret.key)||!Number.isFinite(Date.parse(secret.createdAt))||Date.parse(secret.createdAt)>Date.parse(String(row.resolvedAt))
      ||answer?.questionId!==q.id||answer.optionIds.length!==0||answer.otherText!==secret.key||createHash("sha256").update(JSON.stringify(row.payload)).digest("hex")!==savedName.payloadHash)return;
  } else if (row.result.answers.some(answer => !!answer.otherText)) return;
  const resolvedAt = Date.parse(String(row.resolvedAt));
  const audits = input.activity.filter(event => event.details?.interactionId === b.interactionId && event.action === "issue.thread_interaction_answered");
  const audit = audits[0];
  if (!Number.isFinite(resolvedAt) || audits.length !== 1 || !audit || audit.companyId !== input.companyId || audit.entityId !== input.issueId
    || audit.actorType !== "user" || audit.actorId !== b.userId || audit.details?.interactionKind !== "ask_user_questions" || audit.details.interactionStatus !== "answered"
    || ((environmentName||savedName) && audit.details.answeredQuestionCount !== 1)) return;
  const continuations = input.runs.filter(run => run.contextSnapshot?.interactionId === b.interactionId), run = continuations[0];
  if (!source || source.companyId !== input.companyId || source.agentId !== input.agentId || source.runtimeMode !== "native" || source.status !== "succeeded"
    || source.contextSnapshot?.issueId !== input.issueId || source.contextSnapshot.commentId !== input.canonicalComment.id
    || !Number.isFinite(Date.parse(source.startedAt ?? "")) || Date.parse(source.startedAt!) > resolvedAt
    || continuations.length !== 1 || !run || run.id === source.id || run.companyId !== input.companyId || run.agentId !== input.agentId
    || run.runtimeMode !== "native" || run.status !== "succeeded" || run.contextSnapshot?.issueId !== input.issueId
    || !Number.isFinite(Date.parse(run.startedAt ?? "")) || Date.parse(run.startedAt!) < resolvedAt) return;
  return { ...b, continuationRunId: run.id, resolvedAt: new Date(resolvedAt).toISOString() };
}

export interface ChatCatalogExpectedCompanySecretBindingApproval {
 interactionId:string;proposalId:string;sourceRunId:string;initialRunId:string;userId:string;secretId:string;targetAgentId:string;configPath:string;payloadHash:string;humanInputId:string;humanInputKind:"comment"|"question";
}
export interface ChatCatalogVerifiedCompanySecretBindingApproval extends ChatCatalogExpectedCompanySecretBindingApproval {continuationRunId:string;resolvedAt:string}
export function verifyChatCatalogCompanySecretBindingApproval(input:{
 scenarioId:string;expected:ChatCatalogExpectedCompanySecretBindingApproval;companyId:string;issueId:string;agentId:string;
 interactions:Array<Partial<RequestConfirmationInteraction|AskUserQuestionsInteraction>>;proposals:Array<Partial<import("../../packages/shared/src/types/secrets.js").SecretProposalView>>;activity:Array<ChatCatalogHumanQuestionAudit&{createdAt?:string}>;
 comments:Array<{id:string;companyId?:string;issueId?:string;authorUserId?:string;authorAgentId?:string;createdByRunId?:string;createdAt:string}>;
 secrets:Array<{id:string;companyId:string;scope:string;status:string;createdByUserId?:string|null;createdAt:string}>;
 bindings:Array<{secretId:string;targetType:string;targetId:string;configPath:string;versionSelector:string|number}>;
 runs:Array<{id:string;companyId?:string;agentId:string;status:string;runtimeMode?:string;startedAt?:string|null;contextSnapshot?:Record<string,unknown>|null}>;
}):ChatCatalogVerifiedCompanySecretBindingApproval|undefined {
 const b=input.expected,row=input.interactions.find(q=>q.id===b.interactionId) as Partial<RequestConfirmationInteraction>|undefined,proposal=input.proposals.find(q=>q.id===b.proposalId),payload=row?.payload?.secretProposal;
 const first=input.runs.find(r=>r.id===b.initialRunId),source=input.runs.find(r=>r.id===b.sourceRunId),secret=input.secrets.find(r=>r.id===b.secretId);
 const human=b.humanInputKind==="comment"?input.comments.find(r=>r.id===b.humanInputId):undefined,question=b.humanInputKind==="question"?input.interactions.find(r=>r.id===b.humanInputId):undefined;
 const inputAt=Date.parse(String(human?.createdAt??question?.resolvedAt)),resolvedAt=Date.parse(String(row?.resolvedAt));
 const initialHuman=input.comments.find(c=>c.id===first?.contextSnapshot?.commentId),sourceAt=Date.parse(String(source?.startedAt)),cardAt=Date.parse(String(row?.createdAt)),firstAt=Date.parse(String(first?.startedAt));
 if(input.scenarioId!=="secrets.configure-company-secret"||![sourceAt,cardAt,firstAt,Date.parse(String(payload?.expiresAt))].every(Number.isFinite)||!requestConfirmationPayloadSchema.safeParse(row?.payload).success||!row||input.interactions.filter(q=>q.id===row.id).length!==1||row.kind!=="request_confirmation"||row.status!=="accepted"
  ||row.companyId!==input.companyId||row.issueId!==input.issueId||row.sourceRunId!==b.sourceRunId||row.createdByAgentId!==input.agentId||row.createdByUserId||row.addresseeAgentId||(row.addresseeUserId&&row.addresseeUserId!==b.userId)
  ||row.requestedResolverPolicy!=="human_only"||row.effectiveResolverPolicy!=="human_only"||row.continuationPolicy!=="wake_assignee"||row.idempotencyKey!==`secret-proposal:${b.proposalId}`
  ||row.resolvedByUserId!==b.userId||row.resolvedByAgentId||row.result?.outcome!=="accepted"||row.result?.secretProposal?.status!=="executed"||row.result.secretProposal.errorCode
  ||!payload||payload.proposalId!==b.proposalId||payload.targetAgentId!==b.targetAgentId||payload.configPath!==b.configPath||payload.targetAgentName!=="Morgan"||!/^env\.[_A-Za-z][_A-Za-z0-9]*$/.test(b.configPath)
  ||createHash("sha256").update(JSON.stringify(row.payload)).digest("hex")!==b.payloadHash||!Number.isFinite(resolvedAt)||resolvedAt<Date.parse(String(row.createdAt))||resolvedAt>Date.parse(payload.expiresAt)
  ||!proposal||input.proposals.filter(p=>p.id===b.proposalId).length!==1||proposal.companyId!==input.companyId||proposal.kind!=="binding"||proposal.status!=="approved"||proposal.secretId!==b.secretId||proposal.secretProposalId
  ||proposal.targetType!=="agent"||proposal.target?.id!==b.targetAgentId||proposal.configPath!==b.configPath||proposal.appliedBindingConfigPath!==b.configPath||proposal.originIssue?.id!==input.issueId||proposal.originRunId!==b.sourceRunId||proposal.proposedBy?.id!==input.agentId||proposal.resolvedByUserId!==b.userId
  ||!initialHuman||initialHuman.authorUserId!==b.userId||initialHuman.authorAgentId||initialHuman.createdByRunId||initialHuman.companyId!==input.companyId||initialHuman.issueId!==input.issueId||!first||first.companyId!==input.companyId||first.agentId!==input.agentId||first.status!=="succeeded"||first.runtimeMode!=="native"||first.contextSnapshot?.issueId!==input.issueId
  ||!secret||secret.companyId!==input.companyId||secret.scope!=="company"||secret.status!=="active"||secret.createdByUserId!==b.userId||!first||Date.parse(secret.createdAt)<=Date.parse(String(first.startedAt))||Date.parse(secret.createdAt)>=inputAt
  ||!Number.isFinite(inputAt)||(human?(human.companyId!==input.companyId||human.issueId!==input.issueId||human.authorUserId!==b.userId||!!human.authorAgentId||!!human.createdByRunId):!question||question.kind!=="ask_user_questions"||question.sourceRunId!==b.initialRunId||question.createdByAgentId!==input.agentId||question.status!=="answered"||question.resolvedByUserId!==b.userId||question.companyId!==input.companyId||question.issueId!==input.issueId)
  ||!source||source.id===first.id||source.companyId!==input.companyId||source.agentId!==input.agentId||source.runtimeMode!=="native"||source.status!=="succeeded"||source.contextSnapshot?.issueId!==input.issueId
  ||source.contextSnapshot[b.humanInputKind==="comment"?"commentId":"interactionId"]!==b.humanInputId||Date.parse(String(source.startedAt))<inputAt||Date.parse(String(row.createdAt))<Date.parse(String(source.startedAt)))return;
 const continuations=input.runs.filter(r=>r.contextSnapshot?.interactionId===b.interactionId),run=continuations[0];
 const accepted=input.activity.filter(a=>a.action==="issue.thread_interaction_accepted"&&a.details?.interactionId===b.interactionId);
 const approved=input.activity.filter(a=>a.action==="secret.proposal.approved"&&a.entityId===b.proposalId);
 const mutations=input.activity.filter(a=>/^agent\.(?:updated|config_updated|created|deleted)$/.test(a.action??"")&&Date.parse(String(a.createdAt))>=inputAt);
 if(!mutations.length||mutations.some(a=>a.companyId!==input.companyId||a.entityId!==b.targetAgentId||a.actorType!=="user"||a.actorId!==b.userId||a.details?.proposalId!==b.proposalId||a.details?.configPath!==b.configPath||Date.parse(String(a.createdAt))<resolvedAt)
  ||input.runs.length!==3||continuations.length!==1||!run||run.id===source.id||run.companyId!==input.companyId||run.agentId!==input.agentId||run.runtimeMode!=="native"||run.status!=="succeeded"||run.contextSnapshot?.issueId!==input.issueId||Date.parse(String(run.startedAt))<resolvedAt
  ||accepted.length!==1||accepted[0]?.companyId!==input.companyId||accepted[0].entityId!==input.issueId||accepted[0].actorType!=="user"||accepted[0].actorId!==b.userId
  ||approved.length!==1||approved[0]?.companyId!==input.companyId||approved[0].actorType!=="user"||approved[0].actorId!==b.userId||approved[0].details?.appliedBindingConfigPath!==b.configPath
  ||input.bindings.length!==1||input.bindings[0]?.secretId!==b.secretId||input.bindings[0].targetType!=="agent"||input.bindings[0].targetId!==b.targetAgentId||input.bindings[0].configPath!==b.configPath||input.bindings[0].versionSelector!=="latest")return;
 return {...b,continuationRunId:run.id,resolvedAt:String(row.resolvedAt)};
}

export async function collectChatCatalogCompanySecretApprovalActivity(api:Pick<ChatFlowInput["api"],"get">,companyId:string,issueId:string){
 const [issue,company]=await Promise.all([api.get<Array<ChatCatalogHumanQuestionAudit&{id:string;createdAt:string}>>(`/api/issues/${issueId}/activity`),api.get<Array<ChatCatalogHumanQuestionAudit&{id:string;createdAt:string}>>(`/api/companies/${companyId}/activity?limit=1000`)]);
 const rows=new Map<string,ChatCatalogHumanQuestionAudit&{id:string;createdAt:string}>();
 for(const row of [...issue,...company]){
  if(!row.id||row.companyId!==companyId)throw new Error("Company approval audit scope mismatch");
  const before=rows.get(row.id),project=(v:typeof row)=>({companyId:v.companyId,entityId:v.entityId,action:v.action,actorType:v.actorType,actorId:v.actorId,createdAt:v.createdAt,details:v.details});
  if(before&&!isDeepStrictEqual(project(before),project(row)))throw new Error("Company approval audit identity changed");
  rows.set(row.id,row);
 }
 return [...rows.values()];
}
