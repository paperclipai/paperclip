import type { McpAppViewSummary } from "@paperclipai/shared";

/** Tool rows are keyed `${runId}:tool:${toolUseId}` by the transcript adapter. */
export function runIdFromToolItemId(id: string): string | null {
  const index = id.indexOf(":tool:");
  return index > 0 ? id.slice(0, index) : null;
}

function normalizedName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>).sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

interface IndexedView {
  view: McpAppViewSummary;
  gateway: string;
  upstream: string;
  input: string;
}

/**
 * Harnesses prefix and reformat gateway tool names ("mcp__paperclip__…"), so a
 * row matches when its normalized name ends with the gateway or provider name.
 */
function nameMatches(raw: string, entry: Pick<IndexedView, "gateway" | "upstream">): boolean {
  return (entry.gateway.length > 0 && raw.endsWith(entry.gateway)) || (entry.upstream.length > 0 && raw.endsWith(entry.upstream));
}

export function toolRowMatchesView(rawName: string | undefined, view: McpAppViewSummary): boolean {
  if (!rawName) return false;
  return nameMatches(normalizedName(rawName), { gateway: normalizedName(view.toolName), upstream: normalizedName(view.upstreamToolName) });
}

export interface McpAppViewIndex {
  /**
   * The recorded view for a tool row: same run, same tool, and the newest call
   * with the same arguments. Without an argument match the run's newest call
   * of that tool wins, which is right for repeated identical calls.
   */
  match(item: { id: string; rawName?: string; input?: unknown }): McpAppViewSummary | null;
}

/** Groups a task's views by run once, with names and arguments pre-normalized. */
export function createMcpAppViewIndex(views: readonly McpAppViewSummary[]): McpAppViewIndex {
  const byRun = new Map<string, IndexedView[]>();
  for (const view of views) {
    if (!view.runId) continue;
    const entries = byRun.get(view.runId) ?? [];
    entries.push({ view, gateway: normalizedName(view.toolName), upstream: normalizedName(view.upstreamToolName), input: stableJson(view.toolInput) });
    byRun.set(view.runId, entries);
  }
  return {
    match(item) {
      const runId = runIdFromToolItemId(item.id);
      const entries = runId ? byRun.get(runId) : undefined;
      if (!entries || !item.rawName) return null;
      const raw = normalizedName(item.rawName);
      const candidates = entries.filter((entry) => nameMatches(raw, entry));
      if (candidates.length === 0) return null;
      if (candidates.length > 1 && item.input !== undefined) {
        const input = stableJson(item.input);
        for (let index = candidates.length - 1; index >= 0; index -= 1) {
          if (candidates[index]!.input === input) return candidates[index]!.view;
        }
      }
      return candidates[candidates.length - 1]!.view;
    },
  };
}

const indexCache = new WeakMap<readonly McpAppViewSummary[], McpAppViewIndex>();

/** One index per loaded view list, shared by every tool row of the task. */
export function mcpAppViewIndexFor(views: readonly McpAppViewSummary[]): McpAppViewIndex {
  let index = indexCache.get(views);
  if (!index) {
    index = createMcpAppViewIndex(views);
    indexCache.set(views, index);
  }
  return index;
}

export function matchMcpAppView(
  item: { id: string; rawName?: string; input?: unknown },
  views: readonly McpAppViewSummary[],
): McpAppViewSummary | null {
  return mcpAppViewIndexFor(views).match(item);
}
