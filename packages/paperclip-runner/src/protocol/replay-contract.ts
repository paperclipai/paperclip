import type { ErrorObject, ValidateFunction } from "ajv/dist/2020.js";
import type { FromSchema } from "json-schema-to-ts";

import {
  capabilitiesSchema,
  commandSchema,
  eventSchema,
  identitySchema,
  questionSetSchema,
  requestSchema,
  resultSchema,
  semanticToolSchema,
  stopReasonSchema,
  terminalSchema,
} from "./generated/schema-bundle.js";
import {
  eventValidator as standaloneEventValidator,
  fixtureValidator as standaloneFixtureValidator,
  resultValidator as standaloneResultValidator,
} from "./generated/standalone-validators.js";
import { normalizeLegacyPrpStructuredRunResult } from "./result-normalization.js";

export const PRP_PROTOCOL_NAME = "paperclip.runner";
export const PRP_PROTOCOL_VERSION = 1;
export const PRP_FIXTURE_SCHEMA = "paperclip.prp.fixture.v1";

type TerminalReferences = [typeof stopReasonSchema];
type EventReferences = [
  typeof semanticToolSchema,
  typeof stopReasonSchema,
  typeof terminalSchema,
  typeof resultSchema,
];
export type PrpIdentity = FromSchema<typeof identitySchema>;
export type PrpCapabilities = FromSchema<typeof capabilitiesSchema>;
export type PrpCommand = FromSchema<typeof commandSchema>;
export type PrpSemanticToolEnvelope = FromSchema<typeof semanticToolSchema>;
export type PrpStopReason = FromSchema<typeof stopReasonSchema>;
export type PrpTerminalState = FromSchema<
  typeof terminalSchema,
  { references: TerminalReferences }
>;
type RequestReferences = [typeof questionSetSchema];
export type PrpRequest = FromSchema<typeof requestSchema, { references: RequestReferences }>;
export type PrpStructuredRunResult = FromSchema<typeof resultSchema>;
export type PrpEvent = FromSchema<
  typeof eventSchema,
  { references: EventReferences }
>;
/** Runtime-validated composition of the JSON-Schema-derived contract types. */
export interface PrpFixture {
  schema: typeof PRP_FIXTURE_SCHEMA;
  fixtureVersion: 1;
  protocolVersion: typeof PRP_PROTOCOL_VERSION;
  name: string;
  description: string;
  identity: PrpIdentity;
  capabilities: PrpCapabilities;
  commands: PrpCommand[];
  events: PrpEvent[];
  requests?: PrpRequest[];
  result: PrpStructuredRunResult;
  [key: string]: unknown;
}

export type ProtocolValidationIssueCode =
  | "invalid_json"
  | "schema_validation"
  | "unsupported_required_version"
  | "binding_mismatch";

export interface ProtocolValidationIssue {
  code: ProtocolValidationIssueCode;
  path: string;
  message: string;
}

export type ProtocolValidationResult =
  | { ok: true; fixture: PrpFixture; issues: [] }
  | { ok: false; fixture: null; issues: ProtocolValidationIssue[] };

export interface ProtocolVersionRange {
  min: number;
  max: number;
}

// The validators are generated from the same checked-in schemas as the types.
// Keeping compilation out of the runtime lets strict CSP deployments retain
// `script-src 'self'` without AJV attempting dynamic JavaScript evaluation.
const fixtureValidator = standaloneFixtureValidator as ValidateFunction<PrpFixture>;
const eventValidator = standaloneEventValidator as ValidateFunction<PrpEvent>;
const resultValidator = standaloneResultValidator as ValidateFunction<PrpStructuredRunResult>;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const object = asRecord(value);
  if (object !== null) {
    return `{${Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "undefined";
}

function versionIssues(value: unknown): ProtocolValidationIssue[] {
  const fixture = asRecord(value);
  if (fixture === null) {
    return [];
  }

  const issues: ProtocolValidationIssue[] = [];
  for (const [field, supported] of [
    ["fixtureVersion", 1],
    ["protocolVersion", PRP_PROTOCOL_VERSION],
  ] as const) {
    const actual = fixture[field];
    if (typeof actual === "number" && actual !== supported) {
      issues.push({
        code: "unsupported_required_version",
        path: `/${field}`,
        message: `${field} ${actual} is unsupported; this implementation requires ${supported}`,
      });
    }
  }

  if (Array.isArray(fixture.events)) {
    fixture.events.forEach((entry, index) => {
      const event = asRecord(entry);
      const actual = event?.schemaVersion;
      if (typeof actual === "number" && actual !== 1) {
        issues.push({
          code: "unsupported_required_version",
          path: `/events/${index}/schemaVersion`,
          message: `event schemaVersion ${actual} is unsupported; this implementation requires 1`,
        });
      }
      const payload = asRecord(event?.payload);
      const semanticTool = asRecord(payload?.semantic_tool);
      const semanticToolVersion = semanticTool?.schemaVersion;
      if (typeof semanticToolVersion === "number" && semanticToolVersion !== 1) {
        issues.push({
          code: "unsupported_required_version",
          path: `/events/${index}/payload/semantic_tool/schemaVersion`,
          message: `semantic_tool schemaVersion ${semanticToolVersion} is unsupported; this implementation requires 1`,
        });
      }
      const stopReason = asRecord(payload?.stopReason);
      const stopReasonVersion = stopReason?.schemaVersion;
      if (typeof stopReasonVersion === "number" && stopReasonVersion !== 1) {
        issues.push({
          code: "unsupported_required_version",
          path: `/events/${index}/payload/stopReason/schemaVersion`,
          message: `stopReason schemaVersion ${stopReasonVersion} is unsupported; this implementation requires 1`,
        });
      }
    });
  }
  const capabilities = asRecord(fixture.capabilities);
  const semanticTools = asRecord(capabilities?.semanticTools);
  const semanticToolsVersion = semanticTools?.schemaVersion;
  if (typeof semanticToolsVersion === "number" && semanticToolsVersion !== 1) {
    issues.push({
      code: "unsupported_required_version",
      path: "/capabilities/semanticTools/schemaVersion",
      message: `semanticTools schemaVersion ${semanticToolsVersion} is unsupported; this implementation requires 1`,
    });
  }
  return issues;
}

function ajvIssue(error: ErrorObject): ProtocolValidationIssue {
  return {
    code: "schema_validation",
    path: error.instancePath || "/",
    message: error.message ?? "does not match the PRP schema",
  };
}

interface SemanticCallBinding {
  envelope: PrpSemanticToolEnvelope;
  index: number;
}

function bindingIssues(fixture: PrpFixture): ProtocolValidationIssue[] {
  const issues: ProtocolValidationIssue[] = [];
  const uniqueEvents = new Map<string, PrpEvent>();
  const semanticCalls = new Map<
    string,
    {
      input?: SemanticCallBinding;
      result?: SemanticCallBinding;
      reconciled?: SemanticCallBinding;
    }
  >();
  fixture.events.forEach((event, index) => {
    if (event.runId !== fixture.identity.runId) {
      issues.push({
        code: "binding_mismatch",
        path: `/events/${index}/runId`,
        message: "event runId must match identity.runId",
      });
    }
    if (
      event.normalizedSessionId !== undefined &&
      event.normalizedSessionId !== fixture.identity.normalizedSessionId
    ) {
      issues.push({
        code: "binding_mismatch",
        path: `/events/${index}/normalizedSessionId`,
        message: "event normalizedSessionId must match identity.normalizedSessionId",
      });
    }
    const existing = uniqueEvents.get(event.sourceEventId);
    if (existing === undefined) {
      uniqueEvents.set(event.sourceEventId, event);
    } else {
      if (canonicalJson(existing) !== canonicalJson(event)) {
        issues.push({
          code: "binding_mismatch",
          path: `/events/${index}/sourceEventId`,
          message: "duplicate sourceEventId deliveries must be byte-equivalent",
        });
      }
      // At-least-once source delivery is not a second semantic invocation.
      return;
    }
    const payload = asRecord(event.payload);
    const semanticTool = asRecord(payload?.semantic_tool) as PrpSemanticToolEnvelope | null;
    if (semanticTool !== null) {
      const correlation = asRecord(semanticTool.correlation);
      for (const [field, actual, expected] of [
        ["runId", correlation?.runId, event.runId],
        ["normalizedSessionId", correlation?.normalizedSessionId, event.normalizedSessionId],
        ["turnId", correlation?.turnId, event.turnId],
        ["itemId", correlation?.itemId, event.itemId],
      ] as const) {
        if (actual !== expected) {
          issues.push({
            code: "binding_mismatch",
            path: `/events/${index}/payload/semantic_tool/correlation/${field}`,
            message: `semantic_tool correlation ${field} must match the containing event`,
          });
        }
      }
      const call = semanticCalls.get(semanticTool.callId) ?? {};
      const phase = semanticTool.phase;
      if (call[phase] !== undefined) {
        issues.push({
          code: "binding_mismatch",
          path: `/events/${index}/payload/semantic_tool/callId`,
          message: `semantic_tool call ${semanticTool.callId} must contain exactly one ${phase} envelope`,
        });
      } else {
        call[phase] = {
          envelope: semanticTool,
          index,
        };
        semanticCalls.set(semanticTool.callId, call);
      }
    }
  });

  for (const [callId, call] of semanticCalls) {
    const terminalPhaseCount =
      Number(call.result !== undefined) + Number(call.reconciled !== undefined);
    if (call.input === undefined || terminalPhaseCount !== 1) {
      const present = call.input ?? call.result ?? call.reconciled;
      issues.push({
        code: "binding_mismatch",
        path: `/events/${present?.index ?? 0}/payload/semantic_tool/callId`,
        message: `semantic_tool call ${callId} must contain one input and exactly one result or reconciled envelope`,
      });
      continue;
    }
    if (call.result !== undefined) {
      for (const field of [
        "operationId",
        "idempotencyKey",
        "correlation",
      ] as const) {
        if (
          canonicalJson(call.input.envelope[field]) !==
          canonicalJson(call.result.envelope[field])
        ) {
          issues.push({
            code: "binding_mismatch",
            path: `/events/${call.result.index}/payload/semantic_tool/${field}`,
            message: `semantic_tool result ${field} must match its input envelope`,
          });
        }
      }
    }
    if (call.reconciled !== undefined) {
      // A replacement runner may reconcile a call after recovering the run.
      // The authenticated ingestion boundary owns runner authorization, while
      // replay keeps each event's sourceInstanceId as immutable provenance.
      for (const field of ["operationId", "idempotencyKey"] as const) {
        if (
          canonicalJson(call.input.envelope[field]) !==
          canonicalJson(call.reconciled.envelope[field])
        ) {
          issues.push({
            code: "binding_mismatch",
            path: `/events/${call.reconciled.index}/payload/semantic_tool/${field}`,
            message: `semantic_tool reconciled ${field} must match its input envelope`,
          });
        }
      }
      for (const field of [
        "runId",
        "normalizedSessionId",
        "turnId",
        "itemId",
      ] as const) {
        if (
          call.input.envelope.correlation[field] !==
          call.reconciled.envelope.correlation[field]
        ) {
          issues.push({
            code: "binding_mismatch",
            path: `/events/${call.reconciled.index}/payload/semantic_tool/correlation/${field}`,
            message: `semantic_tool reconciled correlation ${field} must match its input envelope`,
          });
        }
      }
    }
  }

  fixture.commands.forEach((command, index) => {
    if (command.controllerSeq !== index + 1) {
      issues.push({
        code: "binding_mismatch",
        path: `/commands/${index}/controllerSeq`,
        message: `controllerSeq must be ${index + 1} in a scripted fixture`,
      });
    }
  });

  const distinctEvents = [...uniqueEvents.values()];
  const proposedResults = distinctEvents.filter(
    (event) => event.eventType === "run.result.proposed",
  );
  if (proposedResults.length !== 1) {
    issues.push({
      code: "binding_mismatch",
      path: "/events",
      message: "scripted fixtures must contain exactly one unique run.result.proposed event",
    });
  } else if (canonicalJson(proposedResults[0]?.payload) !== canonicalJson(fixture.result)) {
    issues.push({
      code: "binding_mismatch",
      path: "/result",
      message: "fixture result must match the run.result.proposed event payload",
    });
  }

  const terminalEvents = distinctEvents.filter(
    (event) => event.eventType === "run.terminal",
  );
  if (terminalEvents.length !== 1) {
    issues.push({
      code: "binding_mismatch",
      path: "/events",
      message: "scripted fixtures must contain exactly one unique run.terminal event",
    });
  }
  return issues;
}

export function validatePrpFixture(value: unknown): ProtocolValidationResult {
  const unsupported = versionIssues(value);
  if (unsupported.length > 0) {
    return { ok: false, fixture: null, issues: unsupported };
  }
  if (!fixtureValidator(value)) {
    return {
      ok: false,
      fixture: null,
      issues: (fixtureValidator.errors ?? []).map(ajvIssue),
    };
  }

  const bindings = bindingIssues(value);
  return bindings.length === 0
    ? { ok: true, fixture: value, issues: [] }
    : { ok: false, fixture: null, issues: bindings };
}

export function parsePrpFixtureText(text: string): ProtocolValidationResult {
  try {
    return validatePrpFixture(JSON.parse(text) as unknown);
  } catch (error) {
    return {
      ok: false,
      fixture: null,
      issues: [
        {
          code: "invalid_json",
          path: "/",
          message: error instanceof Error ? error.message : "fixture is not valid JSON",
        },
      ],
    };
  }
}

export type EventValidationResult =
  | { ok: true; event: PrpEvent; issues: [] }
  | { ok: false; event: null; issues: ProtocolValidationIssue[] };

export function validatePrpEvent(value: unknown): EventValidationResult {
  const record = asRecord(value);
  const schemaVersion = record?.schemaVersion;
  if (typeof schemaVersion === "number" && schemaVersion !== 1) {
    return {
      ok: false,
      event: null,
      issues: [
        {
          code: "unsupported_required_version",
          path: "/schemaVersion",
          message: `event schemaVersion ${schemaVersion} is unsupported; this implementation requires 1`,
        },
      ],
    };
  }
  if (!eventValidator(value)) {
    return {
      ok: false,
      event: null,
      issues: (eventValidator.errors ?? []).map(ajvIssue),
    };
  }
  return { ok: true, event: value, issues: [] };
}

export type StructuredResultValidationResult =
  | { ok: true; result: PrpStructuredRunResult; issues: [] }
  | { ok: false; result: null; issues: ProtocolValidationIssue[] };

/** Validate a semantic completion independently from a complete replay fixture. */
export function validatePrpStructuredRunResult(
  value: unknown,
): StructuredResultValidationResult {
  const normalized = normalizeLegacyPrpStructuredRunResult(value);
  if (!resultValidator(normalized)) {
    return {
      ok: false,
      result: null,
      issues: (resultValidator.errors ?? []).map(ajvIssue),
    };
  }
  return { ok: true, result: normalized, issues: [] };
}

export function negotiateProtocolVersion(
  runner: ProtocolVersionRange,
  controller: ProtocolVersionRange,
): number | null {
  const selected = Math.min(runner.max, controller.max);
  return selected >= Math.max(runner.min, controller.min) ? selected : null;
}
