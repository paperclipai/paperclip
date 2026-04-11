import type { CreateConfigValues, TranscriptEntry } from "@paperclipai/adapter-utils";

export function buildAnvilLocalConfig(v: CreateConfigValues): Record<string, unknown> {
  const ac: Record<string, unknown> = {};
  if (v.cwd) ac.cwd = v.cwd;
  if (v.promptTemplate) ac.promptTemplate = v.promptTemplate;
  if (v.envVars) ac.envVars = v.envVars;
  if (v.envBindings) ac.envBindings = v.envBindings;
  return ac;
}

export function parseAnvilStdoutLine(line: string, ts: string): TranscriptEntry[] {
  if (line.startsWith("{") && line.endsWith("}")) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && parsed.type === "assistant") {
        return [{ kind: "assistant", ts, text: String(parsed.content) }];
      }
    } catch {
      // ignore
    }
  }
  return [{ kind: "stdout", ts, text: line }];
}
