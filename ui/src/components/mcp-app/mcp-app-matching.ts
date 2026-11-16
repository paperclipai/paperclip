import type { McpAppViewSummary } from "@paperclipai/shared";

export interface McpAppViewIndex {
  /** The views a run recorded, oldest first. */
  forRun(runId: string): McpAppViewSummary[];
}

const EMPTY: McpAppViewSummary[] = [];

/** Groups a task's views by run once; each reply then reads only its own run. */
export function createMcpAppViewIndex(views: readonly McpAppViewSummary[]): McpAppViewIndex {
  const byRun = new Map<string, McpAppViewSummary[]>();
  for (const view of views) {
    if (!view.runId) continue;
    const list = byRun.get(view.runId);
    if (list) list.push(view);
    else byRun.set(view.runId, [view]);
  }
  return { forRun: (runId) => byRun.get(runId) ?? EMPTY };
}

const indexCache = new WeakMap<readonly McpAppViewSummary[], McpAppViewIndex>();

/** One index per loaded view list, shared by every reply of the task. */
export function mcpAppViewIndexFor(views: readonly McpAppViewSummary[]): McpAppViewIndex {
  let index = indexCache.get(views);
  if (!index) {
    index = createMcpAppViewIndex(views);
    indexCache.set(views, index);
  }
  return index;
}
