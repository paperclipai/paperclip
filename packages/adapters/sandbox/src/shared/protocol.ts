import type { TranscriptEntry } from "@paperclipai/adapter-utils";

export interface SandboxWrappedStdoutLine {
  type: "paperclip.sandbox.stdout";
  agentType: string;
  line: string;
}

export function wrapSandboxStdoutLine(agentType: string, line: string): string {
  return JSON.stringify({
    type: "paperclip.sandbox.stdout",
    agentType,
    line,
  } satisfies SandboxWrappedStdoutLine);
}

export function unwrapSandboxStdoutLine(raw: string): SandboxWrappedStdoutLine | null {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.type !== "paperclip.sandbox.stdout") return null;
    if (typeof parsed.agentType !== "string" || typeof parsed.line !== "string") return null;
    return {
      type: "paperclip.sandbox.stdout",
      agentType: parsed.agentType,
      line: parsed.line,
    };
  } catch {
    return null;
  }
}

export function fallbackStdoutEntry(line: string, ts: string): TranscriptEntry[] {
  return [{ kind: "stdout", ts, text: line }];
}
