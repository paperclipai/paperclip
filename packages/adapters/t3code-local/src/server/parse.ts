export type T3RunStatus =
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted"
  | "rolled_back"
  | "waiting";

export interface T3RunResult {
  threadId: string;
  runId: string | null;
  status: T3RunStatus | string;
  reply: string | null;
  error: string | null;
}

function asNullableString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function parseJsonObject(line: string): Record<string, unknown> | null {
  const trimmed = line.trim();
  if (!trimmed.startsWith("{")) return null;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function parseT3RunResult(stdout: string): T3RunResult | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonObject(lines[index]!);
    if (!record || typeof record.threadId !== "string" || typeof record.status !== "string") continue;
    return {
      threadId: record.threadId,
      runId: asNullableString(record.runId),
      status: record.status,
      reply: asNullableString(record.reply),
      error: asNullableString(record.error),
    };
  }
  return null;
}

export function parseT3StopStatus(stdout: string): string | null {
  const lines = stdout.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const record = parseJsonObject(lines[index]!);
    if (record && typeof record.status === "string") return record.status;
  }
  return null;
}

export function parseT3ThreadList(stdout: string): Array<{ threadId: string; title: string }> | null {
  const line = stdout.split(/\r?\n/).reverse().find((candidate) => candidate.trim().startsWith("["));
  if (!line) return null;
  try {
    const parsed: unknown = JSON.parse(line);
    if (!Array.isArray(parsed)) return null;
    return parsed.flatMap((item: unknown) => {
      const record = item as Record<string, unknown> | null;
      return record && typeof record.threadId === "string"
        ? [{ threadId: record.threadId, title: typeof record.title === "string" ? record.title : "" }]
        : [];
    });
  } catch {
    return null;
  }
}

export const T3_STOPPED_STATUSES = new Set([
  "no_active_run",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
  "waiting",
]);

export function isT3ServerUnavailable(text: string): boolean {
  return /No (running )?T3 Code server|Could not reach the T3 Code server/i.test(text);
}

export function isT3ProjectNotFound(text: string): boolean {
  return /No T3 Code project matches/i.test(text);
}

export function isT3ThreadNotFound(text: string): boolean {
  return /thread\b[^\n]*\bwas not found|is not a thread id/i.test(text);
}

export function isT3CommandUnsupported(text: string): boolean {
  return /\b(unknown|unrecognized|invalid)\s+(sub)?command\b/i.test(text);
}

export function firstNonEmptyLine(text: string): string {
  return (
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? ""
  );
}
