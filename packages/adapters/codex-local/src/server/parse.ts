import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

const CODEX_TRANSIENT_UPSTREAM_RE =
  /(?:we(?:'|’)re\s+currently\s+experiencing\s+high\s+demand|temporary\s+errors|rate[-\s]?limit(?:ed)?|too\s+many\s+requests|\b429\b|server\s+overloaded|service\s+unavailable|try\s+again\s+later)/i;
const CODEX_REMOTE_COMPACTION_RE = /remote\s+compact\s+task/i;

export function parseCodexJsonl(stdout: string) {
  let sessionId: string | null = null;
  let finalMessage: string | null = null;
  let errorMessage: string | null = null;
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const type = asString(event.type, "");
    if (type === "thread.started") {
      sessionId = asString(event.thread_id, sessionId ?? "") || sessionId;
      continue;
    }

    if (type === "error") {
      const msg = asString(event.message, "").trim();
      if (msg) errorMessage = msg;
      continue;
    }

    if (type === "item.completed") {
      const item = parseObject(event.item);
      if (asString(item.type, "") === "agent_message") {
        const text = asString(item.text, "");
        if (text) finalMessage = text;
      }
      continue;
    }

    if (type === "turn.completed") {
      const usageObj = parseObject(event.usage);
      usage.inputTokens = asNumber(usageObj.input_tokens, usage.inputTokens);
      usage.cachedInputTokens = asNumber(usageObj.cached_input_tokens, usage.cachedInputTokens);
      usage.outputTokens = asNumber(usageObj.output_tokens, usage.outputTokens);
      continue;
    }

    if (type === "turn.failed") {
      const err = parseObject(event.error);
      const msg = asString(err.message, "").trim();
      if (msg) errorMessage = msg;
    }
  }

  return {
    sessionId,
    summary: finalMessage?.trim() ?? "",
    usage,
    errorMessage,
  };
}

export function isCodexUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");
  return /unknown (session|thread)|session .* not found|thread .* not found|conversation .* not found|missing rollout path for thread|state db missing rollout path|no rollout found for thread id/i.test(
    haystack,
  );
}

export function isCodexTransientUpstreamError(input: {
  stdout?: string | null;
  stderr?: string | null;
  errorMessage?: string | null;
}): boolean {
  const haystack = [
    input.errorMessage ?? "",
    input.stdout ?? "",
    input.stderr ?? "",
  ]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  if (!CODEX_TRANSIENT_UPSTREAM_RE.test(haystack)) return false;
  // Keep automatic retries scoped to the observed remote-compaction/high-demand
  // failure shape; broader 429s may be caused by user or account limits.
  return CODEX_REMOTE_COMPACTION_RE.test(haystack) || /high\s+demand|temporary\s+errors/i.test(haystack);
}
