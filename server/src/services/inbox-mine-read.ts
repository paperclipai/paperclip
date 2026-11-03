import type { InboxSourceError } from "@paperclipai/shared";

type IssueRow = { id: string; parentId?: string | null };
type RunRow = { id: string; issueId?: unknown; contextSnapshot?: unknown };
type ContextResult<I> = { issues: I[]; error?: InboxSourceError };
const CONTEXT_BATCH_SIZE = 100;

export function inboxFailureIssueId(run: RunRow): string | null {
  if (typeof run.issueId === "string" && run.issueId) return run.issueId;
  const context = run.contextSnapshot;
  if (!context || typeof context !== "object" || Array.isArray(context)) return null;
  for (const key of ["issueId", "taskId"] as const) {
    const value = (context as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/** Compose canonical, authorized reads without a browser round trip between them. */
export async function readInboxMine<I extends IssueRow, R extends RunRow>(deps: {
  loadIssues(): Promise<I[]>;
  loadFailures(): Promise<R[]>;
  loadContext(ids: string[], projection: "index" | "rows"): Promise<I[]>;
  sourceError(error: unknown, source: "failures" | "context"): InboxSourceError;
}) {
  const loadContext = async (ids: string[], projection: "index" | "rows"): Promise<ContextResult<I>> => {
    try {
      const issues: I[] = [];
      for (let offset = 0; offset < ids.length; offset += CONTEXT_BATCH_SIZE) {
        issues.push(...await deps.loadContext(ids.slice(offset, offset + CONTEXT_BATCH_SIZE), projection));
      }
      return { issues };
    } catch (error) {
      return { issues: [], error: deps.sourceError(error, "context") };
    }
  };
  const issuesPromise = deps.loadIssues();
  const failuresPromise = deps.loadFailures().then(
    (runs) => ({ runs, error: undefined as InboxSourceError | undefined }),
    (error: unknown) => ({ runs: [] as R[], error: deps.sourceError(error, "failures") }),
  );
  // Start each branch as soon as its own input arrives. In particular, rich
  // failure reads do not wait for the primary task list or its parent captions.
  const parentsPromise = issuesPromise.then((issues) => {
    const loaded = new Set(issues.map((issue) => issue.id));
    const ids = [...new Set(issues.map((issue) => issue.parentId)
      .filter((id): id is string => typeof id === "string" && id.length > 0 && !loaded.has(id)))].sort();
    return loadContext(ids, "index");
  });
  const failureContextPromise = failuresPromise.then(async ({ runs }) => {
    const ids = [...new Set(runs.map(inboxFailureIssueId).filter((id): id is string => Boolean(id)))].sort();
    return { ...await loadContext(ids, "rows"), ids };
  });
  // Admission remains occupied until every started read settles, including when
  // the critical primary query fails while a failure read is still running.
  const results = await Promise.allSettled([
    issuesPromise, failuresPromise, parentsPromise, failureContextPromise,
  ]);
  const [issueResult, failuresResult, parentsResult, contextResult] = results;
  if (issueResult.status === "rejected") throw issueResult.reason;
  if (failuresResult.status === "rejected") throw failuresResult.reason;
  if (parentsResult.status === "rejected") throw parentsResult.reason;
  if (contextResult.status === "rejected") throw contextResult.reason;
  const issues = issueResult.value, failures = failuresResult.value;
  const parents = parentsResult.value, failureContext = contextResult.value;
  // A task that serves both roles keeps its canonical rich failure state.
  const context = new Map(parents.issues.map((issue) => [issue.id, issue]));
  for (const issue of failureContext.issues) context.set(issue.id, issue);
  return {
    issues,
    contextIssues: [...context.values()],
    failureRuns: failures.runs,
    failureIssueIds: failureContext.error ? [] : failureContext.ids,
    ...(failures.error ? { failureError: failures.error } : {}),
    ...(parents.error || failureContext.error ? { contextError: parents.error ?? failureContext.error } : {}),
  };
}
