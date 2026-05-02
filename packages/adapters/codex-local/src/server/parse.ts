import { asString, asNumber, parseObject, parseJson } from "@paperclipai/adapter-utils/server-utils";

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

const CODEX_URL_RE = /(https?:\/\/[^\s'"`<>()[\]{};,!?]+[^\s'"`<>()[\]{};,!.?:]+)/gi;

export function extractCodexLoginUrl(text: string): string | null {
  const match = text.match(CODEX_URL_RE);
  if (!match || match.length === 0) return null;
  for (const rawUrl of match) {
    const cleaned = rawUrl.replace(/[\])}.!,?;:'\"]+$/g, "");
    if (cleaned.includes("openai.com") || cleaned.includes("chatgpt.com") || cleaned.includes("auth")) {
      return cleaned;
    }
  }
  return match[0]?.replace(/[\])}.!,?;:'\"]+$/g, "") ?? null;
}

// Strip ANSI escape sequences (CSI, OSC, SGR, cursor moves, etc.) from terminal output.
// The Codex CLI emits color codes in stdout that confuse downstream regex parsing.
const ANSI_ESCAPE_RE = /\u001B\[[0-?]*[ -/]*[@-~]|\u001B\][^\u0007\u001B]*(?:\u0007|\u001B\\)/g;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, "");
}

// `codex login --device-auth` output looks like:
//   Visit:    https://auth.openai.com/codex/device
//   Then enter the code:    ABCD-EFGH
// (typically with ANSI styling around the URL/code). Codes are 8 alphanumeric
// chars often broken by a single dash, occasionally other separators.
const CODEX_DEVICE_AUTH_URL_RE = /https?:\/\/auth\.openai\.com\/[^\s]*device[^\s]*/i;
const CODEX_USER_CODE_RE = /\b([A-Z0-9]{4})[\s-]?([A-Z0-9]{4})\b/;

export function extractCodexDeviceAuth(text: string): { verificationUrl: string | null; userCode: string | null } {
  const cleaned = stripAnsi(text);
  const urlMatch = cleaned.match(CODEX_DEVICE_AUTH_URL_RE);
  const codeMatch = cleaned.match(CODEX_USER_CODE_RE);
  return {
    verificationUrl: urlMatch ? urlMatch[0].replace(/[\])}.!,?;:'\"]+$/g, "") : null,
    userCode: codeMatch ? `${codeMatch[1]}-${codeMatch[2]}` : null,
  };
}
