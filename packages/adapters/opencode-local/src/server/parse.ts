import { asNumber, asString, parseJson, parseObject } from "@paperclipai/adapter-utils/server-utils";

// Matches any OpenAI-harmony channel control token in canonical (<|channel|>) or
// mangled single-pipe (<channel|>) forms.
const HARMONY_ANY_RE = /<\|?(?:channel|message|start|end|constrain|return)\|?>/;
const CHANNEL_SPLIT_RE = /<\|?channel\|?>/;
const MSG_SEARCH_RE = /<\|?message\|?>/;
const STRIP_HARMONY_RE = /<\|?(?:channel|message|start|end|constrain|return)\|?>/g;

// Gemma 4 emits reasoning as type:"text" parts carrying OpenAI-harmony channel control
// tokens instead of type:"reasoning" events. Strip those tokens and keep only the
// content of the "final" channel. Any text part with no "final" channel is pure
// reasoning/degenerate control output and is discarded entirely.
function sanitizeHarmonyText(text: string): string {
  if (!HARMONY_ANY_RE.test(text)) return text;

  const channelSections = text.split(CHANNEL_SPLIT_RE);
  // channelSections[0] = text before first channel marker (potential preamble)
  // channelSections[1..n] = "{channel_name}<|message|>{content}"

  let finalContent: string | null = null;
  for (let i = 1; i < channelSections.length; i++) {
    const section = channelSections[i];
    const msgMatch = MSG_SEARCH_RE.exec(section);
    if (!msgMatch) continue;
    const channelName = section.slice(0, msgMatch.index).trim().toLowerCase();
    if (channelName === "final") {
      finalContent = section.slice(msgMatch.index + msgMatch[0].length).replace(STRIP_HARMONY_RE, "").trim();
    }
  }

  if (finalContent === null) return "";

  const preamble = channelSections[0].replace(STRIP_HARMONY_RE, "").trim();
  if (!preamble) return finalContent;
  return `${preamble}\n${finalContent}`.trim();
}

function errorText(value: unknown): string {
  if (typeof value === "string") return value;
  const rec = parseObject(value);
  const message = asString(rec.message, "").trim();
  if (message) return message;
  const data = parseObject(rec.data);
  const nestedMessage = asString(data.message, "").trim();
  if (nestedMessage) return nestedMessage;
  const name = asString(rec.name, "").trim();
  if (name) return name;
  const code = asString(rec.code, "").trim();
  if (code) return code;
  try {
    return JSON.stringify(rec);
  } catch {
    return "";
  }
}

export function parseOpenCodeJsonl(stdout: string) {
  let sessionId: string | null = null;
  const messages: string[] = [];
  const errors: string[] = [];
  const toolErrors: string[] = [];
  const usage = {
    inputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
  };
  let costUsd = 0;

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const event = parseJson(line);
    if (!event) continue;

    const currentSessionId = asString(event.sessionID, "").trim();
    if (currentSessionId) sessionId = currentSessionId;

    const type = asString(event.type, "");

    if (type === "text") {
      const part = parseObject(event.part);
      const text = sanitizeHarmonyText(asString(part.text, "").trim());
      if (text) messages.push(text);
      continue;
    }

    if (type === "step_finish") {
      const part = parseObject(event.part);
      const tokens = parseObject(part.tokens);
      const cache = parseObject(tokens.cache);
      usage.inputTokens += asNumber(tokens.input, 0);
      usage.cachedInputTokens += asNumber(cache.read, 0);
      usage.outputTokens += asNumber(tokens.output, 0) + asNumber(tokens.reasoning, 0);
      costUsd += asNumber(part.cost, 0);
      continue;
    }

    if (type === "tool_use") {
      const part = parseObject(event.part);
      const state = parseObject(part.state);
      if (asString(state.status, "") === "error") {
        const text = asString(state.error, "").trim();
        if (text) toolErrors.push(text);
      }
      continue;
    }

    if (type === "error") {
      const text = errorText(event.error ?? event.message).trim();
      if (text) errors.push(text);
      continue;
    }
  }

  return {
    sessionId,
    summary: messages.join("\n\n").trim(),
    usage,
    costUsd,
    errorMessage: errors.length > 0 ? errors.join("\n") : null,
    toolErrors,
  };
}

export function isOpenCodeUnknownSessionError(stdout: string, stderr: string): boolean {
  const haystack = `${stdout}\n${stderr}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n");

  return /unknown\s+session|session\b.*\bnot\s+found|resource\s+not\s+found:.*[\\/]session[\\/].*\.json|notfounderror|no session/i.test(
    haystack,
  );
}
