/**
 * Tasks read at the same time by one chat bootstrap request. Each task already
 * runs its own reads in parallel, so this bounds the database work a single
 * request can start when the database is the bottleneck.
 */
export const ISSUE_CHAT_BOOTSTRAP_TASK_CONCURRENCY = 2;

async function mapWithConcurrency<T, R>(items: readonly T[], concurrency: number, mapper: (item: T) => Promise<R>) {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await mapper(items[index]!);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Resolve task references, keep the readable ones and read each in request
 * order. Missing, foreign and unreadable references are omitted without a
 * trace. The caller owns company scoping, authorization and the per-task
 * payloads, which must match the individual task endpoints. A task named twice
 * (by UUID and by identifier) is read once and returned under each reference.
 */
export async function readIssueChatBootstrapItems<TIssue extends { id: string; companyId: string }, TPayload extends object>(input: {
  companyId: string;
  refs: readonly string[];
  resolve: (ref: string) => Promise<TIssue | null | undefined>;
  filterReadable: (issues: TIssue[]) => Promise<TIssue[]>;
  read: (issue: TIssue) => Promise<TPayload>;
  concurrency?: number;
}): Promise<Array<{ ref: string } & TPayload>> {
  const concurrency = input.concurrency ?? ISSUE_CHAT_BOOTSTRAP_TASK_CONCURRENCY;
  const resolved = await mapWithConcurrency(input.refs, concurrency, async (ref) => {
    const issue = await input.resolve(ref);
    return issue && issue.companyId === input.companyId ? { ref, issue } : null;
  });
  const found = resolved.filter((entry): entry is { ref: string; issue: TIssue } => entry !== null);
  const issuesById = new Map<string, TIssue>();
  for (const entry of found) if (!issuesById.has(entry.issue.id)) issuesById.set(entry.issue.id, entry.issue);
  const readable = await input.filterReadable([...issuesById.values()]);
  const payloads = new Map(
    (await mapWithConcurrency(readable, concurrency, async (issue) => [issue.id, await input.read(issue)] as const)),
  );
  return found.flatMap(({ ref, issue }) => {
    const payload = payloads.get(issue.id);
    return payload ? [{ ref, ...payload }] : [];
  });
}
