// Simulate provider outcomes inside the isolated local inbox dev database.
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { and, eq } from "drizzle-orm";
import { agents, agentRuntimeState, approvals, closeRegisteredClients, companies, companyMemberships, createDb, getPostgresDataDirectory,
  heartbeatRunEvents, heartbeatRuns, inboxDismissals, issueRecoveryActions, issues } from "@paperclipai/db";

const phase = process.argv[2] ?? "reset";
if (!["reset", "one-left", "all-recovered", "repeat"].includes(phase)) throw new Error("Use reset, repeat, one-left, or all-recovered");
const dir = realpathSync(fileURLToPath(new URL("../../tmp/inbox-drive/instances/default/db", import.meta.url)));
const port = Number(readFileSync(dir + "/postmaster.pid", "utf8").split("\n")[3]);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Start the isolated dev server first");
const url = `postgres://paperclip:paperclip@127.0.0.1:${port}/paperclip`;
if (realpathSync((await getPostgresDataDirectory(url))!) !== dir) throw new Error("Unexpected database directory");
const db = createDb(url);
const id = (n: number) => `1b0a0000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const companyId = id(1);
const userId = "local-board";
const titles = ["Review the launch checklist", "Draft release notes", "Check help links", "Prepare the handoff", "Summarize test results"];
try {
  await db.transaction(async tx => {
    const [existing] = await tx.select().from(companies).where(eq(companies.id,companyId));
    if (existing && (existing.name !== "Inbox Test Drive" || existing.issuePrefix !== "IBX")) throw new Error("Fixture identity mismatch");
    if (phase !== "reset" && !existing) throw new Error("Run reset first");
    const now = new Date();
    if (phase === "reset") {
      await tx.insert(companies).values({ id: companyId, name: "Inbox Test Drive", issuePrefix: "IBX", issueCounter: 5,
        defaultDecisionOwnerUserId: userId }).onConflictDoNothing();
      await tx.insert(companyMemberships).values({ companyId, principalType: "user", principalId: userId, membershipRole: "owner" }).onConflictDoNothing();
      await tx.insert(approvals).values({ id: id(2), companyId, requestedByUserId: userId, type: "approve_ceo_strategy",
        payload: { title: "Approve the launch plan", plan: "Release the synthetic inbox after review." } })
        .onConflictDoUpdate({ target: approvals.id, set: { status: "pending", decidedAt: null, decidedByUserId: null, updatedAt: now } });
      await tx.delete(inboxDismissals).where(and(eq(inboxDismissals.companyId, companyId), eq(inboxDismissals.userId,userId)));
      await tx.delete(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId,companyId), eq(issueRecoveryActions.id,id(405))));
      await tx.update(issues).set({ status: "done", hiddenAt: now }).where(and(eq(issues.companyId, companyId),eq(issues.id,id(105))));
    }
    const [first] = await tx.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.id,id(401)));
    const resetAt = phase === "reset" ? new Date(+now + 5 * 3600_000).toISOString() : String(first?.evidence.providerLimitResetAt);
    for (let n = 1; n <= (phase === "repeat" ? 5 : 4); n++) {
      if (phase === "repeat" && n < 5) continue;
      const agentId = id(10 + ((n-1) % 2));
      const issueId = id(100+n);
      const runId = id(350+n);
      const recovered = phase === "all-recovered" || (phase === "one-left" && n < 4);
      const manual = phase === "one-left" && n === 4;
      const resumed = recovered && n === 1;
      const taskStatus = resumed ? "in_progress" : recovered ? "done" : "blocked";
      await tx.insert(agents).values({ id: agentId, companyId, name: n % 2 ? "Editor" : "Reviewer", status: "paused",
        runtimeConfig: { heartbeat: { enabled: false } } }).onConflictDoNothing();
      await tx.insert(issues).values({ id: issueId, companyId, issueNumber:n, identifier:`IBX-${n}`, title: titles[n-1]!,
        createdByUserId: userId, responsibleUserId: userId, assigneeAgentId: agentId, status: taskStatus })
        .onConflictDoUpdate({ target: issues.id, set: { status: taskStatus, hiddenAt: null, updatedAt: now } });
      const failure = { schema:"paperclip.provider-failure.v1", provider:"openai", phase:"startup", category:"quota_exhausted",
        retryability:"requires_action", message:"Five-hour usage limit reached", retryAt:resetAt };
      for (let attempt = phase === "repeat" ? 2 : 0; attempt < 3; attempt++) {
        const attemptId = attempt === 2 ? runId : id(200 + n*10 + attempt);
        const at = new Date(+now - (3-attempt)*60_000);
        await tx.insert(heartbeatRuns).values({ id:attemptId, companyId, agentId, issueId, scopeKind:"issue", nativeIssueId:issueId,
          responsibleUserId:userId, status:"failed", runtimeMode:"native", invocationSource:"on_demand",
          errorCode:"native_provider_usage_limit", error:failure.message, finishedAt:at, createdAt:at, updatedAt:at,
          resultJson:{ providerFailure:failure }, contextSnapshot:{ issueId, aiConnection:{subscriptionId:id(90),provider:"openai"} } })
          .onConflictDoUpdate({ target:heartbeatRuns.id, set:{ resultJson:{providerFailure:failure} } });
        await tx.insert(heartbeatRunEvents).values({ companyId,agentId,runId:attemptId,seq:1,eventType:"lifecycle",
          message:"Bounded retry exhausted: five-hour provider usage limit" }).onConflictDoNothing();
      }
      if (resumed) {
        await tx.insert(heartbeatRuns).values({ id: id(500+n), companyId, agentId, issueId, scopeKind:"issue",
          status:"succeeded", invocationSource:"on_demand", finishedAt:now, createdAt:now, contextSnapshot:{issueId} })
          .onConflictDoUpdate({target:heartbeatRuns.id,set:{createdAt:now,finishedAt:now}});
      } else if (phase === "reset") {
        await tx.delete(heartbeatRuns).where(and(eq(heartbeatRuns.companyId,companyId),eq(heartbeatRuns.id,id(500+n))));
      }
      const evidence = { runId, providerLimitResetAt:resetAt, providerLimitAutomatic:true,
        ...(manual ? {providerLimitResume:{state:"not_requested",reason:"automatic_retry_budget_used"}} : {}) };
      const status = recovered ? "resolved" : "active";
      const nextAction = manual ? "Retry this task after restoring capacity." : "Paperclip will retry this task at the reported reset.";
      await tx.insert(issueRecoveryActions).values({ id:id(400+n), companyId, sourceIssueId:issueId, kind:"active_run_watchdog",
        ownerType:"board", cause:"native_provider_usage_limit", fingerprint:runId, evidence, status, nextAction })
        .onConflictDoUpdate({ target:issueRecoveryActions.id, set:{ evidence,status,nextAction, resolvedAt:recovered ? now : null, updatedAt:now } });
    }
    if (phase === "reset") {
      // The agent status and its last failed run describe the same incident.
      const agentId = id(10);
      const error = "Five-hour usage limit reached";
      await tx.update(agents).set({ status: "error", errorReason: error }).where(and(eq(agents.companyId,companyId),eq(agents.id,agentId)));
      await tx.insert(agentRuntimeState).values({ agentId, companyId, adapterType:"process", lastRunId:id(353),
        lastRunStatus:"failed", lastError:error }).onConflictDoUpdate({target:agentRuntimeState.agentId,
        set:{lastRunId:id(353),lastRunStatus:"failed",lastError:error}});
    }
    if (phase === "one-left" || phase === "all-recovered") {
      await tx.update(issues).set({status:"done"}).where(and(eq(issues.companyId,companyId),eq(issues.id,id(105))));
      await tx.update(issueRecoveryActions).set({status:"resolved", resolvedAt:now}).where(and(eq(issueRecoveryActions.companyId,companyId),eq(issueRecoveryActions.id,id(405))));
    }
  });
  console.log(`Inbox Test Drive: ${phase}. Refresh the inbox.`);
} finally {
  await closeRegisteredClients(url, { scope: "database" });
}
