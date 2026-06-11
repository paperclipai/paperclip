import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { redactEventPayload, redactSensitiveText, REDACTED_EVENT_VALUE } from "../redaction.js";

export class ToolContentValidationError extends Error {
  constructor(
    message: string,
    public readonly reasonCode: string,
    public readonly findings: string[],
  ) {
    super(message);
  }
}

const PROMPT_INJECTION_PATTERNS: Array<{ code: string; re: RegExp }> = [
  { code: "ignore_previous_instructions", re: /\bignore\b.{0,40}\b(previous|above|earlier)\b.{0,40}\binstructions?\b/i },
  { code: "reveal_system_prompt", re: /\b(reveal|print|dump|show)\b.{0,40}\b(system|developer)\b.{0,20}\b(prompt|message|instructions?)\b/i },
  { code: "instruction_hijack", re: /\b(new|updated)\b.{0,20}\b(system|developer)\b.{0,20}\b(instructions?|message)\b/i },
  { code: "secret_exfiltration", re: /\b(exfiltrate|leak|steal|send)\b.{0,40}\b(secret|token|api[-_ ]?key|credential)s?\b/i },
];

type ToolActionSigningSecretEnv = Partial<
  Record<"PAPERCLIP_TOOL_ACTION_SIGNING_SECRET" | "PAPERCLIP_AGENT_JWT_SECRET" | "BETTER_AUTH_SECRET", string | undefined>
>;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableSerialize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, nested]) => `${JSON.stringify(key)}:${stableSerialize(nested)}`);
  return `{${entries.join(",")}}`;
}

function scanPromptInjection(value: unknown): string[] {
  const text = typeof value === "string" ? value : stableSerialize(value);
  return PROMPT_INJECTION_PATTERNS
    .filter((pattern) => pattern.re.test(text))
    .map((pattern) => pattern.code);
}

export function resolveToolActionSigningSecret(env: ToolActionSigningSecretEnv = process.env as ToolActionSigningSecretEnv) {
  const secret = env.PAPERCLIP_TOOL_ACTION_SIGNING_SECRET?.trim();
  if (!secret) {
    throw new Error("PAPERCLIP_TOOL_ACTION_SIGNING_SECRET is required for signed tool action approvals");
  }
  return secret;
}

function signingSecret(explicitSecret?: string) {
  const secret = explicitSecret?.trim();
  return secret || resolveToolActionSigningSecret();
}

export function canonicalToolArguments(value: unknown) {
  return stableSerialize(value ?? {});
}

export function hashToolValue(value: unknown) {
  return createHash("sha256").update(stableSerialize(value)).digest("hex");
}

export function signToolArguments(args: {
  invocationId: string;
  toolName: string;
  canonicalArguments: string;
  signingSecret?: string;
}) {
  const payload = stableSerialize({
    invocationId: args.invocationId,
    toolName: args.toolName,
    canonicalArguments: args.canonicalArguments,
  });
  const signature = createHmac("sha256", signingSecret(args.signingSecret)).update(payload).digest("base64url");
  return Buffer.from(JSON.stringify({ version: 1, alg: "HS256", payload, signature }), "utf8").toString("base64url");
}

export function verifyToolArgumentsSignature(input: {
  signedArguments: string | null | undefined;
  invocationId: string;
  toolName: string;
  canonicalArguments: string;
  signingSecret?: string;
}) {
  if (!input.signedArguments) return false;
  let parsed: { version?: unknown; alg?: unknown; payload?: unknown; signature?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(input.signedArguments, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (parsed.version !== 1 || parsed.alg !== "HS256") return false;
  if (typeof parsed.payload !== "string" || typeof parsed.signature !== "string") return false;
  const expectedPayload = stableSerialize({
    invocationId: input.invocationId,
    toolName: input.toolName,
    canonicalArguments: input.canonicalArguments,
  });
  if (parsed.payload !== expectedPayload) return false;
  const expected = createHmac("sha256", signingSecret(input.signingSecret)).update(parsed.payload).digest("base64url");
  const left = Buffer.from(parsed.signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

export function readSignedToolArguments(input: {
  signedArguments: string | null | undefined;
  invocationId: string;
  toolName: string;
  signingSecret?: string;
}) {
  if (!input.signedArguments) return null;
  let parsed: { payload?: unknown };
  try {
    parsed = JSON.parse(Buffer.from(input.signedArguments, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed.payload !== "string") return null;
  let payload: { invocationId?: unknown; toolName?: unknown; canonicalArguments?: unknown };
  try {
    payload = JSON.parse(parsed.payload);
  } catch {
    return null;
  }
  if (payload.invocationId !== input.invocationId || payload.toolName !== input.toolName) return null;
  if (typeof payload.canonicalArguments !== "string") return null;
  if (!verifyToolArgumentsSignature({
    signedArguments: input.signedArguments,
    invocationId: input.invocationId,
    toolName: input.toolName,
    canonicalArguments: payload.canonicalArguments,
    signingSecret: input.signingSecret,
  })) {
    return null;
  }
  try {
    return JSON.parse(payload.canonicalArguments) as unknown;
  } catch {
    return null;
  }
}

export function summarizeToolValue(value: unknown) {
  const redacted = isPlainObject(value) ? redactEventPayload(value) : value;
  const serialized = stableSerialize(redacted);
  const redactedText = redactSensitiveText(serialized);
  return {
    summary: redactedText.length > 4000 ? `${redactedText.slice(0, 3997)}...` : redactedText,
    sizeBytes: Buffer.byteLength(serialized, "utf8"),
    sha256: createHash("sha256").update(serialized).digest("hex"),
    redactedFields: redactedText.includes(REDACTED_EVENT_VALUE) ? ["sensitive_value"] : [],
  };
}

export function validateToolContent(input: {
  value: unknown;
  direction: "arguments" | "result";
  sensitiveMode?: "redact" | "block";
  promptInjectionMode?: "redact" | "block" | "ignore";
}) {
  const sensitiveMode = input.sensitiveMode ?? "redact";
  const promptInjectionMode = input.promptInjectionMode ?? (input.direction === "result" ? "block" : "ignore");
  const redactedValue = isPlainObject(input.value) ? redactEventPayload(input.value) : input.value;
  const redactedSummary = summarizeToolValue(redactedValue);
  const findings: string[] = [];

  if (redactedSummary.redactedFields?.length) {
    findings.push("sensitive_value");
    if (sensitiveMode === "block") {
      throw new ToolContentValidationError("Tool content contains sensitive values", "sensitive_value_blocked", findings);
    }
  }

  const promptFindings = promptInjectionMode === "ignore" ? [] : scanPromptInjection(input.value);
  if (promptFindings.length > 0) {
    findings.push(...promptFindings);
    if (promptInjectionMode === "block") {
      throw new ToolContentValidationError(
        "Tool result contained prompt-injection instructions and was blocked",
        "prompt_injection_blocked",
        promptFindings,
      );
    }
  }

  return {
    value: redactedValue,
    summary: redactedSummary,
    findings,
  };
}
