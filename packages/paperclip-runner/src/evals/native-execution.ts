import { readFile } from "node:fs/promises";

import {
  validatePrpEvent,
  type PrpEvent,
  type PrpTerminalState,
} from "../protocol/replay-contract.js";
import { PAPERCLIP_RUNNER_NATIVE_EXECUTION_SCHEMA } from "./build-metadata.js";

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const TOOL_OUTCOMES = new Set([
  "succeeded",
  "denied",
  "conflict",
  "duplicate",
  "unavailable",
  "failed",
]);

export const paperclipNativeExecutionSchemaUrl = new URL(
  "../../protocol/schemas/native-execution.schema.json",
  import.meta.url,
);
export const paperclipNativeExecutionFixtureUrl = new URL(
  "../../protocol/fixtures/evals/native-execution-seeded.json",
  import.meta.url,
);

export interface NativeExecutionContentRef {
  uri: string;
  sha256: string;
  byteSize: number;
  mediaType: string;
  [key: string]: unknown;
}

export interface PaperclipNativeExecutionV1 {
  schema: typeof PAPERCLIP_RUNNER_NATIVE_EXECUTION_SCHEMA;
  provenance: "seeded" | "replay" | "live";
  identity: {
    runId: string;
    caseId: string;
    configId: string;
    attemptId: string;
    [key: string]: unknown;
  };
  input: {
    caseSha256: string;
    configSha256: string;
    deterministicSeed: string;
    [key: string]: unknown;
  };
  runner: {
    package: { name: string; version: string; [key: string]: unknown };
    binary: { name: string; sha256: string; [key: string]: unknown };
    prpVersion: number;
    nativeExecutionVersion: number;
    catalogVersion: number;
    catalogSha256: string;
    driverContractVersion: number;
    driverKind: string;
    driverVersion: string;
    [key: string]: unknown;
  };
  events: PrpEvent[];
  semanticTools: {
    definitions: Array<Record<string, unknown>>;
    calls: Array<{ callId: string; operationId: string; eventId: string; [key: string]: unknown }>;
    results: Array<{
      callId: string;
      operationId: string;
      eventId: string;
      outcome: string;
      [key: string]: unknown;
    }>;
    denials: Array<{
      callId: string;
      code: string;
      authorizationBoundary: string;
      retryable: boolean;
      [key: string]: unknown;
    }>;
    [key: string]: unknown;
  };
  terminal: PrpTerminalState;
  observations: Record<string, unknown>;
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    requestCount: number;
    durationMs: number;
    cost: { currency: string; amountMicros: number; [key: string]: unknown } | null;
    [key: string]: unknown;
  };
  transcript: NativeExecutionContentRef & {
    complete: boolean;
    eventCount: number;
    omissionReason: string | null;
  };
  artifactRoot: NativeExecutionContentRef;
  artifacts: NativeExecutionContentRef[];
  failure: {
    classification: string;
    code: string;
    message: string;
    [key: string]: unknown;
  } | null;
  [key: string]: unknown;
}

export class PaperclipNativeExecutionError extends Error {
  readonly code = "paperclip_native_execution_invalid" as const;

  constructor(
    message: string,
    readonly path: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "PaperclipNativeExecutionError";
  }
}

function fail(path: string, message: string): never {
  throw new PaperclipNativeExecutionError(message, path);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, "must be an array");
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    fail(path, `must be an integer >= ${minimum}`);
  }
  return value as number;
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "must be a boolean");
  return value;
}

function digest(value: unknown, path: string): string {
  const parsed = text(value, path);
  if (!SHA256_PATTERN.test(parsed)) fail(path, "must use sha256:<64 lowercase hex>");
  return parsed;
}

function contentRef(value: unknown, path: string): NativeExecutionContentRef {
  const ref = record(value, path);
  return {
    ...structuredClone(ref),
    uri: text(ref.uri, `${path}.uri`),
    sha256: digest(ref.sha256, `${path}.sha256`),
    byteSize: integer(ref.byteSize, `${path}.byteSize`),
    mediaType: text(ref.mediaType, `${path}.mediaType`),
  } as NativeExecutionContentRef;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const object = value as Record<string, unknown>;
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function semanticEntry(
  value: unknown,
  path: string,
  fields: readonly string[],
): Record<string, unknown> {
  const entry = record(value, path);
  for (const field of fields) text(entry[field], `${path}.${field}`);
  return structuredClone(entry);
}

/**
 * Validate the App-native attempt bundle while preserving unknown additive
 * fields. Required identities, digests, event bindings, terminal consistency,
 * semantic-tool outcomes, usage, and transcript completeness fail closed.
 */
export function parsePaperclipNativeExecution(
  value: unknown,
): PaperclipNativeExecutionV1 {
  const bundle = record(value, "bundle");
  if (bundle.schema !== PAPERCLIP_RUNNER_NATIVE_EXECUTION_SCHEMA) {
    fail(
      "bundle.schema",
      `unsupported schema ${String(bundle.schema)}; expected ${PAPERCLIP_RUNNER_NATIVE_EXECUTION_SCHEMA}`,
    );
  }
  if (bundle.provenance !== "seeded" && bundle.provenance !== "replay" && bundle.provenance !== "live") {
    fail("bundle.provenance", "must be seeded, replay, or live");
  }

  const identity = record(bundle.identity, "bundle.identity");
  const parsedIdentity = {
    ...structuredClone(identity),
    runId: text(identity.runId, "bundle.identity.runId"),
    caseId: text(identity.caseId, "bundle.identity.caseId"),
    configId: text(identity.configId, "bundle.identity.configId"),
    attemptId: text(identity.attemptId, "bundle.identity.attemptId"),
  };
  const input = record(bundle.input, "bundle.input");
  const parsedInput = {
    ...structuredClone(input),
    caseSha256: digest(input.caseSha256, "bundle.input.caseSha256"),
    configSha256: digest(input.configSha256, "bundle.input.configSha256"),
    deterministicSeed: text(input.deterministicSeed, "bundle.input.deterministicSeed"),
  };

  const runner = record(bundle.runner, "bundle.runner");
  const runnerPackage = record(runner.package, "bundle.runner.package");
  const runnerBinary = record(runner.binary, "bundle.runner.binary");
  const parsedRunner = {
    ...structuredClone(runner),
    package: {
      ...structuredClone(runnerPackage),
      name: text(runnerPackage.name, "bundle.runner.package.name"),
      version: text(runnerPackage.version, "bundle.runner.package.version"),
    },
    binary: {
      ...structuredClone(runnerBinary),
      name: text(runnerBinary.name, "bundle.runner.binary.name"),
      sha256: digest(runnerBinary.sha256, "bundle.runner.binary.sha256"),
    },
    prpVersion: integer(runner.prpVersion, "bundle.runner.prpVersion", 1),
    nativeExecutionVersion: integer(
      runner.nativeExecutionVersion,
      "bundle.runner.nativeExecutionVersion",
      1,
    ),
    catalogVersion: integer(runner.catalogVersion, "bundle.runner.catalogVersion", 1),
    catalogSha256: digest(runner.catalogSha256, "bundle.runner.catalogSha256"),
    driverContractVersion: integer(
      runner.driverContractVersion,
      "bundle.runner.driverContractVersion",
      1,
    ),
    driverKind: text(runner.driverKind, "bundle.runner.driverKind"),
    driverVersion: text(runner.driverVersion, "bundle.runner.driverVersion"),
  };

  const sourceCursors = new Map<string, number>();
  const sourceEventIds = new Set<string>();
  const events = array(bundle.events, "bundle.events").map((event, index) => {
    const validation = validatePrpEvent(event);
    if (!validation.ok) {
      fail(
        `bundle.events[${index}]${validation.issues[0]?.path ?? ""}`,
        validation.issues[0]?.message ?? "invalid PRP event",
      );
    }
    if (validation.event.runId !== parsedIdentity.runId) {
      fail(`bundle.events[${index}].runId`, "must match bundle.identity.runId");
    }
    if (sourceEventIds.has(validation.event.sourceEventId)) {
      fail(`bundle.events[${index}].sourceEventId`, "must be unique within the bundle");
    }
    sourceEventIds.add(validation.event.sourceEventId);
    const previousSourceSeq = sourceCursors.get(validation.event.sourceInstanceId) ?? 0;
    if (validation.event.sourceSeq <= previousSourceSeq) {
      fail(
        `bundle.events[${index}].sourceSeq`,
        `must be ordered after ${previousSourceSeq} for source ${validation.event.sourceInstanceId}`,
      );
    }
    sourceCursors.set(validation.event.sourceInstanceId, validation.event.sourceSeq);
    return structuredClone(validation.event);
  });
  if (events.length === 0) fail("bundle.events", "must contain native events");

  const terminal = record(bundle.terminal, "bundle.terminal") as unknown as PrpTerminalState;
  if (terminal.schema !== "paperclip.prp.terminal.v1") {
    fail("bundle.terminal.schema", "must be paperclip.prp.terminal.v1");
  }
  const terminalEvents = events.filter((event) => event.eventType === "run.terminal");
  if (terminalEvents.length !== 1) {
    fail("bundle.events", "must contain exactly one run.terminal event");
  }
  if (canonicalJson(terminalEvents[0]?.payload) !== canonicalJson(terminal)) {
    fail("bundle.terminal", "must equal the run.terminal event payload");
  }

  const semanticTools = record(bundle.semanticTools, "bundle.semanticTools");
  const definitions = array(semanticTools.definitions, "bundle.semanticTools.definitions")
    .map((entry, index) => semanticEntry(entry, `bundle.semanticTools.definitions[${index}]`, ["operationId"]));
  const calls = array(semanticTools.calls, "bundle.semanticTools.calls").map((entry, index) => {
    const parsed = semanticEntry(entry, `bundle.semanticTools.calls[${index}]`, [
      "callId",
      "operationId",
      "eventId",
    ]);
    return parsed as PaperclipNativeExecutionV1["semanticTools"]["calls"][number];
  });
  const results = array(semanticTools.results, "bundle.semanticTools.results").map((entry, index) => {
    const path = `bundle.semanticTools.results[${index}]`;
    const parsed = semanticEntry(entry, path, ["callId", "operationId", "eventId", "outcome"]);
    if (!TOOL_OUTCOMES.has(parsed.outcome as string)) fail(`${path}.outcome`, "is unsupported");
    return parsed as PaperclipNativeExecutionV1["semanticTools"]["results"][number];
  });
  const denials = array(semanticTools.denials, "bundle.semanticTools.denials").map((entry, index) => {
    const path = `bundle.semanticTools.denials[${index}]`;
    const parsed = semanticEntry(entry, path, ["callId", "code", "authorizationBoundary"]);
    parsed.retryable = boolean(parsed.retryable, `${path}.retryable`);
    return parsed as PaperclipNativeExecutionV1["semanticTools"]["denials"][number];
  });
  const callById = new Map(calls.map((call) => [call.callId, call]));
  if (callById.size !== calls.length) {
    fail("bundle.semanticTools.calls", "callId values must be unique");
  }
  const resultByCallId = new Map(results.map((result) => [result.callId, result]));
  if (resultByCallId.size !== results.length) {
    fail("bundle.semanticTools.results", "callId values must be unique");
  }
  const eventById = new Map(events.map((event) => [event.sourceEventId, event]));
  const referencedCallEventIds = new Set<string>();
  for (const call of calls) {
    const event = eventById.get(call.eventId);
    if (event?.eventType !== "mcp_app.tool_input") {
      fail("bundle.semanticTools.calls", `call ${call.callId} does not reference a tool-input event`);
    }
    const envelope = semanticToolEnvelope(event, "input", `event ${call.eventId}`);
    if (envelope.callId !== call.callId || envelope.operationId !== call.operationId) {
      fail(
        "bundle.semanticTools.calls",
        `call ${call.callId} does not match semantic envelope ${String(envelope.callId)}/${String(envelope.operationId)}`,
      );
    }
    if (referencedCallEventIds.has(call.eventId)) {
      fail("bundle.semanticTools.calls", `event ${call.eventId} is referenced more than once`);
    }
    referencedCallEventIds.add(call.eventId);
  }
  const referencedResultEventIds = new Set<string>();
  for (const result of results) {
    const call = callById.get(result.callId);
    if (call === undefined || call.operationId !== result.operationId) {
      fail(
        "bundle.semanticTools.results",
        `result ${result.callId} has no matching call with operation ${result.operationId}`,
      );
    }
    const event = eventById.get(result.eventId);
    if (event?.eventType !== "mcp_app.tool_result") {
      fail("bundle.semanticTools.results", `result ${result.callId} does not reference a tool-result event`);
    }
    const envelope = semanticToolEnvelope(event, "result", `event ${result.eventId}`);
    if (
      envelope.callId !== result.callId
      || envelope.operationId !== result.operationId
      || envelope.outcome !== result.outcome
    ) {
      fail(
        "bundle.semanticTools.results",
        `result ${result.callId} does not match semantic envelope ${String(envelope.callId)}/${String(envelope.operationId)}/${String(envelope.outcome)}`,
      );
    }
    if (referencedResultEventIds.has(result.eventId)) {
      fail("bundle.semanticTools.results", `event ${result.eventId} is referenced more than once`);
    }
    referencedResultEventIds.add(result.eventId);
    if (result.outcome === "denied" && !denials.some((denial) => denial.callId === result.callId)) {
      fail("bundle.semanticTools.denials", `denied result ${result.callId} needs a denial receipt`);
    }
  }
  for (const event of events) {
    if (event.eventType === "mcp_app.tool_input" && !referencedCallEventIds.has(event.sourceEventId)) {
      fail("bundle.semanticTools.calls", `tool-input event ${event.sourceEventId} is not indexed`);
    }
    if (event.eventType === "mcp_app.tool_result" && !referencedResultEventIds.has(event.sourceEventId)) {
      fail("bundle.semanticTools.results", `tool-result event ${event.sourceEventId} is not indexed`);
    }
  }
  const denialCallIds = new Set<string>();
  for (const denial of denials) {
    if (denialCallIds.has(denial.callId)) {
      fail("bundle.semanticTools.denials", `call ${denial.callId} has duplicate denial receipts`);
    }
    denialCallIds.add(denial.callId);
    const result = resultByCallId.get(denial.callId);
    if (result?.outcome !== "denied") {
      fail("bundle.semanticTools.denials", `denial ${denial.callId} has no denied result`);
    }
    const resultEvent = eventById.get(result.eventId)!;
    const envelope = semanticToolEnvelope(
      resultEvent,
      "result",
      `event ${result.eventId}`,
    );
    if (
      envelope.code !== denial.code
      || envelope.authorizationBoundary !== denial.authorizationBoundary
      || envelope.retryable !== denial.retryable
    ) {
      fail(
        "bundle.semanticTools.denials",
        `denial ${denial.callId} does not match its semantic result receipt`,
      );
    }
  }

  const usage = record(bundle.usage, "bundle.usage");
  const inputTokens = integer(usage.inputTokens, "bundle.usage.inputTokens");
  const outputTokens = integer(usage.outputTokens, "bundle.usage.outputTokens");
  const totalTokens = integer(usage.totalTokens, "bundle.usage.totalTokens");
  if (totalTokens !== inputTokens + outputTokens) {
    fail("bundle.usage.totalTokens", "must equal inputTokens + outputTokens");
  }
  const costRecord = usage.cost === null ? null : record(usage.cost, "bundle.usage.cost");
  const parsedUsage = {
    ...structuredClone(usage),
    inputTokens,
    outputTokens,
    totalTokens,
    requestCount: integer(usage.requestCount, "bundle.usage.requestCount"),
    durationMs: integer(usage.durationMs, "bundle.usage.durationMs"),
    cost: costRecord === null
      ? null
      : {
          ...structuredClone(costRecord),
          currency: text(costRecord.currency, "bundle.usage.cost.currency"),
          amountMicros: integer(costRecord.amountMicros, "bundle.usage.cost.amountMicros"),
        },
  };

  const transcriptRecord = record(bundle.transcript, "bundle.transcript");
  const transcript = {
    ...contentRef(transcriptRecord, "bundle.transcript"),
    complete: boolean(transcriptRecord.complete, "bundle.transcript.complete"),
    eventCount: integer(transcriptRecord.eventCount, "bundle.transcript.eventCount"),
    omissionReason: transcriptRecord.omissionReason === null
      ? null
      : text(transcriptRecord.omissionReason, "bundle.transcript.omissionReason"),
  };
  if (transcript.complete && transcript.eventCount !== events.length) {
    fail("bundle.transcript.eventCount", "must equal events.length for a complete transcript");
  }
  if (!transcript.complete && transcript.omissionReason === null) {
    fail("bundle.transcript.omissionReason", "is required when the transcript is incomplete");
  }

  const observations = structuredClone(record(bundle.observations, "bundle.observations"));
  const artifactRoot = contentRef(bundle.artifactRoot, "bundle.artifactRoot");
  const artifacts = array(bundle.artifacts, "bundle.artifacts")
    .map((entry, index) => contentRef(entry, `bundle.artifacts[${index}]`));
  const failure = bundle.failure === null
    ? null
    : (() => {
        const parsed = record(bundle.failure, "bundle.failure");
        return {
          ...structuredClone(parsed),
          classification: text(parsed.classification, "bundle.failure.classification"),
          code: text(parsed.code, "bundle.failure.code"),
          message: text(parsed.message, "bundle.failure.message"),
        };
      })();

  return {
    ...structuredClone(bundle),
    schema: PAPERCLIP_RUNNER_NATIVE_EXECUTION_SCHEMA,
    provenance: bundle.provenance,
    identity: parsedIdentity,
    input: parsedInput,
    runner: parsedRunner,
    events,
    semanticTools: { ...structuredClone(semanticTools), definitions, calls, results, denials },
    terminal: structuredClone(terminal),
    observations,
    usage: parsedUsage,
    transcript,
    artifactRoot,
    artifacts,
    failure,
  } as PaperclipNativeExecutionV1;
}

function semanticToolEnvelope(
  event: PrpEvent,
  phase: "input" | "result",
  path: string,
): Record<string, unknown> {
  const payload = record(event.payload, `${path}.payload`);
  const envelope = record(payload.semantic_tool, `${path}.payload.semantic_tool`);
  if (
    envelope.schema !== "paperclip.prp.semantic_tool.v1"
    || envelope.schemaVersion !== 1
    || envelope.phase !== phase
  ) {
    fail(
      `${path}.payload.semantic_tool`,
      `must be a paperclip.prp.semantic_tool.v1 ${phase} envelope`,
    );
  }
  const correlation = record(envelope.correlation, `${path}.payload.semantic_tool.correlation`);
  for (const [field, eventValue] of [
    ["runId", event.runId],
    ["normalizedSessionId", event.normalizedSessionId],
    ["turnId", event.turnId],
    ["itemId", event.itemId],
  ] as const) {
    if (correlation[field] !== eventValue) {
      fail(
        `${path}.payload.semantic_tool.correlation.${field}`,
        `must match the enclosing event ${field}`,
      );
    }
  }
  return envelope;
}

export async function loadPaperclipNativeExecutionFixture(
  url: URL = paperclipNativeExecutionFixtureUrl,
): Promise<PaperclipNativeExecutionV1> {
  const value = JSON.parse(await readFile(url, "utf8")) as unknown;
  return parsePaperclipNativeExecution(value);
}
