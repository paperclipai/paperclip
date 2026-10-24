import type { UsageSummary } from "@paperclipai/adapter-utils";

export interface ParsedMuseCodeOutput {
  sessionId: string | null;
  model: string | null;
  provider: string | null;
  usage: UsageSummary;
  usageReported: boolean;
  usageComplete: boolean;
  summary: string | null;
  terminalKind: string | null;
  errorMessage: string | null;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

export function parseMuseCodeJsonl(stdout: string): ParsedMuseCodeOutput {
  let sessionId: string | null = null;
  let model: string | null = null;
  let provider: string | null = null;
  let inputTokens = 0;
  let cachedTokens = 0;
  let outputTokens = 0;
  let usageReported = false;
  let deltaText = "";
  let terminalKind: string | null = null;
  let terminalText: string | null = null;
  let terminalReason: string | null = null;

  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    let event: Record<string, unknown> | null;
    try {
      event = asRecord(JSON.parse(trimmed));
    } catch {
      continue;
    }
    if (!event) continue;

    const stream = asRecord(event.stream);
    if (stream?.kind === "session" && typeof stream.id === "string" && stream.id) {
      sessionId = stream.id;
    }

    const payloadType = asText(event.payload_type);
    const payload = asRecord(event.payload) ?? {};

    if (payloadType === "run.model.configured") {
      model = asText(payload.model_id) || model;
      provider = asText(payload.provider_id) || provider;
      continue;
    }

    if (payloadType === "run.output.delta") {
      deltaText += asText(payload.text);
      continue;
    }

    if (payloadType === "run.usage") {
      const models = Array.isArray(payload.models) ? payload.models : [];
      inputTokens = 0;
      cachedTokens = 0;
      outputTokens = 0;
      for (const entry of models) {
        const record = asRecord(entry);
        if (!record) continue;
        inputTokens += asCount(record.input_tokens);
        cachedTokens += asCount(record.cached_tokens);
        outputTokens += asCount(record.output_tokens) + asCount(record.reasoning_tokens);
        if (!model && typeof record.model === "string" && record.model) model = record.model;
      }
      usageReported = true;
      continue;
    }

    if (payloadType.startsWith("run.terminal.") || payload.kind === "run_terminal") {
      terminalKind = asText(payload.terminal) || payloadType.slice("run.terminal.".length) || null;
      terminalText = asText(payload.text) || null;
      terminalReason = asText(payload.reason) || null;
    }
  }

  const failed = terminalKind !== null && terminalKind !== "completed";
  return {
    sessionId,
    model,
    provider: provider ?? (model || usageReported ? "meta" : null),
    usage: {
      inputTokens: Math.max(0, inputTokens - cachedTokens),
      outputTokens,
      cachedInputTokens: cachedTokens,
    },
    usageReported,
    usageComplete: usageReported,
    summary: terminalText ?? (deltaText.trim() ? deltaText : null),
    terminalKind,
    errorMessage: failed
      ? terminalReason ?? terminalText ?? `Muse run ${terminalKind}`
      : null,
  };
}

const UNKNOWN_SESSION_PATTERNS = [
  /session[^\n]{0,80}?(not found|no longer exists|does not exist|unknown session)/i,
  /(unknown|missing|invalid) session/i,
  /allow-workspace-switch/i,
  /session[^\n]{0,80}?(different|another) workspace/i,
];

export function isMuseCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stderr}\n${stdout}`;
  return UNKNOWN_SESSION_PATTERNS.some((pattern) => pattern.test(haystack));
}
