/**
 * MC inbound triggerPayload classifier (TSMC-19589 / TSR-4971/4972).
 *
 * Pure runtime filter for CTO execution issues created by a directly triggered
 * Mission Control routine. Classification reads ONLY the originating routine
 * run's triggerPayload — never issue title/body.
 *
 * Outcomes:
 * - liveness → terminal `done`, no CEO handoff
 * - actionable CEO types → one sanitized CEO handoff plan
 * - unknown shapes → safe CTO technical routing (no silent CEO promotion)
 */

import { REDACTED_EVENT_VALUE, sanitizeRecord } from "../redaction.js";

export type McInboundRoute =
  | "liveness_done"
  | "ceo_handoff"
  | "cto_technical";

export type McInboundLivenessSignal =
  | "handshake"
  | "binding_probe"
  | "_binding_probe"
  | "keepalive"
  | "preflight"
  | "machine_ping";

export type McInboundCeoActionableType =
  | "portfolio_directive"
  | "portfolio_input_request"
  | "approval_request"
  | "escalation"
  | "clarification";

export type McInboundClassification = {
  /** High-level route the runtime should take. */
  route: McInboundRoute;
  /** Concrete signal/type that matched, or "unknown". */
  signal: string;
  /** Terminal status for the CTO execution issue, when the filter closes it. */
  executionIssueStatus: "done" | null;
  /** Whether exactly one CEO handoff should be created. */
  createCeoHandoff: boolean;
  /** Whether the payload should stay on the CTO technical path. */
  preserveCtoRouting: boolean;
  /** Short machine-readable reason for logs/tests. */
  reason: string;
};

export type McInboundCeoHandoffPlan = {
  sourceExecutionIssueId: string | null;
  sourceExecutionIssueIdentifier: string | null;
  payloadType: McInboundCeoActionableType | string;
  /** Operational content with callback credentials stripped. */
  sanitizedContent: Record<string, unknown>;
  titleHint: string;
  summary: string | null;
};

const LIVENESS_TYPE_SIGNALS = new Set([
  "handshake",
  "binding_probe",
  "keepalive",
  "keep_alive",
  "liveness",
  "liveness_probe",
  "preflight",
  "machine_handshake",
  "mc_machine_ping",
  "ping",
]);

const CEO_ACTIONABLE_TYPES = new Set<string>([
  "portfolio_directive",
  "portfolio_input_request",
  "approval_request",
  "escalation",
  "clarification",
]);

/** Keys that must never appear in CEO handoff bodies or issue comments. */
const TRANSPORT_SECRET_KEY_RE =
  /^(callback|callbacks|ackcallback|ack_callback|callbackurl|callback_url|primarycallbackurl|secondarycallbackurl|authorization|authheader|auth_header|bearer|bearertoken|bearer_token|token|accesstoken|access_token|apikey|api_key|secret|clientsecret|client_secret|password|passwd|credential|credentials|signingsecret|signing_secret|hmac|privatekey|private_key)$/i;

const TRANSPORT_SECRET_KEY_SUBSTRING_RE =
  /(callbackurl|callback_url|bearer|credential|authorization|signingsecret|hmacsecret|private[_-]?key)/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTruthyFlag(value: unknown): boolean {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on";
}

function readTypeSignal(raw: Record<string, unknown>): string {
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (type) return type;
  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  return kind;
}

function hasNonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Classify an originating routine-run triggerPayload.
 * Does not inspect issue title/body — callers must pass the run payload only.
 */
export function classifyMcInboundTriggerPayload(
  triggerPayload: unknown,
): McInboundClassification {
  if (!isPlainRecord(triggerPayload)) {
    return {
      route: "cto_technical",
      signal: "unknown",
      executionIssueStatus: null,
      createCeoHandoff: false,
      preserveCtoRouting: true,
      reason: "non_object_or_missing_payload",
    };
  }

  // Prefer explicit binding-probe flag even when type is spoofed as actionable.
  if (isTruthyFlag(triggerPayload._binding_probe)) {
    return {
      route: "liveness_done",
      signal: "_binding_probe",
      executionIssueStatus: "done",
      createCeoHandoff: false,
      preserveCtoRouting: false,
      reason: "liveness_binding_probe_flag",
    };
  }

  const typeSignal = readTypeSignal(triggerPayload);

  if (typeSignal === "binding_probe") {
    return {
      route: "liveness_done",
      signal: "binding_probe",
      executionIssueStatus: "done",
      createCeoHandoff: false,
      preserveCtoRouting: false,
      reason: "liveness_binding_probe_type",
    };
  }

  if (typeSignal === "handshake") {
    return {
      route: "liveness_done",
      signal: "handshake",
      executionIssueStatus: "done",
      createCeoHandoff: false,
      preserveCtoRouting: false,
      reason: "liveness_handshake",
    };
  }

  if (
    isTruthyFlag(triggerPayload._mc_machine_ping) ||
    isTruthyFlag(triggerPayload._preflight) ||
    LIVENESS_TYPE_SIGNALS.has(typeSignal)
  ) {
    return {
      route: "liveness_done",
      signal: typeSignal || (isTruthyFlag(triggerPayload._preflight) ? "preflight" : "machine_ping"),
      executionIssueStatus: "done",
      createCeoHandoff: false,
      preserveCtoRouting: false,
      reason: "liveness_keepalive_table",
    };
  }

  if (CEO_ACTIONABLE_TYPES.has(typeSignal)) {
    return {
      route: "ceo_handoff",
      signal: typeSignal,
      executionIssueStatus: null,
      createCeoHandoff: true,
      preserveCtoRouting: false,
      reason: "ceo_actionable_payload",
    };
  }

  return {
    route: "cto_technical",
    signal: typeSignal || "unknown",
    executionIssueStatus: null,
    createCeoHandoff: false,
    preserveCtoRouting: true,
    reason: "unknown_shape_safe_cto_routing",
  };
}

function isTransportSecretKey(key: string): boolean {
  if (TRANSPORT_SECRET_KEY_RE.test(key)) return true;
  return TRANSPORT_SECRET_KEY_SUBSTRING_RE.test(key);
}

/**
 * Deep-sanitize a payload for CEO handoff / issue comments.
 * Removes callback transport objects and redacts secret-bearing keys.
 * Reuses shared sanitizeRecord for generic secret field names.
 */
export function sanitizeMcInboundPayloadForCeoHandoff(
  triggerPayload: unknown,
): Record<string, unknown> {
  if (!isPlainRecord(triggerPayload)) return {};

  const stripTransport = (value: unknown, depth: number): unknown => {
    if (depth > 12) return value;
    if (Array.isArray(value)) {
      return value.map((entry) => stripTransport(entry, depth + 1));
    }
    if (!isPlainRecord(value)) return value;

    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isTransportSecretKey(key)) {
        // Drop entire callback/credential transport subtrees — do not leave
        // partial URL shells that still point at credentialed endpoints.
        if (key.toLowerCase() === "callback" || key.toLowerCase() === "callbacks" || key.toLowerCase() === "ackcallback" || key.toLowerCase() === "ack_callback") {
          out[key] = { redacted: true, reason: "callback_transport_omitted" };
          continue;
        }
        if (typeof child === "string" || typeof child === "number" || typeof child === "boolean") {
          out[key] = REDACTED_EVENT_VALUE;
          continue;
        }
        out[key] = REDACTED_EVENT_VALUE;
        continue;
      }
      out[key] = stripTransport(child, depth + 1);
    }
    return out;
  };

  const stripped = stripTransport(triggerPayload, 0);
  if (!isPlainRecord(stripped)) return {};
  // Second pass: shared secret-name redaction (bearer, token, apiKey, etc.).
  return sanitizeRecord(stripped);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (hasNonEmptyString(value)) return String(value).trim();
  }
  return null;
}

/**
 * Build the single CEO handoff content plan from a classified actionable payload.
 * Call only when classifyMcInboundTriggerPayload(...).createCeoHandoff is true.
 */
export function buildMcInboundCeoHandoffPlan(input: {
  triggerPayload: unknown;
  sourceExecutionIssueId?: string | null;
  sourceExecutionIssueIdentifier?: string | null;
}): McInboundCeoHandoffPlan {
  const classification = classifyMcInboundTriggerPayload(input.triggerPayload);
  const sanitized = sanitizeMcInboundPayloadForCeoHandoff(input.triggerPayload);
  const payloadType = classification.signal;
  const summary = firstString(
    sanitized.summary,
    sanitized.ask,
    sanitized.details,
    sanitized.title,
    sanitized.message,
  );
  const company = firstString(sanitized.company, sanitized.sourceCompany, sanitized.source);
  const titleHint = [
    "MC inbound",
    payloadType !== "unknown" ? payloadType : null,
    company,
    summary ? (summary.length > 80 ? `${summary.slice(0, 77)}...` : summary) : null,
  ]
    .filter(Boolean)
    .join(" — ")
    .slice(0, 200);

  return {
    sourceExecutionIssueId: input.sourceExecutionIssueId ?? null,
    sourceExecutionIssueIdentifier: input.sourceExecutionIssueIdentifier ?? null,
    payloadType,
    sanitizedContent: {
      ...sanitized,
      // Always include a back-reference to the CTO execution issue when known.
      ...(input.sourceExecutionIssueId || input.sourceExecutionIssueIdentifier
        ? {
            sourceExecutionIssue: {
              id: input.sourceExecutionIssueId ?? null,
              identifier: input.sourceExecutionIssueIdentifier ?? null,
            },
          }
        : {}),
    },
    titleHint,
    summary,
  };
}

/** Convenience: full filter decision for a CTO execution issue's origin run. */
export function evaluateMcInboundTriggerPayloadFilter(input: {
  triggerPayload: unknown;
  sourceExecutionIssueId?: string | null;
  sourceExecutionIssueIdentifier?: string | null;
}): {
  classification: McInboundClassification;
  ceoHandoff: McInboundCeoHandoffPlan | null;
} {
  const classification = classifyMcInboundTriggerPayload(input.triggerPayload);
  if (!classification.createCeoHandoff) {
    return { classification, ceoHandoff: null };
  }
  return {
    classification,
    ceoHandoff: buildMcInboundCeoHandoffPlan(input),
  };
}
