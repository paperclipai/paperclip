import { i18n, t } from "@/i18n";

type TranscriptDensity = "comfortable" | "compact";

type TranscriptActivity = {
  activityId?: string;
  name: string;
  status: "running" | "completed";
};

export interface ToolInputDetail {
  label: string;
  value: string;
  tone?: "default" | "code";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 1))}...` : value;
}

function humanizeLabel(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function stripWrappedShell(command: string): string {
  const trimmed = compactWhitespace(command);
  const shellWrapped = trimmed.match(/^(?:(?:\/bin\/)?(?:zsh|bash|sh)|cmd(?:\.exe)?(?:\s+\/d)?(?:\s+\/s)?(?:\s+\/c)?)\s+(?:-lc|\/c)\s+(.+)$/i);
  const inner = shellWrapped?.[1] ?? trimmed;
  const quoted = inner.match(/^(['"])([\s\S]*)\1$/);
  return compactWhitespace(quoted?.[2] ?? inner);
}

function formatUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === null || value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeRecord(record: Record<string, unknown>, keys: string[]): string | null {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return truncate(compactWhitespace(value), 120);
    }
  }
  return null;
}

function parseStructuredToolResult(result: string | undefined) {
  if (!result) return null;
  const lines = result.split(/\r?\n/);
  const metadata = new Map<string, string>();
  let bodyStartIndex = lines.findIndex((line) => line.trim() === "");
  if (bodyStartIndex === -1) bodyStartIndex = lines.length;

  for (let index = 0; index < bodyStartIndex; index += 1) {
    const match = lines[index]?.match(/^([a-z_]+):\s*(.+)$/i);
    if (match) {
      metadata.set(match[1].toLowerCase(), compactWhitespace(match[2]));
    }
  }

  const body = lines.slice(Math.min(bodyStartIndex + 1, lines.length))
    .map((line) => compactWhitespace(line))
    .filter(Boolean)
    .join("\n");

  return {
    command: metadata.get("command") ?? null,
    status: metadata.get("status") ?? null,
    exitCode: metadata.get("exit_code") ?? null,
    body,
  };
}

export function formatToolPayload(value: unknown): string {
  if (typeof value === "string") {
    try {
      return JSON.stringify(JSON.parse(value), null, 2);
    } catch {
      return value;
    }
  }
  return formatUnknown(value);
}

export function parseToolPayload(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function isCommandTool(name: string, input: unknown): boolean {
  if (name === "command_execution" || name === "shell" || name === "shellToolCall" || name === "bash") {
    return true;
  }
  if (typeof input === "string") {
    return /\b(?:bash|zsh|sh|cmd|powershell)\b/i.test(input);
  }
  const record = asRecord(input);
  return Boolean(record && (typeof record.command === "string" || typeof record.cmd === "string"));
}

export function displayToolName(name: string, input: unknown): string {
  if (isCommandTool(name, input)) return t("localizationTranscriptChrome.executingCommand");
  return humanizeLabel(name);
}

export function summarizeToolInput(
  name: string,
  input: unknown,
  density: TranscriptDensity = "comfortable",
): string {
  const compactMax = density === "compact" ? 72 : 120;
  if (typeof input === "string") {
    const normalized = isCommandTool(name, input) ? stripWrappedShell(input) : compactWhitespace(input);
    return truncate(normalized, compactMax);
  }
  const record = asRecord(input);
  if (!record) {
    const serialized = compactWhitespace(formatUnknown(input));
    return serialized ? truncate(serialized, compactMax) : t("localizationTranscriptChrome.inspectInput", { name });
  }

  const command = typeof record.command === "string"
    ? record.command
    : typeof record.cmd === "string"
      ? record.cmd
      : null;
  const humanDescription =
    summarizeRecord(record, ["description", "summary", "reason", "goal", "intent", "action", "task"])
    ?? null;
  if (humanDescription) {
    return truncate(humanDescription, compactMax);
  }
  if (command && isCommandTool(name, record)) {
    return truncate(stripWrappedShell(command), compactMax);
  }

  const direct =
    summarizeRecord(record, ["path", "filePath", "file_path", "query", "url", "prompt", "message"])
    ?? summarizeRecord(record, ["pattern", "name", "title", "target", "tool", "command", "cmd"])
    ?? null;
  if (direct) return truncate(direct, compactMax);

  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const first = record.paths.find((value): value is string => typeof value === "string" && value.trim().length > 0);
    if (first) {
      return truncate(t("localizationTranscriptChrome.pathsSummary", { count: record.paths.length, value: new Intl.NumberFormat(i18n.resolvedLanguage).format(record.paths.length), first }), compactMax);
    }
  }

  const keys = Object.keys(record);
  if (keys.length === 0) return t("localizationTranscriptChrome.noInput", { name });
  if (keys.length === 1) return truncate(t("localizationTranscriptChrome.fieldPayload", { key: keys[0] }), compactMax);
  return truncate(t("localizationTranscriptChrome.fieldsSummary", { count: keys.length, value: new Intl.NumberFormat(i18n.resolvedLanguage).format(keys.length), fields: keys.slice(0, 3).join(", ") }), compactMax);
}

function readToolDetailValue(value: unknown, max = 200): string | null {
  if (typeof value === "string") {
    const normalized = compactWhitespace(value);
    return normalized ? truncate(normalized, max) : null;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

export function describeToolInput(name: string, input: unknown): ToolInputDetail[] {
  if (typeof input === "string") {
    const summary = compactWhitespace(isCommandTool(name, input) ? stripWrappedShell(input) : input);
    return summary ? [{ label: isCommandTool(name, input) ? "Command" : "Input", value: truncate(summary, 200), tone: "code" }] : [];
  }

  const record = asRecord(input);
  if (!record) return [];

  const details: ToolInputDetail[] = [];
  const seen = new Set<string>();
  const pushDetail = (label: string, value: string | null, tone: ToolInputDetail["tone"] = "default") => {
    if (!value) return;
    const key = `${label}:${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    details.push({ label, value, tone });
  };

  pushDetail(
    "Intent",
    summarizeRecord(record, ["description", "summary", "reason", "goal", "intent", "action", "task"]) ?? null,
  );
  pushDetail("Path", readToolDetailValue(record.path) ?? readToolDetailValue(record.filePath) ?? readToolDetailValue(record.file_path));
  pushDetail("Directory", readToolDetailValue(record.cwd));
  pushDetail("Query", readToolDetailValue(record.query));
  pushDetail("Target", readToolDetailValue(record.url) ?? readToolDetailValue(record.target));
  pushDetail("Prompt", readToolDetailValue(record.prompt) ?? readToolDetailValue(record.message));
  pushDetail("Pattern", readToolDetailValue(record.pattern));
  pushDetail("Name", readToolDetailValue(record.name) ?? readToolDetailValue(record.title));

  if (Array.isArray(record.paths) && record.paths.length > 0) {
    const paths = record.paths
      .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
      .slice(0, 3)
      .join(", ");
    if (paths) {
      const suffix = record.paths.length > 3 ? `, +${record.paths.length - 3} more` : "";
      pushDetail("Paths", `${paths}${suffix}`);
    }
  }

  const command = typeof record.command === "string"
    ? record.command
    : typeof record.cmd === "string"
      ? record.cmd
      : null;
  if (command && isCommandTool(name, record) && !details.some((detail) => detail.label === "Intent")) {
    pushDetail("Command", truncate(stripWrappedShell(command), 200), "code");
  }

  return details;
}

export function summarizeToolResult(
  result: string | undefined,
  isError: boolean | undefined,
  density: TranscriptDensity = "comfortable",
): string {
  if (!result) return isError ? t("localizationTranscriptChrome.toolFailed") : t("localizationTranscriptChrome.waitingResult");
  const structured = parseStructuredToolResult(result);
  if (structured) {
    if (structured.body) {
      return truncate(structured.body.split("\n")[0] ?? structured.body, density === "compact" ? 84 : 140);
    }
    if (structured.status === "completed") return t("localizationTranscriptChrome.completed");
    if (structured.status === "failed" || structured.status === "error") {
      return structured.exitCode ? t("localizationTranscriptChrome.exitCode", { code: structured.exitCode }) : t("localizationTranscriptChrome.failed");
    }
  }
  const lines = result
    .split(/\r?\n/)
    .map((line) => compactWhitespace(line))
    .filter(Boolean);
  const firstLine = lines[0] ?? result;
  return truncate(firstLine, density === "compact" ? 84 : 140);
}

export function parseSystemActivity(text: string): TranscriptActivity | null {
  const match = text.match(/^item (started|completed):\s*([a-z0-9_-]+)(?:\s+\(id=([^)]+)\))?$/i);
  if (!match) return null;
  return {
    status: match[1].toLowerCase() === "started" ? "running" : "completed",
    name: humanizeLabel(match[2] ?? "Activity"),
    activityId: match[3] || undefined,
  };
}

export function shouldHideNiceModeStderr(text: string): boolean {
  const normalized = compactWhitespace(text).toLowerCase();
  return normalized.startsWith("[paperclip] skipping saved session resume");
}

export function summarizeNotice(text: string, max = 160): string {
  return truncate(compactWhitespace(text), max);
}

/** Presentation only. Canonical detail labels still drive Intent selection and row keys. */
export function toolInputDetailDisplay(detail: ToolInputDetail, input: unknown): ToolInputDetail {
  const labels: Record<string, string> = {
  "Intent": "localizationTaskRuntime.display.ui_Intent_kdk7sb",
  "Path": "localizationTaskRuntime.display.ui_Path_1tbd3yu",
  "Query": "localizationTaskRuntime.display.ui_Query_17zlk03",
  "Target": "localizationTaskRuntime.display.ui_Target_12ohkdk",
  "Name": "localizationTaskRuntime.display.ui_Name_4el6o6",
  "Command": "localizationTaskRuntime.display.ui_Command_1j2mkia",
  "Input": "localizationTaskRuntime.display.ui_Input_189z5sr",
  "Directory": "localizationTranscriptChrome.detail_Directory",
  "Prompt": "localizationTranscriptChrome.detail_Prompt",
  "Pattern": "localizationTranscriptChrome.detail_Pattern",
  "Paths": "localizationTranscriptChrome.detail_Paths"
};
  let value = detail.value;
  const record = asRecord(input);
  if (detail.label === "Paths" && Array.isArray(record?.paths) && record.paths.length > 3) {
    const paths = record.paths
      .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
      .slice(0, 3)
      .join(", ");
    const count = record.paths.length - 3;
    // Translate only our generated suffix, never a custom/provider string.
    if (paths && detail.value === `${paths}, +${count} more`) {
      value = t("localizationTranscriptChrome.morePaths", {
        count,
        value: new Intl.NumberFormat(i18n.resolvedLanguage).format(count),
        paths,
      });
    }
  }
  return { ...detail, label: labels[detail.label] ? t(labels[detail.label]) : detail.label, value };
}
