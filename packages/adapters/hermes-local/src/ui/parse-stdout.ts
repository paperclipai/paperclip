import type { TranscriptEntry } from "@paperclipai/adapter-utils";

const ANSI_RE = /\x1B\[[0-9;?]*[ -/]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(ANSI_RE, "");
}

export function parseHermesStdoutLine(line: string, ts: string): TranscriptEntry[] {
  const clean = stripAnsi(line);
  const sessionMatch = clean.match(/^Session:\s+([^\s]+)$/);
  if (sessionMatch) {
    return [{ kind: "init", ts, model: "hermes", sessionId: sessionMatch[1] }];
  }
  return [{ kind: "stdout", ts, text: clean }];
}
