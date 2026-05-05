import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, promises as fs, type Dirent } from "node:fs";
import path from "node:path";
import { sanitizeRemoteExecutionEnv } from "./remote-execution-env.js";
import { buildSshSpawnTarget, type SshRemoteExecutionSpec } from "./ssh.js";
import { redactCommandText } from "./command-redaction.js";
import type {
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "./types.js";

export interface RunProcessResult {
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
  pid: number | null;
  startedAt: string | null;
}

export interface TerminalResultCleanupOptions {
  hasTerminalResult: (output: { stdout: string; stderr: string }) => boolean;
  graceMs?: number;
}

interface RunningProcess {
  child: ChildProcess;
  graceSec: number;
  processGroupId: number | null;
}

interface SpawnTarget {
  command: string;
  args: string[];
  cwd?: string;
  cleanup?: () => Promise<void>;
}

type RemoteExecutionSpec = SshRemoteExecutionSpec;

type ChildProcessWithEvents = ChildProcess & {
  on(event: "error", listener: (err: Error) => void): ChildProcess;
  on(
    event: "exit",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): ChildProcess;
};

function resolveProcessGroupId(child: ChildProcess) {
  if (process.platform === "win32") return null;
  return typeof child.pid === "number" && child.pid > 0 ? child.pid : null;
}

function signalRunningProcess(
  running: Pick<RunningProcess, "child" | "processGroupId">,
  signal: NodeJS.Signals,
) {
  if (process.platform !== "win32" && running.processGroupId && running.processGroupId > 0) {
    try {
      process.kill(-running.processGroupId, signal);
      return;
    } catch {
      // Fall back to the direct child signal if group signaling fails.
    }
  }
  if (!running.child.killed) {
    running.child.kill(signal);
  }
}

export const runningProcesses = new Map<string, RunningProcess>();
export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_EXCERPT_BYTES = 32 * 1024;
const TERMINAL_RESULT_SCAN_OVERLAP_CHARS = 64 * 1024;
const SENSITIVE_ENV_KEY = /(key|token|secret|password|passwd|authorization|cookie)/i;
const REDACTED_LOG_VALUE = "***REDACTED***";
const PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES = [
  "../../skills",
  "../../../../../skills",
];
const MATERIALIZED_SKILL_SENTINEL = ".paperclip-materialized-skill.json";
const MATERIALIZED_SKILL_LOCK_OWNER = "owner.json";
const MATERIALIZED_SKILL_LOCK_STALE_MS = 30_000;

export const DEFAULT_PAPERCLIP_AGENT_PROMPT_TEMPLATE = [
  "You are agent {{agent.id}} ({{agent.name}}). Continue your Paperclip work.",
  "",
  "Execution contract:",
  "- Start actionable work in this heartbeat; do not stop at a plan unless the issue asks for planning.",
  "- Leave durable progress in comments, documents, or work products with a clear next action.",
  "- Prefer the smallest verification that proves the change; do not default to full workspace typecheck/build/test on every heartbeat unless the task scope warrants it.",
  "- Use child issues for parallel or long delegated work instead of polling agents, sessions, or processes.",
  "- If woken by a human comment on a dependency-blocked issue, respond or triage the comment without treating the blocked deliverable work as unblocked.",
  "- Create child issues directly when you know what needs to be done; use issue-thread interactions when the board/user must choose suggested tasks, answer structured questions, or confirm a proposal.",
  "- To ask for that input, create an interaction on the current issue with POST /api/issues/{issueId}/interactions using kind suggest_tasks, ask_user_questions, or request_confirmation. Use continuationPolicy wake_assignee when you need to resume after a response; for request_confirmation this resumes only after acceptance.",
  "- When you intentionally restart follow-up work on a completed assigned issue, include structured `resume: true` with the POST /api/issues/{issueId}/comments or PATCH /api/issues/{issueId} comment payload. Generic agent comments on closed issues are inert by default.",
  "- For plan approval, update the plan document first, then create request_confirmation targeting the latest plan revision with idempotencyKey confirmation:{issueId}:plan:{revisionId}. Wait for acceptance before creating implementation subtasks, and create a fresh confirmation after superseding board/user comments if approval is still needed.",
  "- If blocked, mark the issue blocked and name the unblock owner and action.",
  "- Respect budget, pause/cancel, approval gates, and company boundaries.",
].join("\n");

export interface PaperclipSkillEntry {
  key: string;
  runtimeName: string;
  source: string;
  required?: boolean;
  requiredReason?: string | null;
}

export interface InstalledSkillTarget {
  targetPath: string | null;
  kind: "symlink" | "directory" | "file";
}

export interface MaterializedPaperclipSkillCopyResult {
  copiedFiles: number;
  skippedSymlinks: string[];
}

interface PersistentSkillSnapshotOptions {
  adapterType: string;
  availableEntries: PaperclipSkillEntry[];
  desiredSkills: string[];
  installed: Map<string, InstalledSkillTarget>;
  skillsHome: string;
  locationLabel?: string | null;
  installedDetail?: string | null;
  missingDetail: string;
  externalConflictDetail: string;
  externalDetail: string;
  warnings?: string[];
}

function normalizePathSlashes(value: string): string {
  return value.replaceAll("\\", "/");
}

function isMaintainerOnlySkillTarget(candidate: string): boolean {
  return normalizePathSlashes(candidate).includes("/.agents/skills/");
}

function skillLocationLabel(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function buildManagedSkillOrigin(entry: { required?: boolean }): Pick<
  AdapterSkillEntry,
  "origin" | "originLabel" | "readOnly"
> {
  if (entry.required) {
    return {
      origin: "paperclip_required",
      originLabel: "Required by Paperclip",
      readOnly: false,
    };
  }
  return {
    origin: "company_managed",
    originLabel: "Managed by Paperclip",
    readOnly: false,
  };
}

function resolveInstalledEntryTarget(
  skillsHome: string,
  entryName: string,
  dirent: Dirent,
  linkedPath: string | null,
): InstalledSkillTarget {
  const fullPath = path.join(skillsHome, entryName);
  if (dirent.isSymbolicLink()) {
    return {
      targetPath: linkedPath ? path.resolve(path.dirname(fullPath), linkedPath) : null,
      kind: "symlink",
    };
  }
  if (dirent.isDirectory()) {
    return { targetPath: fullPath, kind: "directory" };
  }
  return { targetPath: fullPath, kind: "file" };
}

export function parseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

export function asString(value: unknown, fallback: string): string {
  return typeof value === "string" && value.length > 0 ? value : fallback;
}

export function asNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

export function asStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

export function parseJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function appendWithCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  return combined.length > cap ? combined.slice(combined.length - cap) : combined;
}

export function appendWithByteCap(prev: string, chunk: string, cap = MAX_CAPTURE_BYTES) {
  const combined = prev + chunk;
  const bytes = Buffer.byteLength(combined, "utf8");
  if (bytes <= cap) return combined;

  const buffer = Buffer.from(combined, "utf8");
  let start = Math.max(0, bytes - cap);
  while (start < buffer.length && (buffer[start]! & 0xc0) === 0x80) start += 1;
  return buffer.subarray(start).toString("utf8");
}

function resumeReadable(readable: { resume: () => unknown; destroyed?: boolean } | null | undefined) {
  if (!readable || readable.destroyed) return;
  readable.resume();
}

export function resolvePathValue(obj: Record<string, unknown>, dottedPath: string) {
  const parts = dottedPath.split(".");
  let cursor: unknown = obj;

  for (const part of parts) {
    if (typeof cursor !== "object" || cursor === null || Array.isArray(cursor)) {
      return "";
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }

  if (cursor === null || cursor === undefined) return "";
  if (typeof cursor === "string") return cursor;
  if (typeof cursor === "number" || typeof cursor === "boolean") return String(cursor);

  try {
    return JSON.stringify(cursor);
  } catch {
    return "";
  }
}

export function renderTemplate(template: string, data: Record<string, unknown>) {
  return template.replace(/{{\s*([a-zA-Z0-9_.-]+)\s*}}/g, (_, path) => resolvePathValue(data, path));
}

export function joinPromptSections(
  sections: Array<string | null | undefined>,
  separator = "\n\n",
) {
  return sections
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter(Boolean)
    .join(separator);
}

type PaperclipWakeIssue = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
};

type PaperclipWakeExecutionPrincipal = {
  type: "agent" | "user" | null;
  agentId: string | null;
  userId: string | null;
};

type PaperclipWakeExecutionStage = {
  wakeRole: "reviewer" | "approver" | "executor" | null;
  stageId: string | null;
  stageType: string | null;
  currentParticipant: PaperclipWakeExecutionPrincipal | null;
  returnAssignee: PaperclipWakeExecutionPrincipal | null;
  reviewRequest: {
    instructions: string;
  } | null;
  lastDecisionOutcome: string | null;
  allowedActions: string[];
};

type PaperclipWakeComment = {
  id: string | null;
  issueId: string | null;
  body: string;
  bodyTruncated: boolean;
  createdAt: string | null;
  authorType: string | null;
  authorId: string | null;
};

type PaperclipWakeContinuationSummary = {
  key: string | null;
  title: string | null;
  body: string;
  bodyTruncated: boolean;
  updatedAt: string | null;
};

type PaperclipWakeLivenessContinuation = {
  attempt: number | null;
  maxAttempts: number | null;
  sourceRunId: string | null;
  state: string | null;
  reason: string | null;
  instruction: string | null;
};

type PaperclipWakeChildIssueSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
  summary: string | null;
};

type PaperclipWakeBlockerSummary = {
  id: string | null;
  identifier: string | null;
  title: string | null;
  status: string | null;
  priority: string | null;
};

type PaperclipWakeTreeHoldSummary = {
  holdId: string | null;
  rootIssueId: string | null;
  mode: string | null;
  reason: string | null;
};

type PaperclipWakePayload = {
  reason: string | null;
  issue: PaperclipWakeIssue | null;
  checkedOutByHarness: boolean;
  dependencyBlockedInteraction: boolean;
  treeHoldInteraction: boolean;
  activeTreeHold: PaperclipWakeTreeHoldSummary | null;
  unresolvedBlockerIssueIds: string[];
  unresolvedBlockerSummaries: PaperclipWakeBlockerSummary[];
  executionStage: PaperclipWakeExecutionStage | null;
  continuationSummary: PaperclipWakeContinuationSummary | null;
  livenessContinuation: PaperclipWakeLivenessContinuation | null;
  childIssueSummaries: PaperclipWakeChildIssueSummary[];
  childIssueSummaryTruncated: boolean;
  commentIds: string[];
  latestCommentId: string | null;
  comments: PaperclipWakeComment[];
  requestedCount: number;
  includedCount: number;
  missingCount: number;
  truncated: boolean;
  fallbackFetchNeeded: boolean;
};

function normalizePaperclipWakeIssue(value: unknown): PaperclipWakeIssue | null {
  const issue = parseObject(value);
  const id = asString(issue.id, "").trim() || null;
  const identifier = asString(issue.identifier, "").trim() || null;
  const title = asString(issue.title, "").trim() || null;
  const status = asString(issue.status, "").trim() || null;
  const priority = asString(issue.priority, "").trim() || null;
  if (!id && !identifier && !title) return null;
  return {
    id,
    identifier,
    title,
    status,
    priority,
  };
}

function normalizePaperclipWakeComment(value: unknown): PaperclipWakeComment | null {
  const comment = parseObject(value);
  const author = parseObject(comment.author);
  const body = asString(comment.body, "");
  if (!body.trim()) return null;
  return {
    id: asString(comment.id, "").trim() || null,
    issueId: asString(comment.issueId, "").trim() || null,
    body,
    bodyTruncated: asBoolean(comment.bodyTruncated, false),
    createdAt: asString(comment.createdAt, "").trim() || null,
    authorType: asString(author.type, "").trim() || null,
    authorId: asString(author.id, "").trim() || null,
  };
}

function normalizePaperclipWakeContinuationSummary(value: unknown): PaperclipWakeContinuationSummary | null {
  const summary = parseObject(value);
  const body = asString(summary.body, "").trim();
  if (!body) return null;
  return {
    key: asString(summary.key, "").trim() || null,
    title: asString(summary.title, "").trim() || null,
    body,
    bodyTruncated: asBoolean(summary.bodyTruncated, false),
    updatedAt: asString(summary.updatedAt, "").trim() || null,
  };
}

function normalizePaperclipWakeLivenessContinuation(value: unknown): PaperclipWakeLivenessContinuation | null {
  const continuation = parseObject(value);
  const attempt = asNumber(continuation.attempt, 0);
  const maxAttempts = asNumber(continuation.maxAttempts, 0);
  const sourceRunId = asString(continuation.sourceRunId, "").trim() || null;
  const state = asString(continuation.state, "").trim() || null;
  const reason = asString(continuation.reason, "").trim() || null;
  const instruction = asString(continuation.instruction, "").trim() || null;
  if (!attempt && !maxAttempts && !sourceRunId && !state && !reason && !instruction) return null;
  return {
    attempt: attempt > 0 ? attempt : null,
    maxAttempts: maxAttempts > 0 ? maxAttempts : null,
    sourceRunId,
    state,
    reason,
    instruction,
  };
}

function normalizePaperclipWakeChildIssueSummary(value: unknown): PaperclipWakeChildIssueSummary | null {
  const child = parseObject(value);
  const id = asString(child.id, "").trim() || null;
  const identifier = asString(child.identifier, "").trim() || null;
  const title = asString(child.title, "").trim() || null;
  const status = asString(child.status, "").trim() || null;
  const priority = asString(child.priority, "").trim() || null;
  const summary = asString(child.summary, "").trim() || null;
  if (!id && !identifier && !title && !status && !summary) return null;
  return { id, identifier, title, status, priority, summary };
}

function normalizePaperclipWakeBlockerSummary(value: unknown): PaperclipWakeBlockerSummary | null {
  const blocker = parseObject(value);
  const id = asString(blocker.id, "").trim() || null;
  const identifier = asString(blocker.identifier, "").trim() || null;
  const title = asString(blocker.title, "").trim() || null;
  const status = asString(blocker.status, "").trim() || null;
  const priority = asString(blocker.priority, "").trim() || null;
  if (!id && !identifier && !title && !status) return null;
  return { id, identifier, title, status, priority };
}

function normalizePaperclipWakeTreeHoldSummary(value: unknown): PaperclipWakeTreeHoldSummary | null {
  const hold = parseObject(value);
  const holdId = asString(hold.holdId, "").trim() || null;
  const rootIssueId = asString(hold.rootIssueId, "").trim() || null;
  const mode = asString(hold.mode, "").trim() || null;
  const reason = asString(hold.reason, "").trim() || null;
  if (!holdId && !rootIssueId && !mode && !reason) return null;
  return { holdId, rootIssueId, mode, reason };
}

function normalizePaperclipWakeExecutionPrincipal(value: unknown): PaperclipWakeExecutionPrincipal | null {
  const principal = parseObject(value);
  const typeRaw = asString(principal.type, "").trim().toLowerCase();
  if (typeRaw !== "agent" && typeRaw !== "user") return null;
  return {
    type: typeRaw,
    agentId: asString(principal.agentId, "").trim() || null,
    userId: asString(principal.userId, "").trim() || null,
  };
}

function normalizePaperclipWakeExecutionStage(value: unknown): PaperclipWakeExecutionStage | null {
  const stage = parseObject(value);
  const wakeRoleRaw = asString(stage.wakeRole, "").trim().toLowerCase();
  const wakeRole =
    wakeRoleRaw === "reviewer" || wakeRoleRaw === "approver" || wakeRoleRaw === "executor"
      ? wakeRoleRaw
      : null;
  const allowedActions = Array.isArray(stage.allowedActions)
    ? stage.allowedActions
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const currentParticipant = normalizePaperclipWakeExecutionPrincipal(stage.currentParticipant);
  const returnAssignee = normalizePaperclipWakeExecutionPrincipal(stage.returnAssignee);
  const reviewRequestRaw = parseObject(stage.reviewRequest);
  const reviewInstructions = asString(reviewRequestRaw.instructions, "").trim();
  const reviewRequest = reviewInstructions ? { instructions: reviewInstructions } : null;
  const stageId = asString(stage.stageId, "").trim() || null;
  const stageType = asString(stage.stageType, "").trim() || null;
  const lastDecisionOutcome = asString(stage.lastDecisionOutcome, "").trim() || null;

  if (!wakeRole && !stageId && !stageType && !currentParticipant && !returnAssignee && !reviewRequest && !lastDecisionOutcome && allowedActions.length === 0) {
    return null;
  }

  return {
    wakeRole,
    stageId,
    stageType,
    currentParticipant,
    returnAssignee,
    reviewRequest,
    lastDecisionOutcome,
    allowedActions,
  };
}

export function normalizePaperclipWakePayload(value: unknown): PaperclipWakePayload | null {
  const payload = parseObject(value);
  const comments = Array.isArray(payload.comments)
    ? payload.comments
        .map((entry) => normalizePaperclipWakeComment(entry))
        .filter((entry): entry is PaperclipWakeComment => Boolean(entry))
    : [];
  const commentWindow = parseObject(payload.commentWindow);
  const commentIds = Array.isArray(payload.commentIds)
    ? payload.commentIds
        .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
        .map((entry) => entry.trim())
    : [];
  const executionStage = normalizePaperclipWakeExecutionStage(payload.executionStage);
  const continuationSummary = normalizePaperclipWakeContinuationSummary(payload.continuationSummary);
  const livenessContinuation = normalizePaperclipWakeLivenessContinuation(payload.livenessContinuation);
  const childIssueSummaries = Array.isArray(payload.childIssueSummaries)
    ? payload.childIssueSummaries
        .map((entry) => normalizePaperclipWakeChildIssueSummary(entry))
        .filter((entry): entry is PaperclipWakeChildIssueSummary => Boolean(entry))
    : [];
  const unresolvedBlockerIssueIds = Array.isArray(payload.unresolvedBlockerIssueIds)
    ? payload.unresolvedBlockerIssueIds
        .map((entry) => asString(entry, "").trim())
        .filter(Boolean)
    : [];
  const unresolvedBlockerSummaries = Array.isArray(payload.unresolvedBlockerSummaries)
    ? payload.unresolvedBlockerSummaries
        .map((entry) => normalizePaperclipWakeBlockerSummary(entry))
        .filter((entry): entry is PaperclipWakeBlockerSummary => Boolean(entry))
    : [];

  const activeTreeHold = normalizePaperclipWakeTreeHoldSummary(payload.activeTreeHold);
  if (comments.length === 0 && commentIds.length === 0 && childIssueSummaries.length === 0 && unresolvedBlockerIssueIds.length === 0 && unresolvedBlockerSummaries.length === 0 && !activeTreeHold && !executionStage && !continuationSummary && !livenessContinuation && !normalizePaperclipWakeIssue(payload.issue)) {
    return null;
  }

  return {
    reason: asString(payload.reason, "").trim() || null,
    issue: normalizePaperclipWakeIssue(payload.issue),
    checkedOutByHarness: asBoolean(payload.checkedOutByHarness, false),
    dependencyBlockedInteraction: asBoolean(payload.dependencyBlockedInteraction, false),
    treeHoldInteraction: asBoolean(payload.treeHoldInteraction, false),
    activeTreeHold,
    unresolvedBlockerIssueIds,
    unresolvedBlockerSummaries,
    executionStage,
    continuationSummary,
    livenessContinuation,
    childIssueSummaries,
    childIssueSummaryTruncated: asBoolean(payload.childIssueSummaryTruncated, false),
    commentIds,
    latestCommentId: asString(payload.latestCommentId, "").trim() || null,
    comments,
    requestedCount: asNumber(commentWindow.requestedCount, comments.length || commentIds.length),
    includedCount: asNumber(commentWindow.includedCount, comments.length),
    missingCount: asNumber(commentWindow.missingCount, 0),
    truncated: asBoolean(payload.truncated, false),
    fallbackFetchNeeded: asBoolean(payload.fallbackFetchNeeded, false),
  };
}

export function stringifyPaperclipWakePayload(value: unknown): string | null {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return null;
  return JSON.stringify(normalized);
}

export function renderPaperclipWakePrompt(
  value: unknown,
  options: { resumedSession?: boolean } = {},
): string {
  const normalized = normalizePaperclipWakePayload(value);
  if (!normalized) return "";
  const resumedSession = options.resumedSession === true;
  const executionStage = normalized.executionStage;
  const principalLabel = (principal: PaperclipWakeExecutionPrincipal | null) => {
    if (!principal || !principal.type) return "unknown";
    if (principal.type === "agent") return principal.agentId ? `agent ${principal.agentId}` : "agent";
    return principal.userId ? `user ${principal.userId}` : "user";
  };

  const lines = resumedSession
      ? [
        "## Paperclip Resume Delta",
        "",
        "You are resuming an existing Paperclip session.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Focus on the new wake delta below and continue the current task without restating the full heartbeat boilerplate.",
        "Fetch the API thread only when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        "Execution contract: take concrete action in this heartbeat when the issue is actionable; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action, use child issues instead of polling for long or parallel work, and mark blocked work with the unblock owner/action.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ]
    : [
        "## Paperclip Wake Payload",
        "",
        "Treat this wake payload as the highest-priority change for the current heartbeat.",
        "This heartbeat is scoped to the issue below. Do not switch to another issue until you have handled this wake.",
        "Before generic repo exploration or boilerplate heartbeat updates, acknowledge the latest comment and explain how it changes your next action.",
        "Use this inline wake data first before refetching the issue thread.",
        "Only fetch the API thread when `fallbackFetchNeeded` is true or you need broader history than this batch.",
        "",
        "Execution contract: take concrete action in this heartbeat when the issue is actionable; do not stop at a plan unless planning was requested. Leave durable progress with a clear next action, use child issues instead of polling for long or parallel work, and mark blocked work with the unblock owner/action.",
        "",
        `- reason: ${normalized.reason ?? "unknown"}`,
        `- issue: ${normalized.issue?.identifier ?? normalized.issue?.id ?? "unknown"}${normalized.issue?.title ? ` ${normalized.issue.title}` : ""}`,
        `- pending comments: ${normalized.includedCount}/${normalized.requestedCount}`,
        `- latest comment id: ${normalized.latestCommentId ?? "unknown"}`,
        `- fallback fetch needed: ${normalized.fallbackFetchNeeded ? "yes" : "no"}`,
      ];

  if (normalized.issue?.status) {
    lines.push(`- issue status: ${normalized.issue.status}`);
  }
  if (normalized.issue?.priority) {
    lines.push(`- issue priority: ${normalized.issue.priority}`);
  }
  if (normalized.checkedOutByHarness) {
    lines.push("- checkout: already claimed by the harness for this run");
  }
  if (normalized.dependencyBlockedInteraction) {
    lines.push("- dependency-blocked interaction: yes");
    lines.push("- execution scope: respond or triage the human comment; do not treat blocker-dependent deliverable work as unblocked");
    if (normalized.unresolvedBlockerSummaries.length > 0) {
      const blockers = normalized.unresolvedBlockerSummaries
        .map((blocker) => `${blocker.identifier ?? blocker.id ?? "unknown"}${blocker.title ? ` ${blocker.title}` : ""}${blocker.status ? ` (${blocker.status})` : ""}`)
        .join("; ");
      lines.push(`- unresolved blockers: ${blockers}`);
    } else if (normalized.unresolvedBlockerIssueIds.length > 0) {
      lines.push(`- unresolved blocker issue ids: ${normalized.unresolvedBlockerIssueIds.join(", ")}`);
    }
  }
  if (normalized.treeHoldInteraction) {
    lines.push("- tree-hold interaction: yes");
    lines.push("- execution scope: respond or triage the human comment; the subtree remains paused until an explicit resume action");
    if (normalized.activeTreeHold) {
      const hold = normalized.activeTreeHold;
      lines.push(`- active tree hold: ${hold.holdId ?? "unknown"}${hold.rootIssueId ? ` rooted at ${hold.rootIssueId}` : ""}${hold.mode ? ` (${hold.mode})` : ""}`);
    }
  }
  if (normalized.missingCount > 0) {
    lines.push(`- omitted comments: ${normalized.missingCount}`);
  }

  if (executionStage) {
    lines.push(
      `- execution wake role: ${executionStage.wakeRole ?? "unknown"}`,
      `- execution stage: ${executionStage.stageType ?? "unknown"}`,
      `- execution participant: ${principalLabel(executionStage.currentParticipant)}`,
      `- execution return assignee: ${principalLabel(executionStage.returnAssignee)}`,
      `- last decision outcome: ${executionStage.lastDecisionOutcome ?? "none"}`,
    );
    if (executionStage.allowedActions.length > 0) {
      lines.push(`- allowed actions: ${executionStage.allowedActions.join(", ")}`);
    }
    if (executionStage.reviewRequest) {
      lines.push(
        "",
        "Review request instructions:",
        executionStage.reviewRequest.instructions,
      );
    }
    lines.push("");
    if (executionStage.wakeRole === "reviewer" || executionStage.wakeRole === "approver") {
      lines.push(
        `You are waking as the active ${executionStage.wakeRole} for this issue.`,
        "Do not execute the task itself or continue executor work.",
        "Review the issue and choose one of the allowed actions above.",
        "If you request changes, the workflow routes back to the stored return assignee.",
        "",
      );
    } else if (executionStage.wakeRole === "executor") {
      lines.push(
        "You are waking because changes were requested in the execution workflow.",
        "Address the requested changes on this issue and resubmit when the work is ready.",
        "",
      );
    }
  }

  if (normalized.continuationSummary) {
    lines.push(
      "",
      "Issue continuation summary:",
      normalized.continuationSummary.body,
    );
    if (normalized.continuationSummary.bodyTruncated) {
      lines.push("[continuation summary truncated]");
    }
  }

  if (normalized.livenessContinuation) {
    const continuation = normalized.livenessContinuation;
    lines.push("", "Run liveness continuation:");
    if (continuation.attempt) {
      lines.push(
        `- attempt: ${continuation.attempt}${continuation.maxAttempts ? `/${continuation.maxAttempts}` : ""}`,
      );
    }
    if (continuation.sourceRunId) {
      lines.push(`- source run: ${continuation.sourceRunId}`);
    }
    if (continuation.state) {
      lines.push(`- liveness state: ${continuation.state}`);
    }
    if (continuation.reason) {
      lines.push(`- reason: ${continuation.reason}`);
    }
    if (continuation.instruction) {
      lines.push(`- instruction: ${continuation.instruction}`);
    }
  }

  if (normalized.childIssueSummaries.length > 0) {
    lines.push("", "Direct child issue summaries:");
    for (const child of normalized.childIssueSummaries) {
      const label = child.identifier ?? child.id ?? "unknown";
      lines.push(
        `- ${label}${child.title ? ` ${child.title}` : ""}${child.status ? ` (${child.status})` : ""}`,
      );
      if (child.summary) {
        lines.push(`  ${child.summary}`);
      }
    }
    if (normalized.childIssueSummaryTruncated) {
      lines.push("[child issue summaries truncated]");
    }
  }

  if (normalized.checkedOutByHarness) {
    lines.push(
      "",
      "The harness already checked out this issue for the current run.",
      "Do not call `/api/issues/{id}/checkout` again unless you intentionally switch to a different task.",
      "",
    );
  }

  if (normalized.comments.length > 0) {
    lines.push("New comments in order:");
  }

  for (const [index, comment] of normalized.comments.entries()) {
    const authorLabel = comment.authorId
      ? `${comment.authorType ?? "unknown"} ${comment.authorId}`
      : comment.authorType ?? "unknown";
    lines.push(
      `${index + 1}. comment ${comment.id ?? "unknown"} at ${comment.createdAt ?? "unknown"} by ${authorLabel}`,
      comment.body,
    );
    if (comment.bodyTruncated) {
      lines.push("[comment body truncated]");
    }
    lines.push("");
  }

  return lines.join("\n").trim();
}

export function redactEnvForLogs(env: Record<string, string>): Record<string, string> {
  const redacted: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    redacted[key] = SENSITIVE_ENV_KEY.test(key) ? REDACTED_LOG_VALUE : value;
  }
  return redacted;
}

export function redactCommandTextForLogs(command: string): string {
  return redactCommandText(command, REDACTED_LOG_VALUE);
}

export function buildInvocationEnvForLogs(
  env: Record<string, string>,
  options: {
    runtimeEnv?: NodeJS.ProcessEnv | Record<string, string>;
    includeRuntimeKeys?: string[];
    resolvedCommand?: string | null;
    resolvedCommandEnvKey?: string;
  } = {},
): Record<string, string> {
  const merged: Record<string, string> = { ...env };
  const runtimeEnv = options.runtimeEnv ?? {};

  for (const key of options.includeRuntimeKeys ?? []) {
    if (key in merged) continue;
    const value = runtimeEnv[key];
    if (typeof value !== "string" || value.length === 0) continue;
    merged[key] = value;
  }

  const resolvedCommand = options.resolvedCommand?.trim();
  if (resolvedCommand) {
    merged[options.resolvedCommandEnvKey ?? "PAPERCLIP_RESOLVED_COMMAND"] = redactCommandTextForLogs(resolvedCommand);
  }

  return redactEnvForLogs(merged);
}

export function buildPaperclipEnv(agent: { id: string; companyId: string }): Record<string, string> {
  const resolveHostForUrl = (rawHost: string): string => {
    const host = rawHost.trim();
    if (!host || host === "0.0.0.0" || host === "::") return "localhost";
    if (host.includes(":") && !host.startsWith("[") && !host.endsWith("]")) return `[${host}]`;
    return host;
  };
  const vars: Record<string, string> = {
    PAPERCLIP_AGENT_ID: agent.id,
    PAPERCLIP_COMPANY_ID: agent.companyId,
  };
  const runtimeHost = resolveHostForUrl(
    process.env.PAPERCLIP_LISTEN_HOST ?? process.env.HOST ?? "localhost",
  );
  const runtimePort = process.env.PAPERCLIP_LISTEN_PORT ?? process.env.PORT ?? "3100";
  const apiUrl =
    process.env.PAPERCLIP_RUNTIME_API_URL ??
    process.env.PAPERCLIP_API_URL ??
    `http://${runtimeHost}:${runtimePort}`;
  vars.PAPERCLIP_API_URL = apiUrl;
  return vars;
}

export function applyPaperclipWorkspaceEnv(
  env: Record<string, string>,
  input: {
    workspaceCwd?: string | null;
    workspaceSource?: string | null;
    workspaceStrategy?: string | null;
    workspaceId?: string | null;
    workspaceRepoUrl?: string | null;
    workspaceRepoRef?: string | null;
    workspaceBranch?: string | null;
    workspaceWorktreePath?: string | null;
    agentHome?: string | null;
  },
): Record<string, string> {
  const mappings = [
    ["PAPERCLIP_WORKSPACE_CWD", input.workspaceCwd],
    ["PAPERCLIP_WORKSPACE_SOURCE", input.workspaceSource],
    ["PAPERCLIP_WORKSPACE_STRATEGY", input.workspaceStrategy],
    ["PAPERCLIP_WORKSPACE_ID", input.workspaceId],
    ["PAPERCLIP_WORKSPACE_REPO_URL", input.workspaceRepoUrl],
    ["PAPERCLIP_WORKSPACE_REPO_REF", input.workspaceRepoRef],
    ["PAPERCLIP_WORKSPACE_BRANCH", input.workspaceBranch],
    ["PAPERCLIP_WORKSPACE_WORKTREE_PATH", input.workspaceWorktreePath],
    ["AGENT_HOME", input.agentHome],
  ] as const;

  for (const [key, value] of mappings) {
    if (typeof value === "string" && value.length > 0) {
      env[key] = value;
    }
  }

  return env;
}

export function shapePaperclipWorkspaceEnvForExecution(input: {
  workspaceCwd?: string | null;
  workspaceWorktreePath?: string | null;
  workspaceHints?: Array<Record<string, unknown>>;
  executionTargetIsRemote?: boolean;
  executionCwd?: string | null;
}): {
  workspaceCwd: string | null;
  workspaceWorktreePath: string | null;
  workspaceHints: Array<Record<string, unknown>>;
} {
  const workspaceCwd =
    typeof input.workspaceCwd === "string" && input.workspaceCwd.trim().length > 0
      ? input.workspaceCwd.trim()
      : null;
  const workspaceWorktreePath =
    typeof input.workspaceWorktreePath === "string" && input.workspaceWorktreePath.trim().length > 0
      ? input.workspaceWorktreePath.trim()
      : null;
  const workspaceHints = Array.isArray(input.workspaceHints) ? input.workspaceHints : [];

  if (!input.executionTargetIsRemote) {
    return {
      workspaceCwd,
      workspaceWorktreePath,
      workspaceHints,
    };
  }

  const executionCwd =
    typeof input.executionCwd === "string" && input.executionCwd.trim().length > 0
      ? input.executionCwd.trim()
      : null;
  // On a remote target we must never fall back to the local workspaceCwd —
  // doing so leaks host paths into the remote env (the exact failure mode
  // this helper exists to prevent). Callers are expected to resolve
  // executionCwd via adapterExecutionTargetRemoteCwd before calling this
  // helper, which always returns a non-empty string. Surface a warning so
  // future callers don't silently regress to the leak.
  if (executionCwd === null) {
    // eslint-disable-next-line no-console
    console.warn(
      "[paperclip] shapePaperclipWorkspaceEnvForExecution called with executionCwd=null on a remote target; " +
        "stripping workspaceCwd to avoid leaking local paths into the remote environment.",
    );
  }
  const realizedWorkspaceCwd = executionCwd;
  const localWorkspaceCwd = workspaceCwd ? path.resolve(workspaceCwd) : null;
  const shapedWorkspaceHints = workspaceHints.map((hint) => {
    const nextHint = { ...hint };
    const hintCwd = typeof nextHint.cwd === "string" ? nextHint.cwd.trim() : "";
    if (!hintCwd) return nextHint;

    if (localWorkspaceCwd && path.resolve(hintCwd) === localWorkspaceCwd) {
      if (realizedWorkspaceCwd) {
        nextHint.cwd = realizedWorkspaceCwd;
      } else {
        delete nextHint.cwd;
      }
      return nextHint;
    }

    delete nextHint.cwd;
    return nextHint;
  });

  return {
    workspaceCwd: realizedWorkspaceCwd,
    workspaceWorktreePath: null,
    workspaceHints: shapedWorkspaceHints,
  };
}

export function sanitizeInheritedPaperclipEnv(baseEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };
  for (const key of Object.keys(env)) {
    if (!key.startsWith("PAPERCLIP_")) continue;
    if (key === "PAPERCLIP_RUNTIME_API_URL") continue;
    if (key === "PAPERCLIP_LISTEN_HOST") continue;
    if (key === "PAPERCLIP_LISTEN_PORT") continue;
    delete env[key];
  }
  return env;
}

export function defaultPathForPlatform() {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32;C:\\Windows;C:\\Windows\\System32\\Wbem";
  }
  return "/usr/local/bin:/opt/homebrew/bin:/usr/local/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
}

function windowsPathExts(env: NodeJS.ProcessEnv): string[] {
  return (env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean);
}

async function pathExists(candidate: string) {
  try {
    await fs.access(candidate, process.platform === "win32" ? fsConstants.F_OK : fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function resolveCommandPath(command: string, cwd: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  if (hasPathSeparator) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    return (await pathExists(absolute)) ? absolute : null;
  }

  const pathValue = env.PATH ?? env.Path ?? "";
  const delimiter = process.platform === "win32" ? ";" : ":";
  const dirs = pathValue.split(delimiter).filter(Boolean);
  const exts = process.platform === "win32" ? windowsPathExts(env) : [""];
  const hasExtension = process.platform === "win32" && path.extname(command).length > 0;

  for (const dir of dirs) {
    const candidates =
      process.platform === "win32"
        ? hasExtension
          ? [path.join(dir, command)]
          : exts.map((ext) => path.join(dir, `${command}${ext}`))
        : [path.join(dir, command)];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return candidate;
    }
  }

  return null;
}

export async function resolveCommandForLogs(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: {
    remoteExecution?: RemoteExecutionSpec | null;
  } = {},
): Promise<string> {
  const remote = options.remoteExecution ?? null;
  if (remote) {
    return `ssh://${remote.username}@${remote.host}:${remote.port}/${remote.remoteCwd} :: ${command}`;
  }
  return (await resolveCommandPath(command, cwd, env)) ?? command;
}

function quoteForCmd(arg: string) {
  if (!arg.length) return '""';
  const escaped = arg.replace(/"/g, '""');
  return /[\s"&<>|^()]/.test(escaped) ? `"${escaped}"` : escaped;
}

export function sanitizeSshRemoteEnv(
  env: Record<string, string>,
  inheritedEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return sanitizeRemoteExecutionEnv(env, inheritedEnv);
}

function resolveWindowsCmdShell(env: NodeJS.ProcessEnv): string {
  const fallbackRoot = env.SystemRoot || process.env.SystemRoot || "C:\\Windows";
  return path.join(fallbackRoot, "System32", "cmd.exe");
}

async function resolveSpawnTarget(
  command: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: {
    remoteExecution?: RemoteExecutionSpec | null;
    remoteEnv?: Record<string, string> | null;
  } = {},
): Promise<SpawnTarget> {
  const remote = options.remoteExecution ?? null;
  if (remote) {
    const sshResolved = await resolveCommandPath("ssh", process.cwd(), env);
    if (!sshResolved) {
      throw new Error('Command not found in PATH: "ssh"');
    }
    const spawnTarget = await buildSshSpawnTarget({
      spec: remote,
      command,
      args,
      env: Object.fromEntries(
        Object.entries(options.remoteEnv ?? {}).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      ),
    });
    return {
      command: sshResolved,
      args: spawnTarget.args,
      cwd: process.cwd(),
      cleanup: spawnTarget.cleanup,
    };
  }

  const resolved = await resolveCommandPath(command, cwd, env);
  const executable = resolved ?? command;

  if (process.platform !== "win32") {
    return { command: executable, args };
  }

  if (/\.(cmd|bat)$/i.test(executable)) {
    // Always use cmd.exe for .cmd/.bat wrappers. Some environments override
    // ComSpec to PowerShell, which breaks cmd-specific flags like /d /s /c.
    const shell = resolveWindowsCmdShell(env);
    const commandLine = [quoteForCmd(executable), ...args.map(quoteForCmd)].join(" ");
    return {
      command: shell,
      args: ["/d", "/s", "/c", commandLine],
    };
  }

  return { command: executable, args };
}

export function ensurePathInEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (typeof env.PATH === "string" && env.PATH.length > 0) return env;
  if (typeof env.Path === "string" && env.Path.length > 0) return env;
  return { ...env, PATH: defaultPathForPlatform() };
}

export async function ensureAbsoluteDirectory(
  cwd: string,
  opts: { createIfMissing?: boolean } = {},
) {
  if (!path.isAbsolute(cwd)) {
    throw new Error(`Working directory must be an absolute path: "${cwd}"`);
  }

  const assertDirectory = async () => {
    const stats = await fs.stat(cwd);
    if (!stats.isDirectory()) {
      throw new Error(`Working directory is not a directory: "${cwd}"`);
    }
  };

  try {
    await assertDirectory();
    return;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (!opts.createIfMissing || code !== "ENOENT") {
      if (code === "ENOENT") {
        throw new Error(`Working directory does not exist: "${cwd}"`);
      }
      throw err instanceof Error ? err : new Error(String(err));
    }
  }

  try {
    await fs.mkdir(cwd, { recursive: true });
    await assertDirectory();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Could not create working directory "${cwd}": ${reason}`);
  }
}

export async function resolvePaperclipSkillsDir(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<string | null> {
  const candidates = [
    ...PAPERCLIP_SKILL_ROOT_RELATIVE_CANDIDATES.map((relativePath) => path.resolve(moduleDir, relativePath)),
    ...additionalCandidates.map((candidate) => path.resolve(candidate)),
  ];
  const seenRoots = new Set<string>();

  for (const root of candidates) {
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);
    const isDirectory = await fs.stat(root).then((stats) => stats.isDirectory()).catch(() => false);
    if (isDirectory) return root;
  }

  return null;
}

async function readSkillRequired(skillDir: string): Promise<boolean> {
  try {
    const content = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
    const normalized = content.replace(/\r\n/g, "\n");
    if (!normalized.startsWith("---\n")) return true;
    const closing = normalized.indexOf("\n---\n", 4);
    if (closing < 0) return true;
    const frontmatter = normalized.slice(4, closing);
    return !/^\s*required\s*:\s*false\s*$/m.test(frontmatter);
  } catch {
    return true;
  }
}

export async function listPaperclipSkillEntries(
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const root = await resolvePaperclipSkillsDir(moduleDir, additionalCandidates);
  if (!root) return [];

  try {
    const entries = await fs.readdir(root, { withFileTypes: true });
    const dirs = entries.filter((entry) => entry.isDirectory());
    return Promise.all(dirs.map(async (entry) => {
      const skillDir = path.join(root, entry.name);
      const required = await readSkillRequired(skillDir);
      return {
        key: `paperclipai/paperclip/${entry.name}`,
        runtimeName: entry.name,
        source: skillDir,
        required,
        requiredReason: required
          ? "Bundled Paperclip skills are always available for local adapters."
          : null,
      };
    }));
  } catch {
    return [];
  }
}

export async function readInstalledSkillTargets(skillsHome: string): Promise<Map<string, InstalledSkillTarget>> {
  const entries = await fs.readdir(skillsHome, { withFileTypes: true }).catch(() => []);
  const out = new Map<string, InstalledSkillTarget>();
  for (const entry of entries) {
    const fullPath = path.join(skillsHome, entry.name);
    const linkedPath = entry.isSymbolicLink() ? await fs.readlink(fullPath).catch(() => null) : null;
    out.set(entry.name, resolveInstalledEntryTarget(skillsHome, entry.name, entry, linkedPath));
  }
  return out;
}

export function buildPersistentSkillSnapshot(
  options: PersistentSkillSnapshotOptions,
): AdapterSkillSnapshot {
  const {
    adapterType,
    availableEntries,
    desiredSkills,
    installed,
    skillsHome,
    locationLabel,
    installedDetail,
    missingDetail,
    externalConflictDetail,
    externalDetail,
  } = options;
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSet = new Set(desiredSkills);
  const entries: AdapterSkillEntry[] = [];
  const warnings = [...(options.warnings ?? [])];

  for (const available of availableEntries) {
    const installedEntry = installed.get(available.runtimeName) ?? null;
    const desired = desiredSet.has(available.key);
    let state: AdapterSkillEntry["state"] = "available";
    let managed = false;
    let detail: string | null = null;

    if (installedEntry?.targetPath === available.source) {
      managed = true;
      state = desired ? "installed" : "stale";
      detail = installedDetail ?? null;
    } else if (installedEntry) {
      state = "external";
      detail = desired ? externalConflictDetail : externalDetail;
    } else if (desired) {
      state = "missing";
      detail = missingDetail;
    }

    entries.push({
      key: available.key,
      runtimeName: available.runtimeName,
      desired,
      managed,
      state,
      sourcePath: available.source,
      targetPath: path.join(skillsHome, available.runtimeName),
      detail,
      required: Boolean(available.required),
      requiredReason: available.requiredReason ?? null,
      ...buildManagedSkillOrigin(available),
    });
  }

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
    });
  }

  for (const [name, installedEntry] of installed.entries()) {
    if (availableEntries.some((entry) => entry.runtimeName === name)) continue;
    entries.push({
      key: name,
      runtimeName: name,
      desired: false,
      managed: false,
      state: "external",
      origin: "user_installed",
      originLabel: "User-installed",
      locationLabel: skillLocationLabel(locationLabel),
      readOnly: true,
      sourcePath: null,
      targetPath: installedEntry.targetPath ?? path.join(skillsHome, name),
      detail: externalDetail,
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType,
    supported: true,
    mode: "persistent",
    desiredSkills,
    entries,
    warnings,
  };
}

function normalizeConfiguredPaperclipRuntimeSkills(value: unknown): PaperclipSkillEntry[] {
  if (!Array.isArray(value)) return [];
  const out: PaperclipSkillEntry[] = [];
  for (const rawEntry of value) {
    const entry = parseObject(rawEntry);
    const key = asString(entry.key, asString(entry.name, "")).trim();
    const runtimeName = asString(entry.runtimeName, asString(entry.name, "")).trim();
    const source = asString(entry.source, "").trim();
    if (!key || !runtimeName || !source) continue;
    out.push({
      key,
      runtimeName,
      source,
      required: asBoolean(entry.required, false),
      requiredReason:
        typeof entry.requiredReason === "string" && entry.requiredReason.trim().length > 0
          ? entry.requiredReason.trim()
          : null,
    });
  }
  return out;
}

export async function readPaperclipRuntimeSkillEntries(
  config: Record<string, unknown>,
  moduleDir: string,
  additionalCandidates: string[] = [],
): Promise<PaperclipSkillEntry[]> {
  const configuredEntries = normalizeConfiguredPaperclipRuntimeSkills(config.paperclipRuntimeSkills);
  if (configuredEntries.length > 0) return configuredEntries;
  return listPaperclipSkillEntries(moduleDir, additionalCandidates);
}

export async function readPaperclipSkillMarkdown(
  moduleDir: string,
  skillKey: string,
): Promise<string | null> {
  const normalized = skillKey.trim().toLowerCase();
  if (!normalized) return null;

  const entries = await listPaperclipSkillEntries(moduleDir);
  const match = entries.find((entry) => entry.key === normalized);
  if (!match) return null;

  try {
    return await fs.readFile(path.join(match.source, "SKILL.md"), "utf8");
  } catch {
    return null;
  }
}

export function readPaperclipSkillSyncPreference(config: Record<string, unknown>): {
  explicit: boolean;
  desiredSkills: string[];
} {
  const raw = config.paperclipSkillSync;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { explicit: false, desiredSkills: [] };
  }
  const syncConfig = raw as Record<string, unknown>;
  const desiredValues = syncConfig.desiredSkills;
  const desired = Array.isArray(desiredValues)
    ? desiredValues
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter(Boolean)
    : [];
  return {
    explicit: Object.prototype.hasOwnProperty.call(raw, "desiredSkills"),
    desiredSkills: Array.from(new Set(desired)),
  };
}

function canonicalizeDesiredPaperclipSkillReference(
  reference: string,
  availableEntries: Array<{ key: string; runtimeName?: string | null }>,
): string {
  const normalizedReference = reference.trim().toLowerCase();
  if (!normalizedReference) return "";

  const exactKey = availableEntries.find((entry) => entry.key.trim().toLowerCase() === normalizedReference);
  if (exactKey) return exactKey.key;

  const byRuntimeName = availableEntries.filter((entry) =>
    typeof entry.runtimeName === "string" && entry.runtimeName.trim().toLowerCase() === normalizedReference,
  );
  if (byRuntimeName.length === 1) return byRuntimeName[0]!.key;

  const slugMatches = availableEntries.filter((entry) =>
    entry.key.trim().toLowerCase().split("/").pop() === normalizedReference,
  );
  if (slugMatches.length === 1) return slugMatches[0]!.key;

  return normalizedReference;
}

export function resolvePaperclipDesiredSkillNames(
  config: Record<string, unknown>,
  availableEntries: Array<{ key: string; runtimeName?: string | null; required?: boolean }>,
): string[] {
  const preference = readPaperclipSkillSyncPreference(config);
  const requiredSkills = availableEntries
    .filter((entry) => entry.required)
    .map((entry) => entry.key);
  if (!preference.explicit) {
    return Array.from(new Set(requiredSkills));
  }
  const desiredSkills = preference.desiredSkills
    .map((reference) => canonicalizeDesiredPaperclipSkillReference(reference, availableEntries))
    .filter(Boolean);
  return Array.from(new Set([...requiredSkills, ...desiredSkills]));
}

export function writePaperclipSkillSyncPreference(
  config: Record<string, unknown>,
  desiredSkills: string[],
): Record<string, unknown> {
  const next = { ...config };
  const raw = next.paperclipSkillSync;
  const current =
    typeof raw === "object" && raw !== null && !Array.isArray(raw)
      ? { ...(raw as Record<string, unknown>) }
      : {};
  current.desiredSkills = Array.from(
    new Set(
      desiredSkills
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  );
  next.paperclipSkillSync = current;
  return next;
}

export async function ensurePaperclipSkillSymlink(
  source: string,
  target: string,
  linkSkill: (source: string, target: string) => Promise<void> = (linkSource, linkTarget) =>
    fs.symlink(linkSource, linkTarget),
): Promise<"created" | "repaired" | "skipped"> {
  const existing = await fs.lstat(target).catch(() => null);
  if (!existing) {
    await linkSkill(source, target);
    return "created";
  }

  if (!existing.isSymbolicLink()) {
    return "skipped";
  }

  const linkedPath = await fs.readlink(target).catch(() => null);
  if (!linkedPath) return "skipped";

  const resolvedLinkedPath = path.resolve(path.dirname(target), linkedPath);
  if (resolvedLinkedPath === source) {
    return "skipped";
  }

  const linkedPathExists = await fs.stat(resolvedLinkedPath).then(() => true).catch(() => false);
  if (linkedPathExists) {
    return "skipped";
  }

  await fs.unlink(target);
  await linkSkill(source, target);
  return "repaired";
}

async function hashSkillDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");

  async function visit(candidate: string, relativePath: string): Promise<void> {
    const stat = await fs.lstat(candidate);
    if (stat.isSymbolicLink()) {
      hash.update(`symlink:${relativePath}\n`);
      return;
    }
    if (stat.isDirectory()) {
      hash.update(`dir:${relativePath}\n`);
      const entries = await fs.readdir(candidate, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        await visit(path.join(candidate, entry.name), childRelativePath);
      }
      return;
    }
    if (stat.isFile()) {
      hash.update(`file:${relativePath}:${stat.mode}\n`);
      hash.update(await fs.readFile(candidate));
      hash.update("\n");
      return;
    }
    hash.update(`other:${relativePath}:${stat.mode}\n`);
  }

  await visit(root, "");
  return hash.digest("hex");
}

async function materializedSkillFingerprintMatches(targetRoot: string, sourceFingerprint: string): Promise<boolean> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(targetRoot, MATERIALIZED_SKILL_SENTINEL), "utf8")) as unknown;
    const parsed = parseObject(raw);
    return parsed.version === 1 && parsed.sourceFingerprint === sourceFingerprint;
  } catch {
    return false;
  }
}

async function acquireMaterializeLock(lockDir: string): Promise<() => Promise<void>> {
  await fs.mkdir(path.dirname(lockDir), { recursive: true });
  const deadline = Date.now() + MATERIALIZED_SKILL_LOCK_STALE_MS;
  while (true) {
    try {
      await fs.mkdir(lockDir);
      await fs.writeFile(
        path.join(lockDir, MATERIALIZED_SKILL_LOCK_OWNER),
        `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`,
        "utf8",
      );
      return async () => {
        await fs.rm(lockDir, { recursive: true, force: true });
      };
    } catch (err) {
      const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
      if (code !== "EEXIST") throw err;
      if (await removeStaleMaterializeLock(lockDir, MATERIALIZED_SKILL_LOCK_STALE_MS)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for Paperclip skill materialization lock at ${lockDir}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = err && typeof err === "object" ? (err as { code?: unknown }).code : null;
    return code === "EPERM";
  }
}

async function removeStaleMaterializeLock(lockDir: string, staleMs: number): Promise<boolean> {
  const ownerPath = path.join(lockDir, MATERIALIZED_SKILL_LOCK_OWNER);
  let shouldRemove = false;
  try {
    const raw = JSON.parse(await fs.readFile(ownerPath, "utf8")) as unknown;
    const owner = parseObject(raw);
    const pid = typeof owner.pid === "number" ? owner.pid : 0;
    const createdAt = typeof owner.createdAt === "string" ? Date.parse(owner.createdAt) : Number.NaN;
    const ageMs = Number.isFinite(createdAt) ? Date.now() - createdAt : staleMs + 1;
    shouldRemove = !isPidAlive(pid) || ageMs > staleMs;
  } catch {
    const stat = await fs.stat(lockDir).catch(() => null);
    shouldRemove = !stat || Date.now() - stat.mtimeMs > staleMs;
  }
  if (!shouldRemove) return false;
  await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
  return true;
}

export async function materializePaperclipSkillCopy(
  source: string,
  target: string,
): Promise<MaterializedPaperclipSkillCopyResult> {
  const sourceRoot = path.resolve(source);
  const targetRoot = path.resolve(target);
  const relativeTarget = path.relative(sourceRoot, targetRoot);
  const relativeSource = path.relative(targetRoot, sourceRoot);
  if (
    !relativeTarget ||
    (!relativeTarget.startsWith("..") && !path.isAbsolute(relativeTarget)) ||
    !relativeSource ||
    (!relativeSource.startsWith("..") && !path.isAbsolute(relativeSource))
  ) {
    throw new Error("Refusing to materialize a skill into itself, an ancestor, or one of its descendants.");
  }

  const rootStat = await fs.lstat(sourceRoot);
  if (rootStat.isSymbolicLink()) {
    throw new Error("Refusing to materialize a skill root that is itself a symlink.");
  }
  if (!rootStat.isDirectory()) {
    throw new Error("Paperclip skills must be directories.");
  }

  const result: MaterializedPaperclipSkillCopyResult = {
    copiedFiles: 0,
    skippedSymlinks: [],
  };

  const lockDir = `${targetRoot}.lock`;
  const releaseLock = await acquireMaterializeLock(lockDir);
  const tempRoot = `${targetRoot}.tmp-${process.pid}-${randomUUID()}`;

  async function copyEntry(sourcePath: string, targetPath: string, relativePath: string): Promise<void> {
    const stat = await fs.lstat(sourcePath);
    if (stat.isSymbolicLink()) {
      result.skippedSymlinks.push(relativePath || ".");
      return;
    }

    if (stat.isDirectory()) {
      await fs.mkdir(targetPath, { recursive: true });
      const entries = await fs.readdir(sourcePath, { withFileTypes: true });
      entries.sort((left, right) => left.name.localeCompare(right.name));
      for (const entry of entries) {
        const childRelativePath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        await copyEntry(path.join(sourcePath, entry.name), path.join(targetPath, entry.name), childRelativePath);
      }
      return;
    }

    if (stat.isFile()) {
      await fs.mkdir(path.dirname(targetPath), { recursive: true });
      await fs.copyFile(sourcePath, targetPath, fsConstants.COPYFILE_FICLONE).catch(async () => {
        await fs.copyFile(sourcePath, targetPath);
      });
      await fs.chmod(targetPath, stat.mode).catch(() => {});
      result.copiedFiles += 1;
    }
  }

  try {
    const sourceFingerprint = await hashSkillDirectory(sourceRoot);
    if (await materializedSkillFingerprintMatches(targetRoot, sourceFingerprint)) return result;
    await copyEntry(sourceRoot, tempRoot, "");
    await fs.writeFile(
      path.join(tempRoot, MATERIALIZED_SKILL_SENTINEL),
      `${JSON.stringify({
        version: 1,
        sourceFingerprint,
        copiedFiles: result.copiedFiles,
        skippedSymlinks: result.skippedSymlinks,
      }, null, 2)}\n`,
      "utf8",
    );
    if (await materializedSkillFingerprintMatches(targetRoot, sourceFingerprint)) return result;
    await fs.rm(targetRoot, { recursive: true, force: true });
    await fs.rename(tempRoot, targetRoot);
    return result;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    await releaseLock();
  }
}

export async function removeMaintainerOnlySkillSymlinks(
  skillsHome: string,
  allowedSkillNames: Iterable<string>,
): Promise<string[]> {
  const allowed = new Set(Array.from(allowedSkillNames));
  try {
    const entries = await fs.readdir(skillsHome, { withFileTypes: true });
    const removed: string[] = [];
    for (const entry of entries) {
      if (allowed.has(entry.name)) continue;

      const target = path.join(skillsHome, entry.name);
      const existing = await fs.lstat(target).catch(() => null);
      if (!existing?.isSymbolicLink()) continue;

      const linkedPath = await fs.readlink(target).catch(() => null);
      if (!linkedPath) continue;

      const resolvedLinkedPath = path.isAbsolute(linkedPath)
        ? linkedPath
        : path.resolve(path.dirname(target), linkedPath);
      if (
        !isMaintainerOnlySkillTarget(linkedPath) &&
        !isMaintainerOnlySkillTarget(resolvedLinkedPath)
      ) {
        continue;
      }

      await fs.unlink(target);
      removed.push(entry.name);
    }

    return removed;
  } catch {
    return [];
  }
}

export async function ensureCommandResolvable(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
  options: {
    remoteExecution?: RemoteExecutionSpec | null;
  } = {},
) {
  if (options.remoteExecution) {
    const resolvedSsh = await resolveCommandPath("ssh", process.cwd(), env);
    if (resolvedSsh) return;
    throw new Error('Command not found in PATH: "ssh"');
  }
  const resolved = await resolveCommandPath(command, cwd, env);
  if (resolved) return;
  if (command.includes("/") || command.includes("\\")) {
    const absolute = path.isAbsolute(command) ? command : path.resolve(cwd, command);
    throw new Error(`Command is not executable: "${command}" (resolved: "${absolute}")`);
  }
  throw new Error(`Command not found in PATH: "${command}"`);
}

export async function runChildProcess(
  runId: string,
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: Record<string, string>;
    timeoutSec: number;
    graceSec: number;
    onLog: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
    onLogError?: (err: unknown, runId: string, message: string) => void;
    onSpawn?: (meta: { pid: number; processGroupId: number | null; startedAt: string }) => Promise<void>;
    terminalResultCleanup?: TerminalResultCleanupOptions;
    stdin?: string;
    remoteExecution?: RemoteExecutionSpec | null;
  },
): Promise<RunProcessResult> {
  const onLogError = opts.onLogError ?? ((err, id, msg) => console.warn({ err, runId: id }, msg));
  return new Promise<RunProcessResult>((resolve, reject) => {
    const rawMerged: NodeJS.ProcessEnv = {
      ...sanitizeInheritedPaperclipEnv(process.env),
      ...opts.env,
    };

    // Strip Claude Code nesting-guard env vars so spawned `claude` processes
    // don't refuse to start with "cannot be launched inside another session".
    // These vars leak in when the Paperclip server itself is started from
    // within a Claude Code session (e.g. `npx paperclipai run` in a terminal
    // owned by Claude Code) or when cron inherits a contaminated shell env.
    const CLAUDE_CODE_NESTING_VARS = [
      "CLAUDECODE",
      "CLAUDE_CODE_ENTRYPOINT",
      "CLAUDE_CODE_SESSION",
      "CLAUDE_CODE_PARENT_SESSION",
    ] as const;
    for (const key of CLAUDE_CODE_NESTING_VARS) {
      delete rawMerged[key];
    }

    const mergedEnv = ensurePathInEnv(rawMerged);
    void resolveSpawnTarget(command, args, opts.cwd, mergedEnv, {
      remoteExecution: opts.remoteExecution ?? null,
      remoteEnv: opts.remoteExecution ? opts.env : null,
    })
      .then((target) => {
        const child = spawn(target.command, target.args, {
          cwd: target.cwd ?? opts.cwd,
          env: mergedEnv,
          detached: process.platform !== "win32",
          shell: false,
          stdio: [opts.stdin != null ? "pipe" : "ignore", "pipe", "pipe"],
        }) as ChildProcessWithEvents;
        const startedAt = new Date().toISOString();
        const processGroupId = resolveProcessGroupId(child);

        const spawnPersistPromise =
          typeof child.pid === "number" && child.pid > 0 && opts.onSpawn
            ? opts.onSpawn({ pid: child.pid, processGroupId, startedAt }).catch((err) => {
              onLogError(err, runId, "failed to record child process metadata");
            })
            : Promise.resolve();

        runningProcesses.set(runId, { child, graceSec: opts.graceSec, processGroupId });

        let timedOut = false;
        let stdout = "";
        let stderr = "";
        let logChain: Promise<void> = Promise.resolve();
        let terminalResultSeen = false;
        let terminalCleanupStarted = false;
        let terminalCleanupTimer: NodeJS.Timeout | null = null;
        let terminalCleanupKillTimer: NodeJS.Timeout | null = null;
        let terminalResultStdoutScanOffset = 0;
        let terminalResultStderrScanOffset = 0;

        const clearTerminalCleanupTimers = () => {
          if (terminalCleanupTimer) clearTimeout(terminalCleanupTimer);
          if (terminalCleanupKillTimer) clearTimeout(terminalCleanupKillTimer);
          terminalCleanupTimer = null;
          terminalCleanupKillTimer = null;
        };

        const maybeArmTerminalResultCleanup = () => {
          const terminalCleanup = opts.terminalResultCleanup;
          if (!terminalCleanup || terminalCleanupStarted || timedOut) return;
          if (!terminalResultSeen) {
            const stdoutStart = Math.max(0, terminalResultStdoutScanOffset - TERMINAL_RESULT_SCAN_OVERLAP_CHARS);
            const stderrStart = Math.max(0, terminalResultStderrScanOffset - TERMINAL_RESULT_SCAN_OVERLAP_CHARS);
            const scanOutput = {
              stdout: stdout.slice(stdoutStart),
              stderr: stderr.slice(stderrStart),
            };
            terminalResultStdoutScanOffset = stdout.length;
            terminalResultStderrScanOffset = stderr.length;
            if (scanOutput.stdout.length === 0 && scanOutput.stderr.length === 0) return;
            try {
              terminalResultSeen = terminalCleanup.hasTerminalResult(scanOutput);
            } catch (err) {
              onLogError(err, runId, "failed to inspect terminal adapter output");
            }
          }
          if (!terminalResultSeen) return;

          if (terminalCleanupTimer) return;
          const graceMs = Math.max(0, terminalCleanup.graceMs ?? 5_000);
          terminalCleanupTimer = setTimeout(() => {
            terminalCleanupTimer = null;
            if (terminalCleanupStarted || timedOut) return;
            terminalCleanupStarted = true;
            signalRunningProcess({ child, processGroupId }, "SIGTERM");
            terminalCleanupKillTimer = setTimeout(() => {
              terminalCleanupKillTimer = null;
              signalRunningProcess({ child, processGroupId }, "SIGKILL");
            }, Math.max(1, opts.graceSec) * 1000);
          }, graceMs);
        };

        const timeout =
          opts.timeoutSec > 0
            ? setTimeout(() => {
                timedOut = true;
                clearTerminalCleanupTimers();
                signalRunningProcess({ child, processGroupId }, "SIGTERM");
                setTimeout(() => {
                  signalRunningProcess({ child, processGroupId }, "SIGKILL");
                }, Math.max(1, opts.graceSec) * 1000);
              }, opts.timeoutSec * 1000)
            : null;

        child.stdout?.on("data", (chunk: unknown) => {
          const readable = child.stdout;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stdout = appendWithCap(stdout, text);
          maybeArmTerminalResultCleanup();
          logChain = logChain
            .then(() => opts.onLog("stdout", text))
            .catch((err) => onLogError(err, runId, "failed to append stdout log chunk"))
            .finally(() => {
              maybeArmTerminalResultCleanup();
              resumeReadable(readable);
            });
        });

        child.stderr?.on("data", (chunk: unknown) => {
          const readable = child.stderr;
          if (!readable) return;
          readable.pause();
          const text = String(chunk);
          stderr = appendWithCap(stderr, text);
          maybeArmTerminalResultCleanup();
          logChain = logChain
            .then(() => opts.onLog("stderr", text))
            .catch((err) => onLogError(err, runId, "failed to append stderr log chunk"))
            .finally(() => {
              maybeArmTerminalResultCleanup();
              resumeReadable(readable);
            });
        });

        const stdin = child.stdin;
        if (opts.stdin != null && stdin) {
          void spawnPersistPromise.finally(() => {
            if (child.killed || stdin.destroyed) return;
            stdin.write(opts.stdin as string);
            stdin.end();
          });
        }

        child.on("error", (err: Error) => {
          if (timeout) clearTimeout(timeout);
          clearTerminalCleanupTimers();
          runningProcesses.delete(runId);
          void target.cleanup?.();
          const errno = (err as NodeJS.ErrnoException).code;
          const pathValue = mergedEnv.PATH ?? mergedEnv.Path ?? "";
          const msg =
            errno === "ENOENT"
              ? `Failed to start command "${command}" in "${opts.cwd}". Verify adapter command, working directory, and PATH (${pathValue}).`
              : `Failed to start command "${command}" in "${opts.cwd}": ${err.message}`;
          reject(new Error(msg));
        });

        child.on("exit", () => {
          maybeArmTerminalResultCleanup();
        });

        child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
          if (timeout) clearTimeout(timeout);
          clearTerminalCleanupTimers();
          runningProcesses.delete(runId);
          void logChain.finally(() => {
            void Promise.resolve()
              .then(() => target.cleanup?.())
              .finally(() => {
              resolve({
                exitCode: code,
                signal,
                timedOut,
                stdout,
                stderr,
                pid: child.pid ?? null,
                startedAt,
              });
              });
          });
        });
      })
      .catch(reject);
  });
}
