import type { McpAppViewSummary } from "@paperclipai/shared";

/** Tool rows are keyed `${runId}:tool:${toolUseId}` by the transcript adapter. */
export function runIdFromToolItemId(id: string): string | null {
  const index = id.indexOf(":tool:");
  return index > 0 ? id.slice(0, index) : null;
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Harnesses prefix and reformat gateway tool names ("mcp__paperclip__…"), so a
 * row matches when its normalized name ends with the gateway or provider name.
 */
export function toolRowMatchesView(rawName: string | undefined, view: McpAppViewSummary): boolean {
  if (!rawName) return false;
  const raw = normalizedName(rawName);
  const gateway = normalizedName(view.toolName);
  const upstream = normalizedName(view.upstreamToolName);
  return (gateway.length > 0 && raw.endsWith(gateway)) || (upstream.length > 0 && raw.endsWith(upstream));
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * The recorded view for a tool row: same run, same tool, and, when the run
 * called the tool more than once, the same arguments. With no argument match
 * the latest call wins, which is right for repeated identical calls.
 */
export function matchMcpAppView(
  item: { id: string; rawName?: string; input?: unknown },
  views: readonly McpAppViewSummary[],
): McpAppViewSummary | null {
  const runId = runIdFromToolItemId(item.id);
  if (!runId) return null;
  const candidates = views.filter((view) => view.runId === runId && toolRowMatchesView(item.rawName, view));
  if (candidates.length === 0) return null;
  if (candidates.length === 1 || item.input === undefined) return candidates[candidates.length - 1]!;
  const input = stableJson(item.input);
  return candidates.find((view) => stableJson(view.toolInput) === input) ?? candidates[candidates.length - 1]!;
}
