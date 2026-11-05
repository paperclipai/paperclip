import { chatConversations, heartbeatRuns, issues, taskProviderOutputPolicies, type Db } from "@paperclipai/db";
import { isUuidLike } from "@paperclipai/shared";
import { and, eq } from "drizzle-orm";
import { boundRunIssueId, runTaskContextColumn } from "./run-task-binding.js";

type DbTransaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
type DbOrTransaction = Db | DbTransaction;

export async function retainTaskProviderOutputPolicy(
  tx: DbOrTransaction,
  input: { companyId: string; issueId: string; disposition: "ordinary" | "forbidden" },
): Promise<void> {
  const insert = tx.insert(taskProviderOutputPolicies).values(input);
  if (input.disposition === "forbidden") {
    await insert.onConflictDoUpdate({
      target: taskProviderOutputPolicies.issueId,
      set: { disposition: "forbidden" },
      setWhere: eq(taskProviderOutputPolicies.companyId, input.companyId),
    });
  } else {
    await insert.onConflictDoNothing();
  }
}

export async function taskForbidsProviderOutput(
  tx: Pick<DbOrTransaction, "select">,
  input: { companyId: string; issueId: string },
  options?: { lock?: "share"; noWait?: boolean },
): Promise<boolean> {
  const query = tx.select({ disposition: taskProviderOutputPolicies.disposition })
    .from(taskProviderOutputPolicies)
    .where(and(
      eq(taskProviderOutputPolicies.companyId, input.companyId),
      eq(taskProviderOutputPolicies.issueId, input.issueId),
    ));
  const [policy] = await (options?.lock === "share" ? query.for("share", { noWait: options.noWait ?? true }) : query);
  if (policy) return policy.disposition === "forbidden";
  // A legacy binding without a server-owned disposition is not guest authority.
  const [binding] = await tx.select({ id: chatConversations.id }).from(chatConversations)
    .where(and(
      eq(chatConversations.companyId, input.companyId),
      eq(chatConversations.issueId, input.issueId),
    )).limit(1);
  return Boolean(binding);
}

export async function inheritTaskProviderOutputPolicyFromRun(
  tx: DbOrTransaction,
  input: { companyId: string; issueId: string; runId?: string | null },
): Promise<void> {
  const runId = input.runId;
  if (!runId || !isUuidLike(runId)) return;
  const [run] = await tx.select({
    nativeIssueId: heartbeatRuns.nativeIssueId,
    issueId: heartbeatRuns.issueId,
    contextSnapshot: runTaskContextColumn,
  }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, runId),
  ));
  const sourceIssueId = run ? boundRunIssueId(run) : null;
  if (sourceIssueId && isUuidLike(sourceIssueId)) {
    await inheritTaskProviderOutputPolicy(tx, { companyId: input.companyId, issueId: input.issueId, sourceIssueId });
  }
}

export async function inheritTaskProviderOutputPolicy(
  tx: DbOrTransaction,
  input: { companyId: string; issueId: string; sourceIssueId: string },
): Promise<void> {
  const [source] = await tx.select({ id: issues.id }).from(issues).where(and(
    eq(issues.companyId, input.companyId), eq(issues.id, input.sourceIssueId),
  ));
  if (source && await taskForbidsProviderOutput(tx, { companyId: input.companyId, issueId: source.id })) {
    await retainTaskProviderOutputPolicy(tx, { companyId: input.companyId, issueId: input.issueId, disposition: "forbidden" });
  }
}
