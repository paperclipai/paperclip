export type NonActionableWebhookPayloadKind =
  | "binding_probe"
  | "preflight"
  | "machine_handshake"
  | "directive_receipt_ack"
  | "empty_payload"
  | "empty_directive";

function hasNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0;
}

function hasNonEmptyObjectArray(value: unknown) {
  return Array.isArray(value) && value.some((entry) => entry && typeof entry === "object");
}

function isTruthyFlag(value: unknown) {
  if (value === true || value === 1) return true;
  if (typeof value !== "string") return false;
  return ["true", "1", "yes", "on"].includes(value.trim().toLowerCase());
}

/** Returns the liveness-only class, or null for payloads that may create work. */
export function classifyNonActionableWebhookPayload(
  raw: Record<string, unknown> | null | undefined,
): NonActionableWebhookPayloadKind | null {
  if (!raw) return null;
  if (Object.keys(raw).length === 0) return "empty_payload";

  const kind = typeof raw.kind === "string" ? raw.kind.trim().toLowerCase() : "";
  const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : "";
  if (isTruthyFlag(raw._binding_probe) || type === "binding_probe" || kind === "binding_probe") return "binding_probe";
  if (isTruthyFlag(raw._preflight) || type === "preflight" || kind === "preflight") return "preflight";
  if (isTruthyFlag(raw._mc_machine_ping) || type === "handshake" || kind === "handshake") return "machine_handshake";
  if (type === "directive_receipt_ack" || kind === "directive_receipt_ack") return "directive_receipt_ack";

  const directiveLike = kind.includes("directive") || type.includes("directive");
  if (!directiveLike) return null;
  return hasNonEmptyString(raw.ask)
    || hasNonEmptyString(raw.why)
    || hasNonEmptyString(raw.summary)
    || hasNonEmptyString(raw.details)
    || hasNonEmptyString(raw.ask_title)
    || hasNonEmptyString(raw.ask_body)
    || hasNonEmptyString(raw.title)
    || hasNonEmptyObjectArray(raw.directives)
    || hasNonEmptyObjectArray(raw.tasks)
    ? null
    : "empty_directive";
}
