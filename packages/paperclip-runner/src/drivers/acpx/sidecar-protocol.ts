import type { QualifiedAcpxAgent } from "./qualified-profiles.js";
import type { NativeRuntimeContextSnapshot } from "../../contracts/runtime-context.js";
import type { NativeAcpxPermissionMode } from "../../contracts/native-execution.js";
import {
  classifyGeneratedAcpxToolOperation,
  GENERATED_ACPX_SIDECAR_COMMANDS,
  GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION,
  type GeneratedAcpxToolOperation,
  type GeneratedAcpxSidecarCommand,
  type GeneratedAcpxSidecarEventType,
} from "./generated-sidecar-contract.js";

export const ACPX_SIDECAR_PROTOCOL_VERSION =
  GENERATED_ACPX_SIDECAR_PROTOCOL_VERSION;
export const ACPX_SIDECAR_MAX_FRAME_BYTES = 1024 * 1024;

export interface AcpxSidecarRequest {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  id: number;
  command: GeneratedAcpxSidecarCommand;
  params: Record<string, unknown>;
}

export interface AcpxSidecarResponse {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  id: number;
  ok: boolean;
  result?: Record<string, unknown>;
  error?: { code: string; message: string; retryable: boolean };
}

export interface AcpxSidecarEvent {
  protocolVersion: typeof ACPX_SIDECAR_PROTOCOL_VERSION;
  sequence: number;
  eventType: GeneratedAcpxSidecarEventType;
  runId: string | null;
  turnId: string | null;
  payload: Record<string, unknown>;
}

export interface AcpxSidecarOpenParams {
  runtimeDirectory: string;
  normalizedSessionId: string;
  workingDirectory: string;
  agent: QualifiedAcpxAgent;
  model: string;
  permissionMode: NativeAcpxPermissionMode;
  permissionModePinned: boolean;
  systemInstructions: string;
  runtimeContext: NativeRuntimeContextSnapshot | null;
  tools: readonly Readonly<Record<string, unknown>>[];
  providerSessionKey?: string;
  expectedIdentity?: AcpxExpectedSessionIdentity;
}

export interface AcpxExpectedSessionIdentity {
  kind: "acpx";
  normalizedSessionId: string;
  acpxRecordId: string;
  backendSessionId: string;
  agentSessionId: string;
  profileDigest: string;
  workspaceDigest: string;
  requestedModel: string;
  effectiveModel: string;
  permissionMode?: NativeAcpxPermissionMode;
  providerLifetimeFenceCandidates: readonly [number, number, number];
}

export function parseAcpxSidecarRequest(value: unknown): AcpxSidecarRequest {
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error("ACPX sidecar request is not JSON serializable");
  }
  if (
    !serialized ||
    Buffer.byteLength(serialized) > ACPX_SIDECAR_MAX_FRAME_BYTES
  ) {
    throw new Error("ACPX sidecar request exceeds the frame limit");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("ACPX sidecar request must be an object");
  }
  const request = value as Record<string, unknown>;
  if (
    Object.keys(request).some(
      (key) => !["protocolVersion", "id", "command", "params"].includes(key),
    )
  ) {
    throw new Error("ACPX sidecar request contains an unknown field");
  }
  if (request.protocolVersion !== ACPX_SIDECAR_PROTOCOL_VERSION) {
    throw new Error("unsupported ACPX sidecar protocol version");
  }
  if (!Number.isSafeInteger(request.id) || Number(request.id) < 1)
    throw new Error("sidecar request id must be a positive integer");
  const command = text(request.command);
  if (!(GENERATED_ACPX_SIDECAR_COMMANDS as readonly string[]).includes(command))
    throw new Error("unsupported ACPX sidecar command");
  if (
    typeof request.params !== "object" ||
    request.params === null ||
    Array.isArray(request.params)
  ) {
    throw new Error("ACPX sidecar request params must be an object");
  }
  return {
    protocolVersion: ACPX_SIDECAR_PROTOCOL_VERSION,
    id: Number(request.id),
    command: command as AcpxSidecarRequest["command"],
    params: structuredClone(request.params as Record<string, unknown>),
  };
}

export function boundedSidecarValue(
  value: unknown,
  maxBytes = 64 * 1024,
  overflowFallback?: Record<string, unknown>,
): Record<string, unknown> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new Error("ACPX sidecar value limit must be a positive integer");
  }
  const omitted = (reason: string): Record<string, unknown> => {
    const marker = { omitted: true, reason };
    if (overflowFallback === undefined) return marker;
    try {
      const serialized = stringifyAcpxSidecarFrame({
        ...overflowFallback,
        ...marker,
      });
      if (Buffer.byteLength(serialized) <= maxBytes) {
        const parsed = JSON.parse(serialized);
        if (typeof parsed === "object" && parsed !== null) {
          return parsed as Record<string, unknown>;
        }
      }
    } catch {
      // Fall through to the bounded type-less marker when even the caller's
      // minimal identity cannot be serialized safely.
    }
    return marker;
  };
  try {
    const serialized = stringifyAcpxSidecarFrame(value);
    if (!serialized || Buffer.byteLength(serialized) > maxBytes) {
      return omitted("payload_limit");
    }
    const parsed = JSON.parse(serialized);
    return typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : omitted("object_required");
  } catch {
    return omitted("serialization_failed");
  }
}

/**
 * Replaces isolated UTF-16 surrogates with a Unicode scalar value. JavaScript
 * can retain those code units and JSON.stringify emits them as escapes, while
 * Rust's serde_json correctly rejects them as invalid JSON strings.
 */
export function safeSidecarText(value: string): string {
  const safe: string[] = [];
  for (const codePoint of value) safe.push(safeSidecarCodePoint(codePoint));
  return safe.join("");
}

/**
 * Serializes a frame without emitting string values or property names that
 * Rust cannot decode. The initial round trip preserves JSON.stringify's
 * ordinary toJSON, omission, and number semantics before keys are rebuilt.
 */
export function stringifyAcpxSidecarFrame(value: unknown): string {
  const serialized = JSON.stringify(value);
  if (!serialized) throw new Error("ACPX sidecar frame is not serializable");
  return JSON.stringify(safeSidecarJsonValue(JSON.parse(serialized)));
}

function safeSidecarJsonValue(value: unknown): unknown {
  if (typeof value === "string") return safeSidecarText(value);
  if (Array.isArray(value)) return value.map(safeSidecarJsonValue);
  if (value === null || typeof value !== "object") return value;

  const safe = Object.create(null) as Record<string, unknown>;
  for (const [key, candidate] of Object.entries(
    value as Record<string, unknown>,
  )) {
    const safeKey = safeSidecarText(key);
    if (Object.hasOwn(safe, safeKey)) {
      throw new Error(
        "ACPX sidecar frame has colliding Unicode property names",
      );
    }
    safe[safeKey] = safeSidecarJsonValue(candidate);
  }
  return safe;
}

/**
 * Bounds provider text by Unicode scalar count so the emitted UTF-8 frame and
 * runner-core's `str::chars` admission check observe the same value. Provider
 * strings may also contain an isolated UTF-16 surrogate; replace it rather
 * than emitting a JSON escape that Rust cannot decode as a string.
 */
export function boundedSidecarText(
  value: string,
  maxCodePoints: number,
): string {
  if (!Number.isSafeInteger(maxCodePoints) || maxCodePoints < 0) {
    throw new Error("ACPX sidecar text limit must be a non-negative integer");
  }
  const bounded: string[] = [];
  for (const codePoint of value) {
    if (bounded.length >= maxCodePoints) break;
    bounded.push(safeSidecarCodePoint(codePoint));
  }
  return bounded.join("");
}

/**
 * Classifies the complete provider value before retaining a bounded display
 * copy. `toolOperation` is the sidecar's classification authority when the
 * provider token lies beyond the retained prefix; older frames can continue
 * to be classified from `kind` and `title` by runner-core.
 */
export function frameAcpxToolClassification(
  toolKind: unknown,
  boundedToolTitle: unknown,
): {
  kind: string | null;
  toolOperation: GeneratedAcpxToolOperation;
} {
  const toolOperation = classifyGeneratedAcpxToolOperation(
    toolKind,
    boundedToolTitle,
  );
  return {
    kind:
      typeof toolKind === "string"
        ? boundedSidecarText(toolKind, 4_000)
        : null,
    toolOperation,
  };
}

function safeSidecarCodePoint(codePoint: string): string {
  const codeUnit = codePoint.charCodeAt(0);
  return codePoint.length === 1 && codeUnit >= 0xd800 && codeUnit <= 0xdfff
    ? "\uFFFD"
    : codePoint;
}

export function sanitizeAcpxPlanEntries(value: unknown): Array<{
  content: string;
  status: "pending" | "in_progress" | "completed";
  priority: string | null;
}> {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 256).flatMap((candidate) => {
    const entry = record(candidate);
    const content = text(entry.content).trim().slice(0, 4_000);
    const status = text(entry.status);
    if (
      !content ||
      (status !== "pending" &&
        status !== "in_progress" &&
        status !== "completed")
    )
      return [];
    return [
      {
        content,
        status,
        priority: text(entry.priority).slice(0, 80) || null,
      },
    ];
  });
}

export function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}
