import path from "node:path";
import type { PaperclipSkillEntry } from "@paperclipai/adapter-utils/server-utils";
import type { AcpRuntimeEvent } from "acpx/runtime";

export interface SkillInvocationContext {
  skillRoot: string;
  entries: PaperclipSkillEntry[];
}

function toolInput(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): Record<string, unknown> {
  return event.rawInput && typeof event.rawInput === "object" && !Array.isArray(event.rawInput)
    ? event.rawInput as Record<string, unknown>
    : {};
}

function stringField(input: Record<string, unknown>, ...keys: string[]): string | null {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

function entryForSkillName(entries: PaperclipSkillEntry[], name: string): PaperclipSkillEntry | null {
  const normalized = name.toLowerCase();
  return entries.find((entry) =>
    entry.key.toLowerCase() === normalized ||
    entry.runtimeName.toLowerCase() === normalized
  ) ?? null;
}

function entryForReadPath(
  entries: PaperclipSkillEntry[],
  skillRoot: string,
  readPath: string,
): PaperclipSkillEntry | null {
  const absoluteRoot = path.resolve(skillRoot);
  const relative = path.relative(absoluteRoot, path.resolve(readPath));
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;

  const [runtimeName] = relative.split(path.sep);
  return entries.find((entry) => entry.runtimeName === runtimeName) ?? null;
}

function firstLocationPath(event: Extract<AcpRuntimeEvent, { type: "tool_call" }>): string | null {
  for (const location of event.locations ?? []) {
    if (typeof location?.path === "string" && location.path.trim()) return location.path.trim();
  }
  return null;
}

/**
 * Best-effort ACPX invocation detection. ACP adapters do not expose a
 * cross-provider invocation contract, so this intentionally recognizes only
 * Claude-style Skill calls and file reads for materialized runtime skills.
 *
 * Live adapters do not title read calls with the bare tool name: the Claude
 * ACP adapter emits `title: "Read File"` on the initial tool_call (with empty
 * rawInput/locations) and `title: "Read <path>"` on tool_call_update events,
 * which carry `kind: "read"`, `rawInput.file_path`, and `locations[].path`.
 * Detection therefore keys on the ACP tool kind, with a title-prefix fallback
 * for adapters that omit `kind`, and reads the path from rawInput or
 * locations. Update events for one toolCallId are deduped per run upstream.
 */
export function detectInvokedSkill(
  event: AcpRuntimeEvent,
  context: SkillInvocationContext,
): PaperclipSkillEntry | null {
  if (event.type !== "tool_call") return null;

  const name = (event.title ?? "").trim().toLowerCase();
  const input = toolInput(event);
  if (name === "skill") {
    const skillName = stringField(input, "skill");
    return skillName ? entryForSkillName(context.entries, skillName) : null;
  }
  const isRead = event.kind === "read" || name === "read" || name.startsWith("read ");
  if (isRead) {
    const readPath = stringField(input, "file_path", "path") ?? firstLocationPath(event);
    return readPath ? entryForReadPath(context.entries, context.skillRoot, readPath) : null;
  }
  return null;
}
