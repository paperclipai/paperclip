import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import type {
  AdapterExecutionResult,
  AdapterRuntimeEvent,
} from "../../adapters/index.js";
import type { NativeFinalizationResult } from "@paperclipai/shared";
import type {
  HarnessRuntimeRequestResolution,
  NativeExecutionInput,
  NativeSession,
  NativeSessionBackend,
  PaperclipQuestionSet,
  PersistedNativeSession,
  PrpEvent,
  PrpStructuredRunResult,
} from "../../vendor/paperclip-runner/index.js";
import {
  createNativeSessionBackend,
  createRunnerdCodexTransport,
  executeNativeSession,
  parsePaperclipQuestionSet,
} from "../../vendor/paperclip-runner/index.js";
import type { Db } from "@paperclipai/db";
import { and, desc, eq, gt, inArray, or, sql } from "drizzle-orm";
import {
  documentRevisions,
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
import { resolvePaperclipRunnerBinary } from "./native-codex-runner.js";
import {
  createNativeRunTrace,
  type NativeRunHistoricalSpan,
  type NativeRunSpanScope,
  type NativeRunTrace,
} from "./native-run-trace.js";

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
const NATIVE_DURABLE_IDENTITY_MAX_BYTES = 2 * 1024 * 1024;
const NATIVE_WARM_CHECKPOINT_MAX_BYTES = 8 * 1024 * 1024;
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
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
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
 * authoritative and may intentionally override the host defaults.
 */
export function buildNativeProviderEnvironment(
  configured: NodeJS.ProcessEnv,
  host: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const inherited = Object.fromEntries(
    NATIVE_PROVIDER_HOST_ENV_KEYS.flatMap((key) => {
      const value = host[key];
      return typeof value === "string" && value.length > 0
        ? [[key, value]]
        : [];
    }),
  );
  return { ...inherited, ...configured };
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

function nativeSessionKey(execution: NativeExecutionInput): string {
  return (
    execution.session.normalizedSessionId ??
    `session-${execution.binding.runId}`
  );
}

function nativeSessionScopeKey(execution: NativeExecutionInput): string {
  return JSON.stringify([
    execution.binding.companyId,
    nativeSessionKey(execution),
  ]);
}

function runnerdStateBase(): string {
  return process.env.PAPERCLIP_RUNNER_STATE_DIR ?? resolve(
    resolvePaperclipInstanceRoot(),
    "runtime",
    "paperclip-runner",
    "durable-sessions",
  );
}

function scopedRunnerdStateRoot(execution: NativeExecutionInput): string {
  return resolve(
    runnerdStateBase(),
    createHash("sha256")
      .update(nativeSessionScopeKey(execution))
      .digest("hex"),
  );
}

function legacyRunnerdStateRoot(execution: NativeExecutionInput): string {
  return resolve(
    runnerdStateBase(),
    createHash("sha256").update(nativeSessionKey(execution)).digest("hex"),
  );
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
  const statePath = resolve(root, "control-plane", "mock-core-state.json");
  if (!existsSync(statePath)) return null;
  try {
    return record(
      record(
        JSON.parse(
          readBoundedNativeFile(
            statePath,
            NATIVE_DURABLE_IDENTITY_MAX_BYTES,
            "runner_durable_identity_too_large",
          ).toString("utf8"),
        ),
      ).identity,
    );
  } catch {
    return null;
  }
}

function durableIdentityMatchesExecution(
  identity: Record<string, unknown> | null,
  execution: NativeExecutionInput,
): identity is RunnerdDurableIdentity {
  return Boolean(
    identity &&
      identity.runId === execution.binding.runId &&
      identity.normalizedSessionId === nativeSessionKey(execution) &&
      typeof identity.runnerInstanceId === "string" &&
      identity.runnerInstanceId.length > 0 &&
      typeof identity.environmentLeaseId === "string" &&
      identity.environmentLeaseId.length > 0,
  );
}

/**
 * Pre-company-scope state is reused only when its durable identity is bound to
 * this exact run and normalized session. Run ids are globally unique database
 * keys, so another company cannot claim a legacy directory by choosing the
 * same display/session id. New sessions always use the company-scoped root.
 */
function runnerdStateRoot(execution: NativeExecutionInput): string {
  const scoped = scopedRunnerdStateRoot(execution);
  if (existsSync(scoped)) {
    if (!isSafeNativeStateDirectory(scoped)) {
      throw new Error("runner_state_directory_unsafe");
    }
    return scoped;
  }
  const legacy = legacyRunnerdStateRoot(execution);
  return durableIdentityMatchesExecution(
    readRunnerdDurableIdentity(legacy),
    execution,
  )
    ? legacy
    : scoped;
}

function loadRunnerdDurableBinding(execution: NativeExecutionInput): {
  runnerInstanceId: string;
  environmentLeaseId: string;
} | null {
  const identity = readRunnerdDurableIdentity(runnerdStateRoot(execution));
  if (!durableIdentityMatchesExecution(identity, execution)) return null;
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
  const path = existsSync(scopedPath)
    ? scopedPath
    : legacyNativeSessionCheckpointPath(execution);
  if (!existsSync(path)) return null;
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
  return {
    ...envelope.snapshot,
    identity: {
      runId: execution.binding.runId,
      sessionId: nativeSessionKey(execution),
      companyId: execution.binding.companyId,
      issueId: execution.binding.issueId,
      agentId: execution.binding.agentId,
    },
    semanticResult: null,
    terminal: null,
    activeTurnId: null,
    terminalTurns: [],
    pendingRuntimeRequests: [],
  };
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
  const permanentFailure = sourceFailureCode === "native_event_replay_conflict";
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
        .where(
          and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)),
        )
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
            eq(
              nativeRunFinalizations.companyId,
              cancellationContext.companyId,
            ),
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
        priorCoordinatorDecisionId:
          cancellationContext.coordinatorDecisionId,
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
            eq(
              nativeRunFinalizations.companyId,
              cancellationContext.companyId,
            ),
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
            nextAction:
              "Accept a replacement native turn on the existing run.",
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
  leaseTtlMs?: number;
}): Promise<void> {
  const leaseTtlMs =
    input.leaseTtlMs ?? NATIVE_SESSION_EXECUTION_LEASE_TTL_MS;
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
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  /** Test seam at the provider boundary; production always uses the package Codex backend. */
  backend?: NativeSessionBackend;
  useRunnerd?: boolean;
  onLog?: (stream: "stdout" | "stderr", chunk: string) => Promise<void>;
  onEvent?: (event: AdapterRuntimeEvent) => Promise<void>;
  preparationSpans?: NativeRunHistoricalSpan[];
  /** Resolved adapter env; the runner transport applies a provider allowlist before spawn. */
  runnerEnvironment?: NodeJS.ProcessEnv;
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
  if (input.execution.provider.kind !== "codex") {
    throw new Error("paperclip_runner_provider_unsupported");
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
          const claimed = await tx
            .update(nativeRunFinalizations)
            .set({
              phase: "observed",
              attempt: coordinator.attempt + 1,
              leaseOwner,
              leaseExpiresAt,
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
          return coordinator.attempt + 1;
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
        existingWarmSession = entry.session;
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
  const runnerExecution = input.execution;
  const leaseRenewal = startNativeSessionExecutionLeaseRenewal({
    db: input.db,
    runId: input.execution.binding.runId,
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    leaseOwner,
    attempt,
  });
  try {
    const runnerdBackend =
      input.useRunnerd && input.backend === undefined
        ? await createRunnerdBackend({
            ...input,
            execution: runnerExecution,
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
    await input.db.transaction(async (tx) => {
      const updated = await tx
        .update(nativeRunFinalizations)
        .set({
          phase,
          leaseOwner: null,
          leaseExpiresAt: null,
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
          updatedAt: now,
        })
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
            eq(nativeRunFinalizations.leaseOwner, leaseOwner),
            eq(nativeRunFinalizations.attempt, attempt),
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
      updatedAt: releaseNow,
    })
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
        eq(nativeRunFinalizations.leaseOwner, leaseOwner),
        eq(nativeRunFinalizations.attempt, attempt),
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

export async function createRunnerdBackend(input: {
  db: Db;
  execution: NativeExecutionInput;
  runnerInstanceId: string;
  durableEnvironmentLeaseId?: string;
  onSpawn?: (meta: {
    pid: number;
    processGroupId: number | null;
    startedAt: string;
  }) => Promise<void>;
  runnerEnvironment?: NodeJS.ProcessEnv;
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
  if (input.execution.provider.kind !== "codex") {
    throw new Error("paperclip_runner_provider_unsupported");
  }
  const authority = new PaperclipRunnerToolAuthority(input.db, {
    companyId: input.execution.binding.companyId,
    issueId: input.execution.binding.issueId,
    runId: input.execution.binding.runId,
    agentId: input.execution.binding.agentId,
    normalizedSessionId: nativeSessionKey(input.execution),
    workMode: input.execution.task.workMode,
    enqueueWakeup: input.enqueueWakeup,
  });
  const dynamicTools = await authority.definitions();
  const root = runnerdStateRoot(input.execution);
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const environment = input.runnerEnvironment ?? process.env;

  const archiveContinuityState = async () => {
    const archiveRoot = resolve(
      root,
      "continuity-breaks",
      `${Date.now()}-${randomUUID()}`,
    );
    mkdirSync(archiveRoot, { recursive: true, mode: 0o700 });
    for (const name of ["control-plane", "runner", "codex-home"]) {
      const source = resolve(root, name);
      if (existsSync(source)) renameSync(source, resolve(archiveRoot, name));
    }
  };

  const backend = createNativeSessionBackend(input.execution, {
    runnerInstanceId: input.runnerInstanceId,
    onSpawn: input.onSpawn,
    dynamicTools,
    dynamicToolHandler: (call) => authority.execute(call),
    codexTransportFactory: (recoveryContext) =>
      createRunnerdCodexTransport({
        runnerBinary: resolvePaperclipRunnerBinary(),
        stateDirectory: root,
        environment,
        lifecyclePolicy: input.execution.session.lifecyclePolicy,
        runtimeContext:
          "runtimeContext" in input.execution
            ? input.execution.runtimeContext
            : null,
        resumeDynamicTools: dynamicTools,
        providerRecoveryPolicy: recoveryContext?.providerRecoveryPolicy,
        prpIdentity: {
          runnerInstanceId: input.runnerInstanceId,
          environmentLeaseId:
            input.durableEnvironmentLeaseId ??
            input.execution.binding.executionWorkspaceId,
          runId: input.execution.binding.runId,
          normalizedSessionId: nativeSessionKey(input.execution),
          turnId: `turn-${input.execution.binding.runId}`,
          itemId: `item-${input.execution.binding.runId}`,
        },
        controlPlaneRegistration: async (controlPlaneAuthority) => {
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
                authority: controlPlaneAuthority,
              }),
            { parentName: "runner.transport.connect" },
          );
          return {
            ...registration,
            startupFailureCode: "runner_local_connect_failed" as const,
          };
        },
      }).transport,
  });

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
