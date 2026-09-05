import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, posix, resolve } from "node:path";
import type {
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type {
  HarnessRuntimeRequestResolution,
  NativeExecutionInput,
  NativeRuntimeContextSnapshot,
  NativeSession,
  NativeSessionBackend,
  PaperclipQuestionSet,
  PersistedNativeSession,
  PrpEvent,
  PrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";
import {
  acpxRuntimeSessionDirectoryName,
  createNativeSessionBackend,
  createRunnerdCodexTransport,
  defaultCapabilityRunnerdBinary,
  executeNativeSession,
  parseNativeExecutionInput,
  parsePaperclipQuestionSet,
  resolveSourceCodexHome,
  type RunnerProcessHandle,
  type RunnerProcessLaunchSpec,
} from "../../vendor/paperclip-runner/index.js";
import type { AdapterExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import { createSshCommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/ssh";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import {
  resolvePaperclipRunnerTransport,
  type PaperclipRunnerTransport,
} from "@paperclipai/adapter-utils/runner-connectivity";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  documentRevisions,
  environmentLeases,
  heartbeatRunEvents,
  heartbeatRuns,
  issueDocuments,
  issueThreadInteractions,
  issues,
  nativeRunFinalizations,
} from "@paperclipai/db";
import { PaperclipControlPlanePort } from "./paperclip-control-plane-port.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { registerRunnerPrpAuthority } from "../../realtime/runner-prp-ws.js";
import { connectRunnerPrpIngress } from "../../realtime/runner-prp-outbound.js";
import { issueRecoveryActionService } from "../issue-recovery-actions.js";
import { persistActivity, publishActivity } from "../activity-log.js";
import { commitNativeStatusDecision } from "./status-decision-committer.js";
import { resolvePaperclipInstanceRoot } from "../../home-paths.js";
import { documentService } from "../documents.js";
import { issueThreadInteractionService } from "../issue-thread-interactions.js";
import { issueService } from "../issues.js";
import {
  NATIVE_STATUS_ARBITER_POLICY_VERSION,
  type NativeAuthoritativeIssueStatus,
  type NativeStatusDecision,
} from "./status-arbiter.js";
import { HttpError } from "../../errors.js";
import { redactSensitiveText } from "../../redaction.js";
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";
import {
  createNativeRunTrace,
  type NativeRunHistoricalSpan,
  type NativeRunSpanScope,
  type NativeRunTrace,
} from "./native-run-trace.js";
import { createNativeHarnessBackupStamp } from "./native-harness-backup-stamp.js";
import { readProcessStartedAt } from "../hot-restart.js";
import {
  currentNativeControllerIdentity,
  nextNativeProviderAttempt,
  type NativeControllerIdentity,
  type NativeRestartRecoveryClaim,
} from "./native-restart-recovery.js";

type ActiveNativeSession = {
  session: NativeSession;
  cancelRequested: boolean;
};

class NativeResultPendingFinalizationError extends Error {
  constructor() {
    super("native_result_pending_finalization");
    this.name = "NativeResultPendingFinalizationError";
  }
}

export class NativeCancellationPendingRecoveryError extends Error {
  constructor() {
    super("native_cancellation_pending_recovery");
    this.name = "NativeCancellationPendingRecoveryError";
  }
}

const activeNativeSessions = new Map<string, ActiveNativeSession>();

export async function detachNativeSessionsForRestart(
  runIds: readonly string[],
): Promise<{
  detachedRunIds: string[];
  inactiveRunIds: string[];
  unsupportedRunIds: string[];
}> {
  const detachedRunIds: string[] = [];
  const inactiveRunIds: string[] = [];
  const unsupportedRunIds: string[] = [];
  for (const runId of new Set(runIds)) {
    const active = activeNativeSessions.get(runId);
    if (!active) {
      inactiveRunIds.push(runId);
      continue;
    }
    if (active.session.detachControllerForRestart === undefined) {
      unsupportedRunIds.push(runId);
      continue;
    }
    await active.session.detachControllerForRestart();
    detachedRunIds.push(runId);
  }
  return { detachedRunIds, inactiveRunIds, unsupportedRunIds };
}
const MAX_REMOTE_CHECKPOINT_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_CHECKPOINT_EXPANDED_BYTES = 64 * 1024 * 1024;
const MAX_REMOTE_CHECKPOINT_ENTRIES = 20_000;
const NATIVE_DURABLE_IDENTITY_MAX_BYTES = 2 * 1024 * 1024;
const NATIVE_RUNNER_STATE_MAX_BYTES = 16 * 1024 * 1024;
const NATIVE_WARM_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_HOME_NON_PERSISTENT_ENTRIES = [
  "tmp",
  ".tmp",
  "auth.json",
  "config.toml",
] as const;
const RUNNERD_CONTROL_PLANE_STATE_SCHEMA =
  "paperclip.runner.durable.control-plane-state.v1";
const RUNNERD_STATE_SCHEMA = "paperclip.runner.durable.state.v1";
const CODEX_PROVIDER_STATE_SCHEMA = "paperclip.runner.codex-provider-state.v1";
const ACPX_PROVIDER_STATE_SCHEMA = "paperclip.runner.acpx-provider-state.v3";
const MANAGED_PROVIDER_STATE_SCHEMA =
  "paperclip.runner.managed-provider-state.v1";
const RUNNERD_STATE_LIFECYCLES = new Set([
  "connecting",
  "ready",
  "backpressure",
  "recoverable_failure",
  "unrecoverable",
  "suspended",
  "stopped",
  "revoked",
]);
const TERMINAL_HEARTBEAT_RUN_STATUSES = new Set([
  "succeeded",
  "interrupted",
  "failed",
  "cancelled",
  "timed_out",
]);
const NATIVE_SESSION_EXECUTION_LEASE_TTL_MS = 20 * 60_000;
const NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS = 5 * 60_000;
const NATIVE_SESSION_CANCELLATION_CLEANUP_GRACE_MS = 2_000;
const NATIVE_RUNTIME_REQUEST_RESOLUTION_CACHE_MAX = 256;
type NativeRuntimeRequestResolution = {
  runId: string;
  fingerprint: string;
  commandId: string;
  pending: Promise<void>;
  completedAt: number | null;
};
const nativeRuntimeRequestResolutions = new Map<
  string,
  NativeRuntimeRequestResolution
>();

async function verifiedRecoveryProcessIsAlive(input: {
  pid: number;
  startedAt: string;
}): Promise<boolean> {
  try {
    process.kill(input.pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "EPERM")
      return false;
  }
  try {
    const observed = await readProcessStartedAt(input.pid);
    return (
      observed !== null &&
      new Date(observed).getTime() === new Date(input.startedAt).getTime()
    );
  } catch {
    return false;
  }
}

async function signalVerifiedRecoveryProcess(
  input: { pid: number; startedAt: string },
  signal: NodeJS.Signals,
): Promise<boolean> {
  if (!(await verifiedRecoveryProcessIsAlive(input))) return false;
  try {
    return process.kill(input.pid, signal);
  } catch {
    return false;
  }
}

function pruneNativeRuntimeRequestResolutionCache(): void {
  const completed = [...nativeRuntimeRequestResolutions.entries()]
    .filter(([, resolution]) => resolution.completedAt !== null)
    .sort(
      ([, left], [, right]) =>
        (left.completedAt ?? 0) - (right.completedAt ?? 0),
    );
  for (
    let index = 0;
    index < completed.length - NATIVE_RUNTIME_REQUEST_RESOLUTION_CACHE_MAX;
    index += 1
  ) {
    nativeRuntimeRequestResolutions.delete(completed[index]![0]);
  }
}

function clearNativeRuntimeRequestResolutions(runId: string): void {
  for (const [key, resolution] of nativeRuntimeRequestResolutions) {
    if (resolution.runId === runId) {
      nativeRuntimeRequestResolutions.delete(key);
    }
  }
}

type WarmNativeSession = {
  session: NativeSession;
  configDigest: string;
  busy: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  lastActivityAt: string;
};

const warmNativeSessions = new Map<string, WarmNativeSession>();

function readBoundedNativeFile(
  path: string,
  maxBytes: number,
  errorCode: string,
): Buffer {
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile() || before.size > maxBytes) throw new Error(errorCode);
    const output = Buffer.allocUnsafe(before.size);
    let offset = 0;
    while (offset < output.length) {
      const bytesRead = readSync(
        descriptor,
        output,
        offset,
        output.length - offset,
        offset,
      );
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = fstatSync(descriptor);
    if (
      offset !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino
    ) {
      throw new Error("native_state_file_changed");
    }
    return output;
  } finally {
    closeSync(descriptor);
  }
}

const NATIVE_PROVIDER_HOST_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TEMP",
  "TMP",
  "CODEX_HOME",
  "XDG_CONFIG_HOME",
  "XDG_CACHE_HOME",
  "XDG_DATA_HOME",
  "SystemRoot",
  "PATHEXT",
] as const;

async function measureNativeRunnerSpan<T>(
  trace: NativeRunTrace | undefined,
  name: string,
  fn: () => Promise<T>,
  options:
    | string
    | {
        parentName?: string;
        attributes?: Record<string, string | number | boolean>;
      } = {},
): Promise<T> {
  return trace
    ? trace.measure(
        name,
        fn,
        typeof options === "string" ? { parentName: options } : options,
      )
    : fn();
}

/**
 * Provider bootstrap needs a small amount of host process context even when
 * the agent has no configured env. In particular, an empty environment makes
 * a bare `codex` command unresolvable. Agent-configured values remain
 * authoritative and may intentionally override the host defaults, while the
 * server-selected workspace remains an immutable containment boundary.
 */
export function buildNativeProviderEnvironment(
  configured: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv = process.env,
  assignedWorkspaceCwd?: string,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    NATIVE_PROVIDER_HOST_ENV_KEYS.flatMap((key) => {
      const value = host[key];
      return typeof value === "string" && value.length > 0
        ? [[key, value]]
        : [];
    }),
  );
  const environment = { ...inherited, ...configured };
  if (assignedWorkspaceCwd?.trim()) {
    environment.PAPERCLIP_WORKSPACE_CWD = assignedWorkspaceCwd;
  }
  return environment;
}

type PlanSynchronization = {
  eventId: string;
  planId: string;
  providerRevision: number;
  status:
    | "synchronized"
    | "already_synchronized"
    | "conflict"
    | "invalid"
    | "approval_failed";
  baseRevisionId: string | null;
  digest: string;
  documentRevision: number | null;
  currentRevisionId: string | null;
  confirmationId: string | null;
};

type RuntimeQuestionFallback = {
  kind: "ask_user_questions";
  idempotencyKey: string;
  sourceRunId: string;
  title: string | null;
  summary: string | null;
  continuationPolicy: "wake_assignee";
  payload: {
    version: 1;
    title?: string;
    submitLabel?: string;
    supersedeOnUserComment: false;
    runtimeRequestId: string;
    questionSet: PaperclipQuestionSet;
    questions: Array<{
      id: string;
      prompt: string;
      helpText?: string;
      selectionMode: "single" | "multi";
      required: boolean;
      options: Array<{
        id: string;
        label: string;
        description?: string;
        freeText?: boolean;
      }>;
    }>;
  };
};

/** Translate non-replayable live-input expirations into one durable interaction. */
export function runtimeQuestionFallbackFromEvent(
  event: Pick<PrpEvent, "eventType" | "payload" | "runId">,
): RuntimeQuestionFallback | null {
  if (event.eventType !== "runtime_request.expired") return null;
  const payload = record(event.payload);
  if (
    !["durable_handoff", "provider_process_lost"].includes(
      String(payload.reason),
    ) ||
    payload.replayAllowed !== false
  )
    return null;
  const request = record(payload.request);
  if (
    payload.requestKind !== "runtime" ||
    payload.requestType !== "input" ||
    request.schema !== "paperclip.runtime_request.v2" ||
    request.requestKind !== "runtime" ||
    request.type !== "input" ||
    typeof request.requestId !== "string" ||
    payload.requestId !== request.requestId ||
    typeof request.turnId !== "string" ||
    typeof request.itemId !== "string"
  )
    return null;
  let questionSet: PaperclipQuestionSet;
  try {
    questionSet = parsePaperclipQuestionSet(request.input);
  } catch {
    return null;
  }
  const questions = questionSet.questions.map((question) => ({
    id: question.id,
    prompt: question.prompt,
    ...(question.helpText ? { helpText: question.helpText } : {}),
    selectionMode:
      question.answerMode === "multi_select"
        ? ("multi" as const)
        : ("single" as const),
    required: question.required,
    options:
      question.answerMode === "text"
        ? [
            {
              id: "__paperclip_text__",
              label:
                question.textValidation?.inputType === "integer"
                  ? "Enter an integer"
                  : question.textValidation?.inputType === "number"
                    ? "Enter a number"
                    : "Enter your answer",
              freeText: true,
            },
          ]
        : (question.options ?? []).map((option) => ({
            id: option.id,
            label: option.label,
            ...(option.description ? { description: option.description } : {}),
          })),
  }));
  return {
    kind: "ask_user_questions",
    idempotencyKey: `runtime-input-durable:v1:${event.runId}:${request.requestId}`,
    sourceRunId: event.runId,
    title: questionSet.title?.slice(0, 240) ?? null,
    summary: questionSet.description?.slice(0, 1000) ?? null,
    continuationPolicy: "wake_assignee",
    payload: {
      version: 1,
      ...(questionSet.title ? { title: questionSet.title.slice(0, 240) } : {}),
      ...(questionSet.submitLabel
        ? { submitLabel: questionSet.submitLabel.slice(0, 120) }
        : {}),
      supersedeOnUserComment: false,
      runtimeRequestId: request.requestId,
      questionSet,
      questions,
    },
  };
}

/**
 * Materialize the durable replacement for a non-replayable runtime question.
 *
 * The interaction service enforces the fallback's stable idempotency key, so
 * this is safe both immediately after the event commit and while recovering an
 * exact duplicate whose original post-commit callback did not finish.
 */
export async function materializeRuntimeQuestionFallback(input: {
  db: Db;
  binding: {
    companyId: string;
    issueId: string;
    runId: string;
    agentId: string;
  };
  event: Pick<PrpEvent, "eventType" | "payload" | "runId">;
}): Promise<{
  fallback: RuntimeQuestionFallback;
  interaction: { id: string };
} | null> {
  const fallback = runtimeQuestionFallbackFromEvent(input.event);
  if (!fallback) return null;
  const interaction = await issueThreadInteractionService(input.db).create(
    {
      id: input.binding.issueId,
      companyId: input.binding.companyId,
    },
    fallback as never,
    {
      agentId: input.binding.agentId,
      runId: input.binding.runId,
      systemId: "native-runtime-question-handoff",
    },
  );
  return { fallback, interaction };
}

export function runtimeInputLifecycleMetric(
  event: Pick<PrpEvent, "eventType" | "payload">,
): {
  outcome:
    | "normalized"
    | "rejected"
    | "resolved"
    | "expired"
    | "durable_handoff"
    | "provider_loss_handoff"
    | "cancelled";
  adapter: string;
  requestId: string | null;
} | null {
  const payload = record(event.payload);
  const request = record(payload.request);
  if (
    event.eventType === "runtime_request.created" &&
    request.type === "input"
  ) {
    const origin = record(request.origin);
    return {
      outcome: "normalized",
      adapter: typeof origin.adapter === "string" ? origin.adapter : "unknown",
      requestId:
        typeof request.requestId === "string" ? request.requestId : null,
    };
  }
  if (
    event.eventType === "harness.diagnostic" &&
    payload.code === "runtime_input_rejected"
  ) {
    return {
      outcome: "rejected",
      adapter:
        typeof payload.adapter === "string" ? payload.adapter : "unknown",
      requestId: null,
    };
  }
  const terminalOutcome =
    event.eventType === "runtime_request.resolved"
      ? "resolved"
      : event.eventType === "runtime_request.expired" &&
          payload.reason === "durable_handoff"
        ? "durable_handoff"
        : event.eventType === "runtime_request.expired" &&
            payload.reason === "provider_process_lost"
          ? "provider_loss_handoff"
          : event.eventType === "runtime_request.expired"
            ? "expired"
            : event.eventType === "runtime_request.cancelled"
              ? "cancelled"
              : null;
  const requestType = payload.requestType ?? request.type;
  if (!terminalOutcome || requestType !== "input") return null;
  const origin = record(request.origin);
  return {
    outcome: terminalOutcome,
    adapter:
      typeof payload.adapter === "string"
        ? payload.adapter
        : typeof origin.adapter === "string"
          ? origin.adapter
          : "unknown",
    requestId:
      typeof payload.requestId === "string"
        ? payload.requestId
        : typeof request.requestId === "string"
          ? request.requestId
          : null,
  };
}

export function providerPlanMarkdown(payload: Record<string, unknown>): string {
  const completedMarkdown =
    typeof payload.markdown === "string" ? payload.markdown.trim() : "";
  if (completedMarkdown) return completedMarkdown.slice(0, 256_000);
  const explanation =
    typeof payload.explanation === "string" ? payload.explanation.trim() : "";
  const steps = Array.isArray(payload.steps) ? payload.steps : [];
  const lines = steps.slice(0, 256).flatMap((value) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const step = value as Record<string, unknown>;
    const body =
      typeof step.body === "string" ? step.body.trim().slice(0, 4_000) : "";
    if (!body) return [];
    const status = step.status === "completed" ? "x" : " ";
    const suffix =
      step.status === "blocked"
        ? " _(blocked)_"
        : step.status === "in_progress"
          ? " _(in progress)_"
          : "";
    return [`- [${status}] ${body}${suffix}`];
  });
  return [explanation, lines.join("\n")]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, 256_000);
}

export function semanticProviderPlanMarkdown(
  result: Record<string, unknown>,
): string | null {
  const artifacts = Array.isArray(result.artifacts) ? result.artifacts : [];
  for (const value of artifacts) {
    const artifact = record(value);
    if (
      artifact.kind !== "native_provider_plan" ||
      typeof artifact.ref !== "string"
    )
      continue;
    const match = artifact.ref.match(
      /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/i,
    );
    const completedMarkdown = match?.[1]?.trim();
    if (completedMarkdown) return completedMarkdown.slice(0, 256_000);

    const embedded = artifact.ref.match(
      /^native-provider-plan:([^\n]+)\n([\s\S]+)$/i,
    );
    if (embedded) {
      const title = embedded[1]!
        .replace(/^(?:DOT-\d+-)?/i, "")
        .replace(/-v\d+$/i, "")
        .replace(/-/g, " ")
        .trim();
      const body = embedded[2]!.trim();
      if (title && body) {
        return [`# ${title.charAt(0).toUpperCase()}${title.slice(1)}`, "", body]
          .join("\n")
          .slice(0, 256_000);
      }
    }

    if (/^\s*1\.\s+/.test(artifact.ref)) {
      const numberedPlan = artifact.ref
        .split(/\s+\|\s+(?=\d+\.\s+)/)
        .join("\n")
        .trim();
      if (numberedPlan) return `# Plan\n\n${numberedPlan}`.slice(0, 256_000);
    }

    // Some qualified Codex builds use the artifact reference itself as a
    // compact, human-readable plan. Accept only an explicitly numbered form;
    // arbitrary opaque artifact references must never become plan documents.
    const inlineNumbered = artifact.ref.trim();
    if (/\(1\)\s+.+\(2\)\s+/s.test(inlineNumbered)) {
      const body = inlineNumbered
        .replace(/^DOT-\d+\s+plan:\s*/i, "")
        .replace(/^\(1\)\s*/, "1. ")
        .replace(/;\s*\((\d+)\)\s*/g, "\n$1. ")
        .trim();
      if (body) return `# Plan\n\n${body}`.slice(0, 256_000);
    }

    const compact =
      artifact.ref.match(/^native-provider-plan:([^#]+)#(.+)$/i) ??
      artifact.ref.match(/^native-plan:\/\/[^/]+\/([^#]+)#(.+)$/i);
    if (!compact) continue;
    const humanize = (slug: string) =>
      slug
        .replace(
          /\b(GET|POST|PUT|PATCH|DELETE)-([a-z0-9][a-z0-9-]*)/gi,
          (_whole, method: string, path: string) =>
            `${method.toUpperCase()} /${path}`,
        )
        .replace(/-/g, " ")
        .replace(/\bjson\b/gi, "JSON")
        .replace(/\bapi\b/gi, "API")
        .replace(/\s+/g, " ")
        .trim();
    const title = humanize(compact[1]!.replace(/-v\d+$/i, ""));
    const steps = compact[2]!.split(";").flatMap((encoded) => {
      const parsed = encoded.match(/^\d+-(.+)$/);
      const sentence = humanize(parsed?.[1] ?? encoded);
      return sentence
        ? [sentence.charAt(0).toUpperCase() + sentence.slice(1)]
        : [];
    });
    if (!title || steps.length === 0) continue;
    return [
      `# ${title.charAt(0).toUpperCase()}${title.slice(1)}`,
      "",
      ...steps.map((step, index) => `${index + 1}. ${step}`),
    ]
      .join("\n")
      .slice(0, 256_000);
  }
  const hasNativePlanArtifact = artifacts.some(
    (value) => record(value).kind === "native_provider_plan",
  );
  const summary =
    typeof result.summary === "string" ? result.summary.trim() : "";
  const summaryPlan = hasNativePlanArtifact
    ? summary.match(
        /(?:^|:\s*)(1\)\s+[\s\S]+;\s*2\)\s+[\s\S]+;\s*3\)\s+[\s\S]+)$/,
      )
    : null;
  if (summaryPlan) {
    const body = summaryPlan[1]!
      .replace(/^1\)\s*/, "1. ")
      .replace(/;\s*(\d+)\)\s*/g, "\n$1. ")
      .trim();
    if (body) return `# Plan\n\n${body}`.slice(0, 256_000);
  }
  return null;
}

/**
 * Convert a server-owned pending interaction into the semantic wait that a
 * provider omitted. This is not a fabricated final response: it records that
 * the current turn intentionally yielded to a durable governance surface.
 */
export function nativeGovernedWaitResult(input: {
  interaction: { id: string; title: string | null; summary: string | null };
  completionContract: NativeExecutionInput["completionContract"]["contract"];
}): PrpStructuredRunResult {
  const interactionRef = `interaction:${input.interaction.id}`;
  const label =
    input.interaction.title?.trim() ||
    input.interaction.summary?.trim() ||
    "the requested response";
  return {
    schema: "paperclip.run_result.v1",
    reportedWorkDisposition: "yielded",
    summary: `Waiting for ${label}.`,
    completionClaim: {
      contractRevision: input.completionContract.revision,
      objectiveSatisfied: false,
      criteria: input.completionContract.criteria.map((criterion) => ({
        criterionId: criterion.id,
        status: "unknown",
        evidenceRefs: [interactionRef],
      })),
      remainingWork: [
        {
          description: "Resume after the durable interaction is resolved.",
          blocksCompletion: true,
        },
      ],
    },
    evidence: [{ ref: interactionRef }],
    verification: [],
    attentionRequests: [],
    artifacts: [{ kind: "issue_thread_interaction", ref: interactionRef }],
    continuation: {
      kind: "response_wake",
      summary:
        "Resume from the resolved interaction response without repeating prior work.",
      idempotencyKey: `interaction-response:${input.interaction.id}`,
    },
  };
}

/**
 * Bridge an asynchronous durable-interaction lookup to the runner package's
 * synchronous governed-wait boundary. Observations are single-use and bound
 * to one exact source event so a delayed or replayed lookup cannot leak into a
 * later provider event.
 */
export function createGovernedWaitEventObservation(
  resolvePending: () => Promise<PrpStructuredRunResult | null>,
) {
  let generation = 0;
  let observation: {
    sourceInstanceId: string;
    sourceEventId: string;
    sourceSeq: number;
    result: PrpStructuredRunResult;
  } | null = null;

  return {
    async observe(event: PrpEvent, eligible: boolean): Promise<void> {
      const currentGeneration = ++generation;
      observation = null;
      if (!eligible) return;
      const result = await resolvePending();
      if (generation !== currentGeneration || result === null) return;
      // If the interaction is answered after this read, parking remains the
      // fail-closed outcome: the durable answer owns the response-wake path.
      // Continuing provider work on a possibly stale authorization does not.
      observation = {
        sourceInstanceId: event.sourceInstanceId,
        sourceEventId: event.sourceEventId,
        sourceSeq: event.sourceSeq,
        result,
      };
    },
    consume(event: PrpEvent): PrpStructuredRunResult | null {
      generation += 1;
      const current = observation;
      observation = null;
      if (
        current === null ||
        current.sourceInstanceId !== event.sourceInstanceId ||
        current.sourceEventId !== event.sourceEventId ||
        current.sourceSeq !== event.sourceSeq
      ) {
        return null;
      }
      return current.result;
    },
  };
}

/**
 * Partial item-verdict responses deliberately leave their original durable
 * interaction pending. They are already authority-checked before entering the
 * closed native envelope, so that exact interaction may park the continuation
 * run without requiring the model to recreate a second request.
 */
export function continuingPendingInteractionIds(
  execution: NativeExecutionInput,
): string[] {
  return execution.interactionResponses
    .filter(
      (response) =>
        response.kind === "request_item_verdicts" &&
        response.response.status === "pending",
    )
    .map((response) => response.interactionId);
}

export async function synchronizeCompletedProviderPlan(input: {
  db: Db;
  execution: NativeExecutionInput;
  event: {
    sourceEventId: string;
    turnId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  };
}): Promise<PlanSynchronization | null> {
  if (
    input.event.eventType !== "plan.updated" ||
    input.event.payload.complete !== true
  )
    return null;
  if (
    !("executionMode" in input.execution) ||
    input.execution.executionMode !== "plan"
  )
    return null;
  const planningContext = input.execution.planningContext;
  if (!planningContext) return null;
  const planId =
    typeof input.event.payload.planId === "string"
      ? input.event.payload.planId
      : "";
  const providerRevision = Number.isSafeInteger(input.event.payload.revision)
    ? Number(input.event.payload.revision)
    : 0;
  const body = providerPlanMarkdown(input.event.payload);
  const digest = createHash("sha256").update(body).digest("hex");
  if (!planId || providerRevision < 1 || !body) {
    return {
      eventId: input.event.sourceEventId,
      planId,
      providerRevision,
      status: "invalid",
      baseRevisionId: planningContext.baseRevisionId,
      digest,
      documentRevision: null,
      currentRevisionId: null,
      confirmationId: null,
    };
  }
  const provenance = `runner-plan-sync:v2 run=${input.execution.binding.runId} turn=${input.event.turnId ?? "unknown"} provider=${input.execution.provider.kind} plan=${planId} revision=${providerRevision} digest=${digest}`;
  const existingRevision = await input.db
    .select({
      revisionNumber: documentRevisions.revisionNumber,
      id: documentRevisions.id,
    })
    .from(documentRevisions)
    .innerJoin(
      issueDocuments,
      eq(issueDocuments.documentId, documentRevisions.documentId),
    )
    .where(
      and(
        eq(issueDocuments.issueId, input.execution.binding.issueId),
        eq(issueDocuments.key, "plan"),
        eq(documentRevisions.changeSummary, provenance),
      ),
    )
    .orderBy(desc(documentRevisions.revisionNumber))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const documents = documentService(input.db);
  let revision = existingRevision;
  let status: PlanSynchronization["status"] = existingRevision
    ? "already_synchronized"
    : "synchronized";
  if (!revision) {
    const latest = await documents.getIssueDocumentByKey(
      input.execution.binding.issueId,
      "plan",
    );
    if (latest?.latestRevisionId && latest.body === body) {
      const sameRunRevision = await input.db
        .select({
          id: documentRevisions.id,
          revisionNumber: documentRevisions.revisionNumber,
          createdByRunId: documentRevisions.createdByRunId,
        })
        .from(documentRevisions)
        .where(eq(documentRevisions.id, latest.latestRevisionId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (sameRunRevision?.createdByRunId === input.execution.binding.runId) {
        revision = sameRunRevision;
        status = "already_synchronized";
      }
    }
  }
  try {
    if (!revision) {
      const write = await documents.upsertIssueDocument({
        issueId: input.execution.binding.issueId,
        key: "plan",
        title: "Plan",
        format: "markdown",
        body,
        baseRevisionId: planningContext.baseRevisionId,
        changeSummary: provenance,
        createdByAgentId: input.execution.binding.agentId,
        createdByRunId: input.execution.binding.runId,
      });
      revision = {
        revisionNumber: write.document.latestRevisionNumber,
        id: write.document.latestRevisionId!,
      };
    }
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    const latest = await documents.getIssueDocumentByKey(
      input.execution.binding.issueId,
      "plan",
    );
    return {
      eventId: input.event.sourceEventId,
      planId,
      providerRevision,
      status: "conflict",
      baseRevisionId: planningContext.baseRevisionId,
      digest,
      documentRevision: latest?.latestRevisionNumber ?? null,
      currentRevisionId: latest?.latestRevisionId ?? null,
      confirmationId: null,
    };
  }
  const current = await documents.getIssueDocumentByKey(
    input.execution.binding.issueId,
    "plan",
  );
  if (!current || !revision?.id || current.latestRevisionId !== revision.id) {
    return {
      eventId: input.event.sourceEventId,
      planId,
      providerRevision,
      status: "conflict",
      baseRevisionId: planningContext.baseRevisionId,
      digest,
      documentRevision: current?.latestRevisionNumber ?? null,
      currentRevisionId: current?.latestRevisionId ?? null,
      confirmationId: null,
    };
  }
  let confirmationId: string;
  let confirmationPending = false;
  try {
    const confirmation = await issueThreadInteractionService(input.db).create(
      {
        id: input.execution.binding.issueId,
        companyId: input.execution.binding.companyId,
      },
      {
        kind: "request_confirmation",
        idempotencyKey: `runner-plan-approval:v1:${input.execution.binding.runId}:${planId}:${providerRevision}:${digest}`,
        sourceRunId: input.execution.binding.runId,
        title: `Review plan revision ${revision.revisionNumber}`,
        summary: "Review the synchronized Paperclip plan.",
        continuationPolicy: "wake_assignee",
        payload: {
          version: 1,
          prompt: `Approve plan revision ${revision.revisionNumber}?`,
          detailsMarkdown:
            "The completed provider plan has been synchronized to the canonical Plan document.",
          acceptLabel: "Approve plan",
          rejectLabel: "Request changes",
          rejectRequiresReason: true,
          supersedeOnUserComment: false,
          target: {
            type: "issue_document",
            issueId: input.execution.binding.issueId,
            documentId: current.id,
            key: "plan",
            revisionId: revision.id,
            revisionNumber: revision.revisionNumber,
            label: `Plan v${revision.revisionNumber}`,
          },
        },
      } as never,
      {
        agentId: input.execution.binding.agentId,
        runId: input.execution.binding.runId,
      },
    );
    confirmationId = confirmation.id;
    confirmationPending = confirmation.status === "pending";
  } catch {
    return {
      eventId: input.event.sourceEventId,
      planId,
      providerRevision,
      status: "approval_failed",
      baseRevisionId: planningContext.baseRevisionId,
      digest,
      documentRevision: revision.revisionNumber,
      currentRevisionId: revision.id,
      confirmationId: null,
    };
  }
  if (confirmationPending) {
    try {
      const currentIssue = await input.db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, input.execution.binding.issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (currentIssue && currentIssue.status !== "in_review") {
        await issueService(input.db).update(input.execution.binding.issueId, {
          status: "in_review",
          actorAgentId: input.execution.binding.agentId,
        });
      }
    } catch {
      const settledIssue = await input.db
        .select({ status: issues.status })
        .from(issues)
        .where(eq(issues.id, input.execution.binding.issueId))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (settledIssue?.status !== "in_review") {
        return {
          eventId: input.event.sourceEventId,
          planId,
          providerRevision,
          status: "approval_failed",
          baseRevisionId: planningContext.baseRevisionId,
          digest,
          documentRevision: revision.revisionNumber,
          currentRevisionId: revision.id,
          confirmationId,
        };
      }
    }
  }
  return {
    eventId: input.event.sourceEventId,
    planId,
    providerRevision,
    status,
    baseRevisionId: planningContext.baseRevisionId,
    digest,
    documentRevision: revision.revisionNumber,
    currentRevisionId: revision.id,
    confirmationId,
  };
}

class SessionToolAuthorityEpoch {
  readonly runId: string;
  #authority: PaperclipRunnerToolAuthority;
  #revoked = false;

  constructor(runId: string, authority: PaperclipRunnerToolAuthority) {
    this.runId = runId;
    this.#authority = authority;
  }

  revoke(): void {
    this.#revoked = true;
  }

  #assertCurrent(): void {
    if (this.#revoked) {
      throw new Error("native_tool_authority_epoch_revoked");
    }
  }

  definitions() {
    this.#assertCurrent();
    return this.#authority.definitions();
  }

  async execute(call: Parameters<PaperclipRunnerToolAuthority["execute"]>[0]) {
    this.#assertCurrent();
    return await this.#authority.execute(call);
  }
}

const sessionToolAuthorityEpochs = new Map<string, SessionToolAuthorityEpoch>();
const initializingSessionToolAuthorities = new Set<string>();
const executingRunnerdSessionScopes = new Map<string, string>();

function nativeSessionKey(execution: NativeExecutionInput): string {
  return (
    execution.session.normalizedSessionId ??
    `session-${execution.binding.runId}`
  );
}

function nativeSessionWorkspaceScope(execution: NativeExecutionInput) {
  // Projectless local runs use the heartbeat run id as a durable placeholder
  // rather than fabricating an execution_workspaces row. Do not let that
  // per-run placeholder break continuity for the same provider session; the
  // immutable workspace descriptor is the stable identity in that case.
  const transientWorkspace =
    execution.binding.executionWorkspaceId === execution.binding.runId;
  return transientWorkspace
    ? {
        kind: "transient" as const,
        cwd: execution.workspace.cwd,
        repoUrl: execution.workspace.repoUrl,
        repoRef: execution.workspace.repoRef,
        branchName: execution.workspace.branchName,
      }
    : {
        kind: "managed" as const,
        executionWorkspaceId: execution.binding.executionWorkspaceId,
      };
}

function nativeProviderSessionScope(execution: NativeExecutionInput) {
  switch (execution.provider.kind) {
    case "claude_managed":
      return {
        kind: execution.provider.kind,
        profileId: execution.provider.managedProfile.profileId,
      };
    case "aws_agentcore":
      return {
        kind: execution.provider.kind,
        profileId: execution.provider.agentCoreProfile.profileId,
      };
    case "acpx":
      return {
        kind: execution.provider.kind,
        agent: execution.provider.agent,
        profile: execution.provider.profile,
      };
    case "codex":
    case "opencode":
      // These local providers have no separate persisted profile id. Company,
      // agent, and workspace bind their credential/session context; mutable
      // model and permission settings remain in nativeSessionConfigDigest so
      // they rotate an incompatible warm session within the same scope.
      return { kind: execution.provider.kind };
  }
}

function nativeSessionScopeKey(execution: NativeExecutionInput): string {
  return canonicalJson({
    schema: "paperclip.native-session-scope.v2",
    companyId: execution.binding.companyId,
    agentId: execution.binding.agentId,
    workspace: nativeSessionWorkspaceScope(execution),
    provider: {
      driverKind: execution.session.driverKind,
      identity: nativeProviderSessionScope(execution),
    },
    normalizedSessionId: nativeSessionKey(execution),
  });
}

function legacyCompanyNativeSessionScopeKey(
  execution: NativeExecutionInput,
): string {
  return JSON.stringify([
    execution.binding.companyId,
    nativeSessionKey(execution),
  ]);
}

function runnerdStateBase(): string {
  return (
    process.env.PAPERCLIP_RUNNER_STATE_DIR ??
    resolve(
      resolvePaperclipInstanceRoot(),
      "runtime",
      "paperclip-runner",
      "durable-sessions",
    )
  );
}

function scopedRunnerdStateRoot(execution: NativeExecutionInput): string {
  return resolve(
    runnerdStateBase(),
    createHash("sha256").update(nativeSessionScopeKey(execution)).digest("hex"),
  );
}

function scrubRunnerdQuarantineLaunchState(root: string): void {
  const codexHome = resolve(root, "codex-home");
  const codexHomeStats = lstatSync(codexHome, { throwIfNoEntry: false });
  if (!codexHomeStats) return;
  if (!codexHomeStats.isDirectory() || codexHomeStats.isSymbolicLink()) {
    throw new Error("runner_state_directory_unsafe");
  }
  for (const name of CODEX_HOME_NON_PERSISTENT_ENTRIES) {
    const entry = resolve(codexHome, name);
    const stats = lstatSync(entry, { throwIfNoEntry: false });
    if (!stats) continue;
    // Remove symlinks themselves, never their targets. Real temporary
    // directories are safe to remove recursively inside the verified home.
    rmSync(entry, {
      recursive: stats.isDirectory() && !stats.isSymbolicLink(),
      force: true,
    });
  }
}

function quarantineRunnerdStateRoot(
  root: string,
  reason: "identity_indeterminate" | "identity_mismatch",
): string {
  const stateBase = resolve(runnerdStateBase());
  const resolvedRoot = resolve(root);
  const stateKey = basename(resolvedRoot);
  // Callers pass only roots derived by this module. Keep that boundary explicit
  // so a future call site cannot turn quarantine into an arbitrary filesystem
  // move, and never follow or move a symlink in place of the state directory.
  if (
    dirname(resolvedRoot) !== stateBase ||
    !/^[a-f0-9]{64}$/.test(stateKey) ||
    !isSafeNativeStateDirectory(resolvedRoot)
  ) {
    throw new Error("runner_state_directory_unsafe");
  }
  // Quarantine retains durable session history for diagnosis and recovery, but
  // launch credentials and transient files are re-materializable and must not
  // survive after this state loses authority.
  scrubRunnerdQuarantineLaunchState(resolvedRoot);
  const quarantineRoot = resolve(stateBase, "quarantine");
  mkdirSync(quarantineRoot, { recursive: true, mode: 0o700 });
  if (!isSafeNativeStateDirectory(quarantineRoot)) {
    throw new Error("runner_state_directory_unsafe");
  }
  const destination = resolve(
    quarantineRoot,
    `${stateKey}.${reason}.${Date.now()}.${process.pid}.${randomUUID()}`,
  );
  renameSync(resolvedRoot, destination);
  return destination;
}

function legacyCompanyRunnerdStateRoot(
  execution: NativeExecutionInput,
): string {
  return resolve(
    runnerdStateBase(),
    createHash("sha256")
      .update(legacyCompanyNativeSessionScopeKey(execution))
      .digest("hex"),
  );
}

function legacyRunnerdStateRoot(execution: NativeExecutionInput): string {
  return resolve(
    runnerdStateBase(),
    createHash("sha256").update(nativeSessionKey(execution)).digest("hex"),
  );
}

function migrateLegacyRunnerdStateRoot(input: {
  legacy: string;
  scoped: string;
  execution: NativeExecutionInput;
  verifiedPriorRunId?: string;
}): string | null {
  if (!existsSync(input.legacy)) return null;
  if (!isSafeNativeStateDirectory(input.legacy)) {
    throw new Error("runner_state_directory_unsafe");
  }
  const legacyIdentity = readRunnerdDurableIdentity(input.legacy);
  const exactRun = durableIdentityMatchesExecution(
    legacyIdentity,
    input.execution,
  );
  const verifiedSettledPriorRun = Boolean(
    input.verifiedPriorRunId &&
    legacyIdentity?.runId === input.verifiedPriorRunId &&
    durableIdentityMatchesSession(legacyIdentity, input.execution),
  );
  if (!exactRun && !verifiedSettledPriorRun) {
    // A legacy path does not encode the full session scope. A mismatch may be
    // valid live state owned by another agent/workspace, so refusing the claim
    // is safe but moving that ambiguous directory is not.
    throw new Error("runner_state_identity_mismatch");
  }
  if (
    exactRun &&
    legacyIdentity &&
    ["absent", "indeterminate"].includes(
      runnerdAuthorityLifecycle(
        input.legacy,
        legacyIdentity as RunnerdDurableIdentity,
      ),
    )
  ) {
    quarantineRunnerdStateRoot(input.legacy, "identity_indeterminate");
    throw new Error("runner_state_identity_mismatch");
  }
  try {
    renameSync(input.legacy, input.scoped);
  } catch (error) {
    // Another in-process recovery may have won the atomic rename. The scoped
    // directory is authoritative once it exists; otherwise preserve the
    // original migration failure rather than silently starting empty state.
    if (!isSafeNativeStateDirectory(input.scoped)) throw error;
    const scopedIdentity = readRunnerdDurableIdentity(input.scoped);
    const exactScopedRun = durableIdentityMatchesExecution(
      scopedIdentity,
      input.execution,
    );
    const sameVerifiedPriorRun = Boolean(
      input.verifiedPriorRunId &&
      scopedIdentity &&
      scopedIdentity.runId === input.verifiedPriorRunId &&
      scopedIdentity.runnerInstanceId === legacyIdentity?.runnerInstanceId &&
      scopedIdentity.environmentLeaseId ===
        legacyIdentity?.environmentLeaseId &&
      durableIdentityMatchesSession(scopedIdentity, input.execution),
    );
    if (!exactScopedRun && !sameVerifiedPriorRun) {
      throw new Error("runner_state_identity_mismatch");
    }
  }
  return input.scoped;
}

function runnerdAuthorityLifecycle(
  root: string,
  identity: RunnerdDurableIdentity,
): "absent" | "suspended" | "not_suspended" | "indeterminate" {
  const runnerRoot = resolve(root, "runner");
  if (!existsSync(runnerRoot)) return "absent";
  if (!isSafeNativeStateDirectory(runnerRoot)) return "indeterminate";
  const statePath = resolve(runnerRoot, "runner-state.json");
  if (!existsSync(statePath)) {
    try {
      // Older remote transports created this controller-side placeholder even
      // though runner state was owned by the sandbox. It carries no authority,
      // so a verified failover backup may be consulted. Any non-empty direct
      // directory remains indeterminate and therefore blocks fallback.
      return readdirSync(runnerRoot).length === 0 ? "absent" : "indeterminate";
    } catch {
      return "indeterminate";
    }
  }
  try {
    const state = record(
      JSON.parse(
        readBoundedNativeFile(
          statePath,
          NATIVE_RUNNER_STATE_MAX_BYTES,
          "runner_state_too_large",
        ).toString("utf8"),
      ),
    );
    if (
      state.schema !== RUNNERD_STATE_SCHEMA ||
      typeof state.lifecycle !== "string" ||
      !RUNNERD_STATE_LIFECYCLES.has(state.lifecycle)
    ) {
      return "indeterminate";
    }
    if (
      state.runnerInstanceId === identity.runnerInstanceId &&
      state.environmentLeaseId === identity.environmentLeaseId &&
      state.runId === identity.runId &&
      state.normalizedSessionId === identity.normalizedSessionId
    ) {
      if (state.lifecycle === "suspended") return "suspended";
      return "not_suspended";
    }
    return "indeterminate";
  } catch {
    return "indeterminate";
  }
}

function runnerdAuthorityLifecycleWithVerifiedBackup(input: {
  root: string;
  identity: RunnerdDurableIdentity;
  execution: NativeExecutionInput;
  allowVerifiedBackup: boolean;
}): "suspended" | "not_suspended" | "indeterminate" {
  const direct = runnerdAuthorityLifecycle(input.root, input.identity);
  if (direct !== "absent") return direct;
  if (!input.allowVerifiedBackup) return "indeterminate";
  const backup = verifyNativeHarnessBackup({
    root: input.root,
    execution: input.execution,
    runnerInstanceId: input.identity.runnerInstanceId,
  });
  if (!backup) return "indeterminate";
  const backupLifecycle = runnerdAuthorityLifecycle(
    backup.root,
    input.identity,
  );
  return backupLifecycle === "absent" ? "indeterminate" : backupLifecycle;
}

type PriorRunnerdStateVerification =
  | "verified"
  | "active"
  | "authority_indeterminate"
  | "scope_mismatch"
  | "terminal_state_indeterminate"
  | "unavailable";

async function verifyPriorRunnerdStateForSessionScope(input: {
  db: Db;
  root: string;
  identity: RunnerdDurableIdentity;
  execution: NativeExecutionInput;
  allowVerifiedBackup: boolean;
}): Promise<PriorRunnerdStateVerification> {
  let priorRun: {
    status: string;
    runnerProfileJson: unknown;
  } | null;
  try {
    priorRun = await input.db
      .select({
        status: heartbeatRuns.status,
        runnerProfileJson: heartbeatRuns.runnerProfileJson,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.id, input.identity.runId),
          eq(heartbeatRuns.companyId, input.execution.binding.companyId),
          eq(heartbeatRuns.agentId, input.execution.binding.agentId),
        ),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
  } catch {
    return "unavailable";
  }
  if (!priorRun) return "authority_indeterminate";
  if (!TERMINAL_HEARTBEAT_RUN_STATUSES.has(priorRun.status)) {
    return "active";
  }
  const persistedInput = record(
    priorRun.runnerProfileJson,
  ).nativeExecutionInput;
  if (persistedInput === undefined) return "authority_indeterminate";
  try {
    const priorExecution = parseNativeExecutionInput(persistedInput);
    const sameScope =
      priorExecution.binding.runId === input.identity.runId &&
      nativeSessionScopeKey(priorExecution) ===
        nativeSessionScopeKey(input.execution);
    if (!sameScope) return "scope_mismatch";
    const lifecycle = runnerdAuthorityLifecycleWithVerifiedBackup(input);
    return lifecycle === "suspended"
      ? "verified"
      : "terminal_state_indeterminate";
  } catch {
    return "authority_indeterminate";
  }
}

async function migrateRunnerdStateRootForExecution(input: {
  db: Db;
  execution: NativeExecutionInput;
  allowVerifiedBackup: boolean;
  restartRecovery?: NativeRestartRecoveryClaim;
}): Promise<void> {
  const scoped = scopedRunnerdStateRoot(input.execution);
  if (existsSync(scoped)) {
    if (!isSafeNativeStateDirectory(scoped)) {
      throw new Error("runner_state_directory_unsafe");
    }
    const identity = readRunnerdDurableIdentity(scoped);
    if (!identity) {
      if (input.restartRecovery?.kind !== "reattach_existing_runner") {
        quarantineRunnerdStateRoot(scoped, "identity_indeterminate");
      }
      throw new Error("runner_state_identity_mismatch");
    }
    if (!durableIdentityMatchesSession(identity, input.execution)) {
      if (input.restartRecovery?.kind !== "reattach_existing_runner") {
        quarantineRunnerdStateRoot(scoped, "identity_mismatch");
      }
      throw new Error("runner_state_identity_mismatch");
    }
    if (input.restartRecovery?.kind === "bootstrap_incomplete") {
      if (runnerdStateProvesIncompleteBootstrap(scoped)) {
        quarantineRunnerdStateRoot(scoped, "identity_indeterminate");
        return;
      }
      // Database evidence alone cannot distinguish a never-connected runner
      // from a partially-persisted provider bootstrap. Only the durable PRP
      // root can authorize a fresh bootstrap; anything else stays fail-closed.
      throw new Error("runner_state_identity_mismatch");
    }
    if (durableIdentityMatchesExecution(identity, input.execution)) {
      if (
        runnerdAuthorityLifecycleWithVerifiedBackup({
          root: scoped,
          identity,
          execution: input.execution,
          allowVerifiedBackup: input.allowVerifiedBackup,
        }) === "indeterminate"
      ) {
        if (input.restartRecovery?.kind !== "reattach_existing_runner") {
          quarantineRunnerdStateRoot(scoped, "identity_indeterminate");
        }
        throw new Error("runner_state_identity_mismatch");
      }
    } else {
      const verification = await verifyPriorRunnerdStateForSessionScope({
        db: input.db,
        root: scoped,
        identity,
        execution: input.execution,
        allowVerifiedBackup: input.allowVerifiedBackup,
      });
      if (verification !== "verified") {
        if (verification !== "active" && verification !== "unavailable") {
          quarantineRunnerdStateRoot(
            scoped,
            verification === "scope_mismatch"
              ? "identity_mismatch"
              : "identity_indeterminate",
          );
        }
        throw new Error("runner_state_identity_mismatch");
      }
    }
    return;
  }
  for (const legacy of [
    legacyCompanyRunnerdStateRoot(input.execution),
    legacyRunnerdStateRoot(input.execution),
  ]) {
    if (!existsSync(legacy)) continue;
    const identity = readRunnerdDurableIdentity(legacy);
    if (
      !identity ||
      !durableIdentityMatchesSession(identity, input.execution)
    ) {
      // Unlike the full-scope target above, this legacy name can legitimately
      // belong to another scope. Leave it in place for its owner and fail the
      // attempted migration visibly.
      throw new Error("runner_state_identity_mismatch");
    }
    let verifiedPriorRunId: string | undefined;
    if (!durableIdentityMatchesExecution(identity, input.execution)) {
      const verification = await verifyPriorRunnerdStateForSessionScope({
        db: input.db,
        root: legacy,
        identity,
        execution: input.execution,
        allowVerifiedBackup: input.allowVerifiedBackup,
      });
      if (verification !== "verified") {
        if (verification === "terminal_state_indeterminate") {
          // The database proves this ambiguous legacy path belongs to the same
          // full session scope and its owner is terminal, so it is now safe to
          // move aside. Scope mismatches and active/unavailable owners remain
          // untouched because the legacy name may still belong to them.
          quarantineRunnerdStateRoot(legacy, "identity_indeterminate");
        }
        throw new Error("runner_state_identity_mismatch");
      }
      verifiedPriorRunId = identity.runId;
    }
    migrateLegacyRunnerdStateRoot({
      legacy,
      scoped,
      execution: input.execution,
      ...(verifiedPriorRunId ? { verifiedPriorRunId } : {}),
    });
    return;
  }
}

export function runnerdStateProvesIncompleteBootstrap(root: string): boolean {
  try {
    const statePath = resolve(
      root,
      "control-plane",
      "control-plane-state.json",
    );
    const state = record(
      JSON.parse(
        readBoundedNativeFile(
          statePath,
          NATIVE_DURABLE_IDENTITY_MAX_BYTES,
          "runner_durable_identity_too_large",
        ).toString("utf8"),
      ),
    );
    const commands = Array.isArray(state.commands)
      ? state.commands.map(record)
      : [];
    const committedEvents = Array.isArray(state.committedEvents)
      ? state.committedEvents
      : [];
    const onlyUnconsumedBootstrapCommands = commands.every(
      (command) =>
        command.status === "pending" &&
        (command.type === "run.prepare" || command.type === "session.open"),
    );
    return (
      state.schema === RUNNERD_CONTROL_PLANE_STATE_SCHEMA &&
      state.connectionCount === 0 &&
      committedEvents.length === 0 &&
      onlyUnconsumedBootstrapCommands
    );
  } catch {
    return false;
  }
}

function isSafeNativeStateDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stats = lstatSync(path);
  return stats.isDirectory() && !stats.isSymbolicLink();
}

type RunnerdDurableIdentity = Record<string, unknown> & {
  runId: string;
  normalizedSessionId: string;
  runnerInstanceId: string;
  environmentLeaseId: string;
};

function readRunnerdDurableIdentity(
  root: string,
): Record<string, unknown> | null {
  if (!isSafeNativeStateDirectory(root)) return null;
  const controlPlaneRoot = resolve(root, "control-plane");
  if (!isSafeNativeStateDirectory(controlPlaneRoot)) return null;
  const statePath = resolve(controlPlaneRoot, "control-plane-state.json");
  if (!existsSync(statePath)) return null;
  try {
    const state = record(
      JSON.parse(
        readBoundedNativeFile(
          statePath,
          NATIVE_DURABLE_IDENTITY_MAX_BYTES,
          "runner_durable_identity_too_large",
        ).toString("utf8"),
      ),
    );
    if (state.schema !== RUNNERD_CONTROL_PLANE_STATE_SCHEMA) return null;
    return record(state.identity);
  } catch {
    return null;
  }
}

function durableIdentityMatchesExecution(
  identity: Record<string, unknown> | null,
  execution: NativeExecutionInput,
): boolean {
  return Boolean(
    identity &&
    identity.runId === execution.binding.runId &&
    durableIdentityMatchesSession(identity, execution),
  );
}

function durableIdentityMatchesSession(
  identity: Record<string, unknown> | null,
  execution: NativeExecutionInput,
): identity is RunnerdDurableIdentity {
  return Boolean(
    identity &&
    identity.normalizedSessionId === nativeSessionKey(execution) &&
    typeof identity.runId === "string" &&
    identity.runId.length > 0 &&
    typeof identity.runnerInstanceId === "string" &&
    identity.runnerInstanceId.length > 0 &&
    typeof identity.environmentLeaseId === "string" &&
    identity.environmentLeaseId.length > 0,
  );
}

/**
 * Pre-v2 state is migrated for an exact active run, or for a suspended prior
 * run whose persisted, validated execution input proves the same full native
 * session scope. Ambiguous company/session-only state can never be claimed by
 * another agent, workspace, or provider profile.
 */
function runnerdStateRoot(execution: NativeExecutionInput): string {
  const scoped = scopedRunnerdStateRoot(execution);
  if (existsSync(scoped)) {
    if (!isSafeNativeStateDirectory(scoped)) {
      throw new Error("runner_state_directory_unsafe");
    }
    return scoped;
  }
  for (const legacy of [
    legacyCompanyRunnerdStateRoot(execution),
    legacyRunnerdStateRoot(execution),
  ]) {
    const migrated = migrateLegacyRunnerdStateRoot({
      legacy,
      scoped,
      execution,
    });
    if (migrated) return migrated;
  }
  return scoped;
}

function loadRunnerdDurableBinding(execution: NativeExecutionInput): {
  runnerInstanceId: string;
  environmentLeaseId: string;
} | null {
  const identity = readRunnerdDurableIdentity(runnerdStateRoot(execution));
  // The run id is intentionally different during a continuation. Reuse only
  // the verified runner/lease binding from the same company-scoped durable
  // session root; rotateLocalAuthorityEpoch then requires that exact binding
  // before it can archive the prior per-run authority.
  if (!durableIdentityMatchesSession(identity, execution)) return null;
  return {
    runnerInstanceId: identity.runnerInstanceId,
    environmentLeaseId: identity.environmentLeaseId,
  };
}

function nativeSessionConfigDigest(execution: NativeExecutionInput): string {
  const executionLocation = {
    executionKind: "local_process",
    workspaceId: execution.binding.executionWorkspaceId,
    cwd: execution.workspace.cwd,
  };
  return `sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        companyId: execution.binding.companyId,
        normalizedSessionId: nativeSessionKey(execution),
        executionLocation,
        provider: execution.provider,
        driverKind: execution.session.driverKind,
        lifecyclePolicy: execution.session.lifecyclePolicy,
        executionMode:
          "executionMode" in execution ? execution.executionMode : "default",
        runtimeContextDigest:
          "runtimeContext" in execution
            ? execution.runtimeContext.aggregateDigest
            : null,
      }),
    )
    .digest("hex")}`;
}

function nativeHarnessEnvironmentFingerprint(
  execution: NativeExecutionInput,
): string {
  return `sha256:${createHash("sha256")
    .update(
      canonicalJson({
        companyId: execution.binding.companyId,
        agentId: execution.binding.agentId,
        issueId: execution.binding.issueId,
        normalizedSessionId: nativeSessionKey(execution),
        workspace: {
          cwd: execution.workspace.cwd,
          repoUrl: execution.workspace.repoUrl,
          repoRef: execution.workspace.repoRef,
          branchName: execution.workspace.branchName,
        },
        provider: execution.provider,
        driverKind: execution.session.driverKind,
      }),
    )
    .digest("hex")}`;
}

type NativeProviderKind = NativeExecutionInput["provider"]["kind"];
type NativeDriverKind = NativeExecutionInput["session"]["driverKind"];

export interface NativeHarnessPersistenceDirectory {
  name: "runner" | "codex-home" | "opencode" | "acpx";
  location: "runner" | "filesystem";
  excludeEntries: readonly string[];
}

export interface NativeHarnessPersistenceProfile {
  providerKind: NativeProviderKind;
  driverKind: NativeDriverKind;
  directories: readonly NativeHarnessPersistenceDirectory[];
}

export interface NativeHarnessBackupManifest {
  schema: "paperclip.native-harness-backup.v1";
  normalizedSessionId: string;
  runnerInstanceId: string;
  providerKind: NativeProviderKind;
  driverKind: NativeDriverKind;
  providerSessionIdentity: unknown;
  sourceProviderLeaseId: string;
  environmentFingerprint: string;
  runnerContractVersion: number;
  directories: Array<{
    name: string;
    sha256: string;
    bytes: number;
  }>;
  completedAt: string;
}

export function resolveNativeHarnessPersistenceProfile(
  execution: NativeExecutionInput,
): NativeHarnessPersistenceProfile {
  const providerDirectory: NativeHarnessPersistenceDirectory | null =
    execution.provider.kind === "codex"
      ? {
          name: "codex-home",
          location: "filesystem",
          // Codex session history lives below this home, but these files are
          // launch-time material: auth.json is copied from the configured
          // credential source and config.toml can contain the native MCP
          // bearer token. Re-materialize both for a replacement sandbox
          // instead of putting credentials into the disaster-recovery copy.
          excludeEntries: CODEX_HOME_NON_PERSISTENT_ENTRIES,
        }
      : execution.provider.kind === "opencode"
        ? {
            name: "opencode",
            location: "filesystem",
            excludeEntries: [],
          }
        : execution.provider.kind === "acpx"
          ? {
              name: "acpx",
              location: "filesystem",
              // ACPX stores each provider beneath a stable session directory.
              // Codex creates process-local executable aliases in tmp/arg0;
              // they may point outside the runtime tree and are neither safe
              // nor necessary to restore. Credentials and launch-time config
              // are also re-materialized in the replacement sandbox.
              excludeEntries:
                execution.provider.agent === "codex"
                  ? CODEX_HOME_NON_PERSISTENT_ENTRIES.map(
                      (entry) =>
                        `acpx/${acpxRuntimeSessionDirectoryName(nativeSessionKey(execution))}/codex-home/${entry}`,
                    )
                  : [],
            }
          : null;
  return {
    providerKind: execution.provider.kind,
    driverKind: execution.session.driverKind,
    directories: [
      { name: "runner", location: "runner", excludeEntries: [] },
      ...(providerDirectory ? [providerDirectory] : []),
    ],
  };
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(
      ([left], [right]) => left.localeCompare(right),
    );
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function runnerProviderStateFilename(execution: NativeExecutionInput): string {
  switch (execution.provider.kind) {
    case "codex":
    case "opencode":
      return "codex-provider-state.json";
    case "acpx":
      return "acpx-provider-state.json";
    case "claude_managed":
    case "aws_agentcore":
      return "managed-provider-state.json";
  }
}

/**
 * The v2 runner owns PRP identity/lifecycle in runner-state.json and keeps
 * provider recovery identity in a sibling provider state file. Never infer a
 * resumable provider from the outer PRP journal alone.
 */
export function providerSessionIdentityFromDurableProviderState(input: {
  execution: NativeExecutionInput;
  providerState: unknown;
}): Record<string, unknown> {
  const state = record(input.providerState);
  const expectedSessionId = nativeSessionKey(input.execution);
  const nonEmptyString = (value: unknown): value is string =>
    typeof value === "string" && value.trim().length > 0;
  const sha256 = (value: unknown): value is string =>
    typeof value === "string" && /^sha256:[0-9a-f]{64}$/.test(value);
  const emptyIdentity = () => ({
    providerSessionId: null,
    providerBackendSessionId: null,
    providerSessionIdentity: null,
  });
  switch (input.execution.provider.kind) {
    case "acpx": {
      const descriptor = record(state.descriptor);
      const identity = record(state.identity);
      const expectedModel = input.execution.provider.model;
      const requiredIdentityFields = [
        "kind",
        "normalizedSessionId",
        "acpxRecordId",
        "backendSessionId",
        "agentSessionId",
        "profileDigest",
        "workspaceDigest",
        "requestedModel",
        "effectiveModel",
      ] as const;
      if (
        state.schema !== ACPX_PROVIDER_STATE_SCHEMA ||
        state.lifecycle !== "suspended" ||
        state.providerExitUnconfirmed !== false ||
        state.activeTurnId !== null ||
        descriptor.kind !== "acpx" ||
        descriptor.provider !== "acpx" ||
        descriptor.driver !== "acpx_runtime" ||
        descriptor.agent !== input.execution.provider.agent ||
        descriptor.model !== expectedModel ||
        descriptor.normalizedSessionId !== expectedSessionId ||
        identity.kind !== "acpx" ||
        identity.normalizedSessionId !== expectedSessionId ||
        requiredIdentityFields.some(
          (field) => !nonEmptyString(identity[field]),
        ) ||
        !sha256(identity.profileDigest) ||
        !sha256(identity.workspaceDigest) ||
        identity.profileDigest !== descriptor.commandDigest ||
        identity.requestedModel !== expectedModel ||
        identity.effectiveModel !== expectedModel ||
        identity.permissionMode !== input.execution.provider.permissionMode ||
        !["approve-all", "approve-reads", "deny-all"].includes(
          String(identity.permissionMode),
        ) ||
        !Array.isArray(identity.providerLifetimeFenceCandidates) ||
        identity.providerLifetimeFenceCandidates.length !== 3 ||
        new Set(identity.providerLifetimeFenceCandidates).size !== 3 ||
        identity.providerLifetimeFenceCandidates.some(
          (port) =>
            !Number.isInteger(port) ||
            Number(port) < 49_152 ||
            Number(port) > 65_535,
        )
      ) {
        return emptyIdentity();
      }
      return {
        providerSessionId: identity.acpxRecordId ?? null,
        providerBackendSessionId: identity.backendSessionId ?? null,
        providerSessionIdentity: structuredClone(identity),
      };
    }
    case "codex":
    case "opencode": {
      const config = record(state.config);
      const expectedDriver =
        input.execution.provider.kind === "codex"
          ? "codex_app_server"
          : "opencode_server";
      if (
        state.schema !== CODEX_PROVIDER_STATE_SCHEMA ||
        !["prepared", "session_open", "provider_exited"].includes(
          String(state.lifecycle),
        ) ||
        !nonEmptyString(state.threadId) ||
        (state.providerSessionId !== null &&
          state.providerSessionId !== undefined &&
          !nonEmptyString(state.providerSessionId)) ||
        state.activeProviderTurnId !== null ||
        state.ambiguousTurnStartPending === true ||
        config.provider !== input.execution.provider.kind ||
        config.driver !== expectedDriver
      ) {
        return emptyIdentity();
      }
      return {
        providerSessionId: state.threadId ?? null,
        providerBackendSessionId: state.providerSessionId ?? null,
        providerSessionIdentity: null,
      };
    }
    case "claude_managed":
    case "aws_agentcore": {
      const descriptor = record(state.descriptor);
      if (
        state.schema !== MANAGED_PROVIDER_STATE_SCHEMA ||
        state.lifecycle !== "suspended" ||
        state.normalizedSessionId !== expectedSessionId ||
        descriptor.kind !== input.execution.provider.kind ||
        !nonEmptyString(state.providerSessionId) ||
        state.activeTurnId !== null
      ) {
        return emptyIdentity();
      }
      return {
        providerSessionId: state.providerSessionId ?? null,
        providerBackendSessionId: state.providerSessionId ?? null,
        providerSessionIdentity: null,
      };
    }
  }
}

function providerSessionIdentityIsPresent(value: unknown): boolean {
  const identity = record(value);
  return (
    (identity.providerSessionId !== null &&
      identity.providerSessionId !== undefined) ||
    (identity.providerBackendSessionId !== null &&
      identity.providerBackendSessionId !== undefined) ||
    (identity.providerSessionIdentity !== null &&
      identity.providerSessionIdentity !== undefined)
  );
}

export function providerSessionIdentityTransitionIsAllowed(input: {
  execution: NativeExecutionInput;
  previous: unknown;
  current: unknown;
}): boolean {
  if (canonicalJson(input.previous) === canonicalJson(input.current)) {
    return true;
  }
  if (
    input.execution.provider.kind !== "acpx" ||
    input.execution.interactionResponses.length === 0
  ) {
    return false;
  }

  const previousOuter = record(input.previous);
  const currentOuter = record(input.current);
  const previous = record(previousOuter.providerSessionIdentity);
  const current = record(currentOuter.providerSessionIdentity);
  if (previous.kind !== "acpx" || current.kind !== "acpx") return false;

  const stableFields = [
    "normalizedSessionId",
    "profileDigest",
    "workspaceDigest",
    "requestedModel",
    "effectiveModel",
    "permissionMode",
  ] as const;
  if (
    current.normalizedSessionId !== nativeSessionKey(input.execution) ||
    stableFields.some(
      (field) =>
        typeof previous[field] !== "string" ||
        previous[field] !== current[field],
    )
  ) {
    return false;
  }

  return (
    typeof previous.acpxRecordId === "string" &&
    typeof previous.backendSessionId === "string" &&
    typeof previous.agentSessionId === "string" &&
    typeof current.acpxRecordId === "string" &&
    typeof current.backendSessionId === "string" &&
    typeof current.agentSessionId === "string" &&
    previousOuter.providerSessionId === previous.acpxRecordId &&
    previousOuter.providerBackendSessionId === previous.backendSessionId &&
    currentOuter.providerSessionId === current.acpxRecordId &&
    currentOuter.providerBackendSessionId === current.backendSessionId
  );
}

function digestBackupDirectory(directory: string): {
  sha256: string;
  bytes: number;
} {
  const hash = createHash("sha256");
  let bytes = 0;
  const visit = (current: string, relative: string) => {
    const entries = readdirSync(current, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    if (entries.length === 0) hash.update(`directory:${relative}\0`);
    for (const entry of entries) {
      const entryPath = resolve(current, entry.name);
      const entryRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const stats = lstatSync(entryPath);
      if (entry.isDirectory()) {
        hash.update(`directory:${entryRelative}:${stats.mode & 0o777}\0`);
        visit(entryPath, entryRelative);
      } else if (entry.isSymbolicLink()) {
        hash.update(`symlink:${entryRelative}:${readlinkSync(entryPath)}\0`);
      } else if (entry.isFile()) {
        const contents = readFileSync(entryPath);
        bytes += contents.byteLength;
        hash.update(
          `file:${entryRelative}:${stats.mode & 0o777}:${contents.byteLength}\0`,
        );
        hash.update(contents);
      } else {
        throw new Error(
          `runner_harness_backup_unsupported_entry:${entryRelative}`,
        );
      }
    }
  };
  visit(directory, "");
  return { sha256: `sha256:${hash.digest("hex")}`, bytes };
}

function harnessBackupRoot(root: string): string {
  return resolve(root, "failover-backups");
}

function harnessBackupCandidates(root: string): string[] {
  const backupRoot = harnessBackupRoot(root);
  return [resolve(backupRoot, "current"), resolve(backupRoot, "previous")];
}

type VerifiedHarnessBackup = {
  root: string;
  manifest: NativeHarnessBackupManifest;
  bytes: number;
};

export function shouldRestoreNativeHarnessBackupIntoSandbox(input: {
  acquisitionOutcome: "created" | "resumed" | "replacement" | null;
  reusableLeaseConfigured: boolean | null | undefined;
  backupAvailable: boolean;
}): boolean {
  return (
    input.acquisitionOutcome === "created" &&
    input.reusableLeaseConfigured === false &&
    input.backupAvailable
  );
}

function compatibleNativeHarnessBackupManifests(input: {
  root: string;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
}): Array<{ root: string; manifest: NativeHarnessBackupManifest }> {
  const profile = resolveNativeHarnessPersistenceProfile(input.execution);
  const expectedNames = profile.directories
    .map((directory) => directory.name)
    .sort();
  const compatible: Array<{
    root: string;
    manifest: NativeHarnessBackupManifest;
  }> = [];
  for (const candidateRoot of harnessBackupCandidates(input.root)) {
    const manifestPath = resolve(candidateRoot, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    let manifest: NativeHarnessBackupManifest;
    try {
      manifest = JSON.parse(
        readFileSync(manifestPath, "utf8"),
      ) as NativeHarnessBackupManifest;
    } catch {
      continue;
    }
    if (
      manifest.schema !== "paperclip.native-harness-backup.v1" ||
      manifest.normalizedSessionId !== nativeSessionKey(input.execution) ||
      manifest.runnerInstanceId !== input.runnerInstanceId ||
      manifest.providerKind !== profile.providerKind ||
      manifest.driverKind !== profile.driverKind ||
      manifest.environmentFingerprint !==
        nativeHarnessEnvironmentFingerprint(input.execution) ||
      manifest.runnerContractVersion !== RUNNERD_BINARY_CONTRACT_VERSION ||
      !providerSessionIdentityIsPresent(manifest.providerSessionIdentity) ||
      !Array.isArray(manifest.directories)
    )
      continue;
    const manifestNames = manifest.directories
      .map((directory) => directory.name)
      .sort();
    if (canonicalJson(expectedNames) !== canonicalJson(manifestNames)) continue;
    compatible.push({ root: candidateRoot, manifest });
  }
  return compatible;
}

export function buildNativeHarnessBackupManifest(input: {
  backupRoot: string;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  providerSessionIdentity: unknown;
  sourceProviderLeaseId: string;
  completedAt?: string;
}): NativeHarnessBackupManifest {
  if (!providerSessionIdentityIsPresent(input.providerSessionIdentity)) {
    throw new Error("runner_harness_state_mismatch");
  }
  const profile = resolveNativeHarnessPersistenceProfile(input.execution);
  const directories = profile.directories.map((directory) => {
    const path = resolve(input.backupRoot, directory.name);
    if (!existsSync(path)) throw new Error("runner_harness_state_mismatch");
    return { name: directory.name, ...digestBackupDirectory(path) };
  });
  return {
    schema: "paperclip.native-harness-backup.v1",
    normalizedSessionId: nativeSessionKey(input.execution),
    runnerInstanceId: input.runnerInstanceId,
    providerKind: profile.providerKind,
    driverKind: profile.driverKind,
    providerSessionIdentity: input.providerSessionIdentity,
    sourceProviderLeaseId: input.sourceProviderLeaseId,
    environmentFingerprint: nativeHarnessEnvironmentFingerprint(
      input.execution,
    ),
    runnerContractVersion: RUNNERD_BINARY_CONTRACT_VERSION,
    directories,
    completedAt: input.completedAt ?? new Date().toISOString(),
  };
}

export function verifyNativeHarnessBackup(input: {
  root: string;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
}): VerifiedHarnessBackup | null {
  for (const {
    root: candidateRoot,
    manifest,
  } of compatibleNativeHarnessBackupManifests(input)) {
    let bytes = 0;
    let valid = true;
    for (const declared of manifest.directories) {
      const directoryPath = resolve(candidateRoot, declared.name);
      if (!existsSync(directoryPath)) {
        valid = false;
        break;
      }
      try {
        const digest = digestBackupDirectory(directoryPath);
        if (
          digest.sha256 !== declared.sha256 ||
          digest.bytes !== declared.bytes
        ) {
          valid = false;
          break;
        }
        bytes += digest.bytes;
      } catch {
        valid = false;
        break;
      }
    }
    if (valid) return { root: candidateRoot, manifest, bytes };
  }
  return null;
}

function nativeSessionCheckpointDirectory(): string {
  const directory = resolve(
    resolvePaperclipInstanceRoot(),
    "runtime",
    "paperclip-runner",
    "sessions",
  );
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  return directory;
}

function nativeSessionCheckpointPath(execution: NativeExecutionInput): string {
  return resolve(
    nativeSessionCheckpointDirectory(),
    `${createHash("sha256")
      .update(nativeSessionScopeKey(execution))
      .digest("hex")}.json`,
  );
}

function legacyCompanyNativeSessionCheckpointPath(
  execution: NativeExecutionInput,
): string {
  return resolve(
    nativeSessionCheckpointDirectory(),
    `${createHash("sha256")
      .update(legacyCompanyNativeSessionScopeKey(execution))
      .digest("hex")}.json`,
  );
}

function legacyNativeSessionCheckpointPath(
  execution: NativeExecutionInput,
): string {
  return resolve(
    nativeSessionCheckpointDirectory(),
    `${createHash("sha256")
      .update(nativeSessionKey(execution))
      .digest("hex")}.json`,
  );
}

function persistWarmNativeCheckpoint(
  execution: NativeExecutionInput,
  configDigest: string,
  snapshot: PersistedNativeSession,
): void {
  const path = nativeSessionCheckpointPath(execution);
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(
    temporary,
    JSON.stringify({
      schema: "paperclip.native-session-supervisor.v1",
      configDigest,
      updatedAt: new Date().toISOString(),
      snapshot,
    }),
    { encoding: "utf8", mode: 0o600 },
  );
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function loadWarmNativeCheckpoint(
  execution: NativeExecutionInput,
  configDigest: string,
): PersistedNativeSession | null {
  const scopedPath = nativeSessionCheckpointPath(execution);
  const path = [
    scopedPath,
    legacyCompanyNativeSessionCheckpointPath(execution),
    legacyNativeSessionCheckpointPath(execution),
  ].find((candidate) => existsSync(candidate));
  if (!path) return null;
  const envelope = JSON.parse(
    readBoundedNativeFile(
      path,
      NATIVE_WARM_CHECKPOINT_MAX_BYTES,
      "native_session_supervisor_checkpoint_too_large",
    ).toString("utf8"),
  ) as {
    schema?: string;
    configDigest?: string;
    snapshot?: PersistedNativeSession;
  };
  if (
    envelope.schema !== "paperclip.native-session-supervisor.v1" ||
    !envelope.snapshot
  ) {
    throw new Error("native_session_supervisor_checkpoint_mismatch");
  }
  // A provider/model/runtime-context/permission change is an intentional
  // incompatibility boundary. Leave the older checkpoint replayable by its
  // original execution, but start a fresh provider session for this config.
  if (envelope.configDigest !== configDigest) return null;
  const persistedIdentity = record(envelope.snapshot.identity);
  if (
    persistedIdentity.sessionId !== nativeSessionKey(execution) ||
    persistedIdentity.companyId !== execution.binding.companyId ||
    persistedIdentity.agentId !== execution.binding.agentId
  ) {
    throw new Error("native_session_supervisor_checkpoint_mismatch");
  }
  const sameRunRecovery =
    persistedIdentity.runId === execution.binding.runId &&
    persistedIdentity.issueId === execution.binding.issueId;
  const resumed = sameRunRecovery
    ? structuredClone(envelope.snapshot)
    : {
        ...envelope.snapshot,
        identity: {
          runId: execution.binding.runId,
          sessionId: nativeSessionKey(execution),
          companyId: execution.binding.companyId,
          issueId: execution.binding.issueId,
          agentId: execution.binding.agentId,
        },
        // A warm provider can be rebound only after the previous run settled.
        // Its provider identity survives, but run-scoped turn, result, and
        // request authority must not cross into the new heartbeat run.
        semanticResult: null,
        terminal: null,
        activeTurnId: null,
        terminalTurns: [],
        pendingRuntimeRequests: [],
      };
  if (path !== scopedPath) {
    // Copy the validated legacy checkpoint into the fully scoped location.
    // persistWarmNativeCheckpoint uses an atomic rename and leaving the old
    // file in place keeps this migration idempotent across interrupted boots.
    persistWarmNativeCheckpoint(execution, configDigest, resumed);
  }
  return resumed;
}

async function releaseWarmNativeSession(
  sessionId: string,
  idleTimeoutMs: number,
  failed: boolean,
): Promise<void> {
  const entry = warmNativeSessions.get(sessionId);
  if (!entry) return;
  entry.busy = false;
  entry.lastActivityAt = new Date().toISOString();
  if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
  if (failed) {
    warmNativeSessions.delete(sessionId);
    await entry.session
      .close({ reason: "warm native session failed" })
      .catch(() => undefined);
    return;
  }
  entry.idleTimer = setTimeout(() => {
    const current = warmNativeSessions.get(sessionId);
    if (!current || current.busy) return;
    warmNativeSessions.delete(sessionId);
    void current.session.close({ reason: "warm native session idle timeout" });
  }, idleTimeoutMs);
  entry.idleTimer.unref();
}

export function nativeSessionFailureDisposition(
  attempt: number,
  now = new Date(),
  sourceFailureCode?: ReturnType<typeof nativeSessionFailureSourceCode>,
) {
  const permanentFailure =
    sourceFailureCode === "native_event_replay_conflict" ||
    sourceFailureCode === "runner_remote_provider_artifact_incompatible";
  const exhausted = permanentFailure || attempt >= 3;
  return {
    phase: exhausted
      ? ("terminal_failure" as const)
      : ("retryable_failure" as const),
    failureCode: permanentFailure
      ? sourceFailureCode!
      : exhausted
        ? ("native_session_retry_exhausted" as const)
        : ("native_session_interrupted" as const),
    nextAttemptAt: exhausted ? null : new Date(now.getTime() + 30_000),
  };
}

export function nativeSessionRecoveryProjection(input: {
  phase: "retryable_failure" | "terminal_failure";
  failureCode: string;
  agentId: string;
}) {
  const exhausted = input.phase === "terminal_failure";
  return {
    exhausted,
    issueStatus: exhausted ? ("in_review" as const) : null,
    recoveryOwner: exhausted
      ? { kind: "board" as const }
      : { kind: "agent" as const, agentId: input.agentId },
    recoveryActionOwnerType: exhausted
      ? ("board" as const)
      : ("agent" as const),
    recoveryActionOwnerAgentId: exhausted ? null : input.agentId,
    recoveryActionCause: input.failureCode,
    supersedeOnIdentityChange: true as const,
  };
}

export function nativeSessionFailureSourceCode(
  error: unknown,
):
  | "runner_remote_provider_artifact_incompatible"
  | "provider_process_exited"
  | "provider_stdout_closed"
  | "provider_process_output_closed"
  | "provider_process_status_failed"
  | "provider_initialize_timeout"
  | "provider_initialize_protocol_error"
  | "provider_request_timeout"
  | "provider_request_protocol_error"
  | "provider_frame_too_large"
  | "provider_transport_failed"
  | "native_runner_process_exited"
  | "planning_mode_unsupported"
  | "native_event_replay_conflict"
  | "native_session_interrupted" {
  const message = error instanceof Error ? error.message : String(error);
  if (/runner_remote_provider_artifact_incompatible/i.test(message)) {
    return "runner_remote_provider_artifact_incompatible";
  }
  if (/provider_process_exited/i.test(message)) {
    return "provider_process_exited";
  }
  if (/provider_stdout_closed/i.test(message)) {
    return "provider_stdout_closed";
  }
  if (/provider_process_output_closed/i.test(message)) {
    return "provider_process_output_closed";
  }
  if (/provider_process_status_failed/i.test(message)) {
    return "provider_process_status_failed";
  }
  if (/provider_initialize_timeout/i.test(message)) {
    return "provider_initialize_timeout";
  }
  if (/provider_initialize_protocol_error/i.test(message)) {
    return "provider_initialize_protocol_error";
  }
  if (/provider_request_timeout/i.test(message)) {
    return "provider_request_timeout";
  }
  if (/provider_request_protocol_error/i.test(message)) {
    return "provider_request_protocol_error";
  }
  if (/provider_frame_too_large|stdout frame exceeded/i.test(message)) {
    return "provider_frame_too_large";
  }
  if (
    /provider_transport_failed|invalid JSON-RPC|provider failed/i.test(message)
  ) {
    return "provider_transport_failed";
  }
  if (
    /native_runner_process_exited|runnerd exited|runner process failed/i.test(
      message,
    )
  ) {
    return "native_runner_process_exited";
  }
  if (/planning_mode_unsupported/i.test(message)) {
    return "planning_mode_unsupported";
  }
  if (/native_event_replay_conflict/i.test(message)) {
    return "native_event_replay_conflict";
  }
  return "native_session_interrupted";
}

const PROVIDER_DURABLE_EVENT_TYPES = new Set([
  "harness.ready",
  "session.started",
  "session.resumed",
  "session.updated",
  "turn.started",
  "provider.event",
  "provider.rpc_result",
]);

type NativeRecoveryMode =
  "bootstrap_retry" | "exact_checkpoint_resume" | "ambiguous_state";

export async function nativeProviderRecoveryEvidence(input: {
  db: Db;
  runId: string;
  sourceFailureCode: ReturnType<typeof nativeSessionFailureSourceCode>;
}): Promise<{
  recoveryMode: NativeRecoveryMode;
  providerSessionEstablished: boolean;
  providerEventsExist: boolean;
  checkpointExists: boolean;
}> {
  const run = await input.db
    .select({ runnerProfileJson: heartbeatRuns.runnerProfileJson })
    .from(heartbeatRuns)
    .where(eq(heartbeatRuns.id, input.runId))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const checkpoint = record(run?.runnerProfileJson).sessionCheckpoint;
  const checkpointRecord = record(checkpoint);
  const checkpointExists = Object.keys(checkpointRecord).length > 0;
  const providerSessionEstablished =
    (typeof checkpointRecord.providerSessionId === "string" &&
      checkpointRecord.providerSessionId.length > 0) ||
    Object.keys(record(checkpointRecord.providerIdentity)).length > 0;
  const durableEvents = await input.db
    .select({ eventType: heartbeatRunEvents.eventType })
    .from(heartbeatRunEvents)
    .where(eq(heartbeatRunEvents.runId, input.runId));
  const providerEventsExist = durableEvents.some((event) =>
    PROVIDER_DURABLE_EVENT_TYPES.has(event.eventType),
  );
  if (checkpointExists && providerSessionEstablished) {
    return {
      recoveryMode: "exact_checkpoint_resume",
      providerSessionEstablished: true,
      providerEventsExist,
      checkpointExists,
    };
  }
  const definitelyPreSession = new Set<
    ReturnType<typeof nativeSessionFailureSourceCode>
  >([
    "runner_remote_provider_artifact_incompatible",
    "provider_process_exited",
    "provider_stdout_closed",
    "provider_process_output_closed",
    "provider_process_status_failed",
    "provider_initialize_timeout",
    "provider_initialize_protocol_error",
    "provider_request_timeout",
    "provider_request_protocol_error",
    "native_runner_process_exited",
  ]).has(input.sourceFailureCode);
  if (!checkpointExists && !providerEventsExist && definitelyPreSession) {
    return {
      recoveryMode: "bootstrap_retry",
      providerSessionEstablished: false,
      providerEventsExist: false,
      checkpointExists: false,
    };
  }
  return {
    recoveryMode: "ambiguous_state",
    providerSessionEstablished:
      providerSessionEstablished || providerEventsExist,
    providerEventsExist,
    checkpointExists,
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export type NativeSessionSteeringState = {
  disposition: "available" | "unsupported" | "temporarily_unavailable";
  activeTurnId: string | null;
};

export class NativeSessionSteeringError extends Error {
  constructor(
    readonly code:
      | "steering_unsupported"
      | "steering_temporarily_unavailable"
      | "steering_stale_turn"
      | "steering_timeout"
      | "steering_rejected",
    message: string,
  ) {
    super(message);
    this.name = "NativeSessionSteeringError";
  }
}

export class NativeRuntimeRequestResolutionError extends Error {
  constructor(
    readonly code:
      | "native_session_not_active"
      | "runtime_request_resolution_unsupported"
      | "runtime_request_stale_turn"
      | "runtime_request_resolution_conflict",
    message: string,
  ) {
    super(message);
    this.name = "NativeRuntimeRequestResolutionError";
  }
}

/** Resolve a provider runtime request on an in-process native backend. */
export async function resolveNativeRuntimeRequest(input: {
  runId: string;
  requestId: string;
  turnId: string;
  resolution: HarnessRuntimeRequestResolution;
  /**
   * Revalidate the caller's durable lifecycle and authorization immediately
   * before the provider mutation. Capability and snapshot reads above this
   * edge are asynchronous, so route-level checks performed before entering
   * this helper are not sufficient to authorize the eventual dispatch.
   */
  authorizeBeforeDispatch: () => Promise<void>;
}): Promise<{ commandId: string }> {
  const active = activeNativeSessions.get(input.runId);
  if (!active) {
    throw new NativeRuntimeRequestResolutionError(
      "native_session_not_active",
      "The active native session is not attached.",
    );
  }
  const capabilities = await active.session.capabilities();
  if (
    !capabilities.runtimeRequestResolution ||
    active.session.resolveRuntimeRequest === undefined
  ) {
    throw new NativeRuntimeRequestResolutionError(
      "runtime_request_resolution_unsupported",
      "This native session does not resolve runtime requests in-process.",
    );
  }
  const snapshot = await active.session.snapshot();
  if (snapshot.activeTurnId !== input.turnId) {
    throw new NativeRuntimeRequestResolutionError(
      "runtime_request_stale_turn",
      "The runtime request belongs to a turn that is no longer active.",
    );
  }

  const key = `${input.runId}:${input.requestId}`;
  const fingerprint = JSON.stringify({
    turnId: input.turnId,
    resolution: input.resolution,
  });
  const prior = nativeRuntimeRequestResolutions.get(key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      throw new NativeRuntimeRequestResolutionError(
        "runtime_request_resolution_conflict",
        "A different response was already submitted for this runtime request.",
      );
    }
    await prior.pending;
    return { commandId: prior.commandId };
  }

  const commandId = `native-runtime-response:${randomUUID()}`;
  // Reserve the request key before yielding to authorization or provider I/O.
  // This makes duplicate retries join one dispatch and makes a conflicting
  // response fail closed even while the first authorization check is pending.
  const pending = Promise.resolve().then(async () => {
    await input.authorizeBeforeDispatch();
    if (activeNativeSessions.get(input.runId) !== active) {
      throw new NativeRuntimeRequestResolutionError(
        "native_session_not_active",
        "The active native session changed before the response was dispatched.",
      );
    }
    await active.session.resolveRuntimeRequest!({
      requestId: input.requestId,
      turnId: input.turnId,
      resolution: input.resolution,
    });
  });
  const resolution: NativeRuntimeRequestResolution = {
    runId: input.runId,
    fingerprint,
    commandId,
    pending,
    completedAt: null,
  };
  nativeRuntimeRequestResolutions.set(key, resolution);
  try {
    await pending;
    resolution.completedAt = Date.now();
    pruneNativeRuntimeRequestResolutionCache();
    return { commandId };
  } catch (error) {
    if (nativeRuntimeRequestResolutions.get(key) === resolution) {
      nativeRuntimeRequestResolutions.delete(key);
    }
    throw error;
  }
}

export async function getNativeSessionSteeringState(
  runId: string,
): Promise<NativeSessionSteeringState> {
  const active = activeNativeSessions.get(runId);
  if (!active)
    return { disposition: "temporarily_unavailable", activeTurnId: null };
  const capabilities = await active.session.capabilities();
  if (!capabilities.steering || !active.session.steer) {
    return { disposition: "unsupported", activeTurnId: null };
  }
  const snapshot = await active.session.snapshot();
  return {
    disposition: snapshot.activeTurnId
      ? "available"
      : "temporarily_unavailable",
    activeTurnId: snapshot.activeTurnId ?? null,
  };
}

/** Dispatches a true same-turn steering message and resolves only after ack. */
export async function steerNativeSession(input: {
  runId: string;
  message: string;
  correlationId: string;
  timeoutMs?: number;
}): Promise<{ turnId: string }> {
  const active = activeNativeSessions.get(input.runId);
  if (!active) {
    throw new NativeSessionSteeringError(
      "steering_temporarily_unavailable",
      "The active native session is not attached.",
    );
  }
  const capabilities = await active.session.capabilities();
  if (!capabilities.steering || !active.session.steer) {
    throw new NativeSessionSteeringError(
      "steering_unsupported",
      "This provider does not support same-turn steering.",
    );
  }
  const snapshot = await active.session.snapshot();
  const turnId = snapshot.activeTurnId ?? null;
  if (!turnId) {
    throw new NativeSessionSteeringError(
      "steering_stale_turn",
      "The target turn is no longer active.",
    );
  }

  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    await Promise.race([
      active.session.steer({
        turnId,
        message: { role: "user", text: input.message },
        correlationId: input.correlationId,
      }),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(
          () =>
            reject(
              new NativeSessionSteeringError(
                "steering_timeout",
                "The provider did not acknowledge steering in time.",
              ),
            ),
          input.timeoutMs ?? 10_000,
        );
      }),
    ]);
    return { turnId };
  } catch (error) {
    if (error instanceof NativeSessionSteeringError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    if (/stale|terminal|active turn/i.test(message)) {
      throw new NativeSessionSteeringError(
        "steering_stale_turn",
        "The target turn is no longer active.",
      );
    }
    if (/unsupported|unavailable|capability/i.test(message)) {
      throw new NativeSessionSteeringError(
        "steering_unsupported",
        "This provider does not support same-turn steering.",
      );
    }
    throw new NativeSessionSteeringError(
      "steering_rejected",
      "The provider rejected the steering message.",
    );
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function cancelNativeSession(
  runId: string,
  reason: string,
): Promise<boolean>;
export function cancelNativeSession(
  runId: string,
  reason: string,
  options: {
    db: Db;
    scope?: "turn" | "run" | "issue";
    replacementAccepted?: boolean;
  },
): Promise<{
  dispatched: boolean;
  decision: NativeStatusDecision | null;
  decisionId: string | null;
  auditId: string | null;
}>;
export async function cancelNativeSession(
  runId: string,
  reason: string,
  options?: {
    db: Db;
    scope?: "turn" | "run" | "issue";
    replacementAccepted?: boolean;
  },
): Promise<
  | boolean
  | {
      dispatched: boolean;
      decision: NativeStatusDecision | null;
      decisionId: string | null;
      auditId: string | null;
    }
> {
  let decision: NativeStatusDecision | null = null;
  let decisionContext: {
    companyId: string;
    issueId: string;
    assessmentId: string | null;
    priorStatus: string;
    priorStatusVersion: number;
    priorDecisionId: string | null;
    coordinatorDecisionId: string | null;
    agentId: string;
  } | null = null;
  if (options) {
    const run = await options.db
      .select({
        agentId: heartbeatRuns.agentId,
        companyId: heartbeatRuns.companyId,
        nativeIssueId: heartbeatRuns.nativeIssueId,
        runtimeMode: heartbeatRuns.runtimeMode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (run?.runtimeMode === "native") {
      const issueId = run.nativeIssueId;
      if (!issueId) throw new Error("native_cancellation_binding_missing");
      const issue = await options.db
        .select({
          status: issues.status,
          statusVersion: issues.statusVersion,
          lastStatusDecisionId: issues.lastStatusDecisionId,
        })
        .from(issues)
        .where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!issue) throw new Error("native_cancellation_binding_missing");
      const coordinator = await options.db
        .select({
          assessmentId: nativeRunFinalizations.assessmentId,
          decisionId: nativeRunFinalizations.decisionId,
        })
        .from(nativeRunFinalizations)
        .where(
          and(
            eq(nativeRunFinalizations.runId, runId),
            eq(nativeRunFinalizations.companyId, run.companyId),
            eq(nativeRunFinalizations.issueId, issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!coordinator)
        throw new Error("native_cancellation_coordinator_missing");
      decision = resolveNativeCancellationStatus({
        scope: options.scope ?? "run",
        priorIssueStatus: issue.status as NativeAuthoritativeIssueStatus,
        agentId: run.agentId,
        replacementAccepted: options.replacementAccepted,
      });
      decisionContext = {
        companyId: run.companyId,
        issueId,
        assessmentId: coordinator.assessmentId ?? null,
        priorStatus: issue.status,
        priorStatusVersion: Number(issue.statusVersion),
        priorDecisionId: issue.lastStatusDecisionId,
        coordinatorDecisionId: coordinator.decisionId ?? null,
        agentId: run.agentId,
      };
    }
  }
  let decisionId: string | null = null;
  let auditId: string | null = null;
  let cancellationIntentId: string | null = null;
  let recoveringCancellationIntent = false;
  let priorCoordinatorDecisionIdAtIntent: string | null = null;
  if (options && decision && decisionContext) {
    const cancellationDecision = decision;
    const cancellationContext = decisionContext;
    const effects = cancellationDecision.effects.map((effect) => effect.kind);
    let intentPublication: Parameters<typeof publishActivity>[0] | null = null;
    const intent = await options.db.transaction(async (tx) => {
      const lockedRun = await tx
        .select({
          agentId: heartbeatRuns.agentId,
          companyId: heartbeatRuns.companyId,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          resultJson: heartbeatRuns.resultJson,
          runtimeMode: heartbeatRuns.runtimeMode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !lockedRun ||
        lockedRun.runtimeMode !== "native" ||
        lockedRun.companyId !== cancellationContext.companyId ||
        lockedRun.agentId !== cancellationContext.agentId ||
        lockedRun.nativeIssueId !== cancellationContext.issueId
      ) {
        throw new Error("native_cancellation_binding_changed");
      }
      const coordinator = await tx
        .select({ runId: nativeRunFinalizations.runId })
        .from(nativeRunFinalizations)
        .where(
          and(
            eq(nativeRunFinalizations.runId, runId),
            eq(nativeRunFinalizations.companyId, cancellationContext.companyId),
            eq(nativeRunFinalizations.issueId, cancellationContext.issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!coordinator)
        throw new Error("native_cancellation_coordinator_missing");

      const resultJson = record(lockedRun.resultJson);
      const existing = record(resultJson.nativeCancellation);
      const existingIntentId =
        typeof existing.intentId === "string" && existing.intentId.length > 0
          ? existing.intentId
          : null;
      if (existingIntentId) {
        const matchingIntent =
          existing.schema === "paperclip.native-cancellation.v1" &&
          existing.companyId === cancellationContext.companyId &&
          existing.runId === runId &&
          existing.issueId === cancellationContext.issueId &&
          existing.scope === (options.scope ?? "run") &&
          existing.reasonCode === cancellationDecision.reasonCode &&
          JSON.stringify(existing.effects) === JSON.stringify(effects);
        if (!matchingIntent)
          throw new Error("native_cancellation_intent_conflict");
        const existingAuditId =
          typeof existing.intentAuditId === "string" &&
          existing.intentAuditId.length > 0
            ? existing.intentAuditId
            : null;
        if (!existingAuditId)
          throw new Error("native_cancellation_intent_audit_missing");
        return {
          intentId: existingIntentId,
          auditId: existingAuditId,
          acknowledged: existing.dispatchState === "acknowledged",
          dispatched: existing.dispatched === true,
          decisionId:
            typeof existing.decisionId === "string"
              ? existing.decisionId
              : null,
          priorCoordinatorDecisionId:
            typeof existing.priorCoordinatorDecisionId === "string"
              ? existing.priorCoordinatorDecisionId
              : null,
          existing: true,
        };
      }

      const intentId = `native-cancellation:${randomUUID()}`;
      const activity = await persistActivity(tx as unknown as Db, {
        companyId: cancellationContext.companyId,
        actorType: "system",
        actorId: "native-session-cancellation",
        action: "native.cancellation_intent_recorded",
        entityType: "heartbeat_run",
        entityId: runId,
        agentId: cancellationContext.agentId,
        runId,
        issueId: cancellationContext.issueId,
        details: {
          intentId,
          scope: options.scope ?? "run",
          reasonCode: cancellationDecision.reasonCode,
          effects,
        },
      });
      const intentAuditId = activity.activity?.id ?? null;
      if (!intentAuditId)
        throw new Error("native_cancellation_intent_audit_missing");
      const written = await tx
        .update(heartbeatRuns)
        .set({
          resultJson: {
            ...resultJson,
            nativeCancellation: {
              schema: "paperclip.native-cancellation.v1",
              intentId,
              intentAuditId,
              companyId: cancellationContext.companyId,
              runId,
              issueId: cancellationContext.issueId,
              scope: options.scope ?? "run",
              reasonCode: cancellationDecision.reasonCode,
              effects,
              dispatchState: "pending",
              dispatched: false,
              decisionId: null,
              priorCoordinatorDecisionId:
                cancellationContext.coordinatorDecisionId,
              recordedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.companyId, cancellationContext.companyId),
            eq(heartbeatRuns.agentId, cancellationContext.agentId),
            eq(heartbeatRuns.nativeIssueId, cancellationContext.issueId),
          ),
        )
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows[0] ?? null);
      if (!written) throw new Error("native_cancellation_binding_changed");
      intentPublication = activity.publication;
      return {
        intentId,
        auditId: intentAuditId,
        acknowledged: false,
        dispatched: false,
        decisionId: null,
        priorCoordinatorDecisionId: cancellationContext.coordinatorDecisionId,
        existing: false,
      };
    });
    if (intentPublication) publishActivity(intentPublication);
    cancellationIntentId = intent.intentId;
    auditId = intent.auditId;
    decisionId = intent.decisionId;
    recoveringCancellationIntent = intent.existing;
    priorCoordinatorDecisionIdAtIntent = intent.priorCoordinatorDecisionId;
    if (intent.acknowledged) {
      return {
        dispatched: intent.dispatched,
        decision,
        decisionId,
        auditId,
      };
    }
  }
  const active = activeNativeSessions.get(runId);
  let dispatched = false;
  if (active) {
    dispatched = true;
    if (!active.cancelRequested) {
      active.cancelRequested = true;
      try {
        if (active.session.cancel) {
          const cancellationAbort = new AbortController();
          const cleanup = active.session.cancel({
            reason,
            signal: cancellationAbort.signal,
          }).cleanup;
          let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
          const settled = await Promise.race([
            cleanup.then(
              () => true,
              () => true,
            ),
            new Promise<false>((resolve) => {
              cleanupTimer = setTimeout(
                () => resolve(false),
                NATIVE_SESSION_CANCELLATION_CLEANUP_GRACE_MS,
              );
            }),
          ]);
          if (cleanupTimer) clearTimeout(cleanupTimer);
          if (!settled) {
            cancellationAbort.abort(
              new Error("native session cancellation cleanup timed out"),
            );
            void cleanup.catch(() => undefined);
          }
        } else if (active.session.interrupt)
          await active.session.interrupt({ reason });
      } catch (error) {
        active.cancelRequested = false;
        throw error;
      }
    }
  }
  if (!options) return dispatched;

  if (decision && decisionContext) {
    const cancellationDecision = decision;
    const cancellationContext = decisionContext;
    if (!cancellationIntentId || !auditId)
      throw new Error("native_cancellation_intent_audit_missing");
    if (
      recoveringCancellationIntent &&
      cancellationContext.coordinatorDecisionId !==
        priorCoordinatorDecisionIdAtIntent
    ) {
      decisionId ??= cancellationContext.coordinatorDecisionId;
    }
    if (
      cancellationContext.assessmentId &&
      cancellationDecision.reasonCode !== null &&
      !decisionId
    ) {
      const committed = await commitNativeStatusDecision({
        db: options.db,
        companyId: cancellationContext.companyId,
        issueId: cancellationContext.issueId,
        runId,
        assessmentId: cancellationContext.assessmentId,
        priorStatus: cancellationContext.priorStatus,
        priorStatusVersion: cancellationContext.priorStatusVersion,
        priorDecisionId: cancellationContext.priorDecisionId,
        decision: cancellationDecision,
      });
      decisionId = committed.decision.id;
    }
    const acknowledgement = await options.db.transaction(async (tx) => {
      const lockedRun = await tx
        .select({
          agentId: heartbeatRuns.agentId,
          companyId: heartbeatRuns.companyId,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          resultJson: heartbeatRuns.resultJson,
          runtimeMode: heartbeatRuns.runtimeMode,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId))
        .for("update")
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (
        !lockedRun ||
        lockedRun.runtimeMode !== "native" ||
        lockedRun.companyId !== cancellationContext.companyId ||
        lockedRun.agentId !== cancellationContext.agentId ||
        lockedRun.nativeIssueId !== cancellationContext.issueId
      ) {
        throw new Error("native_cancellation_binding_changed");
      }
      const coordinator = await tx
        .select({ runId: nativeRunFinalizations.runId })
        .from(nativeRunFinalizations)
        .where(
          and(
            eq(nativeRunFinalizations.runId, runId),
            eq(nativeRunFinalizations.companyId, cancellationContext.companyId),
            eq(nativeRunFinalizations.issueId, cancellationContext.issueId),
          ),
        )
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (!coordinator)
        throw new Error("native_cancellation_coordinator_missing");

      const resultJson = record(lockedRun.resultJson);
      const intent = record(resultJson.nativeCancellation);
      const matchingIntent =
        intent.schema === "paperclip.native-cancellation.v1" &&
        intent.intentId === cancellationIntentId &&
        intent.intentAuditId === auditId &&
        intent.companyId === cancellationContext.companyId &&
        intent.runId === runId &&
        intent.issueId === cancellationContext.issueId;
      if (!matchingIntent)
        throw new Error("native_cancellation_intent_conflict");
      if (intent.dispatchState === "acknowledged") {
        return {
          publication: null,
          decisionId:
            typeof intent.decisionId === "string"
              ? intent.decisionId
              : decisionId,
        };
      }

      if (
        options.replacementAccepted &&
        cancellationDecision.effects.some(
          (effect) => effect.kind === "accept_replacement_turn",
        )
      ) {
        await tx
          .update(heartbeatRuns)
          .set({
            status: "running",
            continuationAttempt: sql`${heartbeatRuns.continuationAttempt} + 1`,
            nextAction: "Accept a replacement native turn on the existing run.",
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(heartbeatRuns.id, runId),
              eq(heartbeatRuns.companyId, cancellationContext.companyId),
              eq(heartbeatRuns.agentId, cancellationContext.agentId),
              eq(heartbeatRuns.nativeIssueId, cancellationContext.issueId),
            ),
          );
      }
      const activity = await persistActivity(tx as unknown as Db, {
        companyId: cancellationContext.companyId,
        actorType: "system",
        actorId: "native-session-cancellation",
        action: "native.cancellation_dispatch_acknowledged",
        entityType: "heartbeat_run",
        entityId: runId,
        agentId: cancellationContext.agentId,
        runId,
        issueId: cancellationContext.issueId,
        details: {
          intentId: cancellationIntentId,
          intentAuditId: auditId,
          scope: options.scope ?? "run",
          reasonCode: cancellationDecision.reasonCode,
          effects: cancellationDecision.effects.map((effect) => effect.kind),
          dispatched,
          decisionId,
        },
      });
      const acknowledgementAuditId = activity.activity?.id ?? null;
      if (!acknowledgementAuditId)
        throw new Error("native_cancellation_ack_audit_missing");
      const cancellationWrite = await tx
        .update(heartbeatRuns)
        .set({
          resultJson: {
            ...resultJson,
            nativeCancellation: {
              ...intent,
              dispatchState: "acknowledged",
              dispatched,
              decisionId,
              acknowledgementAuditId,
              acknowledgedAt: new Date().toISOString(),
            },
          },
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(heartbeatRuns.id, runId),
            eq(heartbeatRuns.companyId, cancellationContext.companyId),
            eq(heartbeatRuns.agentId, cancellationContext.agentId),
            eq(heartbeatRuns.nativeIssueId, cancellationContext.issueId),
          ),
        )
        .returning({ id: heartbeatRuns.id })
        .then((rows) => rows[0] ?? null);
      if (!cancellationWrite)
        throw new Error("native_cancellation_binding_changed");
      return { publication: activity.publication, decisionId };
    });
    decisionId = acknowledgement.decisionId;
    if (acknowledgement.publication)
      publishActivity(acknowledgement.publication);
  }
  return { dispatched, decision, decisionId, auditId };
}

/** Authenticated cancellation scope projected through the shared arbiter. */
export function resolveNativeCancellationStatus(input: {
  scope: "turn" | "run" | "issue";
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  replacementAccepted?: boolean;
}): NativeStatusDecision {
  if (input.scope === "turn") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: input.replacementAccepted ? null : "cancellation_turn_only",
      unblockDescriptor: null,
      effects: [{ kind: "accept_replacement_turn" }],
    };
  }
  if (input.scope === "run") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "cancellation_run_only",
      unblockDescriptor: null,
      effects: [{ kind: "release_run_resources" }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "cancelled",
    toStatus: "cancelled",
    reasonCode: "cancellation_issue_authorized",
    unblockDescriptor: null,
    effects: [{ kind: "release_checkout" }, { kind: "cancel_continuations" }],
  };
}

export async function renewNativeSessionExecutionLease(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  leaseOwner: string;
  attempt: number;
  controller?: NativeControllerIdentity;
  leaseTtlMs?: number;
}): Promise<void> {
  const controller =
    input.controller ?? (await currentNativeControllerIdentity());
  const leaseTtlMs = input.leaseTtlMs ?? NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
  if (
    !Number.isInteger(leaseTtlMs) ||
    leaseTtlMs < 1_000 ||
    leaseTtlMs > NATIVE_SESSION_EXECUTION_LEASE_TTL_MS
  ) {
    throw new Error("native_session_lease_ttl_invalid");
  }
  const [updated] = await input.db
    .update(nativeRunFinalizations)
    .set({
      leaseExpiresAt: sql`now() + (${leaseTtlMs} * interval '1 millisecond')`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(nativeRunFinalizations.runId, input.runId),
        eq(nativeRunFinalizations.companyId, input.companyId),
        eq(nativeRunFinalizations.issueId, input.issueId),
        eq(nativeRunFinalizations.leaseOwner, input.leaseOwner),
        eq(nativeRunFinalizations.attempt, input.attempt),
        eq(nativeRunFinalizations.controllerBootId, controller.bootId),
        eq(nativeRunFinalizations.controllerPid, controller.pid),
        eq(
          nativeRunFinalizations.controllerProcessStartedAt,
          controller.processStartedAt,
        ),
        gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ runId: nativeRunFinalizations.runId });
  if (!updated) throw new Error("native_session_lease_lost");
}

function startNativeSessionExecutionLeaseRenewal(input: {
  db: Db;
  runId: string;
  companyId: string;
  issueId: string;
  leaseOwner: string;
  attempt: number;
  controller: NativeControllerIdentity;
}): { stop: () => Promise<void> } {
  let leaseLost: Error | null = null;
  let renewal = Promise.resolve();
  const renew = () => {
    if (leaseLost) return;
    renewal = renewal
      .then(() => renewNativeSessionExecutionLease(input))
      .then(() => undefined)
      .catch(async (error: unknown) => {
        leaseLost =
          error instanceof Error
            ? error
            : new Error("native_session_lease_lost");
        await cancelNativeSession(
          input.runId,
          "native session execution lease lost",
        ).catch(() => undefined);
      });
  };
  const timer = setInterval(
    renew,
    NATIVE_SESSION_EXECUTION_LEASE_RENEW_INTERVAL_MS,
  );
  timer.unref?.();
  return {
    stop: async () => {
      clearInterval(timer);
      await renewal;
      if (leaseLost) throw leaseLost;
    },
  };
}

export async function executePaperclipNativeSession(input: {
  db: Db;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  leaseOwner?: string;
  restartRecovery?: NativeRestartRecoveryClaim;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Test seam at the provider boundary; production uses a qualified package backend. */
  backend?: NativeSessionBackend;
  useRunnerd?: boolean;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void>;
  preparationSpans?: NativeRunHistoricalSpan[];
  /** Resolved adapter env; the runner transport applies a provider allowlist before spawn. */
  runnerEnvironment?: NodeJS.ProcessEnv;
  runnerExecutionTarget?: AdapterExecutionTarget | null;
  /** Resolved per-run authorization; not an independent instance setting. */
  runnerIngressAuthorized?: boolean;
  runnerPublicUrl?: string | null;
  runnerCaBundlePath?: string | null;
  runnerRemoteBinaryPath?: string | null;
  runnerRemoteCodexPath?: string | null;
  runnerRemoteCodexNpmSpec?: string | null;
  runnerRemoteProviderPackPath?: string | null;
  enqueueWakeup?: (
    agentId: string,
    options: {
      source: "assignment";
      triggerDetail: "system";
      reason: "issue_assigned";
      payload: Record<string, unknown>;
      idempotencyKey: string;
      requestedByActorType: "agent";
      requestedByActorId: string;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}): Promise<AdapterExecutionResult> {
  if (!input.useRunnerd) {
    return executePaperclipNativeSessionWithinScope(input);
  }
  const sessionScopeId = nativeSessionScopeKey(input.execution);
  if (executingRunnerdSessionScopes.has(sessionScopeId)) {
    throw new Error("native_session_supervisor_busy");
  }
  executingRunnerdSessionScopes.set(
    sessionScopeId,
    input.execution.binding.runId,
  );
  try {
    return await executePaperclipNativeSessionWithinScope(input);
  } finally {
    if (
      executingRunnerdSessionScopes.get(sessionScopeId) ===
      input.execution.binding.runId
    ) {
      executingRunnerdSessionScopes.delete(sessionScopeId);
    }
  }
}

async function executePaperclipNativeSessionWithinScope(
  input: Parameters<typeof executePaperclipNativeSession>[0],
): Promise<AdapterExecutionResult> {
  if (
    input.execution.provider.kind !== "codex" &&
    input.execution.provider.kind !== "opencode" &&
    input.execution.provider.kind !== "claude_managed" &&
    input.execution.provider.kind !== "aws_agentcore" &&
    input.execution.provider.kind !== "acpx"
  ) {
    throw new Error("paperclip_runner_provider_unsupported");
  }
  if (
    input.execution.provider.kind === "acpx" &&
    input.execution.provider.agent === "pi"
  ) {
    throw new Error(
      "paperclip_runner_provider_unsupported: ACPX Pi is unavailable until descriptor-confined verified launch is implemented",
    );
  }
  const earliestPreparationStart = input.preparationSpans?.reduce(
    (earliest, span) => Math.min(earliest, span.startedAtMs),
    Date.now(),
  );
  const trace = createNativeRunTrace({
    runId: input.execution.binding.runId,
    startedAtMs: earliestPreparationStart,
    onEvent: input.onEvent,
  });
  const preparationSpans = input.preparationSpans ?? [];
  const taskPrepareScope = trace.start("task.prepare", {
    parentName: "task.run",
    startedAtMs: earliestPreparationStart,
  });
  const environmentSpans = preparationSpans.filter(
    (span) =>
      span.name === "environment.acquire" ||
      span.name === "environment.workspace.realize",
  );
  const environmentStartedAtMs = environmentSpans.reduce(
    (earliest, span) => Math.min(earliest, span.startedAtMs),
    Date.now(),
  );
  const environmentEndedAtMs = environmentSpans.reduce(
    (latest, span) => Math.max(latest, span.endedAtMs),
    environmentStartedAtMs,
  );
  const environmentScope =
    environmentSpans.length > 0
      ? trace.start("environment.startup", {
          parentName: "task.prepare",
          startedAtMs: environmentStartedAtMs,
        })
      : null;
  for (const span of preparationSpans) {
    const rootMilestone =
      span.name === "heartbeat.queue" || span.name === "comment.to_run_created";
    await trace.record({
      ...span,
      parentName: rootMilestone
        ? "task.run"
        : environmentSpans.includes(span)
          ? "environment.startup"
          : "task.prepare",
    });
  }
  if (environmentScope) {
    await trace.end(environmentScope, { endedAtMs: environmentEndedAtMs });
  }
  if (input.useRunnerd) {
    await migrateRunnerdStateRootForExecution({
      db: input.db,
      execution: input.execution,
      allowVerifiedBackup:
        input.runnerExecutionTarget?.kind === "remote" &&
        input.runnerExecutionTarget.transport === "sandbox",
      restartRecovery: input.restartRecovery,
    });
  }
  const durableRunnerBinding = input.useRunnerd
    ? loadRunnerdDurableBinding(input.execution)
    : null;
  const effectiveRunnerInstanceId =
    durableRunnerBinding?.runnerInstanceId ?? input.runnerInstanceId;
  if (effectiveRunnerInstanceId !== input.runnerInstanceId) {
    await input.db
      .update(heartbeatRuns)
      .set({
        runnerInstanceId: effectiveRunnerInstanceId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(heartbeatRuns.id, input.execution.binding.runId),
          eq(heartbeatRuns.companyId, input.execution.binding.companyId),
          eq(heartbeatRuns.agentId, input.execution.binding.agentId),
        ),
      );
  }
  const leaseOwner =
    input.leaseOwner ?? `${effectiveRunnerInstanceId}:${randomUUID()}`;
  const controller = await currentNativeControllerIdentity();
  const leaseNow = new Date();
  const leaseExpiresAt = new Date(leaseNow.getTime() + 20 * 60_000);
  let attempt: number;
  try {
    attempt = await trace.measure(
      "native.coordinator.claim",
      () =>
        input.db.transaction(async (tx) => {
          const coordinator = await tx
            .select()
            .from(nativeRunFinalizations)
            .where(
              and(
                eq(nativeRunFinalizations.runId, input.execution.binding.runId),
                eq(
                  nativeRunFinalizations.companyId,
                  input.execution.binding.companyId,
                ),
                eq(
                  nativeRunFinalizations.issueId,
                  input.execution.binding.issueId,
                ),
              ),
            )
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (!coordinator)
            throw new Error("native_finalization_coordinator_missing");
          const leaseNow = new Date();
          const leaseExpiresAt = new Date(
            leaseNow.getTime() + NATIVE_SESSION_EXECUTION_LEASE_TTL_MS,
          );
          // A durable result means provider execution already completed. The
          // recovery/finalization path must reconcile it; never reacquire a
          // provider session and execute the turn a second time.
          if (coordinator.resultId)
            throw new NativeResultPendingFinalizationError();
          const boundRun = await tx
            .select({
              agentId: heartbeatRuns.agentId,
              companyId: heartbeatRuns.companyId,
              nativeIssueId: heartbeatRuns.nativeIssueId,
              resultJson: heartbeatRuns.resultJson,
              runtimeMode: heartbeatRuns.runtimeMode,
            })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.id, input.execution.binding.runId))
            .for("update")
            .limit(1)
            .then((rows) => rows[0] ?? null);
          if (
            !boundRun ||
            boundRun.runtimeMode !== "native" ||
            boundRun.companyId !== input.execution.binding.companyId ||
            boundRun.agentId !== input.execution.binding.agentId ||
            boundRun.nativeIssueId !== input.execution.binding.issueId
          ) {
            throw new Error("native_execution_binding_changed");
          }
          const cancellationIntent = record(
            record(boundRun.resultJson).nativeCancellation,
          );
          if (
            cancellationIntent.scope === "run" &&
            (cancellationIntent.dispatchState === "pending" ||
              cancellationIntent.dispatchState === "acknowledged")
          ) {
            const intentMatchesBinding =
              cancellationIntent.schema ===
                "paperclip.native-cancellation.v1" &&
              cancellationIntent.companyId ===
                input.execution.binding.companyId &&
              cancellationIntent.runId === input.execution.binding.runId &&
              cancellationIntent.issueId === input.execution.binding.issueId;
            if (!intentMatchesBinding)
              throw new Error("native_cancellation_intent_conflict");
            // Run cancellation remains a claim fence after dispatch ack until
            // the heartbeat cancellation path terminalizes the run.
            throw new NativeCancellationPendingRecoveryError();
          }
          if (["committed", "applied"].includes(coordinator.phase))
            throw new Error("native_run_already_committed");
          if (
            coordinator.leaseOwner &&
            coordinator.leaseOwner !== leaseOwner &&
            coordinator.leaseExpiresAt &&
            coordinator.leaseExpiresAt > leaseNow
          )
            throw new Error("native_finalization_lease_busy");
          const recovering = input.restartRecovery;
          if (
            recovering &&
            (recovering.runId !== coordinator.runId ||
              recovering.leaseOwner !== leaseOwner ||
              coordinator.leaseOwner !== leaseOwner ||
              coordinator.controllerBootId !== controller.bootId ||
              coordinator.controllerPid !== controller.pid ||
              coordinator.controllerGeneration !==
                recovering.controllerGeneration)
          ) {
            throw new Error("native_restart_recovery_claim_changed");
          }
          const nextAttempt = nextNativeProviderAttempt(
            coordinator.attempt,
            recovering?.kind,
          );
          const nextControllerGeneration = recovering
            ? recovering.controllerGeneration
            : coordinator.controllerBootId === controller.bootId
              ? Math.max(1, coordinator.controllerGeneration)
              : coordinator.controllerGeneration + 1;
          const claimed = await tx
            .update(nativeRunFinalizations)
            .set({
              phase: "observed",
              attempt: nextAttempt,
              leaseOwner,
              leaseExpiresAt,
              controllerBootId: controller.bootId,
              controllerPid: controller.pid,
              controllerProcessStartedAt: controller.processStartedAt,
              controllerGeneration: nextControllerGeneration,
              failureCode: null,
              failureDetail: null,
              nextAttemptAt: null,
              updatedAt: leaseNow,
            })
            .where(
              and(
                eq(nativeRunFinalizations.runId, coordinator.runId),
                eq(
                  nativeRunFinalizations.companyId,
                  input.execution.binding.companyId,
                ),
                eq(
                  nativeRunFinalizations.issueId,
                  input.execution.binding.issueId,
                ),
                eq(nativeRunFinalizations.attempt, coordinator.attempt),
                eq(nativeRunFinalizations.phase, coordinator.phase),
              ),
            )
            .returning({ runId: nativeRunFinalizations.runId })
            .then((rows) => rows[0] ?? null);
          if (!claimed) throw new Error("native_session_lease_lost");
          await tx
            .update(heartbeatRuns)
            .set({
              nativePhase: "observed",
              nativePhaseUpdatedAt: leaseNow,
              updatedAt: leaseNow,
            })
            .where(eq(heartbeatRuns.id, coordinator.runId));
          return nextAttempt;
        }),
      { parentName: "task.prepare" },
    );
    await trace.end(taskPrepareScope);
  } catch (error) {
    await trace.end(taskPrepareScope, { outcome: "failed" });
    await trace.finish("failed");
    throw error;
  }
  const controlPlaneInstanceId = `${effectiveRunnerInstanceId}:control`;
  const planSynchronizations: PlanSynchronization[] = [];
  const upsertPlanSynchronization = (
    synchronization: PlanSynchronization,
  ): void => {
    const existingIndex = planSynchronizations.findIndex(
      (candidate) => candidate.eventId === synchronization.eventId,
    );
    if (existingIndex >= 0) {
      planSynchronizations[existingIndex] = synchronization;
      return;
    }
    planSynchronizations.push(synchronization);
  };
  const recordPlanSynchronization = async (event: {
    sourceEventId: string;
    turnId?: string;
    eventType: string;
    payload: Record<string, unknown>;
  }) => {
    const synchronization = await synchronizeCompletedProviderPlan({
      db: input.db,
      execution: input.execution,
      event,
    });
    if (!synchronization) return;
    upsertPlanSynchronization(synchronization);
    const activity = await persistActivity(input.db, {
      companyId: input.execution.binding.companyId,
      actorType: "agent",
      actorId: input.execution.binding.agentId,
      agentId: input.execution.binding.agentId,
      runId: input.execution.binding.runId,
      issueId: input.execution.binding.issueId,
      action: "issue.document_updated",
      entityType: "issue",
      entityId: input.execution.binding.issueId,
      details: {
        key: "plan",
        source: "native_plan_synchronization",
        synchronization,
      },
    });
    publishActivity(activity.publication);
    if (input.onLog)
      await input.onLog(
        "stdout",
        `${JSON.stringify({ type: "paperclip.plan.synchronization", synchronization })}\n`,
      );
  };
  let nativeSessionExecuteStartedAtMs = Date.now();
  let sessionStartedAtMs: number | null = null;
  let sessionStartupMode: "bootstrap" | "resume" | null = null;
  let turnSubmittedAtMs: number | null = null;
  let turnStartedAtMs: number | null = null;
  let firstAgentEventRecorded = false;
  let turnCompletedAtMs: number | null = null;
  let runnerSessionStartupScope: NativeRunSpanScope | null = null;
  let agentTurnScope: NativeRunSpanScope | null = null;
  let taskSettleScope: NativeRunSpanScope | null = null;
  const governedWaitObservation = createGovernedWaitEventObservation(
    resolvePendingGovernedWait,
  );
  const controlPlane = new PaperclipControlPlanePort(
    input.db,
    {
      companyId: input.execution.binding.companyId,
      issueId: input.execution.binding.issueId,
      runId: input.execution.binding.runId,
      agentId: input.execution.binding.agentId,
      sessionId: nativeSessionKey(input.execution),
      completionContractId: input.execution.completionContract.id,
      completionContractSha256: input.execution.completionContract.sha256,
      sourceInstanceId: effectiveRunnerInstanceId,
      controlPlaneSourceInstanceId: controlPlaneInstanceId,
    },
    {
      onCommittedEvent: async (event) => {
        const eventAtMs = Date.parse(event.emittedAt);
        const milestoneAtMs = Number.isFinite(eventAtMs)
          ? eventAtMs
          : Date.now();
        if (
          event.eventType === "session.started" &&
          sessionStartedAtMs === null
        ) {
          sessionStartedAtMs = milestoneAtMs;
          sessionStartupMode = "bootstrap";
          await trace.record({
            name: "runner.session.bootstrap",
            parentName: "runner.session.startup",
            startedAtMs: nativeSessionExecuteStartedAtMs,
            endedAtMs: milestoneAtMs,
          });
        }
        if (
          event.eventType === "turn.submitted" &&
          turnSubmittedAtMs === null
        ) {
          turnSubmittedAtMs = milestoneAtMs;
          // A recovered provider session does not emit session.started again. In
          // that case the first durable turn.submitted event is the earliest
          // transport-neutral proof that runnerd reattached to the exact
          // provider session and is ready for work. Keep that startup time out of
          // runner.turn.submit so cold-resume latency is visible as its own span.
          if (sessionStartedAtMs === null) {
            await trace.record({
              name: "runner.session.resume",
              parentName: "runner.session.startup",
              startedAtMs: nativeSessionExecuteStartedAtMs,
              endedAtMs: milestoneAtMs,
              attributes: {
                provider: input.execution.provider.kind,
                strategy: "exact_provider_session",
              },
            });
            sessionStartedAtMs = milestoneAtMs;
            sessionStartupMode = "resume";
          }
          await trace.record({
            name: "runner.turn.submit",
            parentName: "runner.session.startup",
            startedAtMs: sessionStartedAtMs,
            endedAtMs: milestoneAtMs,
          });
          if (runnerSessionStartupScope) {
            trace.annotate(runnerSessionStartupScope, {
              mode: sessionStartupMode ?? "bootstrap",
            });
            await trace.end(runnerSessionStartupScope, {
              endedAtMs: milestoneAtMs,
            });
          }
          agentTurnScope = trace.start("agent.turn", {
            parentName: "native.session.execute",
            startedAtMs: milestoneAtMs,
            attributes: { provider: input.execution.provider.kind },
          });
          trace.activate(agentTurnScope);
        }
        if (event.eventType === "turn.started" && turnStartedAtMs === null) {
          turnStartedAtMs = milestoneAtMs;
          await trace.record({
            name: "provider.turn.queue",
            parentName: "agent.turn",
            startedAtMs: turnSubmittedAtMs ?? milestoneAtMs,
            endedAtMs: milestoneAtMs,
          });
        }
        if (
          !firstAgentEventRecorded &&
          turnStartedAtMs !== null &&
          (event.eventType === "item.started" ||
            event.eventType === "item.completed")
        ) {
          const payload = record(event.payload);
          const kind =
            typeof payload.kind === "string" ? payload.kind : "unknown";
          if (
            [
              "reasoning",
              "agentMessage",
              "toolCall",
              "dynamicToolCall",
            ].includes(kind)
          ) {
            firstAgentEventRecorded = true;
            await trace.record({
              name: "provider.time_to_first_agent_event",
              parentName: "agent.turn",
              startedAtMs: turnStartedAtMs,
              endedAtMs: milestoneAtMs,
              attributes: { eventKind: kind },
            });
          }
        }
        if (
          [
            "turn.completed",
            "turn.failed",
            "turn.interrupted",
            "turn.cancelled",
          ].includes(event.eventType) &&
          turnCompletedAtMs === null
        ) {
          turnCompletedAtMs = milestoneAtMs;
          if (!agentTurnScope) {
            agentTurnScope = trace.start("agent.turn", {
              parentName: "native.session.execute",
              startedAtMs:
                turnSubmittedAtMs ??
                turnStartedAtMs ??
                nativeSessionExecuteStartedAtMs,
              attributes: { provider: input.execution.provider.kind },
            });
            trace.activate(agentTurnScope);
          }
          const outcome =
            event.eventType === "turn.completed" ? "ok" : "failed";
          await trace.end(agentTurnScope, {
            endedAtMs: milestoneAtMs,
            outcome,
          });
          taskSettleScope = trace.start("task.settle", {
            parentName: "task.run",
            startedAtMs: milestoneAtMs,
          });
          trace.activate(taskSettleScope);
        }
        if (input.onLog)
          await input.onLog(
            "stdout",
            `${JSON.stringify({ type: "paperclip.prp.event", event })}\n`,
          );
        const inputMetric = runtimeInputLifecycleMetric(event);
        if (inputMetric && input.onLog) {
          await input.onLog(
            "stdout",
            `${JSON.stringify({
              type: "paperclip.runtime_input.metric",
              ...inputMetric,
            })}\n`,
          );
        }
        const questionFallback = await materializeRuntimeQuestionFallback({
          db: input.db,
          binding: input.execution.binding,
          event,
        });
        if (questionFallback) {
          if (input.onLog) {
            const origin = record(record(record(event.payload).request).origin);
            await input.onLog(
              "stdout",
              `${JSON.stringify({
                type: "paperclip.runtime_input.metric",
                outcome:
                  record(event.payload).reason === "durable_handoff"
                    ? "durable_handoff_materialized"
                    : "provider_loss_materialized",
                requestId: record(event.payload).requestId,
                interactionId: questionFallback.interaction.id,
                adapter:
                  typeof origin.adapter === "string"
                    ? origin.adapter
                    : "unknown",
              })}\n`,
            );
          }
        }
        await governedWaitObservation.observe(
          event,
          event.eventType === "item.completed" || questionFallback !== null,
        );
        await recordPlanSynchronization(
          event as {
            sourceEventId: string;
            turnId?: string;
            eventType: string;
            payload: Record<string, unknown>;
          },
        );
      },
      onDuplicateEvent: async (event) => {
        // A crash can happen after the event commit but before its callback
        // finishes. Recover only idempotent durable projections here; activity,
        // publication, logging, trace, and metric effects remain committed-only.
        const questionFallback = await materializeRuntimeQuestionFallback({
          db: input.db,
          binding: input.execution.binding,
          event,
        });
        await governedWaitObservation.observe(
          event,
          event.eventType === "item.completed" || questionFallback !== null,
        );
        const planSynchronization = await synchronizeCompletedProviderPlan({
          db: input.db,
          execution: input.execution,
          event: event as {
            sourceEventId: string;
            turnId?: string;
            eventType: string;
            payload: Record<string, unknown>;
          },
        });
        if (planSynchronization) {
          upsertPlanSynchronization(planSynchronization);
        }
      },
    },
  );
  let native: Awaited<ReturnType<typeof executeNativeSession>>;
  const lifecyclePolicy = input.execution.session?.lifecyclePolicy ?? {
    mode: "per_turn" as const,
    idleTimeoutMs: null,
  };
  const warmSessionId =
    lifecyclePolicy.mode === "warm"
      ? nativeSessionScopeKey(input.execution)
      : null;
  const warmConfigDigest =
    lifecyclePolicy.mode === "warm"
      ? nativeSessionConfigDigest(input.execution)
      : null;
  let existingWarmSession: NativeSession | undefined;
  let persistedWarmSession: PersistedNativeSession | null | undefined;
  if (warmSessionId !== null && warmConfigDigest !== null) {
    const entry = warmNativeSessions.get(warmSessionId);
    if (entry) {
      if (entry.configDigest !== warmConfigDigest) {
        if (entry.busy) throw new Error("native_session_supervisor_busy");
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
        warmNativeSessions.delete(warmSessionId);
        await entry.session.close({
          reason: "warm native session configuration changed",
        });
        persistedWarmSession = loadWarmNativeCheckpoint(
          input.execution,
          warmConfigDigest,
        );
      } else {
        if (entry.busy) throw new Error("native_session_supervisor_busy");
        entry.busy = true;
        if (entry.idleTimer !== null) clearTimeout(entry.idleTimer);
        entry.idleTimer = null;
        if (input.useRunnerd) {
          // A retained driver closes over the tool authority from the run that
          // created it. Preserve provider continuity through its durable
          // checkpoint, but rebuild the runnerd backend so the next run gets a
          // fresh, immutable authority epoch. Reusing the live driver would
          // either retain stale authority or require rebinding old callbacks.
          warmNativeSessions.delete(warmSessionId);
          await entry.session.close({
            reason: "warm native session authority epoch rotated",
          });
          persistedWarmSession = loadWarmNativeCheckpoint(
            input.execution,
            warmConfigDigest,
          );
        } else {
          existingWarmSession = entry.session;
        }
      }
    } else {
      persistedWarmSession = loadWarmNativeCheckpoint(
        input.execution,
        warmConfigDigest,
      );
    }
  }
  async function resolvePendingGovernedWait() {
    const continuingInteractionIds = continuingPendingInteractionIds(
      input.execution,
    );
    const interaction = await input.db
      .select({
        id: issueThreadInteractions.id,
        title: issueThreadInteractions.title,
        summary: issueThreadInteractions.summary,
      })
      .from(issueThreadInteractions)
      .where(
        and(
          eq(
            issueThreadInteractions.companyId,
            input.execution.binding.companyId,
          ),
          eq(issueThreadInteractions.issueId, input.execution.binding.issueId),
          or(
            eq(
              issueThreadInteractions.sourceRunId,
              input.execution.binding.runId,
            ),
            ...(continuingInteractionIds.length > 0
              ? [inArray(issueThreadInteractions.id, continuingInteractionIds)]
              : []),
          ),
          eq(issueThreadInteractions.status, "pending"),
        ),
      )
      .orderBy(
        desc(issueThreadInteractions.createdAt),
        desc(issueThreadInteractions.id),
      )
      .limit(1)
      .then((rows) => rows[0] ?? null);
    return interaction
      ? nativeGovernedWaitResult({
          interaction,
          completionContract: input.execution.completionContract.contract,
        })
      : null;
  }
  const runnerExecution =
    input.useRunnerd && input.runnerExecutionTarget?.kind === "remote"
      ? {
          ...input.execution,
          workspace: {
            ...input.execution.workspace,
            cwd: input.runnerExecutionTarget.remoteCwd,
          },
        }
      : input.execution;
  const leaseRenewal = startNativeSessionExecutionLeaseRenewal({
    db: input.db,
    runId: input.execution.binding.runId,
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    leaseOwner,
    attempt,
    controller,
  });
  try {
    const runnerdBackend =
      input.useRunnerd && input.backend === undefined
        ? await createRunnerdBackend({
            ...input,
            // Durable scope and prior-run verification use the controller's
            // canonical workspace identity. createRunnerdBackend separately
            // projects remoteCwd into the provider execution boundary.
            execution: input.execution,
            runnerInstanceId: effectiveRunnerInstanceId,
            durableEnvironmentLeaseId: durableRunnerBinding?.environmentLeaseId,
            trace,
          })
        : null;
    nativeSessionExecuteStartedAtMs = Date.now();
    native = await trace.measure(
      "native.session.execute",
      async () => {
        runnerSessionStartupScope = trace.start("runner.session.startup", {
          parentName: "native.session.execute",
          startedAtMs: nativeSessionExecuteStartedAtMs,
        });
        trace.activate(runnerSessionStartupScope);
        const result = await trace.run(runnerSessionStartupScope, () =>
          executeNativeSession({
            input: runnerExecution,
            backend:
              input.backend ??
              runnerdBackend ??
              createNativeSessionBackend(input.execution, {
                runnerInstanceId: input.runnerInstanceId,
                onSpawn: input.onSpawn,
                opencodeEnvironment: input.runnerEnvironment ?? process.env,
                acpxEnvironment: input.runnerEnvironment ?? process.env,
                opencodeRuntimeDirectory: resolve(
                  resolvePaperclipInstanceRoot(),
                  "runtime",
                  "paperclip-runner",
                  "opencode",
                ),
                acpxRuntimeDirectory: resolve(
                  resolvePaperclipInstanceRoot(),
                  "runtime",
                  "paperclip-runner",
                  "acpx",
                ),
              }),
            controlPlane,
            runnerInstanceId: effectiveRunnerInstanceId,
            controlPlaneInstanceId,
            resolveGovernedWait: ({ event }) =>
              governedWaitObservation.consume(event),
            resolveMissingResult: async ({ terminalEvent }) => {
              // A model may correctly create a durable question/confirmation and
              // then end its provider turn without also invoking paperclip_finish.
              // Recover only completed turns with a pending interaction created by
              // this exact run; unrelated or failed turns still fail closed.
              if (terminalEvent.eventType !== "turn.completed") return null;
              return resolvePendingGovernedWait();
            },
            existingSession: existingWarmSession,
            persistedSession: persistedWarmSession,
            keepSessionOpen: warmSessionId !== null,
            requireSessionCloseBeforeReturn:
              runnerdBackend !== null &&
              input.runnerExecutionTarget?.kind === "remote",
            onCheckpoint:
              warmSessionId !== null && warmConfigDigest !== null
                ? async (snapshot) =>
                    persistWarmNativeCheckpoint(
                      input.execution,
                      warmConfigDigest,
                      snapshot,
                    )
                : undefined,
            onContinuityBreak: async (continuity) => {
              const atMs = Date.now();
              await trace.record({
                name: "provider.session.continuity_break",
                parentName: "native.session.execute",
                startedAtMs: atMs,
                endedAtMs: atMs,
                outcome: "failed",
                attributes: {
                  reason: continuity.reason,
                  previousDriverSessionId: continuity.previousDriverSessionId,
                  previousProviderSessionId:
                    continuity.previousProviderSessionId ?? "unavailable",
                  replacementDriverSessionId:
                    continuity.replacementDriverSessionId,
                  replacementProviderSessionId:
                    continuity.replacementProviderSessionId ?? "unavailable",
                },
              });
              await input.onLog?.(
                "stderr",
                `[paperclip-runner] provider session continuity break: exact resume failed (${continuity.reason}); old driver session=${continuity.previousDriverSessionId}, old provider session=${continuity.previousProviderSessionId ?? "unavailable"}, replacement driver session=${continuity.replacementDriverSessionId}, replacement provider session=${continuity.replacementProviderSessionId ?? "unavailable"}\n`,
              );
            },
            onSession: (session) => {
              if (
                session &&
                warmSessionId !== null &&
                warmConfigDigest !== null
              ) {
                const existing = warmNativeSessions.get(warmSessionId);
                if (existing) existing.session = session;
                else
                  warmNativeSessions.set(warmSessionId, {
                    session,
                    configDigest: warmConfigDigest,
                    busy: true,
                    idleTimer: null,
                    lastActivityAt: new Date().toISOString(),
                  });
              }
              if (session)
                activeNativeSessions.set(input.execution.binding.runId, {
                  session,
                  cancelRequested: false,
                });
              else {
                activeNativeSessions.delete(input.execution.binding.runId);
                clearNativeRuntimeRequestResolutions(
                  input.execution.binding.runId,
                );
              }
            },
          }),
        );
        await trace.end(runnerSessionStartupScope, {
          outcome:
            result.terminal.runTerminalState === "succeeded" ? "ok" : "failed",
        });
        return result;
      },
      { parentName: "task.run" },
    );
    await leaseRenewal.stop();
    await trace.record({
      name: "native.result.finalize",
      parentName: "task.settle",
      startedAtMs: turnCompletedAtMs ?? nativeSessionExecuteStartedAtMs,
      endedAtMs: Date.now(),
    });
    activeNativeSessions.delete(input.execution.binding.runId);
    clearNativeRuntimeRequestResolutions(input.execution.binding.runId);
  } catch (error) {
    await leaseRenewal.stop().catch(() => undefined);
    const failedAtMs = Date.now();
    if (runnerSessionStartupScope) {
      await trace.end(runnerSessionStartupScope, {
        endedAtMs: failedAtMs,
        outcome: "failed",
      });
    }
    if (agentTurnScope) {
      await trace.end(agentTurnScope, {
        endedAtMs: failedAtMs,
        outcome: "failed",
      });
    }
    if (!taskSettleScope) {
      taskSettleScope = trace.start("task.settle", {
        parentName: "task.run",
        startedAtMs: failedAtMs,
      });
    }
    trace.activate(taskSettleScope);
    activeNativeSessions.delete(input.execution.binding.runId);
    clearNativeRuntimeRequestResolutions(input.execution.binding.runId);
    if (warmSessionId !== null && lifecyclePolicy.mode === "warm") {
      await releaseWarmNativeSession(
        warmSessionId,
        lifecyclePolicy.idleTimeoutMs,
        true,
      );
    }
    if (
      error instanceof NativeResultPendingFinalizationError ||
      error instanceof NativeCancellationPendingRecoveryError
    ) {
      // This is not a provider failure and must not overwrite the durable
      // result/coordinator state. The heartbeat boundary will either hand an
      // already-materialized result to the finalizer or retain the durable
      // cancellation intent for cancellation recovery.
      if (taskSettleScope) {
        await trace.end(taskSettleScope, { outcome: "ok" });
      }
      await trace.finish("ok");
      throw error;
    }
    const now = new Date();
    const sourceFailureCode = nativeSessionFailureSourceCode(error);
    const recoveryEvidence = await nativeProviderRecoveryEvidence({
      db: input.db,
      runId: input.execution.binding.runId,
      sourceFailureCode,
    });
    const disposition = nativeSessionFailureDisposition(
      attempt,
      now,
      sourceFailureCode,
    );
    const phase =
      recoveryEvidence.recoveryMode === "ambiguous_state"
        ? ("terminal_failure" as const)
        : disposition.phase;
    const failureCode =
      recoveryEvidence.recoveryMode === "ambiguous_state"
        ? sourceFailureCode
        : disposition.failureCode;
    const nextAttemptAt =
      recoveryEvidence.recoveryMode === "ambiguous_state"
        ? null
        : disposition.nextAttemptAt;
    const recoveryProjection = nativeSessionRecoveryProjection({
      phase,
      failureCode,
      agentId: input.execution.binding.agentId,
    });
    const { exhausted } = recoveryProjection;
    const integrityFailure =
      sourceFailureCode === "native_event_replay_conflict";
    const message =
      error instanceof Error
        ? error.message.slice(0, 2_000)
        : String(error).slice(0, 2_000);
    const sanitizedStderrTail = redactSensitiveText(message).slice(-4_096);
    await input.db.transaction(async (tx) => {
      const updated = await tx
        .update(nativeRunFinalizations)
        .set({
          phase,
          leaseOwner: null,
          leaseExpiresAt: null,
          recoveryState:
            phase === "retryable_failure" ? "resuming_session" : "blocked",
          failureCode,
          failureDetail: {
            message,
            originalFailureCode: sourceFailureCode,
            recoveryMode: recoveryEvidence.recoveryMode,
            providerSessionEstablished:
              recoveryEvidence.providerSessionEstablished,
            providerEventsExist: recoveryEvidence.providerEventsExist,
            checkpointExists: recoveryEvidence.checkpointExists,
            recoveryOwner: recoveryProjection.recoveryOwner,
            nextAction:
              recoveryEvidence.recoveryMode === "ambiguous_state"
                ? "Inspect the original provider failure and durable events; state is ambiguous and a replacement provider session is forbidden."
                : integrityFailure
                  ? "Inspect the persisted runner events and checkpoint for a source-sequence integrity conflict; automatic recovery is stopped."
                  : exhausted
                    ? "Inspect the persisted native session after its bounded resume budget was exhausted."
                    : recoveryEvidence.recoveryMode === "bootstrap_retry"
                      ? "Retry provider bootstrap on this same run; durable evidence proves no provider session or provider event was created."
                      : "Resume this same run from its exact persisted native provider checkpoint after the retry delay.",
          },
          nextAttemptAt,
          recoveryHistory: sql`(
            select coalesce(jsonb_agg(item order by ordinal), '[]'::jsonb)
            from jsonb_array_elements(
              coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
              || jsonb_build_array(${JSON.stringify({
                at: now.toISOString(),
                disposition: phase,
                reason: sourceFailureCode,
                controllerBootId: controller.bootId,
                controllerGeneration:
                  input.restartRecovery?.controllerGeneration ?? null,
                providerAttempt: attempt,
                stderrTail: sanitizedStderrTail,
                providerSessionEstablished:
                  recoveryEvidence.providerSessionEstablished,
                checkpointExists: recoveryEvidence.checkpointExists,
              })}::jsonb)
            ) with ordinality as history(item, ordinal)
            where ordinal > greatest(
              jsonb_array_length(
                coalesce(${nativeRunFinalizations.recoveryHistory}, '[]'::jsonb)
                || jsonb_build_array(${JSON.stringify({
                  at: now.toISOString(),
                  disposition: phase,
                  reason: sourceFailureCode,
                  controllerBootId: controller.bootId,
                  controllerGeneration:
                    input.restartRecovery?.controllerGeneration ?? null,
                  providerAttempt: attempt,
                  stderrTail: sanitizedStderrTail,
                  providerSessionEstablished:
                    recoveryEvidence.providerSessionEstablished,
                  checkpointExists: recoveryEvidence.checkpointExists,
                })}::jsonb)
              ) - 20,
              0
            )
          )`,
          updatedAt: now,
        })
        .where(
          and(
            eq(nativeRunFinalizations.runId, input.execution.binding.runId),
            eq(
              nativeRunFinalizations.companyId,
              input.execution.binding.companyId,
            ),
            eq(nativeRunFinalizations.issueId, input.execution.binding.issueId),
            eq(nativeRunFinalizations.leaseOwner, leaseOwner),
            eq(nativeRunFinalizations.attempt, attempt),
            eq(nativeRunFinalizations.controllerBootId, controller.bootId),
            eq(nativeRunFinalizations.controllerPid, controller.pid),
            eq(
              nativeRunFinalizations.controllerProcessStartedAt,
              controller.processStartedAt,
            ),
            gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
          ),
        )
        .returning({ runId: nativeRunFinalizations.runId })
        .then((rows) => rows[0] ?? null);
      if (!updated) throw new Error("native_session_lease_lost");
      await tx
        .update(heartbeatRuns)
        .set({
          nativePhase: phase,
          nativePhaseUpdatedAt: now,
          error: message,
          errorCode: sourceFailureCode,
          updatedAt: now,
        })
        .where(eq(heartbeatRuns.id, input.execution.binding.runId));
      if (recoveryProjection.issueStatus) {
        await issueService(tx as unknown as Db).update(
          input.execution.binding.issueId,
          { status: recoveryProjection.issueStatus },
          tx,
        );
      }
      await issueRecoveryActionService(tx as unknown as Db).upsertSourceScoped({
        companyId: input.execution.binding.companyId,
        sourceIssueId: input.execution.binding.issueId,
        kind: "active_run_watchdog",
        ownerType: recoveryProjection.recoveryActionOwnerType,
        ownerAgentId: recoveryProjection.recoveryActionOwnerAgentId,
        returnOwnerAgentId: input.execution.binding.agentId,
        cause: recoveryProjection.recoveryActionCause,
        fingerprint: createHash("sha256")
          .update(`${input.execution.binding.runId}:${failureCode}`)
          .digest("hex"),
        evidence: {
          runId: input.execution.binding.runId,
          coordinatorAttempt: attempt,
          sourceFailureCode,
          recoveryDisposition: failureCode,
          recoveryMode: recoveryEvidence.recoveryMode,
          providerSessionEstablished:
            recoveryEvidence.providerSessionEstablished,
        },
        nextAction:
          recoveryEvidence.recoveryMode === "ambiguous_state"
            ? "Inspect the original provider failure and explicitly resolve the ambiguous session state; do not open a replacement provider session."
            : integrityFailure
              ? "Inspect the persisted runner event collision and explicitly repair or replace the run; automatic retries are disabled."
              : exhausted
                ? "Inspect the provider trace and explicitly choose a replacement run or provider configuration; automatic provider work is stopped."
                : recoveryEvidence.recoveryMode === "bootstrap_retry"
                  ? "Retry bootstrap on the same run without manufacturing a provider checkpoint."
                  : "Resume the exact persisted native session on the same heartbeat run.",
        wakePolicy: nextAttemptAt
          ? {
              kind: "resume_native_run",
              runId: input.execution.binding.runId,
              notBefore: nextAttemptAt.toISOString(),
            }
          : null,
        maxAttempts: 3,
        supersedeOnIdentityChange: recoveryProjection.supersedeOnIdentityChange,
      });
    });
    if (taskSettleScope) {
      await trace.end(taskSettleScope, { outcome: "failed" });
    }
    await trace.finish("failed");
    throw error;
  }
  if (
    planSynchronizations.length === 0 &&
    "executionMode" in input.execution &&
    input.execution.executionMode === "plan"
  ) {
    const markdown = semanticProviderPlanMarkdown(
      native.result as unknown as Record<string, unknown>,
    );
    if (markdown) {
      const digest = createHash("sha256").update(markdown).digest("hex");
      await recordPlanSynchronization({
        sourceEventId: `semantic-plan:${input.execution.binding.runId}:${digest}`,
        ...(native.turnId ? { turnId: native.turnId } : {}),
        eventType: "plan.updated",
        payload: {
          schema: "paperclip.plan.updated.v1",
          planId: `semantic:${native.turnId ?? input.execution.binding.runId}`,
          revision: 1,
          complete: true,
          markdown,
          source: "semantic_result_artifact",
        },
      });
    }
  }
  const releaseNow = new Date();
  const released = await input.db
    .update(nativeRunFinalizations)
    .set({
      leaseOwner: null,
      leaseExpiresAt: null,
      recoveryState: null,
      recoveryRequestId: null,
      updatedAt: releaseNow,
    })
    .where(
      and(
        eq(nativeRunFinalizations.runId, input.execution.binding.runId),
        eq(nativeRunFinalizations.companyId, input.execution.binding.companyId),
        eq(nativeRunFinalizations.issueId, input.execution.binding.issueId),
        eq(nativeRunFinalizations.leaseOwner, leaseOwner),
        eq(nativeRunFinalizations.attempt, attempt),
        eq(nativeRunFinalizations.controllerBootId, controller.bootId),
        eq(nativeRunFinalizations.controllerPid, controller.pid),
        eq(
          nativeRunFinalizations.controllerProcessStartedAt,
          controller.processStartedAt,
        ),
        gt(nativeRunFinalizations.leaseExpiresAt, sql`now()`),
      ),
    )
    .returning({ runId: nativeRunFinalizations.runId })
    .then((rows) => rows[0] ?? null);
  if (!released) throw new Error("native_session_lease_lost");
  const finalization: NativeFinalizationResult = {
    schema: "paperclip.native-finalization.v1",
    runtimeMode: "native",
    runId: input.execution.binding.runId,
    issueId: input.execution.binding.issueId,
    companyId: input.execution.binding.companyId,
    result: native.result as unknown as Record<string, unknown>,
    terminal: native.terminal,
    turnId: native.turnId,
    sourceInstanceId: effectiveRunnerInstanceId,
    normalizedSessionId: native.normalizedSessionId,
    providerSessionId: native.providerSessionId,
    driverKind: native.driverKind,
    driverVersion: native.driverVersion,
    nativeEventCount: native.nativeEventCount,
    highestContiguousSourceSeq: native.highestContiguousSourceSeq,
    workspaceFinalizeStatus: "pending",
  };
  // A following run cannot attach until the prior run's durable finalization
  // is committed. Provider completion alone is not an authority boundary.
  if (warmSessionId !== null && lifecyclePolicy.mode === "warm") {
    await releaseWarmNativeSession(
      warmSessionId,
      lifecyclePolicy.idleTimeoutMs,
      false,
    );
  }
  const adapterResult: AdapterExecutionResult = {
    exitCode: native.terminal.runTerminalState === "succeeded" ? 0 : 1,
    signal: null,
    timedOut: false,
    errorMessage:
      native.terminal.runTerminalState === "succeeded"
        ? null
        : `Native session ${native.terminal.runTerminalState}`,
    resultJson: {
      nativeResult: native.result as unknown as Record<string, unknown>,
      nativeTerminal: native.terminal as unknown as Record<string, unknown>,
      planSynchronizations,
    },
    summary: native.result.summary,
    sessionId: native.normalizedSessionId,
    sessionDisplayId: native.providerSessionId ?? native.normalizedSessionId,
    provider: "openai",
    model: input.execution.provider.model,
    usage: normalizeNativeUsage(native.usage),
    costUsd: nativeUsageCostUsd(native.usage),
    usageBasis: "per_run",
    nativeFinalization: finalization,
  };
  if (taskSettleScope) {
    await trace.end(taskSettleScope, {
      outcome:
        native.terminal.runTerminalState === "succeeded" ? "ok" : "failed",
    });
  }
  await trace.finish(
    native.terminal.runTerminalState === "succeeded" ? "ok" : "failed",
  );
  return adapterResult;
}

function numericUsageField(
  usage: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

function nativeUsageMeasurement(usage: Record<string, unknown>) {
  const nestedUsage = record(usage.usage);
  const candidates = [
    record(usage.runDelta),
    record(nestedUsage.runDelta),
    record(usage.total),
    record(nestedUsage.total),
    record(usage.cumulative),
    record(nestedUsage.cumulative),
    nestedUsage,
    usage,
  ];
  return (
    candidates.find(
      (candidate) =>
        numericUsageField(candidate, [
          "inputTokens",
          "input",
          "promptTokens",
          "outputTokens",
          "output",
          "completionTokens",
        ]) !== undefined,
    ) ?? usage
  );
}

export function nativeUsageCostUsd(usage: Record<string, unknown> | null) {
  if (!usage) return undefined;
  const measurement = nativeUsageMeasurement(usage);
  const direct =
    numericUsageField(usage, [
      "providerCostUsd",
      "cacheAdjustedCostUsd",
      "costUsd",
    ]) ??
    numericUsageField(measurement, [
      "providerCostUsd",
      "cacheAdjustedCostUsd",
      "costUsd",
    ]);
  if (direct !== undefined) return direct;
  const cost = record(usage.cost);
  const currency =
    typeof cost.currency === "string" ? cost.currency.toUpperCase() : "USD";
  if (currency !== "USD") return undefined;
  return numericUsageField(cost, ["amount", "total"]);
}

export function normalizeNativeUsage(usage: Record<string, unknown> | null) {
  if (!usage) return undefined;
  const measurement = nativeUsageMeasurement(usage);
  const cache = record(measurement.cache);
  const cachedInputTokens =
    numericUsageField(measurement, [
      "cachedInputTokens",
      "cacheReadInputTokens",
      "cacheReadTokens",
      "cachedReadTokens",
    ]) ?? numericUsageField(cache, ["read"]);
  return {
    inputTokens:
      numericUsageField(measurement, [
        "inputTokens",
        "input",
        "promptTokens",
      ]) ?? 0,
    outputTokens:
      numericUsageField(measurement, [
        "outputTokens",
        "output",
        "completionTokens",
      ]) ?? 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
  };
}

function processEnvironment(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(environment).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

export function parseRemoteExecutableCandidate(stdout: string): string | null {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length !== 1) return null;
  const candidate = lines[0]!;
  if (
    !candidate.startsWith("/") ||
    candidate.length > 4_096 ||
    !/^\/[A-Za-z0-9_./+@-]+$/.test(candidate)
  ) {
    return null;
  }
  return posix.normalize(candidate);
}

export function mayUsePreinstalledRunnerArtifact(
  configuredRemoteBinaryPath: string | null | undefined,
): boolean {
  return !configuredRemoteBinaryPath?.trim();
}

const RUNNERD_BUILD_METADATA_SCHEMA =
  "paperclip-runner/runnerd-build-metadata/v1";
const RUNNERD_BINARY_CONTRACT_VERSION = 2;

const REMOTE_PROVIDER_PACK_SCHEMA = "paperclip-runner/remote-provider-pack/v1";
const REMOTE_PROVIDER_PACK_PINS = {
  nodeMinimum: "24.11.0",
  codex: "0.148.0",
  opencode: "1.18.17",
  acpx: "0.13.1",
  claudeAcp: "0.70.0",
  codexAcp: "1.6.2",
} as const;
const REMOTE_PROVIDER_PACK_PROFILE_DIGESTS = {
  claude:
    "sha256:9d73d1f0f121fb96cc8badb28c22d5bff02d8582eb2e40360a81c189e1b9422a",
  codex:
    "sha256:7a923b3829884d3cabcc9659d22cace3f86813e7bfffc90974b10140a45bc400",
} as const;
const REMOTE_PROVIDER_PACK_ARTIFACT_PATHS = {
  nodeCommand: "node_modules/node/bin/node",
  productionLock: "pnpm-lock.yaml",
  opencodeCommand: "node_modules/.bin/opencode",
  opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
  opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs",
  acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
} as const;

type RemoteProviderPackManifest = {
  schema: typeof REMOTE_PROVIDER_PACK_SCHEMA;
  digest: string;
  payload: {
    pins: typeof REMOTE_PROVIDER_PACK_PINS;
    target: { platform: string; architecture: string };
    runnerSourceRevision: string;
    distDigest: string;
    bridgeDigest: string;
    acpxProfileDigests: typeof REMOTE_PROVIDER_PACK_PROFILE_DIGESTS;
    artifacts: {
      nodeCommand: { path: string; sha256: string };
      productionLock: { path: string; sha256: string };
      opencodeCommand: { path: string; sha256: string };
      opencodeExecutable: { path: string; sha256: string };
      opencodeProxy: { path: string; sha256: string };
      acpxSidecar: { path: string; sha256: string };
    };
  };
};

function sha256File(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

export function sha256DirectoryTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string, prefix = "") => {
    const entries = readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`directory\0${relativePath}\n`);
        visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        hash.update(`file\0${relativePath}\0${sha256File(absolutePath)}\n`);
      } else if (entry.isSymbolicLink()) {
        hash.update(
          `symlink\0${relativePath}\0${readlinkSync(absolutePath)}\n`,
        );
      } else {
        throw new Error(
          `runner_remote_provider_artifact_incompatible: unsupported dist entry ${relativePath}`,
        );
      }
    }
  };
  visit(root);
  return `sha256:${hash.digest("hex")}`;
}

function providerPackRelativePath(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    posix.normalize(value) !== value ||
    value.split("/").includes("..")
  ) {
    throw new Error(
      `runner_remote_provider_artifact_incompatible: invalid ${field}`,
    );
  }
  return value;
}

export function readRemoteProviderPackManifest(
  packRoot: string,
): RemoteProviderPackManifest {
  let manifest: RemoteProviderPackManifest;
  try {
    manifest = JSON.parse(
      readFileSync(resolve(packRoot, "provider-pack.json"), "utf8"),
    ) as RemoteProviderPackManifest;
  } catch (error) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: provider-pack.json is unreadable",
      { cause: error },
    );
  }
  const payload = manifest?.payload;
  if (
    manifest.schema !== REMOTE_PROVIDER_PACK_SCHEMA ||
    !payload ||
    canonicalJson(payload.pins) !== canonicalJson(REMOTE_PROVIDER_PACK_PINS) ||
    canonicalJson(payload.acpxProfileDigests) !==
      canonicalJson(REMOTE_PROVIDER_PACK_PROFILE_DIGESTS) ||
    typeof payload.target?.platform !== "string" ||
    typeof payload.target?.architecture !== "string" ||
    !/^[0-9a-f]{40}(?:-dirty)?$/.test(payload.runnerSourceRevision) ||
    !/^sha256:[0-9a-f]{64}$/.test(payload.distDigest)
  ) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: provider pack pins or source revision do not match",
    );
  }
  const digest = `sha256:${createHash("sha256")
    .update(canonicalJson(payload))
    .digest("hex")}`;
  if (manifest.digest !== digest) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: provider pack manifest digest mismatch",
    );
  }
  const artifactEntries = [
    [
      "provider Node",
      payload.artifacts?.nodeCommand,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.nodeCommand,
    ],
    [
      "production lockfile",
      payload.artifacts?.productionLock,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.productionLock,
    ],
    [
      "OpenCode command",
      payload.artifacts?.opencodeCommand,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.opencodeCommand,
    ],
    [
      "OpenCode executable",
      payload.artifacts?.opencodeExecutable,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.opencodeExecutable,
    ],
    [
      "OpenCode proxy",
      payload.artifacts?.opencodeProxy,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.opencodeProxy,
    ],
    [
      "ACPX sidecar",
      payload.artifacts?.acpxSidecar,
      REMOTE_PROVIDER_PACK_ARTIFACT_PATHS.acpxSidecar,
    ],
  ] as const;
  for (const [label, artifact, expectedPath] of artifactEntries) {
    const artifactPath = providerPackRelativePath(
      artifact?.path,
      `${label} path`,
    );
    if (artifactPath !== expectedPath) {
      throw new Error(
        `runner_remote_provider_artifact_incompatible: ${label} path must be ${expectedPath}`,
      );
    }
    if (
      typeof artifact?.sha256 !== "string" ||
      sha256File(resolve(packRoot, artifactPath)) !== artifact.sha256
    ) {
      throw new Error(
        `runner_remote_provider_artifact_incompatible: ${label} digest mismatch`,
      );
    }
  }
  if (sha256DirectoryTree(resolve(packRoot, "dist")) !== payload.distDigest) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: provider dist tree digest mismatch",
    );
  }
  const bridgeDigest = `sha256:${createHash("sha256")
    .update(payload.artifacts.opencodeProxy.sha256)
    .update("\n")
    .update(payload.artifacts.acpxSidecar.sha256)
    .update("\n")
    .update(payload.distDigest)
    .digest("hex")}`;
  if (payload.bridgeDigest !== bridgeDigest) {
    throw new Error(
      "runner_remote_provider_artifact_incompatible: provider bridge digest mismatch",
    );
  }
  return structuredClone(manifest);
}

export function assertRemoteRunnerBuildMetadata(
  value: unknown,
  requiredMode: "dial_wss" | "listen_ws",
): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("runner_remote_artifact_metadata_invalid");
  }
  const metadata = value as Record<string, unknown>;
  if (
    metadata.schema !== RUNNERD_BUILD_METADATA_SCHEMA ||
    metadata.binaryName !== "paperclip-runnerd" ||
    metadata.packageName !== "@paperclipai/paperclip-runner" ||
    metadata.binaryContractVersion !== RUNNERD_BINARY_CONTRACT_VERSION
  ) {
    throw new Error("runner_remote_artifact_contract_incompatible");
  }
  const modes = Array.isArray(metadata.prpTransportModes)
    ? metadata.prpTransportModes
    : [];
  if (!modes.includes(requiredMode)) {
    throw new Error(
      `runner_remote_transport_capability_missing:${requiredMode}`,
    );
  }
}

async function stageRemoteRunnerFile(input: {
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  runner: CommandManagedRuntimeRunner;
  sourcePath: string;
  targetPath: string;
  mode: number;
}): Promise<void> {
  const runner = input.runner;
  if (runner.syncIn) {
    await runner.syncIn([
      {
        operationId: `runner-stage-${randomUUID()}`,
        files: [
          {
            sourcePath: input.sourcePath,
            targetPath: input.targetPath,
            kind: "file",
            mode: input.mode,
          },
        ],
      },
    ]);
    return;
  }
  const bytes = readFileSync(input.sourcePath);
  const directory = posix.dirname(input.targetPath);
  const script =
    `umask 077; mkdir -p '${directory.replaceAll("'", "'\\''")}' && ` +
    `base64 -d > '${input.targetPath.replaceAll("'", "'\\''")}' && ` +
    `chmod ${input.mode.toString(8)} '${input.targetPath.replaceAll("'", "'\\''")}'`;
  const result = await runner.execute({
    command: "sh",
    args: ["-c", script],
    stdin: bytes.toString("base64"),
    bypassSession: true,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_staging_failed");
  }
}

function archiveExcludeArgs(entries: readonly string[]): string[] {
  for (const entry of entries) {
    const segments = entry.split("/");
    if (
      entry.length === 0 ||
      entry.startsWith("/") ||
      segments.some(
        (segment) =>
          segment === "" ||
          segment === "." ||
          segment === ".." ||
          !/^[A-Za-z0-9._-]+$/.test(segment),
      )
    ) {
      throw new Error("runner_remote_checkpoint_exclusion_invalid");
    }
  }
  return entries.map((entry) => `--exclude=./${entry}`);
}

export async function stageRemoteRunnerDirectory(input: {
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  runner: CommandManagedRuntimeRunner;
  sourcePath: string;
  targetPath: string;
  mode: number;
  excludeEntries?: readonly string[];
}): Promise<void> {
  const excludeArgs = archiveExcludeArgs(input.excludeEntries ?? []);
  if (input.runner.syncIn) {
    let stagingRoot: string | null = null;
    let sourcePath = input.sourcePath;
    try {
      if (excludeArgs.length > 0) {
        stagingRoot = mkdtempSync(join(tmpdir(), "paperclip-runner-restore-"));
        const archive = execFileSync(
          "tar",
          [...excludeArgs, "-czf", "-", "-C", input.sourcePath, "."],
          { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
        );
        execFileSync("tar", ["-xzf", "-", "-C", stagingRoot], {
          input: archive,
          maxBuffer: 64 * 1024 * 1024,
        });
        sourcePath = stagingRoot;
      }
      await input.runner.syncIn([
        {
          operationId: `runner-stage-dir-${randomUUID()}`,
          files: [
            {
              sourcePath,
              targetPath: input.targetPath,
              kind: "directory",
              mode: input.mode,
            },
          ],
        },
      ]);
    } finally {
      if (stagingRoot) rmSync(stagingRoot, { recursive: true, force: true });
    }
    return;
  }
  const archive = execFileSync(
    "tar",
    [...excludeArgs, "-czf", "-", "-C", input.sourcePath, "."],
    { encoding: "buffer", maxBuffer: 64 * 1024 * 1024 },
  );
  const escapedTarget = input.targetPath.replaceAll("'", "'\\''");
  const script =
    `umask 077; mkdir -p '${escapedTarget}' && ` +
    `base64 -d | tar -xzf - -C '${escapedTarget}' && ` +
    `chmod ${input.mode.toString(8)} '${escapedTarget}'`;
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", script],
    stdin: archive.toString("base64"),
    bypassSession: true,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_directory_staging_failed");
  }
}

async function remoteRunnerPathExists(input: {
  runner: CommandManagedRuntimeRunner;
  path: string;
  kind: "file" | "directory";
}): Promise<boolean> {
  const escapedPath = input.path.replaceAll("'", "'\\''");
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `test -${input.kind === "file" ? "f" : "d"} '${escapedPath}'`],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  return result.exitCode === 0 && !result.timedOut;
}

function assertSafeRemoteCheckpointArchive(archive: Buffer): void {
  if (archive.length > MAX_REMOTE_CHECKPOINT_ARCHIVE_BYTES) {
    throw new Error("runner_remote_checkpoint_archive_too_large");
  }
  let names: string[];
  let verboseEntries: string[];
  try {
    names = execFileSync("tar", ["-tzf", "-"], {
      input: archive,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    })
      .split("\n")
      .filter((line) => line.length > 0);
    verboseEntries = execFileSync("tar", ["-tvzf", "-"], {
      input: archive,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 30_000,
    })
      .split("\n")
      .filter((line) => line.length > 0);
  } catch {
    throw new Error("runner_remote_checkpoint_archive_invalid");
  }
  if (
    names.length === 0 ||
    names.length > MAX_REMOTE_CHECKPOINT_ENTRIES ||
    verboseEntries.length !== names.length
  ) {
    throw new Error("runner_remote_checkpoint_archive_invalid");
  }
  for (const name of names) {
    const normalized = name.replace(/^\.\//, "");
    if (
      name.includes("\0") ||
      name.startsWith("/") ||
      normalized.split("/").some((part) => part === "..")
    ) {
      throw new Error("runner_remote_checkpoint_archive_unsafe_path");
    }
  }
  for (const entry of verboseEntries) {
    const type = entry.trimStart()[0];
    if (type !== "-" && type !== "d") {
      throw new Error("runner_remote_checkpoint_archive_unsafe_entry");
    }
  }
  try {
    execFileSync("tar", ["-xOzf", "-"], {
      input: archive,
      stdio: ["pipe", "pipe", "pipe"],
      maxBuffer: MAX_REMOTE_CHECKPOINT_EXPANDED_BYTES,
      timeout: 60_000,
    });
  } catch {
    throw new Error("runner_remote_checkpoint_archive_expanded_too_large");
  }
}

function assertSafeExtractedCheckpoint(root: string): void {
  const pending = [root];
  let entries = 0;
  let totalBytes = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_REMOTE_CHECKPOINT_ENTRIES) {
        throw new Error("runner_remote_checkpoint_too_many_entries");
      }
      const path = join(directory, entry.name);
      const metadata = lstatSync(path);
      if (
        metadata.isSymbolicLink() ||
        (!metadata.isDirectory() && !metadata.isFile())
      ) {
        throw new Error("runner_remote_checkpoint_unsafe_entry");
      }
      if (metadata.isDirectory()) {
        pending.push(path);
      } else {
        totalBytes += metadata.size;
        if (totalBytes > MAX_REMOTE_CHECKPOINT_EXPANDED_BYTES) {
          throw new Error("runner_remote_checkpoint_expanded_too_large");
        }
      }
    }
  }
}

/**
 * Copy a remote runner directory into durable local state.
 *
 * Some provider homes contain process-local scratch trees (for example Codex's
 * `tmp/arg0` executable aliases). Those aliases can point outside the directory
 * and are neither portable nor required to resume a provider session. When a
 * provider supplies a native syncOut implementation, create a sibling snapshot
 * first so the live runtime remains untouched and the provider's archive safety
 * checks still apply to every persisted entry.
 */
export async function syncRemoteRunnerDirectoryOut(input: {
  runner: CommandManagedRuntimeRunner;
  sourcePath: string;
  targetPath: string;
  mode: number;
  excludeEntries?: readonly string[];
}): Promise<void> {
  if (
    !(await remoteRunnerPathExists({
      runner: input.runner,
      path: input.sourcePath,
      kind: "directory",
    }))
  )
    return;
  mkdirSync(resolve(input.targetPath, ".."), { recursive: true, mode: 0o700 });
  const excluded = input.excludeEntries ?? [];
  const excludeArgs = archiveExcludeArgs(excluded)
    .map((argument) => `'${argument}'`)
    .join(" ");
  if (input.runner.syncOut) {
    let syncSourcePath = input.sourcePath;
    let snapshotPath: string | null = null;
    if (excluded.length > 0) {
      const checkpointId = randomUUID();
      snapshotPath = posix.join(
        posix.dirname(input.sourcePath),
        `.paperclip-checkpoint-${checkpointId}`,
      );
      const archivePath = `${snapshotPath}.tar`;
      const escapedSource = input.sourcePath.replaceAll("'", "'\\''");
      const escapedSnapshot = snapshotPath.replaceAll("'", "'\\''");
      const escapedArchive = archivePath.replaceAll("'", "'\\''");
      const snapshotResult = await input.runner.execute({
        command: "sh",
        args: [
          "-c",
          `set -e; umask 077; mkdir -p '${escapedSnapshot}'; ` +
            `trap "rm -f '${escapedArchive}'" EXIT; ` +
            `tar ${excludeArgs} -cf '${escapedArchive}' -C '${escapedSource}' .; ` +
            `tar -xf '${escapedArchive}' -C '${escapedSnapshot}'`,
        ],
        bypassSession: true,
        timeoutMs: 120_000,
      });
      if (snapshotResult.exitCode !== 0 || snapshotResult.timedOut) {
        throw new Error("runner_remote_checkpoint_snapshot_failed");
      }
      syncSourcePath = snapshotPath;
    }
    try {
      await input.runner.syncOut([
        {
          operationId: `runner-checkpoint-dir-${randomUUID()}`,
          files: [
            {
              sourcePath: syncSourcePath,
              targetPath: input.targetPath,
              kind: "directory",
              mode: input.mode,
            },
          ],
        },
      ]);
    } finally {
      if (snapshotPath) {
        const escapedSnapshot = snapshotPath.replaceAll("'", "'\\''");
        await input.runner
          .execute({
            command: "sh",
            args: ["-c", `rm -rf -- '${escapedSnapshot}'`],
            bypassSession: true,
            timeoutMs: 30_000,
          })
          .catch(() => undefined);
      }
    }
    return;
  }
  const escapedSource = input.sourcePath.replaceAll("'", "'\\''");
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `tar ${excludeArgs} -czf - -C '${escapedSource}' . | base64`],
    bypassSession: true,
    timeoutMs: 120_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_checkpoint_failed");
  }
  const archive = Buffer.from(result.stdout.replace(/\s+/g, ""), "base64");
  assertSafeRemoteCheckpointArchive(archive);
  const parent = resolve(input.targetPath, "..");
  const stagingRoot = mkdtempSync(join(parent, ".paperclip-checkpoint-"));
  const stagedTarget = join(stagingRoot, "payload");
  const previousTarget = join(
    parent,
    `.paperclip-checkpoint-previous-${randomUUID()}`,
  );
  let previousMoved = false;
  let replacementInstalled = false;
  try {
    mkdirSync(stagedTarget, { recursive: true, mode: input.mode });
    execFileSync(
      "tar",
      [
        "--no-same-owner",
        "--no-same-permissions",
        "-xzf",
        "-",
        "-C",
        stagedTarget,
      ],
      { input: archive, maxBuffer: 8 * 1024 * 1024, timeout: 60_000 },
    );
    assertSafeExtractedCheckpoint(stagedTarget);
    chmodSync(stagedTarget, input.mode);
    if (existsSync(input.targetPath)) {
      renameSync(input.targetPath, previousTarget);
      previousMoved = true;
    }
    renameSync(stagedTarget, input.targetPath);
    replacementInstalled = true;
    if (previousMoved) {
      rmSync(previousTarget, { recursive: true, force: true });
      previousMoved = false;
    }
  } catch (error) {
    if (
      previousMoved &&
      !replacementInstalled &&
      !existsSync(input.targetPath)
    ) {
      try {
        renameSync(previousTarget, input.targetPath);
        previousMoved = false;
      } catch {
        // Leave the last durable checkpoint at previousTarget. Deleting it in
        // finally would turn a failed replacement into irreversible data loss.
      }
    }
    throw error;
  } finally {
    if (previousMoved && replacementInstalled) {
      rmSync(previousTarget, { recursive: true, force: true });
    }
    rmSync(stagingRoot, { recursive: true, force: true });
  }
}

async function readRemoteRunnerState(input: {
  runner: CommandManagedRuntimeRunner;
  stateDirectory: string;
}): Promise<Record<string, unknown>> {
  const statePath = posix.join(input.stateDirectory, "runner-state.json");
  const escapedPath = statePath.replaceAll("'", "'\\''");
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `test -f '${escapedPath}' && base64 < '${escapedPath}'`],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_state_unavailable");
  }
  return record(
    JSON.parse(
      Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8"),
    ),
  );
}

async function readRemoteRunnerProviderState(input: {
  runner: CommandManagedRuntimeRunner;
  stateDirectory: string;
  execution: NativeExecutionInput;
}): Promise<Record<string, unknown>> {
  const statePath = posix.join(
    input.stateDirectory,
    runnerProviderStateFilename(input.execution),
  );
  const escapedPath = statePath.replaceAll("'", "'\\''");
  const result = await input.runner.execute({
    command: "sh",
    args: ["-c", `test -f '${escapedPath}' && base64 < '${escapedPath}'`],
    bypassSession: true,
    timeoutMs: 10_000,
  });
  if (result.exitCode !== 0 || result.timedOut) {
    throw new Error("runner_remote_provider_state_unavailable");
  }
  return record(
    JSON.parse(
      Buffer.from(result.stdout.replace(/\s+/g, ""), "base64").toString("utf8"),
    ),
  );
}

function createRemoteRunnerProcessLauncher(input: {
  target: Extract<AdapterExecutionTarget, { kind: "remote" }>;
  runner: CommandManagedRuntimeRunner;
  remoteBinary: string;
  runnerInstanceId: string;
  ensureArtifact?: () => Promise<void>;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  trace?: NativeRunTrace;
  onRunnerProcessSpawned?: () => void;
}): (spec: RunnerProcessLaunchSpec) => RunnerProcessHandle {
  const runner = input.runner;
  return (spec) => {
    const child: RunnerProcessHandle["child"] = {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => {
        const pattern = `--runner-id ${input.runnerInstanceId}`;
        void runner.execute({
          command: "pkill",
          args: ["-f", pattern],
          bypassSession: true,
          timeoutMs: 10_000,
        });
        return true;
      },
    };
    const completion = (async () => {
      if (input.ensureArtifact) {
        if (input.trace) {
          await input.trace.measure(
            "runner.runtime.stage",
            input.ensureArtifact,
            { parentName: "runner.session.startup" },
          );
        } else {
          await input.ensureArtifact();
        }
      }
      const launchStartedAtMs = Date.now();
      // The provider's onSpawn callback is optional and some sandbox command
      // runners cannot report a remote pid until after the command has begun
      // streaming. Signal as soon as staging is complete and the launch RPC is
      // dispatched; this is late enough to avoid preview retries during staging
      // and early enough to avoid a callback-dependent deadlock.
      input.onRunnerProcessSpawned?.();
      await input.trace?.record({
        name: "runner.process.dispatch",
        parentName: "runner.session.startup",
        startedAtMs: launchStartedAtMs,
        endedAtMs: Date.now(),
        attributes: { target: "remote" },
      });
      const result = await runner.execute({
        command: input.remoteBinary,
        args: [...spec.args],
        cwd: input.target.remoteCwd,
        env: processEnvironment(spec.environment),
        timeoutMs: 62 * 60_000,
        useSession: true,
        onLog: input.onLog,
        onSpawn: async (meta) => {
          child.pid = meta.pid;
          await input.onSpawn?.({
            pid: meta.pid,
            processGroupId: null,
            startedAt: new Date().toISOString(),
          });
          await input.trace?.record({
            name: "runner.process.launch",
            parentName: "runner.session.startup",
            startedAtMs: launchStartedAtMs,
            endedAtMs: Date.now(),
          });
        },
      });
      child.exitCode = result.exitCode;
      return {
        code: result.exitCode,
        signal: null,
        stdout: result.stdout,
        stderr: result.stderr,
      };
    })();
    return { child, completion };
  };
}

/**
 * Select the remote runner transport before any artifact is staged or provider
 * endpoint is acquired. Sandbox ingress is available only to a run already
 * authorized by native runtime selection.
 */
export function resolveRemoteRunnerTransportMode(input: {
  target: AdapterExecutionTarget;
  runnerIngressAuthorized: boolean;
}): "listen_ws" | "dial_wss" {
  if (input.target.kind !== "remote") {
    throw new Error("runner_transport_ineligible: remote target is required");
  }
  const requiredMode =
    input.target.transport === "sandbox" &&
    input.target.effectiveCapabilities?.runnerWebSocketIngress === true
      ? "listen_ws"
      : "dial_wss";
  if (requiredMode === "listen_ws" && !input.runnerIngressAuthorized) {
    throw new Error("runner_ingress_unavailable");
  }
  return requiredMode;
}

export function remoteCheckpointIncompleteFailure(
  settlement: "settled" | "unsettled",
  incompleteReason: "unavailable" | "not_suspended" | null,
): Error | null {
  // A transport that never completed provider bootstrap has no provider state
  // to preserve; its original launch failure remains authoritative. Once
  // runnerd has proved suspension, however, an unreadable or incomplete
  // checkpoint must fail the required close so outer sandbox release is
  // withheld. Process containment still happens in the transport finally.
  if (settlement === "unsettled") return null;
  return new Error(
    `runner_remote_checkpoint_incomplete: exact suspended harness state unavailable (${incompleteReason ?? "unknown"})`,
  );
}

/** Production runnerd backend seam, exported so provider wiring can be regression tested. */
export async function createRunnerdBackend(input: {
  db: Db;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  restartRecovery?: NativeRestartRecoveryClaim;
  durableEnvironmentLeaseId?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  runnerEnvironment?: NodeJS.ProcessEnv;
  runnerExecutionTarget?: AdapterExecutionTarget | null;
  /** Resolved per-run authorization; not an independent instance setting. */
  runnerIngressAuthorized?: boolean;
  runnerPublicUrl?: string | null;
  runnerCaBundlePath?: string | null;
  runnerRemoteBinaryPath?: string | null;
  runnerRemoteCodexPath?: string | null;
  runnerRemoteCodexNpmSpec?: string | null;
  runnerRemoteProviderPackPath?: string | null;
  trace?: NativeRunTrace;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  enqueueWakeup?: (
    agentId: string,
    options: {
      source: "assignment";
      triggerDetail: "system";
      reason: "issue_assigned";
      payload: Record<string, unknown>;
      idempotencyKey: string;
      requestedByActorType: "agent";
      requestedByActorId: string;
      contextSnapshot: Record<string, unknown>;
    },
  ) => Promise<unknown>;
}): Promise<NativeSessionBackend> {
  const sessionScopeId = nativeSessionScopeKey(input.execution);
  if (initializingSessionToolAuthorities.has(sessionScopeId)) {
    throw new Error("native_session_supervisor_busy");
  }
  initializingSessionToolAuthorities.add(sessionScopeId);
  try {
    await migrateRunnerdStateRootForExecution({
      db: input.db,
      execution: input.execution,
      allowVerifiedBackup:
        input.runnerExecutionTarget?.kind === "remote" &&
        input.runnerExecutionTarget.transport === "sandbox",
      restartRecovery: input.restartRecovery,
    });
    return await createRunnerdBackendWithinSessionClaim(input, sessionScopeId);
  } finally {
    initializingSessionToolAuthorities.delete(sessionScopeId);
  }
}

async function createRunnerdBackendWithinSessionClaim(
  input: Parameters<typeof createRunnerdBackend>[0],
  sessionScopeId: string,
): Promise<NativeSessionBackend> {
  const target = input.runnerExecutionTarget ?? { kind: "local" as const };
  const authority = new PaperclipRunnerToolAuthority(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    normalizedSessionId: nativeSessionKey(input.execution),
    workMode: input.execution.task.workMode,
    enqueueWakeup: input.enqueueWakeup,
  });
  const authorityEpoch = new SessionToolAuthorityEpoch(
    input.execution.binding.runId,
    authority,
  );
  let dynamicTools: Awaited<
    ReturnType<SessionToolAuthorityEpoch["definitions"]>
  >;
  try {
    dynamicTools = await authorityEpoch.definitions();
  } catch (error) {
    authorityEpoch.revoke();
    throw error;
  }
  const root = runnerdStateRoot(input.execution);
  const durableIdentity = readRunnerdDurableIdentity(root);
  const durableBinding = durableIdentityMatchesSession(
    durableIdentity,
    input.execution,
  )
    ? durableIdentity
    : null;
  const effectiveRunnerInstanceId =
    durableBinding?.runnerInstanceId ?? input.runnerInstanceId;
  const effectiveEnvironmentLeaseId =
    durableBinding?.environmentLeaseId ??
    input.durableEnvironmentLeaseId ??
    input.execution.binding.executionWorkspaceId;
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const remoteTarget = target.kind === "remote" ? target : null;
  const remoteCommandRunner = remoteTarget
    ? remoteTarget.transport === "ssh"
      ? createSshCommandManagedRuntimeRunner({
          spec: remoteTarget.spec,
          defaultCwd: remoteTarget.remoteCwd,
        })
      : remoteTarget.runner
    : null;
  if (remoteTarget && !remoteCommandRunner) {
    throw new Error(
      "runner_transport_ineligible: remote process runner is unavailable",
    );
  }
  const remoteRuntimeRoot = remoteTarget
    ? posix.join(
        remoteTarget.remoteCwd,
        ".paperclip-runtime",
        "paperclip-runner",
      )
    : null;
  const requiresRemoteProviderPack =
    remoteTarget !== null &&
    (input.execution.provider.kind === "opencode" ||
      input.execution.provider.kind === "acpx");
  const configuredProviderPackRoot =
    input.runnerRemoteProviderPackPath?.trim() || null;
  let expectedProviderPackManifest: RemoteProviderPackManifest | null = null;
  if (requiresRemoteProviderPack) {
    if (
      !configuredProviderPackRoot ||
      !existsSync(configuredProviderPackRoot) ||
      !lstatSync(configuredProviderPackRoot).isDirectory()
    ) {
      throw new Error(
        "runner_remote_provider_artifact_incompatible: configure PAPERCLIP_RUNNER_REMOTE_PROVIDER_PACK_PATH with the build-owned provider pack",
      );
    }
    expectedProviderPackManifest = readRemoteProviderPackManifest(
      configuredProviderPackRoot,
    );
  }
  const stagedRemoteProviderPackRoot = remoteRuntimeRoot
    ? posix.join(remoteRuntimeRoot, "provider-pack")
    : null;
  let activeRemoteProviderPackRoot: string | null = null;
  const remoteBinary = remoteRuntimeRoot
    ? posix.join(remoteRuntimeRoot, "bin", "paperclip-runnerd")
    : null;
  // The transport hashes runnerBinary on the controller before an external
  // launcher starts runnerd. Keep that artifact identity in the controller's
  // filesystem; the remote launcher separately owns the sandbox command path.
  // When an explicit remote artifact is configured, prepareRemoteRunner stages
  // these exact bytes at remoteBinary before launch.
  const controllerRunnerBinary = remoteTarget
    ? input.runnerRemoteBinaryPath?.trim() || resolvePaperclipRunnerBinary()
    : resolvePaperclipRunnerBinary();
  const explicitRemoteCodex = input.runnerRemoteCodexPath?.trim() || null;
  const remoteCodexNpmSpec = input.runnerRemoteCodexNpmSpec?.trim() || null;
  if (explicitRemoteCodex && remoteCodexNpmSpec) {
    throw new Error("runner_remote_codex_source_conflict");
  }
  const remoteCodexBinary =
    remoteRuntimeRoot && input.execution.provider.kind === "codex"
      ? remoteCodexNpmSpec
        ? posix.join(
            remoteRuntimeRoot,
            "harnesses",
            "codex",
            "node_modules",
            ".bin",
            "codex",
          )
        : posix.join(remoteRuntimeRoot, "bin", "codex")
      : null;
  const remoteSessionDigest = createHash("sha256")
    .update(nativeSessionKey(input.execution))
    .digest("hex");
  const remoteSessionRoot = remoteRuntimeRoot
    ? posix.join(remoteRuntimeRoot, "sessions", remoteSessionDigest)
    : null;
  const remoteStateDirectory = remoteSessionRoot
    ? posix.join(remoteSessionRoot, "runner")
    : undefined;
  const remoteRunnerFilesystemRoot = remoteSessionRoot
    ? posix.join(remoteSessionRoot, "filesystem")
    : null;
  const persistenceProfile = resolveNativeHarnessPersistenceProfile(
    input.execution,
  );
  const sandboxLeaseAcquisition =
    remoteTarget?.transport === "sandbox"
      ? (remoteTarget.sandboxLeaseAcquisition ?? null)
      : null;
  const remotePersistencePath = (
    directory: NativeHarnessPersistenceDirectory,
  ): string | null =>
    directory.location === "runner"
      ? (remoteStateDirectory ?? null)
      : remoteRunnerFilesystemRoot
        ? posix.join(remoteRunnerFilesystemRoot, directory.name)
        : null;
  const sourceRuntimeContext =
    "runtimeContext" in input.execution ? input.execution.runtimeContext : null;
  const remoteRuntimeContext: NativeRuntimeContextSnapshot | null =
    remoteRunnerFilesystemRoot && sourceRuntimeContext
      ? {
          ...sourceRuntimeContext,
          instructions: {
            ...sourceRuntimeContext.instructions,
            bundle: {
              ...sourceRuntimeContext.instructions.bundle,
              rootPath: posix.join(
                remoteRunnerFilesystemRoot,
                "context",
                "instructions",
              ),
            },
          },
          skills: sourceRuntimeContext.skills.map((skill, index) => ({
            ...skill,
            bundle: {
              ...skill.bundle,
              rootPath: posix.join(
                remoteRunnerFilesystemRoot,
                "context",
                "skills",
                `${index}-${skill.bundle.digest.slice(0, 12)}`,
              ),
            },
          })),
        }
      : sourceRuntimeContext;
  let remotePrepared = false;
  let remoteHarnessStatePrepared = false;
  let selectedRemoteMode: "dial_wss" | "listen_ws" | null = null;
  let remoteCaBundleMapping: { sourcePath: string; targetPath: string } | null =
    null;
  let resolveRemoteRunnerProcessSpawned: (() => void) | null = null;
  const remoteRunnerProcessSpawned = remoteTarget
    ? new Promise<void>((resolveSpawned) => {
        resolveRemoteRunnerProcessSpawned = resolveSpawned;
      })
    : Promise.resolve();

  const verifyRemoteRunner = async (
    requiredMode: "dial_wss" | "listen_ws",
    executable = remoteBinary,
  ) => {
    if (!remoteTarget || !remoteCommandRunner || !executable) return;
    const metadataResult = await remoteCommandRunner.execute({
      command: executable,
      args: ["--build-metadata"],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 30_000,
    });
    if (metadataResult.exitCode !== 0 || metadataResult.timedOut) {
      throw new Error("runner_remote_artifact_verification_failed");
    }
    let metadata: Record<string, unknown>;
    try {
      metadata = JSON.parse(metadataResult.stdout) as Record<string, unknown>;
    } catch (error) {
      throw new Error("runner_remote_artifact_metadata_invalid", {
        cause: error,
      });
    }
    assertRemoteRunnerBuildMetadata(metadata, requiredMode);
  };

  const verifyRemoteCodex = async (executable = remoteCodexBinary) => {
    if (!remoteTarget || !remoteCommandRunner || !executable) return;
    const versionResult = await remoteCommandRunner.execute({
      command: executable,
      args: ["--version"],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 30_000,
    });
    if (versionResult.exitCode !== 0 || versionResult.timedOut) {
      throw new Error("runner_remote_codex_artifact_verification_failed");
    }
    const versionOutput = `${versionResult.stdout}\n${versionResult.stderr}`;
    const version = versionOutput.match(/\bcodex-cli\s+(\d+\.\d+\.\d+)\b/)?.[1];
    if (version !== REMOTE_PROVIDER_PACK_PINS.codex) {
      throw new Error(
        `runner_remote_provider_artifact_incompatible: expected Codex ${REMOTE_PROVIDER_PACK_PINS.codex}, received ${version ?? "an unrecognized version"}`,
      );
    }
  };

  const verifyRemoteProviderPack = async (packRoot: string) => {
    if (!remoteTarget || !remoteCommandRunner || !expectedProviderPackManifest)
      return;
    const expected = Buffer.from(
      canonicalJson(expectedProviderPackManifest),
      "utf8",
    ).toString("base64");
    const providerNodeCommand = posix.join(
      packRoot,
      expectedProviderPackManifest.payload.artifacts.nodeCommand.path,
    );
    const verifyScript = [
      "const fs=require('node:fs')",
      "const crypto=require('node:crypto')",
      "const path=require('node:path')",
      "const root=process.argv[1]",
      "const expected=Buffer.from(process.argv[2],'base64').toString('utf8')",
      "const actual=fs.readFileSync(path.join(root,'provider-pack.json'),'utf8').trim()",
      "const canonical=(v)=>Array.isArray(v)?'['+v.map(canonical).join(',')+']':v&&typeof v==='object'?'{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+canonical(v[k])).join(',')+'}':JSON.stringify(v)",
      "const manifest=JSON.parse(actual)",
      "if(canonical(manifest)!==expected)throw new Error('manifest mismatch')",
      "const hash=(p)=>'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(path.join(root,p))).digest('hex')",
      "const tree=(treeRoot)=>{const digest=crypto.createHash('sha256');const visit=(directory,prefix='')=>{for(const entry of fs.readdirSync(directory,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){const relative=prefix?prefix+'/'+entry.name:entry.name;const absolute=path.join(directory,entry.name);if(entry.isDirectory()){digest.update('directory\\0'+relative+'\\n');visit(absolute,relative)}else if(entry.isFile()){digest.update('file\\0'+relative+'\\0'+'sha256:'+crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')+'\\n')}else if(entry.isSymbolicLink()){digest.update('symlink\\0'+relative+'\\0'+fs.readlinkSync(absolute)+'\\n')}else throw new Error('unsupported dist entry '+relative)}};visit(treeRoot);return 'sha256:'+digest.digest('hex')}",
      "for(const name of ['nodeCommand','productionLock','opencodeCommand','opencodeExecutable','opencodeProxy','acpxSidecar']){const artifact=manifest.payload.artifacts[name];if(hash(artifact.path)!==artifact.sha256)throw new Error(name+' digest mismatch')}",
      "if(tree(path.join(root,'dist'))!==manifest.payload.distDigest)throw new Error('dist tree digest mismatch')",
      "const version=process.versions.node.split('.').map(Number)",
      "const minimum=manifest.payload.pins.nodeMinimum.split('.').map(Number)",
      "if(version[0]<minimum[0]||(version[0]===minimum[0]&&(version[1]<minimum[1]||(version[1]===minimum[1]&&version[2]<minimum[2]))))throw new Error('Node version incompatible')",
      "if(process.platform!==manifest.payload.target.platform||process.arch!==manifest.payload.target.architecture)throw new Error('provider pack target mismatch')",
      "const packageVersion=(pkg)=>JSON.parse(fs.readFileSync(path.join(root,'node_modules',...pkg.split('/'),'package.json'),'utf8')).version",
      "const expectedPackages={acpx:manifest.payload.pins.acpx,'@agentclientprotocol/claude-agent-acp':manifest.payload.pins.claudeAcp,'@agentclientprotocol/codex-acp':manifest.payload.pins.codexAcp,'opencode-ai':manifest.payload.pins.opencode}",
      "for(const [pkg,version] of Object.entries(expectedPackages))if(packageVersion(pkg)!==version)throw new Error(pkg+' version mismatch')",
    ].join(";");
    const verified = await remoteCommandRunner.execute({
      command: providerNodeCommand,
      args: ["-e", verifyScript, packRoot, expected],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 30_000,
    });
    if (verified.exitCode !== 0 || verified.timedOut) {
      throw new Error(
        `runner_remote_provider_artifact_incompatible: provider pack verification failed (${verified.stderr.trim().slice(-1_024)})`,
      );
    }
    const opencodeCommand = posix.join(
      packRoot,
      expectedProviderPackManifest.payload.artifacts.opencodeCommand.path,
    );
    const opencodeVersion = await remoteCommandRunner.execute({
      command: opencodeCommand,
      args: ["--version"],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 30_000,
    });
    if (
      opencodeVersion.exitCode !== 0 ||
      opencodeVersion.timedOut ||
      opencodeVersion.stdout.trim() !== REMOTE_PROVIDER_PACK_PINS.opencode
    ) {
      throw new Error(
        "runner_remote_provider_artifact_incompatible: OpenCode version mismatch",
      );
    }
  };

  const discoverPreinstalledProviderPack = async () => {
    if (!remoteTarget || !remoteCommandRunner) return null;
    const result = await remoteCommandRunner.execute({
      command: "sh",
      args: [
        "-c",
        'for candidate in /opt/paperclip-runner/provider-pack "$HOME/.local/share/paperclip-runner/provider-pack"; do if [ -f "$candidate/provider-pack.json" ]; then printf \'%s\\n\' "$candidate"; break; fi; done',
      ],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    return parseRemoteExecutableCandidate(result.stdout);
  };

  const discoverPreinstalledExecutable = async (
    name: "paperclip-runnerd" | "codex",
  ) => {
    if (!remoteTarget || !remoteCommandRunner) return null;
    const result = await remoteCommandRunner.execute({
      command: "sh",
      args: [
        "-c",
        `candidate="$HOME/.local/bin/${name}"; ` +
          `if [ -x "$candidate" ]; then printf '%s\\n' "$candidate"; ` +
          `else command -v ${name} 2>/dev/null || true; fi`,
      ],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.timedOut) return null;
    return parseRemoteExecutableCandidate(result.stdout);
  };

  const linkPreinstalledExecutable = async (
    sourcePath: string,
    targetPath: string,
  ) => {
    if (!remoteTarget || !remoteCommandRunner) return;
    const escapedSource = sourcePath.replaceAll("'", "'\\''");
    const escapedTarget = targetPath.replaceAll("'", "'\\''");
    const escapedDirectory = posix.dirname(targetPath).replaceAll("'", "'\\''");
    const result = await remoteCommandRunner.execute({
      command: "sh",
      args: [
        "-c",
        `umask 077; mkdir -p '${escapedDirectory}' && ` +
          `ln -sfn '${escapedSource}' '${escapedTarget}'`,
      ],
      cwd: remoteTarget.remoteCwd,
      bypassSession: true,
      timeoutMs: 10_000,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new Error("runner_remote_preinstalled_link_failed");
    }
  };

  const prepareRemoteRunner = async (
    requiredMode: "dial_wss" | "listen_ws",
  ) => {
    if (
      !remoteTarget ||
      !remoteCommandRunner ||
      !remoteBinary ||
      remotePrepared
    )
      return;
    selectedRemoteMode = requiredMode;
    let usedPreinstalledRunner = false;
    const explicitRemoteBinary = input.runnerRemoteBinaryPath?.trim() || null;
    if (mayUsePreinstalledRunnerArtifact(explicitRemoteBinary)) {
      const preinstalledRunner = await measureNativeRunnerSpan(
        input.trace,
        "runner.artifact.discover",
        () => discoverPreinstalledExecutable("paperclip-runnerd"),
      );
      if (preinstalledRunner) {
        try {
          await measureNativeRunnerSpan(
            input.trace,
            "runner.artifact.verify_preinstalled",
            () => verifyRemoteRunner(requiredMode, preinstalledRunner),
          );
          await measureNativeRunnerSpan(
            input.trace,
            "runner.artifact.link",
            () => linkPreinstalledExecutable(preinstalledRunner, remoteBinary),
          );
          usedPreinstalledRunner = true;
          await input.onLog?.(
            "stderr",
            "[paperclip-runner] using preinstalled runnerd from the sandbox image\n",
          );
        } catch {
          usedPreinstalledRunner = false;
        }
      }
    }
    if (!usedPreinstalledRunner) {
      const sourceBinary =
        explicitRemoteBinary ?? defaultCapabilityRunnerdBinary();
      if (!existsSync(sourceBinary)) {
        throw new Error("runner_remote_artifact_unavailable");
      }
      if (!explicitRemoteBinary) {
        const platform = await remoteCommandRunner.execute({
          command: "sh",
          args: ["-c", "uname -s; uname -m"],
          cwd: remoteTarget.remoteCwd,
          bypassSession: true,
          timeoutMs: 10_000,
        });
        const [remoteOs = "", remoteArch = ""] = platform.stdout
          .trim()
          .split(/\r?\n/);
        const localOs =
          process.platform === "darwin"
            ? "Darwin"
            : process.platform === "linux"
              ? "Linux"
              : process.platform;
        const localArch =
          process.arch === "x64"
            ? "x86_64"
            : process.arch === "arm64"
              ? "aarch64"
              : process.arch;
        const archMatches =
          remoteArch === localArch ||
          (localArch === "aarch64" && remoteArch === "arm64");
        if (
          platform.exitCode !== 0 ||
          platform.timedOut ||
          remoteOs !== localOs ||
          !archMatches
        ) {
          throw new Error(
            "runner_remote_artifact_platform_mismatch: configure PAPERCLIP_RUNNER_REMOTE_BINARY_PATH for the remote OS and architecture",
          );
        }
      }
      await stageRemoteRunnerFile({
        target: remoteTarget,
        runner: remoteCommandRunner,
        sourcePath: sourceBinary,
        targetPath: remoteBinary,
        mode: 0o700,
      });
    }
    await measureNativeRunnerSpan(input.trace, "runner.artifact.verify", () =>
      verifyRemoteRunner(requiredMode),
    );
    if (remoteCodexBinary && explicitRemoteCodex) {
      if (!existsSync(explicitRemoteCodex)) {
        throw new Error("runner_remote_codex_artifact_unavailable");
      }
      await stageRemoteRunnerFile({
        target: remoteTarget,
        runner: remoteCommandRunner,
        sourcePath: explicitRemoteCodex,
        targetPath: remoteCodexBinary,
        mode: 0o700,
      });
      await verifyRemoteCodex();
    }
    if (remoteCodexBinary && remoteCodexNpmSpec) {
      let usedPreinstalledCodex = false;
      const preinstalledCodex = await measureNativeRunnerSpan(
        input.trace,
        "harness.artifact.discover",
        () => discoverPreinstalledExecutable("codex"),
      );
      if (preinstalledCodex) {
        try {
          await measureNativeRunnerSpan(
            input.trace,
            "harness.artifact.verify_preinstalled",
            () => verifyRemoteCodex(preinstalledCodex),
          );
          await measureNativeRunnerSpan(
            input.trace,
            "harness.artifact.link",
            () =>
              linkPreinstalledExecutable(preinstalledCodex, remoteCodexBinary),
          );
          usedPreinstalledCodex = true;
          await input.onLog?.(
            "stderr",
            "[paperclip-runner] using preinstalled Codex from the sandbox image\n",
          );
        } catch {
          usedPreinstalledCodex = false;
        }
      }
      if (!usedPreinstalledCodex) {
        const installRoot = posix.join(
          remoteRuntimeRoot!,
          "harnesses",
          "codex",
        );
        const installResult = await remoteCommandRunner.execute({
          command: "npm",
          args: [
            "install",
            "--prefix",
            installRoot,
            "--no-audit",
            "--no-fund",
            remoteCodexNpmSpec,
          ],
          cwd: remoteTarget.remoteCwd,
          bypassSession: true,
          timeoutMs: 180_000,
        });
        if (installResult.exitCode !== 0 || installResult.timedOut) {
          throw new Error("runner_remote_codex_install_failed");
        }
      }
      await measureNativeRunnerSpan(
        input.trace,
        "harness.artifact.verify",
        () => verifyRemoteCodex(),
      );
    }
    if (remoteCodexBinary && !explicitRemoteCodex && !remoteCodexNpmSpec) {
      const preinstalledCodex = await measureNativeRunnerSpan(
        input.trace,
        "harness.artifact.discover",
        () => discoverPreinstalledExecutable("codex"),
      );
      if (!preinstalledCodex) {
        throw new Error(
          "runner_remote_codex_artifact_unavailable: install codex in the sandbox image or configure PAPERCLIP_RUNNER_REMOTE_CODEX_NPM_SPEC",
        );
      }
      await measureNativeRunnerSpan(
        input.trace,
        "harness.artifact.verify_preinstalled",
        () => verifyRemoteCodex(preinstalledCodex),
      );
      await measureNativeRunnerSpan(input.trace, "harness.artifact.link", () =>
        linkPreinstalledExecutable(preinstalledCodex, remoteCodexBinary),
      );
      await measureNativeRunnerSpan(
        input.trace,
        "harness.artifact.verify",
        () => verifyRemoteCodex(),
      );
      await input.onLog?.(
        "stderr",
        "[paperclip-runner] using preinstalled Codex from the sandbox image\n",
      );
    }
    if (
      requiresRemoteProviderPack &&
      configuredProviderPackRoot &&
      stagedRemoteProviderPackRoot
    ) {
      let preinstalledProviderPack = await discoverPreinstalledProviderPack();
      if (preinstalledProviderPack) {
        try {
          await measureNativeRunnerSpan(
            input.trace,
            "provider_pack.verify_preinstalled",
            () => verifyRemoteProviderPack(preinstalledProviderPack!),
          );
          const escapedSource = preinstalledProviderPack.replaceAll(
            "'",
            "'\\''",
          );
          const escapedTarget = stagedRemoteProviderPackRoot.replaceAll(
            "'",
            "'\\''",
          );
          const escapedParent = posix
            .dirname(stagedRemoteProviderPackRoot)
            .replaceAll("'", "'\\''");
          const linked = await remoteCommandRunner.execute({
            command: "sh",
            args: [
              "-c",
              `umask 077; mkdir -p '${escapedParent}' && rm -rf '${escapedTarget}' && ln -s '${escapedSource}' '${escapedTarget}'`,
            ],
            cwd: remoteTarget.remoteCwd,
            bypassSession: true,
            timeoutMs: 10_000,
          });
          if (linked.exitCode !== 0 || linked.timedOut) {
            throw new Error(
              "runner_remote_provider_artifact_incompatible: preinstalled provider pack could not be linked",
            );
          }
          activeRemoteProviderPackRoot = stagedRemoteProviderPackRoot;
          await input.onLog?.(
            "stderr",
            "[paperclip-runner] using manifest-matched provider pack from the sandbox image\n",
          );
        } catch {
          preinstalledProviderPack = null;
        }
      }
      if (!preinstalledProviderPack) {
        if (!remoteCommandRunner.syncIn) {
          throw new Error(
            "runner_remote_provider_artifact_incompatible: this remote transport cannot stage a provider pack; preinstall the exact manifest-matched pack",
          );
        }
        const escapedPackRoot = stagedRemoteProviderPackRoot.replaceAll(
          "'",
          "'\\''",
        );
        const cleared = await remoteCommandRunner.execute({
          command: "sh",
          args: ["-c", `rm -rf '${escapedPackRoot}'`],
          cwd: remoteTarget.remoteCwd,
          bypassSession: true,
          timeoutMs: 10_000,
        });
        if (cleared.exitCode !== 0 || cleared.timedOut) {
          throw new Error(
            "runner_remote_provider_artifact_incompatible: stale provider pack could not be replaced",
          );
        }
        await stageRemoteRunnerDirectory({
          target: remoteTarget,
          runner: remoteCommandRunner,
          sourcePath: configuredProviderPackRoot,
          targetPath: stagedRemoteProviderPackRoot,
          mode: 0o700,
        });
        await measureNativeRunnerSpan(input.trace, "provider_pack.verify", () =>
          verifyRemoteProviderPack(stagedRemoteProviderPackRoot),
        );
        activeRemoteProviderPackRoot = stagedRemoteProviderPackRoot;
      }
    }
    remotePrepared = true;
  };

  const inspectRemoteHarnessState = async (): Promise<{
    complete: boolean;
    runnerState: Record<string, unknown> | null;
    providerSessionIdentity: Record<string, unknown> | null;
    incompleteReason: "unavailable" | "not_suspended" | null;
  }> => {
    if (!remoteCommandRunner || !remoteStateDirectory) {
      return {
        complete: false,
        runnerState: null,
        providerSessionIdentity: null,
        incompleteReason: "unavailable",
      };
    }
    const requirements = persistenceProfile.directories.flatMap((directory) => {
      const path = remotePersistencePath(directory);
      if (!path) return [];
      const escaped = path.replaceAll("'", "'\\''");
      return directory.name === "runner"
        ? [`test -f '${escaped}/runner-state.json'`]
        : [`test -d '${escaped}'`];
    });
    const escapedRunnerState = posix
      .join(remoteStateDirectory, "runner-state.json")
      .replaceAll("'", "'\\''");
    const escapedProviderState = posix
      .join(remoteStateDirectory, runnerProviderStateFilename(input.execution))
      .replaceAll("'", "'\\''");
    const inspected = await remoteCommandRunner.execute({
      command: "sh",
      args: [
        "-c",
        `${requirements.join(" && ")} && test -f '${escapedProviderState}' && base64 < '${escapedRunnerState}'`,
      ],
      bypassSession: true,
      timeoutMs: 10_000,
    });
    if (inspected.exitCode !== 0 || inspected.timedOut) {
      return {
        complete: false,
        runnerState: null,
        providerSessionIdentity: null,
        incompleteReason: "unavailable",
      };
    }
    let runnerState: Record<string, unknown>;
    try {
      runnerState = record(
        JSON.parse(
          Buffer.from(inspected.stdout.replace(/\s+/g, ""), "base64").toString(
            "utf8",
          ),
        ),
      );
    } catch {
      throw new Error("runner_harness_state_mismatch");
    }
    if (
      runnerState.runnerInstanceId !== input.runnerInstanceId ||
      runnerState.normalizedSessionId !== nativeSessionKey(input.execution)
    ) {
      throw new Error("runner_harness_state_mismatch");
    }
    if (runnerState.lifecycle !== "suspended") {
      return {
        complete: false,
        runnerState: null,
        providerSessionIdentity: null,
        incompleteReason: "not_suspended",
      };
    }
    let providerState: Record<string, unknown>;
    try {
      providerState = await readRemoteRunnerProviderState({
        runner: remoteCommandRunner,
        stateDirectory: remoteStateDirectory,
        execution: input.execution,
      });
    } catch {
      throw new Error("runner_harness_state_mismatch");
    }
    const providerSessionIdentity =
      providerSessionIdentityFromDurableProviderState({
        execution: input.execution,
        providerState,
      });
    if (!providerSessionIdentityIsPresent(providerSessionIdentity)) {
      throw new Error("runner_harness_state_mismatch");
    }
    const previousManifest = compatibleNativeHarnessBackupManifests({
      root,
      execution: input.execution,
      runnerInstanceId: input.runnerInstanceId,
    })[0]?.manifest;
    if (
      previousManifest &&
      !providerSessionIdentityTransitionIsAllowed({
        execution: input.execution,
        previous: previousManifest.providerSessionIdentity,
        current: providerSessionIdentity,
      })
    ) {
      throw new Error("runner_harness_state_mismatch");
    }
    return {
      complete: true,
      runnerState,
      providerSessionIdentity,
      incompleteReason: null,
    };
  };

  const recordInPlaceHarnessReuse = async (
    providerSessionIdentity: Record<string, unknown>,
    startedAtMs = Date.now(),
  ) => {
    const now = Date.now();
    const attributes = {
      provider: input.execution.provider.kind,
      harness: input.execution.session.driverKind,
      lifecycleMode: input.execution.session.lifecyclePolicy.mode,
      stateSource: "sandbox_filesystem",
      bytesTransferred: 0,
    };
    await input.trace?.record({
      name: "harness_state.reuse",
      startedAtMs,
      endedAtMs: now,
      attributes,
    });
    await input.trace?.record({
      name: "provider.session.resume",
      startedAtMs: now,
      endedAtMs: now,
      attributes: {
        provider: input.execution.provider.kind,
        harness: input.execution.session.driverKind,
        identityPresent: providerSessionIdentityIsPresent(
          providerSessionIdentity,
        ),
      },
    });
  };

  const recordHarnessBackupStampForCurrentLease = async (
    backup: VerifiedHarnessBackup,
  ) => {
    if (remoteTarget?.transport !== "sandbox" || !remoteTarget.leaseId) {
      return;
    }
    const leaseRow = await input.db
      .select({
        metadata: environmentLeases.metadata,
        providerLeaseId: environmentLeases.providerLeaseId,
      })
      .from(environmentLeases)
      .where(eq(environmentLeases.id, remoteTarget.leaseId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!leaseRow?.providerLeaseId) {
      throw new Error("runner_harness_backup_lease_missing");
    }
    if (
      sandboxLeaseAcquisition?.providerLeaseId &&
      sandboxLeaseAcquisition.providerLeaseId !== leaseRow.providerLeaseId
    ) {
      throw new Error("runner_harness_backup_lease_mismatch");
    }
    const stamp = createNativeHarnessBackupStamp({
      manifestPath: resolve(backup.root, "manifest.json"),
      sessionScopeId,
      authorizedProviderLeaseId: leaseRow.providerLeaseId,
      normalizedSessionId: backup.manifest.normalizedSessionId,
      runnerInstanceId: backup.manifest.runnerInstanceId,
      completedAt: backup.manifest.completedAt,
    });
    const updated = await input.db
      .update(environmentLeases)
      .set({
        metadata: {
          ...(leaseRow.metadata ?? {}),
          nativeHarnessBackup: stamp,
        },
        updatedAt: new Date(),
      })
      .where(eq(environmentLeases.id, remoteTarget.leaseId))
      .returning({ id: environmentLeases.id })
      .then((rows) => rows[0] ?? null);
    if (!updated) throw new Error("runner_harness_backup_lease_missing");
  };

  const restoreVerifiedHarnessBackup = async () => {
    if (!remoteTarget || !remoteCommandRunner) {
      throw new Error("runner_harness_backup_unavailable");
    }
    const backup = verifyNativeHarnessBackup({
      root,
      execution: input.execution,
      runnerInstanceId: input.runnerInstanceId,
    });
    if (!backup) throw new Error("runner_harness_backup_unavailable");
    await measureNativeRunnerSpan(
      input.trace,
      "harness_state.failover_restore",
      async () => {
        for (const directory of persistenceProfile.directories) {
          const targetPath = remotePersistencePath(directory);
          if (!targetPath) throw new Error("runner_harness_state_mismatch");
          await stageRemoteRunnerDirectory({
            target: remoteTarget,
            runner: remoteCommandRunner,
            sourcePath: resolve(backup.root, directory.name),
            targetPath,
            mode: 0o700,
          });
        }
      },
      {
        attributes: {
          provider: input.execution.provider.kind,
          harness: input.execution.session.driverKind,
          lifecycleMode: input.execution.session.lifecyclePolicy.mode,
          stateSource: "verified_failover_backup",
          bytesTransferred: backup.bytes,
        },
      },
    );
    const restored = await inspectRemoteHarnessState();
    if (
      !restored.complete ||
      !restored.runnerState ||
      !restored.providerSessionIdentity ||
      canonicalJson(restored.providerSessionIdentity) !==
        canonicalJson(backup.manifest.providerSessionIdentity)
    ) {
      throw new Error("runner_harness_state_mismatch");
    }
    // A deliberately non-reusable environment receives a fresh provider lease
    // for every turn. Stamp that new lease as soon as the verified host backup
    // has been restored so a later provider/bootstrap failure can still clean
    // the ephemeral sandbox up without discarding the only durable copy.
    await recordHarnessBackupStampForCurrentLease(backup);
    return backup;
  };

  const materializeRemoteHarnessLaunchState = async () => {
    if (!remoteTarget || !remoteCommandRunner) return;
    for (const directory of persistenceProfile.directories) {
      if (directory.location !== "filesystem") continue;
      const targetPath = remotePersistencePath(directory);
      if (!targetPath) throw new Error("runner_harness_state_mismatch");
      const escapedTarget = targetPath.replaceAll("'", "'\\''");
      const created = await remoteCommandRunner.execute({
        command: "sh",
        args: ["-c", `umask 077; install -d -m 0700 '${escapedTarget}'`],
        bypassSession: true,
        timeoutMs: 10_000,
      });
      if (created.exitCode !== 0 || created.timedOut) {
        throw new Error("runner_remote_directory_staging_failed");
      }

      // Codex launch credentials are intentionally excluded from failover
      // backups. Re-materialize only those launch-time files into a fresh or
      // replacement sandbox after the durable history has been restored.
      if (directory.name !== "codex-home") continue;
      const localDirectory = resolve(root, directory.name);
      for (const name of ["auth.json", "config.toml"] as const) {
        const sourcePath = resolve(localDirectory, name);
        if (!existsSync(sourcePath)) continue;
        await stageRemoteRunnerFile({
          target: remoteTarget,
          runner: remoteCommandRunner,
          sourcePath,
          targetPath: posix.join(targetPath, name),
          mode: 0o600,
        });
      }
    }
  };

  const ensureRemoteRunner = async () => {
    await measureNativeRunnerSpan(
      input.trace,
      "stage.sync",
      async () => {
        if (!selectedRemoteMode) {
          throw new Error("runner_remote_transport_mode_unresolved");
        }
        try {
          await verifyRemoteRunner(selectedRemoteMode);
          await verifyRemoteCodex();
          if (requiresRemoteProviderPack) {
            if (!activeRemoteProviderPackRoot) {
              throw new Error(
                "runner_remote_provider_artifact_incompatible: provider pack was not prepared",
              );
            }
            await verifyRemoteProviderPack(activeRemoteProviderPackRoot);
          }
        } catch {
          remotePrepared = false;
          await prepareRemoteRunner(selectedRemoteMode);
        }
        if (!remoteHarnessStatePrepared) {
          await measureNativeRunnerSpan(input.trace, "stage.asset.home", () =>
            measureNativeRunnerSpan(
              input.trace,
              "session.checkpoint.restore",
              async () => {
                if (
                  remoteTarget?.transport === "sandbox" &&
                  remoteCommandRunner
                ) {
                  const acquisitionRecordedAtMs = Date.now();
                  const backupAvailable = harnessBackupCandidates(root).some(
                    (candidate) =>
                      existsSync(resolve(candidate, "manifest.json")),
                  );
                  const restoreIntoCreatedSandbox =
                    shouldRestoreNativeHarnessBackupIntoSandbox({
                      acquisitionOutcome:
                        sandboxLeaseAcquisition?.outcome ?? null,
                      reusableLeaseConfigured:
                        remoteTarget.reusableLeaseConfigured,
                      backupAvailable,
                    });
                  await input.trace?.record({
                    name: "sandbox.lease.acquisition",
                    startedAtMs: acquisitionRecordedAtMs,
                    endedAtMs: acquisitionRecordedAtMs,
                    attributes: {
                      provider: remoteTarget.providerKey ?? "sandbox",
                      harness: input.execution.session.driverKind,
                      lifecycleMode:
                        input.execution.session.lifecyclePolicy.mode,
                      outcome: sandboxLeaseAcquisition?.outcome ?? "unknown",
                      stateSource:
                        sandboxLeaseAcquisition?.outcome === "replacement" ||
                        restoreIntoCreatedSandbox
                          ? "verified_failover_backup"
                          : sandboxLeaseAcquisition?.outcome === "resumed"
                            ? "sandbox_filesystem"
                            : "new_sandbox",
                      bytesTransferred: 0,
                    },
                  });
                  if (sandboxLeaseAcquisition?.outcome === "resumed") {
                    const reuseStartedAtMs = Date.now();
                    const state = await measureNativeRunnerSpan(
                      input.trace,
                      "sandbox.lease.resume",
                      inspectRemoteHarnessState,
                      {
                        attributes: {
                          provider: remoteTarget.providerKey ?? "sandbox",
                          harness: input.execution.session.driverKind,
                          lifecycleMode:
                            input.execution.session.lifecyclePolicy.mode,
                          outcome: "resumed",
                        },
                      },
                    );
                    if (
                      !state.complete ||
                      !state.runnerState ||
                      !state.providerSessionIdentity
                    ) {
                      throw new Error("runner_harness_state_mismatch");
                    }
                    await recordInPlaceHarnessReuse(
                      state.providerSessionIdentity,
                      reuseStartedAtMs,
                    );
                  } else if (
                    sandboxLeaseAcquisition?.outcome === "replacement"
                  ) {
                    await measureNativeRunnerSpan(
                      input.trace,
                      "sandbox.lease.replacement",
                      restoreVerifiedHarnessBackup,
                      {
                        attributes: {
                          provider: remoteTarget.providerKey ?? "sandbox",
                          harness: input.execution.session.driverKind,
                          lifecycleMode:
                            input.execution.session.lifecyclePolicy.mode,
                          outcome: "replacement",
                          reason: sandboxLeaseAcquisition.reason ?? "unknown",
                        },
                      },
                    );
                  } else if (restoreIntoCreatedSandbox) {
                    await measureNativeRunnerSpan(
                      input.trace,
                      "sandbox.lease.replacement",
                      restoreVerifiedHarnessBackup,
                      {
                        attributes: {
                          provider: remoteTarget.providerKey ?? "sandbox",
                          harness: input.execution.session.driverKind,
                          lifecycleMode:
                            input.execution.session.lifecyclePolicy.mode,
                          outcome: "created",
                          reason: "reuse_disabled",
                        },
                      },
                    );
                  } else {
                    const reuseStartedAtMs = Date.now();
                    const state = await inspectRemoteHarnessState();
                    if (
                      state.complete &&
                      state.runnerState &&
                      state.providerSessionIdentity
                    ) {
                      // Re-entry while this newly-created lease is already running (for
                      // example a transport reconnect) still uses the in-place state.
                      await recordInPlaceHarnessReuse(
                        state.providerSessionIdentity,
                        reuseStartedAtMs,
                      );
                    } else if (backupAvailable) {
                      // A continuation that has a durable backup but no recorded reusable
                      // lease was not provider-confirmed lost. Never silently create a new
                      // provider session from that ambiguous state.
                      throw new Error("runner_harness_state_mismatch");
                    }
                  }
                  await materializeRemoteHarnessLaunchState();
                } else if (remoteTarget && remoteCommandRunner) {
                  // Local and generic SSH execution retain their existing checkpoint
                  // behavior. The manifest-only failover gate applies to managed sandbox
                  // replacement, where provider lease provenance is available.
                  for (const directory of persistenceProfile.directories) {
                    const localDirectory = resolve(root, directory.name);
                    const remoteDirectory = remotePersistencePath(directory);
                    if (
                      remoteDirectory &&
                      existsSync(localDirectory) &&
                      !(await remoteRunnerPathExists({
                        runner: remoteCommandRunner,
                        path:
                          directory.name === "runner"
                            ? posix.join(remoteDirectory, "runner-state.json")
                            : remoteDirectory,
                        kind:
                          directory.name === "runner" ? "file" : "directory",
                      }))
                    ) {
                      await stageRemoteRunnerDirectory({
                        target: remoteTarget,
                        runner: remoteCommandRunner,
                        sourcePath: localDirectory,
                        targetPath: remoteDirectory,
                        mode: 0o700,
                        excludeEntries: directory.excludeEntries,
                      });
                    }
                  }
                }
              },
              {
                attributes: {
                  mode: remoteTarget?.transport ?? "local",
                  lifecycleMode: input.execution.session.lifecyclePolicy.mode,
                },
              },
            ),
          );
          remoteHarnessStatePrepared = true;
        }
        if (
          remoteTarget &&
          remoteCommandRunner &&
          remoteRunnerFilesystemRoot &&
          sourceRuntimeContext &&
          remoteRuntimeContext
        ) {
          await measureNativeRunnerSpan(
            input.trace,
            "stage.asset.runtime_context",
            async () => {
              await stageRemoteRunnerDirectory({
                target: remoteTarget,
                runner: remoteCommandRunner,
                sourcePath: sourceRuntimeContext.instructions.bundle.rootPath,
                targetPath: remoteRuntimeContext.instructions.bundle.rootPath,
                mode: 0o555,
              });
              for (
                let index = 0;
                index < sourceRuntimeContext.skills.length;
                index += 1
              ) {
                await stageRemoteRunnerDirectory({
                  target: remoteTarget,
                  runner: remoteCommandRunner,
                  sourcePath:
                    sourceRuntimeContext.skills[index]!.bundle.rootPath,
                  targetPath:
                    remoteRuntimeContext.skills[index]!.bundle.rootPath,
                  mode: 0o555,
                });
              }
              await stageRemoteRunnerFile({
                target: remoteTarget,
                runner: remoteCommandRunner,
                sourcePath: resolve(root, "runtime-context.json"),
                targetPath: posix.join(
                  remoteRunnerFilesystemRoot,
                  "runtime-context.json",
                ),
                mode: 0o600,
              });
            },
          );
        }
        if (remoteTarget && remoteCommandRunner && remoteCaBundleMapping) {
          const caBundleMapping = remoteCaBundleMapping;
          await measureNativeRunnerSpan(
            input.trace,
            "stage.asset.ca_bundle",
            () =>
              stageRemoteRunnerFile({
                target: remoteTarget,
                runner: remoteCommandRunner,
                sourcePath: caBundleMapping.sourcePath,
                targetPath: caBundleMapping.targetPath,
                mode: 0o600,
              }),
          );
        }
      },
      {
        attributes: {
          target: remoteTarget?.transport ?? "local",
          lifecycleMode: input.execution.session.lifecyclePolicy.mode,
        },
      },
    );
  };

  const checkpointRemoteRunner = async (
    settlement: "settled" | "unsettled",
  ) => {
    if (
      !remoteCommandRunner ||
      !remoteStateDirectory ||
      !remoteRunnerFilesystemRoot
    )
      return;
    // Transport release also runs when provider bootstrap failed. In that case
    // runnerd has no durable provider identity (and may not have created the
    // provider persistence directory at all), so attempting a failover backup
    // would replace the original provider error with
    // `runner_harness_state_mismatch`. Only checkpoint a harness that runnerd
    // has proved complete. A malformed or identity-conflicting state still
    // throws from inspectRemoteHarnessState and therefore fails closed.
    let checkpointable = await inspectRemoteHarnessState();
    // The remote runner writes its suspended lifecycle and provider state
    // before the outer process-owner RPC necessarily observes completion.
    // Allow a very small bounded visibility window without ever accepting an
    // active, incomplete, malformed, or identity-conflicting checkpoint.
    for (let attempt = 1; !checkpointable.complete && attempt < 3; attempt++) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      checkpointable = await inspectRemoteHarnessState();
    }
    if (!checkpointable.complete) {
      const incompleteFailure = remoteCheckpointIncompleteFailure(
        settlement,
        checkpointable.incompleteReason,
      );
      await input.onLog?.(
        "stderr",
        `[paperclip-runner] remote checkpoint ${incompleteFailure ? "failed" : "skipped"}: exact suspended harness state unavailable (process=${settlement} reason=${checkpointable.incompleteReason})\n`,
      );
      if (incompleteFailure) throw incompleteFailure;
      return;
    }
    const backupSpanAttributes = {
      provider: input.execution.provider.kind,
      harness: input.execution.session.driverKind,
      lifecycleMode: input.execution.session.lifecyclePolicy.mode,
      stateSource: "sandbox_filesystem",
      bytesTransferred: 0,
    };
    try {
      await measureNativeRunnerSpan(
        input.trace,
        "session.checkpoint.persist",
        () =>
          measureNativeRunnerSpan(
            input.trace,
            "harness_state.backup.persist",
            async () => {
              const verified = await inspectRemoteHarnessState();
              if (
                !verified.complete ||
                !verified.runnerState ||
                !verified.providerSessionIdentity
              ) {
                throw new Error("runner_harness_state_mismatch");
              }
              const providerSessionIdentity = verified.providerSessionIdentity;

              const backupRoot = harnessBackupRoot(root);
              mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
              const pendingRoot = resolve(
                backupRoot,
                `.pending-${randomUUID()}`,
              );
              mkdirSync(pendingRoot, { recursive: true, mode: 0o700 });
              try {
                for (const directory of persistenceProfile.directories) {
                  const sourcePath = remotePersistencePath(directory);
                  if (!sourcePath)
                    throw new Error("runner_harness_state_mismatch");
                  const targetPath = resolve(pendingRoot, directory.name);
                  await syncRemoteRunnerDirectoryOut({
                    runner: remoteCommandRunner,
                    sourcePath,
                    targetPath,
                    mode: 0o700,
                    excludeEntries: directory.excludeEntries,
                  });
                  if (!existsSync(targetPath)) {
                    throw new Error("runner_harness_state_mismatch");
                  }
                }
                const manifest = buildNativeHarnessBackupManifest({
                  backupRoot: pendingRoot,
                  execution: input.execution,
                  runnerInstanceId: input.runnerInstanceId,
                  providerSessionIdentity,
                  sourceProviderLeaseId:
                    sandboxLeaseAcquisition?.providerLeaseId ??
                    remoteTarget?.leaseId ??
                    input.durableEnvironmentLeaseId ??
                    "unknown",
                });
                backupSpanAttributes.bytesTransferred =
                  manifest.directories.reduce(
                    (total, directory) => total + directory.bytes,
                    0,
                  );
                const temporaryManifest = resolve(
                  pendingRoot,
                  "manifest.json.tmp",
                );
                const manifestPath = resolve(pendingRoot, "manifest.json");
                writeFileSync(temporaryManifest, JSON.stringify(manifest), {
                  encoding: "utf8",
                  mode: 0o600,
                });
                renameSync(temporaryManifest, manifestPath);

                const currentRoot = resolve(backupRoot, "current");
                const previousRoot = resolve(backupRoot, "previous");
                rmSync(previousRoot, { recursive: true, force: true });
                let movedCurrent = false;
                if (existsSync(currentRoot)) {
                  renameSync(currentRoot, previousRoot);
                  movedCurrent = true;
                }
                try {
                  renameSync(pendingRoot, currentRoot);
                  if (
                    remoteTarget?.transport === "sandbox" &&
                    remoteTarget.leaseId
                  ) {
                    await recordHarnessBackupStampForCurrentLease({
                      root: currentRoot,
                      manifest,
                      bytes: backupSpanAttributes.bytesTransferred,
                    });
                  }
                } catch (error) {
                  if (existsSync(currentRoot)) {
                    rmSync(currentRoot, { recursive: true, force: true });
                  }
                  if (
                    movedCurrent &&
                    existsSync(previousRoot) &&
                    !existsSync(currentRoot)
                  ) {
                    renameSync(previousRoot, currentRoot);
                  }
                  throw error;
                }
                rmSync(previousRoot, { recursive: true, force: true });
              } finally {
                rmSync(pendingRoot, { recursive: true, force: true });
              }
            },
            {
              attributes: backupSpanAttributes,
            },
          ),
        { parentName: "task.settle" },
      );
    } catch (error) {
      const detail = redactSensitiveText(
        error instanceof Error ? error.message : String(error),
      )
        .replace(/[\r\n]+/g, " ")
        .slice(0, 512);
      await input.onLog?.(
        "stderr",
        `[paperclip-runner] remote checkpoint failed: ${detail || "unknown failure"}\n`,
      );
      throw error;
    }
  };

  const prepareExternalRunnerState =
    remoteTarget && remoteCommandRunner
      ? async () => {
          selectedRemoteMode ??= resolveRemoteRunnerTransportMode({
            target: remoteTarget,
            runnerIngressAuthorized: input.runnerIngressAuthorized === true,
          });
          await ensureRemoteRunner();
        }
      : undefined;
  const archiveExternalRunnerState =
    remoteCommandRunner && remoteStateDirectory && remoteSessionRoot
      ? async (archive: { archiveKey: string }) => {
          if (!/^[0-9a-f]{24}$/.test(archive.archiveKey)) {
            throw new Error("runner_remote_authority_archive_invalid");
          }
          const sourcePath = posix.join(
            remoteStateDirectory,
            "runner-state.json",
          );
          const archiveDirectory = posix.join(
            remoteSessionRoot,
            "authority-epochs",
            `epoch-${archive.archiveKey}`,
          );
          const archivedStatePath = posix.join(
            archiveDirectory,
            "runner-state.json",
          );
          const result = await remoteCommandRunner.execute({
            command: "sh",
            args: [
              "-c",
              'set -eu; if test -L "$2" || { test -e "$2" && test ! -d "$2"; }; then exit 1; fi; if test -f "$1" && test ! -L "$1" && test ! -e "$3" && test ! -L "$3"; then umask 077; install -d -m 0700 "$2"; mv -- "$1" "$3"; elif test ! -e "$1" && test ! -L "$1" && test -f "$3" && test ! -L "$3"; then :; else exit 1; fi; base64 < "$3"',
              "paperclip-runner-authority-archive",
              sourcePath,
              archiveDirectory,
              archivedStatePath,
            ],
            bypassSession: true,
            timeoutMs: 10_000,
          });
          if (result.exitCode !== 0 || result.timedOut) {
            throw new Error("runner_remote_authority_archive_failed");
          }
          try {
            return record(
              JSON.parse(
                Buffer.from(
                  result.stdout.replace(/\s+/g, ""),
                  "base64",
                ).toString("utf8"),
              ),
            );
          } catch {
            throw new Error("runner_remote_authority_archive_failed");
          }
        }
      : undefined;

  const remoteProcessLauncher =
    remoteTarget && remoteCommandRunner && remoteBinary
      ? createRemoteRunnerProcessLauncher({
          target: remoteTarget,
          runner: remoteCommandRunner,
          remoteBinary,
          runnerInstanceId: input.runnerInstanceId,
          ensureArtifact: ensureRemoteRunner,
          onSpawn: input.onSpawn,
          onLog: input.onLog,
          trace: input.trace,
          onRunnerProcessSpawned: () => resolveRemoteRunnerProcessSpawned?.(),
        })
      : undefined;
  const runnerExecution: NativeExecutionInput = remoteTarget
    ? {
        ...input.execution,
        workspace: {
          ...input.execution.workspace,
          cwd: remoteTarget.remoteCwd,
        },
      }
    : input.execution;
  const effectiveRunnerEnvironment: NodeJS.ProcessEnv = remoteRuntimeRoot
    ? {
        ...(input.runnerEnvironment ?? process.env),
        HOME: remoteTarget!.remoteCwd,
        CODEX_HOME: posix.join(remoteTarget!.remoteCwd, ".codex"),
        PAPERCLIP_WORKSPACE_CWD: remoteTarget!.remoteCwd,
      }
    : {
        ...(input.runnerEnvironment ?? process.env),
        PAPERCLIP_WORKSPACE_CWD: input.execution.workspace.cwd,
      };
  const archiveContinuityState = async () => {
    const archiveToken = `${Date.now()}-${randomUUID()}`;
    const archiveRoot = resolve(root, "continuity-breaks", archiveToken);
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    for (const name of [
      "control-plane",
      "runner",
      "codex-home",
      "opencode",
      "acpx",
    ]) {
      const source = resolve(root, name);
      if (existsSync(source)) renameSync(source, resolve(archiveRoot, name));
    }
    if (remoteCommandRunner && remoteSessionRoot) {
      const escapedSource = remoteSessionRoot.replaceAll("'", "'\\''");
      const archivedRemote = `${remoteSessionRoot}.continuity-break-${archiveToken}`;
      const escapedArchive = archivedRemote.replaceAll("'", "'\\''");
      const result = await remoteCommandRunner.execute({
        command: "sh",
        args: [
          "-c",
          `if test -d '${escapedSource}'; then mv '${escapedSource}' '${escapedArchive}'; fi`,
        ],
        bypassSession: true,
        timeoutMs: 30_000,
      });
      if (result.exitCode !== 0 || result.timedOut) {
        throw new Error("runner_continuity_break_archive_failed");
      }
    }
    remotePrepared = false;
  };
  const adoptedProcess =
    target.kind === "local" &&
    input.restartRecovery?.kind === "reattach_existing_runner"
      ? input.restartRecovery.process
      : null;
  const backend = createNativeSessionBackend(runnerExecution, {
    runnerInstanceId: input.runnerInstanceId,
    environment: effectiveRunnerEnvironment,
    workingDirectoryAuthority: remoteTarget
      ? "remote_runner"
      : "local_filesystem",
    onSpawn: input.onSpawn,
    dynamicTools,
    dynamicToolHandler: (call) => authorityEpoch.execute(call),
    acpxDynamicToolHandler: (call) => authorityEpoch.execute(call),
    opencodeRuntimeDirectory: resolve(
      resolvePaperclipInstanceRoot(),
      "runtime",
      "paperclip-runner",
      "opencode",
    ),
    acpxRuntimeDirectory: resolve(
      resolvePaperclipInstanceRoot(),
      "runtime",
      "paperclip-runner",
      "acpx",
    ),
    codexTransportFactory: (recoveryContext) =>
      createRunnerdCodexTransport({
        provider:
          input.execution.provider.kind === "codex"
            ? "codex"
            : input.execution.provider.kind === "opencode"
              ? "opencode"
              : input.execution.provider.kind === "claude_managed"
                ? "claude_managed"
                : input.execution.provider.kind === "aws_agentcore"
                  ? "aws_agentcore"
                  : input.execution.provider.kind === "acpx"
                    ? "acpx"
                    : undefined,
        ...(input.execution.provider.kind === "acpx"
          ? {
              acpxAgent: input.execution.provider.agent,
              acpxPermissionMode: input.execution.provider.permissionMode,
              acpxPermissionModePinned:
                input.execution.schema ===
                "paperclip.native-execution-input.v4",
              acpxRuntimeDirectory: remoteRunnerFilesystemRoot
                ? posix.join(remoteRunnerFilesystemRoot, "acpx")
                : resolve(
                    resolvePaperclipInstanceRoot(),
                    "runtime",
                    "paperclip-runner",
                    "acpx",
                  ),
            }
          : {}),
        ...(input.execution.provider.kind === "opencode"
          ? {
              opencodePermissionMode: input.execution.provider.permissionMode,
            }
          : {}),
        ...(input.execution.provider.kind === "claude_managed"
          ? {
              managedProfile: {
                ...input.execution.provider.managedProfile,
                maxSessionListCostUsd:
                  input.execution.provider.maxSessionListCostUsd,
                model: input.execution.provider.model,
              },
            }
          : {}),
        ...(input.execution.provider.kind === "aws_agentcore"
          ? {
              agentCoreProfile: {
                ...input.execution.provider.agentCoreProfile,
                maxEstimatedSessionCostUsd:
                  input.execution.provider.maxEstimatedSessionCostUsd,
                maxIterations:
                  input.execution.provider.invocationLimits.maxIterations,
                maxOutputTokens:
                  input.execution.provider.invocationLimits.maxOutputTokens,
                timeoutSeconds:
                  input.execution.provider.invocationLimits.timeoutSeconds,
                model: input.execution.provider.model,
              },
            }
          : {}),
        ...(expectedProviderPackManifest && stagedRemoteProviderPackRoot
          ? {
              providerNodeCommand: posix.join(
                stagedRemoteProviderPackRoot,
                expectedProviderPackManifest.payload.artifacts.nodeCommand.path,
              ),
              providerNodeCommandSha256:
                expectedProviderPackManifest.payload.artifacts.nodeCommand
                  .sha256,
              providerPackAuthorityDigest: expectedProviderPackManifest.digest,
              opencodeCommand: posix.join(
                stagedRemoteProviderPackRoot,
                expectedProviderPackManifest.payload.artifacts
                  .opencodeExecutable.path,
              ),
              opencodeCommandSha256:
                expectedProviderPackManifest.payload.artifacts
                  .opencodeExecutable.sha256,
              opencodeProxyPath: posix.join(
                stagedRemoteProviderPackRoot,
                expectedProviderPackManifest.payload.artifacts.opencodeProxy
                  .path,
              ),
              opencodeProxySha256:
                expectedProviderPackManifest.payload.artifacts.opencodeProxy
                  .sha256,
              acpxSidecarPath: posix.join(
                stagedRemoteProviderPackRoot,
                expectedProviderPackManifest.payload.artifacts.acpxSidecar.path,
              ),
              acpxSidecarSha256:
                expectedProviderPackManifest.payload.artifacts.acpxSidecar
                  .sha256,
            }
          : {}),
        stateDirectory: root,
        runnerStateDirectory: remoteStateDirectory,
        readRunnerState:
          remoteStateDirectory && remoteCommandRunner
            ? () =>
                readRemoteRunnerState({
                  runner: remoteCommandRunner,
                  stateDirectory: remoteStateDirectory,
                })
            : undefined,
        prepareExternalRunnerState,
        archiveExternalRunnerState,
        runnerBinary: controllerRunnerBinary,
        codexCommand: remoteCodexBinary ?? undefined,
        sourceCodexHome: remoteTarget
          ? resolveSourceCodexHome(input.runnerEnvironment ?? process.env)
          : undefined,
        runnerProcessLauncher: remoteProcessLauncher,
        runnerReconnectGraceMs: remoteTarget ? 120_000 : undefined,
        adoptExistingRunner: adoptedProcess
          ? {
              ...adoptedProcess,
              isAlive: () => verifiedRecoveryProcessIsAlive(adoptedProcess),
              signal: (signal) =>
                signalVerifiedRecoveryProcess(adoptedProcess, signal),
            }
          : undefined,
        environment: effectiveRunnerEnvironment,
        lifecyclePolicy: input.execution.session.lifecyclePolicy,
        runtimeContext:
          "runtimeContext" in input.execution
            ? input.execution.runtimeContext
            : null,
        runnerRuntimeContext: remoteRuntimeContext,
        runnerFilesystemRoot: remoteRunnerFilesystemRoot ?? undefined,
        opencodeRuntimeDirectory: remoteRunnerFilesystemRoot
          ? posix.join(remoteRunnerFilesystemRoot, "opencode")
          : undefined,
        resumeDynamicTools: dynamicTools,
        resumeCompletionContract: {
          revision: input.execution.completionContract.contract.revision,
          criterionIds:
            input.execution.completionContract.contract.criteria.map(
              (criterion) => criterion.id,
            ),
        },
        resumeActiveTurnId:
          recoveryContext?.persistedSession?.activeTurnId ?? null,
        resumeProviderSession: recoveryContext?.persistedSession,
        providerRecoveryPolicy:
          recoveryContext?.providerRecoveryPolicy ??
          (input.execution.provider.kind === "acpx" &&
          input.execution.interactionResponses.length > 0
            ? "allow_replacement_after_governed_wait"
            : undefined),
        prpIdentity: {
          runnerInstanceId: effectiveRunnerInstanceId,
          environmentLeaseId: effectiveEnvironmentLeaseId,
          runId: input.execution.binding.runId,
          normalizedSessionId:
            input.execution.session.normalizedSessionId ??
            `session-${input.execution.binding.runId}`,
          turnId: `turn-${input.execution.binding.runId}`,
          itemId: `item-${input.execution.binding.runId}`,
        },
        controlPlaneRegistration: (authority) =>
          measureNativeRunnerSpan(
            input.trace,
            "runner.transport.connect",
            async () => {
              if (target.kind === "local") {
                const selectedAtMs = Date.now();
                await input.trace?.record({
                  name: "runner.transport.selected",
                  parentName: "runner.transport.connect",
                  startedAtMs: selectedAtMs,
                  endedAtMs: selectedAtMs,
                  attributes: {
                    mode: "local_loopback",
                    connectionOwner: "runnerd",
                  },
                });
                await input.onLog?.(
                  "stderr",
                  "[paperclip-runner] transport mode=local_loopback state=connecting\n",
                );
                const registration = await measureNativeRunnerSpan(
                  input.trace,
                  "runner.prp.route.register",
                  () =>
                    registerRunnerPrpAuthority({
                      companyId: input.execution.binding.companyId,
                      runId: input.execution.binding.runId,
                      authority,
                    }),
                );
                return {
                  ...registration,
                  startupFailureCode: "runner_local_connect_failed" as const,
                };
              }

              const requiredMode = resolveRemoteRunnerTransportMode({
                target,
                runnerIngressAuthorized: input.runnerIngressAuthorized === true,
              });
              let transport: PaperclipRunnerTransport;
              if (requiredMode === "dial_wss") {
                // Validate eligibility before staging any artifact.
                transport = await measureNativeRunnerSpan(
                  input.trace,
                  "runner.transport.resolve",
                  () =>
                    resolvePaperclipRunnerTransport({
                      target,
                      runId: input.execution.binding.runId,
                      localConnectUrl: "ws://127.0.0.1/unused",
                      runnerPublicUrl: input.runnerPublicUrl,
                      runnerCaBundlePath: input.runnerCaBundlePath,
                      runnerIngressAuthorized:
                        input.runnerIngressAuthorized === true,
                    }),
                );
                if (
                  transport.mode === "direct_outbound" &&
                  transport.caBundlePath &&
                  !existsSync(transport.caBundlePath)
                ) {
                  throw new Error(
                    "runner_direct_wss_failed: configured runner CA bundle is unavailable",
                  );
                }
                await measureNativeRunnerSpan(
                  input.trace,
                  "runner.artifact.prepare",
                  () => prepareRemoteRunner(requiredMode),
                );
              } else {
                await measureNativeRunnerSpan(
                  input.trace,
                  "runner.artifact.prepare",
                  () => prepareRemoteRunner(requiredMode),
                );
                // Provider endpoint acquisition happens only after runnerd is staged
                // and its listener capability has been verified.
                transport = await measureNativeRunnerSpan(
                  input.trace,
                  "runner.ingress.acquire",
                  () =>
                    resolvePaperclipRunnerTransport({
                      target,
                      runId: input.execution.binding.runId,
                      localConnectUrl: "ws://127.0.0.1/unused",
                      runnerPublicUrl: input.runnerPublicUrl,
                      runnerCaBundlePath: input.runnerCaBundlePath,
                      runnerIngressAuthorized: true,
                    }),
                );
              }

              const selectedAtMs = Date.now();
              await input.trace?.record({
                name: "runner.transport.selected",
                parentName: "runner.transport.connect",
                startedAtMs: selectedAtMs,
                endedAtMs: selectedAtMs,
                attributes: {
                  mode: transport.mode,
                  connectionOwner:
                    transport.mode === "provider_ingress"
                      ? "paperclip"
                      : "runnerd",
                },
              });

              await input.onLog?.(
                "stderr",
                `[paperclip-runner] transport mode=${transport.mode} state=connecting\n`,
              );

              if (transport.mode === "direct_outbound") {
                const inbound = await measureNativeRunnerSpan(
                  input.trace,
                  "runner.prp.route.register",
                  () =>
                    registerRunnerPrpAuthority({
                      companyId: input.execution.binding.companyId,
                      runId: input.execution.binding.runId,
                      authority,
                    }),
                  { parentName: "runner.transport.connect" },
                );
                let caBundlePath = transport.caBundlePath;
                if (caBundlePath && remoteBinary) {
                  const remoteCaBundlePath = posix.join(
                    posix.dirname(remoteBinary),
                    "runner-ca-bundle.pem",
                  );
                  remoteCaBundleMapping = {
                    sourcePath: caBundlePath,
                    targetPath: remoteCaBundlePath,
                  };
                  caBundlePath = remoteCaBundlePath;
                }
                return {
                  connection: {
                    mode: "connect" as const,
                    connectUrl: transport.connectUrl,
                    ...(caBundlePath ? { caBundlePath } : {}),
                  },
                  startupFailureCode: "runner_direct_wss_failed" as const,
                  checkpoint: checkpointRemoteRunner,
                  release: () => inbound.release(),
                };
              }

              if (transport.mode !== "provider_ingress") {
                throw new Error("runner_transport_mode_changed_after_dispatch");
              }
              let outbound: ReturnType<typeof connectRunnerPrpIngress> | null =
                null;
              let activation: Promise<void> | null = null;
              return {
                connection: {
                  mode: "listen" as const,
                  listenAddress: transport.listenAddress,
                  listenPort: transport.listenPort,
                  listenPath: transport.listenPath,
                },
                activate: () => {
                  activation = measureNativeRunnerSpan(
                    input.trace,
                    "runner.transport.activation",
                    async () => {
                      await measureNativeRunnerSpan(
                        input.trace,
                        "runner.ingress.wait_for_process",
                        () => remoteRunnerProcessSpawned,
                      );
                      outbound = connectRunnerPrpIngress({
                        authority,
                        endpoint: transport.ingress,
                        onStateChange: (state, failureCode) => {
                          void input.onLog?.(
                            "stderr",
                            `[paperclip-runner] transport mode=provider_ingress state=${state}${failureCode ? ` failure=${failureCode}` : ""}\n`,
                          );
                        },
                      });
                    },
                    { parentName: "runner.session.startup" },
                  );
                },
                ready: async () => {
                  await measureNativeRunnerSpan(
                    input.trace,
                    "runner.transport.ready",
                    async () => {
                      await activation;
                      if (!outbound)
                        throw new Error("runner_ingress_unavailable");
                      await measureNativeRunnerSpan(
                        input.trace,
                        "runner.prp.authenticate",
                        () => outbound!.ready,
                      );
                    },
                    { parentName: "runner.session.startup" },
                  );
                },
                get failure() {
                  return outbound?.failure;
                },
                startupFailureCode: "runner_ingress_unavailable" as const,
                checkpoint: checkpointRemoteRunner,
                release: async () => {
                  if (outbound) await outbound.close();
                  else await transport.ingress.close();
                },
              };
            },
          ),
      }).transport,
  });
  const priorAuthorityEpoch = sessionToolAuthorityEpochs.get(sessionScopeId);
  if (priorAuthorityEpoch && priorAuthorityEpoch !== authorityEpoch) {
    priorAuthorityEpoch.revoke();
  }
  sessionToolAuthorityEpochs.set(sessionScopeId, authorityEpoch);
  return {
    descriptor: () => backend.descriptor(),
    openSession: (sessionInput) => backend.openSession(sessionInput),
    recoverSession: (snapshot, options) =>
      backend.recoverSession
        ? backend.recoverSession(snapshot, options)
        : Promise.resolve({
            recovered: false,
            reason: "driver does not support recovery",
          }),
    openReplacementSession: async (sessionInput) => {
      await measureNativeRunnerSpan(
        input.trace,
        "provider.session.archive_before_replacement",
        archiveContinuityState,
        { parentName: "native.session.execute" },
      );
      return backend.openSession(sessionInput);
    },
  } satisfies NativeSessionBackend;
}
