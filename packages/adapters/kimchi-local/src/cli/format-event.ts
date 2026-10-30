import pc from "picocolors";
import { printAcpxStreamEvent } from "@paperclipai/adapter-utils/acpx-engine/cli";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

export function printKimchiStreamEvent(raw: string, debug: boolean): void {
  const line = raw.trim();
  if (!line) return;

  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(line) as Record<string, unknown>;
  } catch {
    console.log(line);
    return;
  }

  // kimchi_local is ACP-only: the shared acpx printer owns acpx.* events
  // (streaming deltas, tool-call lifecycle, session metadata).
  if (asString(parsed.type).startsWith("acpx.")) {
    printAcpxStreamEvent(line, debug);
    return;
  }

  if (asString(parsed.type).trim().toLowerCase() === "error" || asString(parsed.role).trim().toLowerCase() === "error") {
    const text =
      asString(parsed.content) ||
      asString(parsed.message) ||
      asString(parsed.error) ||
      "Kimchi error";
    console.log(pc.red(`error: ${text}`));
    return;
  }

  console.log(line);
}
