import type { TranscriptEntry } from "@paperclipai/adapter-utils";

// Browser-safe: this module is also published as the ./ui-parser bundle that
// the board loads for external installs, so it must not import node APIs.

const ESC = String.fromCharCode(27);
const ANSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, "g");

export function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

const SYSTEM_LINE_RE =
  /^(?:Aider v|Main model:|Weak model:|Editor model:|Model:|Models:|Git repo:|Repo-map:|Added |Applied edit to |Commit [0-9a-f]{7,40}|Tokens:|Cost:|Scanning repo|Use \/help)/i;

const ERROR_LINE_RE =
  /(?:^Traceback \(most recent call last\)|litellm\.[A-Za-z]*(?:Error|Exception)|\b(?:Authentication|RateLimit|BadRequest)Error\b|^Error:|^Warning:)/;

export function parseStdoutLine(rawLine: string, ts: string): TranscriptEntry[] {
  const line = stripAnsi(rawLine);
  const trimmed = line.trim();
  if (!trimmed) return [];

  if (ERROR_LINE_RE.test(trimmed)) {
    return [{ kind: "stderr", ts, text: line }];
  }

  if (SYSTEM_LINE_RE.test(trimmed)) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  if (trimmed.startsWith("[paperclip]")) {
    return [{ kind: "system", ts, text: trimmed }];
  }

  // Everything else is Aider relaying the model, streamed line by line.
  return [{ kind: "assistant", ts, text: line, delta: true }];
}

// Named alias matching the other adapter packages' UI exports.
export const parseAiderStdoutLine = parseStdoutLine;
