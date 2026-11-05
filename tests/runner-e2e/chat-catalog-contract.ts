import { createHash } from "node:crypto";
import { askUserQuestionsPayloadSchema } from "../../packages/shared/src/validators/issue.js";
import type { AskUserQuestionsInteraction } from "../../packages/shared/src/types/issue.js";
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
export function validChatCatalogHumanCounts(implementation: Pick<ChatCatalogCase, "setupHumanMessageCount" | "expectedHumanMessageCount" | "queryOutcome">): boolean {
  const setup = implementation.setupHumanMessageCount ?? 0, total = implementation.expectedHumanMessageCount ?? 1;
  return Number.isSafeInteger(setup) && setup >= 0 && Number.isSafeInteger(total)
    && total >= setup + (implementation.queryOutcome === "rejected" ? 0 : 1);
}
export function chatCatalogAllowsHumanQuestionAnswer(scenarioId: string): boolean {
  return ["secrets.personal-secret", "secrets.configure-company-secret"].includes(scenarioId);
}
export function chatCatalogHumanHistoryMatches(input: {
  implementation: Pick<ChatCatalogCase, "setupHumanMessageCount" | "expectedHumanMessageCount" | "queryOutcome"> & Partial<Pick<ChatCatalogCase, "scenarioId">>;
  questionAnswer?: ChatCatalogVerifiedHumanQuestionAnswer;
  human: Array<{ id: string; body: string }>; runIds: string[];
  boundary: ChatCatalogSetupBoundary; renderedQuery: string;
}): boolean {
  const count = input.implementation.setupHumanMessageCount ?? 0;
  return (!input.questionAnswer || chatCatalogAllowsHumanQuestionAnswer(input.implementation.scenarioId ?? ""))
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

export interface ChatCatalogExpectedHumanQuestionAnswer { interactionId: string; sourceRunId: string; userId: string; companyEnvironmentNameAnswer?: { questionId: string; payloadHash: string; value: "DEPLOYMENT_API_KEY" }; companySavedSecretNameAnswer?: { questionId: string; payloadHash: string; value: string; secretId: string } }
export interface ChatCatalogVerifiedHumanQuestionAnswer extends ChatCatalogExpectedHumanQuestionAnswer { continuationRunId: string; resolvedAt: string }
export interface ChatCatalogHumanQuestionAudit {
  companyId?: string; entityId?: string; action?: string; actorType?: string; actorId?: string;
  details?: Record<string, unknown> | null;
}
export function verifyChatCatalogHumanQuestionAnswer(input: {
  expected: ChatCatalogExpectedHumanQuestionAnswer; companyId: string; issueId: string; agentId: string;
  canonicalComment: { id: string; authorUserId?: string };
  companySecrets?: Array<{id:string;companyId:string;scope:string;key:string;status:string;createdByUserId?:string|null;createdAt:string}>;
  interactions: Array<Partial<AskUserQuestionsInteraction>>; activity: ChatCatalogHumanQuestionAudit[];
  runs: Array<{ id: string; companyId?: string; agentId: string; status: string; runtimeMode?: string; startedAt?: string | null; contextSnapshot?: Record<string, unknown> | null }>;
}): ChatCatalogVerifiedHumanQuestionAnswer | undefined {
  const b = input.expected, rows = input.interactions.filter(row => row.id === b.interactionId), row = rows[0];
  if (rows.length !== 1 || !row || b.userId !== input.canonicalComment.authorUserId
    || row.companyId !== input.companyId || row.issueId !== input.issueId || row.sourceRunId !== b.sourceRunId
    || row.createdByAgentId !== input.agentId || row.createdByUserId || row.addresseeUserId !== b.userId || row.addresseeAgentId
    || row.kind !== "ask_user_questions" || row.status !== "answered" || !chatCatalogHumanQuestionPolicies(row)
    || row.resolvedByUserId !== b.userId || row.resolvedByAgentId || row.result?.answers?.length !== 1) return;
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
    if(!qs||qs.questions.length!==1||!q||q.id!==savedName.questionId||q.answerMode!=="text"||!q.required||q.options?.length||q.customAnswer?.enabled||q.initialText!==undefined
      ||!/^What (?:secret )?key name did you save the deployment (?:API )?key under\?$/i.test(q.prompt)
      ||secrets?.length!==1||!secret||secret.companyId!==input.companyId||secret.scope!=="company"||secret.status!=="active"||secret.createdByUserId!==b.userId
      ||secret.key!==savedName.value||!/^[a-zA-Z0-9_.-]{1,120}$/.test(secret.key)||!Number.isFinite(Date.parse(secret.createdAt))||Date.parse(secret.createdAt)>Date.parse(String(row.resolvedAt))
      ||answer?.questionId!==q.id||answer.optionIds.length!==0||answer.otherText!==secret.key||createHash("sha256").update(JSON.stringify(row.payload)).digest("hex")!==savedName.payloadHash)return;
  } else if (row.result.answers.some(answer => !!answer.otherText)) return;
  const resolvedAt = Date.parse(String(row.resolvedAt));
  const audits = input.activity.filter(event => event.details?.interactionId === b.interactionId && event.action === "issue.thread_interaction_answered");
  const audit = audits[0];
  if (!Number.isFinite(resolvedAt) || audits.length !== 1 || !audit || audit.companyId !== input.companyId || audit.entityId !== input.issueId
    || audit.actorType !== "user" || audit.actorId !== b.userId || audit.details?.interactionKind !== "ask_user_questions" || audit.details.interactionStatus !== "answered"
    || ((environmentName||savedName) && audit.details.answeredQuestionCount !== 1)) return;
  const source = input.runs.find(run => run.id === b.sourceRunId);
  const continuations = input.runs.filter(run => run.contextSnapshot?.interactionId === b.interactionId), run = continuations[0];
  if (!source || source.companyId !== input.companyId || source.agentId !== input.agentId || source.runtimeMode !== "native" || source.status !== "succeeded"
    || source.contextSnapshot?.issueId !== input.issueId || source.contextSnapshot.commentId !== input.canonicalComment.id
    || !Number.isFinite(Date.parse(source.startedAt ?? "")) || Date.parse(source.startedAt!) > resolvedAt
    || continuations.length !== 1 || !run || run.id === source.id || run.companyId !== input.companyId || run.agentId !== input.agentId
    || run.runtimeMode !== "native" || run.status !== "succeeded" || run.contextSnapshot?.issueId !== input.issueId
    || !Number.isFinite(Date.parse(run.startedAt ?? "")) || Date.parse(run.startedAt!) < resolvedAt) return;
  return { ...b, continuationRunId: run.id, resolvedAt: new Date(resolvedAt).toISOString() };
}
