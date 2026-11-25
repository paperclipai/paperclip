import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { EnvironmentLease } from "../../../packages/shared/src/types/environment.js";
import type { NativeWorkspaceSyncReference } from "../../../server/src/services/native-runtime/native-workspace-sync.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { collectRunEvents } from "../run-observations.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { prepareFailedWebsiteExport, cleanupFailedWebsiteExport } from "./runtime-workspace-repair.js";
import { destroyOwnedFailedSandbox } from "./runtime-daytona-destroy.js";
import { selectedRuntimeInputs, runtimePrivateSpec } from "./runtime-private.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import type { OwnedDaytonaTarget } from "./runtime-daytona-target.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
type RecoveryList = { active?: IssueRecoveryAction; actions: IssueRecoveryAction[] };
export function destroyedLeaseBound(lease: EnvironmentLease, input: { companyId: string; taskId: string; runId: string; leaseId: string; sandboxId: string; environmentId: string }) {
  const termination = record(lease.metadata?.remoteExecutionTermination);
  return lease.id === input.leaseId && lease.companyId === input.companyId && lease.issueId === input.taskId && lease.heartbeatRunId === input.runId && lease.environmentId === input.environmentId && lease.provider === "daytona" && lease.providerLeaseId === input.sandboxId && termination.state === "destroyed" && lease.metadata?.pendingCleanupInFlight !== true;
}
export function lostSandboxGuidance(reply: string) { return /saved (?:sources?|attachments?)|surviv(?:ing|ed).*(?:files?|attachments?)|attached.*(?:files?|source)/i.test(reply) && /human|board|operator|you (?:can|must|need)/i.test(reply) && /reconstruct|rebuild|continue/i.test(reply) && /destroy|lost|missing|unrecover|cannot|can't|not recover/i.test(reply) && !/(?:human|board|operator) (?:approval|decision|action) (?:is |was )?(?:not (?:needed|required)|unnecessary)|\b(?:can|will)\b[^.!?\n]{0,100}\b(?:rebuild|reconstruct|continue)\b[^.!?\n]{0,60}\bwithout (?:any )?(?:human|board|operator) (?:approval|decision|action)/i.test(reply) && !/(?:I(?:'ve| have)?|already|successfully)\s+(?:recovered|restored|reconstructed)|all.*lost.*(?:recovered|restored)/i.test(reply); }
export function gradeLostSandbox(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("real-historical-failure-destroyed-source-and-survivors", !!o, "A real failed export, actual exact provider destruction, independent platform proof and durable attributed survivors are required."); if (!o) return c.result(); const s = o.state;
  c.add("exact-destroyed-platform-allocation-and-surviving-source", s.exactProviderDestroyed === true && s.platformDestructionBound === true && s.survivingAttachmentVerified === true && s.noReconstructionBeforeHuman === true && lostSandboxGuidance(String(s.guidanceReply)), "Chat identifies the actual saved sources and destroyed original; no agent or fixture may reconstruct before the authorized human decision.");
  c.add("actual-routed-human-decision-with-explicit-known-losses", s.actualReconstructionUi === true && s.actualReconstructionStatus === 202 && s.humanDecisionBound === true && s.missingWorkAcknowledged === true, "The actual routed Continue from saved sources control selects the actual attachment, records losses/previous external effects and explicit human acknowledgement.");
  c.add("fresh-supported-admission-consumes-actual-decision", s.freshSessionBound === true && s.decisionSourcesBound === true && s.reconstructedArtifactVerified === true && s.newerWorkPreserved === true, "Exactly one fresh native worker session is admitted through normal gates with real source receipts; its actual reconstructed page is grounded in the selected surviving bytes while newer destination work remains intact.");
  c.add("old-failure-events-and-no-silent-loss-recovery", s.originalFailureRetained === true && s.originalEventsRetained === true && s.confirmationBound === true && /saved|surviv|attach|source/i.test(String(s.confirmationReply)) && /reconstruct|rebuilt|recover|preserv/i.test(String(s.confirmationReply)) && /lost|missing|unattached|cannot|can't|only.*(?:source|attachment)/i.test(String(s.confirmationReply)) && !/all.*lost.*(?:recovered|restored)|nothing (?:was |is )?lost/i.test(String(s.confirmationReply)), "The final own-phase reply distinguishes reconstruction from unsupported recovery; the old failed native run and immutable original events survive.");
  c.add("exact-native-and-task-scope", o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.runs.length === 4 && o.runs.filter(row => row.status === "failed").length === 1 && o.runs.filter(row => row.status === "succeeded").length === 3, "One original failed source, one reconstruction worker and two explicit controller turns are the entire native history.");
  return c.result();
}
export const runtimeLostSandboxCases = [runtimeDefinition("workspaces.recover-lost-sandbox", async ctx => {
  try {
    const s = await prepareFailedWebsiteExport(ctx), selected = selectedRuntimeInputs(ctx, "workspaces.recover-lost-sandbox"), ref = s.reference, companyId = ctx.input.fixtures.company.id;
    if (!ctx.input.privateSecrets) throw new Error("Exact provider fault requires the retained private secret sink");
    const destruction = await destroyOwnedFailedSandbox({ scenarioId: "workspaces.recover-lost-sandbox", executionId: ctx.input.execution.id, binding: { companyId, environmentId: s.target.environmentId, taskId: s.task.id, runId: s.originalRun.id, leaseId: ref.leaseId, sandboxId: ref.providerLeaseId, actionId: s.action.id, attempt: ctx.input.nonce }, baseURL: ctx.input.api.baseURL, cookies: await ctx.input.page.context().cookies(ctx.input.api.baseURL), credential: selected.credentials.DAYTONA_API_KEY! }, ctx.input.privateSecrets);
    // The product must independently prove absence/termination itself. The
    // standalone SDK delete receipt never substitutes for platform evidence.
    await ctx.input.api.post(`/api/issues/${s.task.id}/recovery-actions/recover-workspace`, { actionId: s.action.id, runId: s.originalRun.id, idempotencyKey: randomUUID() });
    const gone = await pollUntil({ label: "Actual platform verifies historical sandbox destruction and holds reconstruction", deadlineAt: Date.now() + 240000,
      load: async () => ({ lease: await ctx.input.api.get<EnvironmentLease>(`/api/environment-leases/${ref.leaseId}`), run: await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${s.originalRun.id}`), recovery: await ctx.input.api.get<RecoveryList>(`/api/issues/${s.task.id}/recovery-actions`) }),
      accept: v => destroyedLeaseBound(v.lease, { companyId, taskId: s.task.id, runId: s.originalRun.id, leaseId: ref.leaseId, sandboxId: ref.providerLeaseId, environmentId: s.target.environmentId }) && v.run.status === "failed" && record(v.recovery.actions.find(row => row.id === s.action.id)?.evidence.workspaceRecovery).status === "blocked" });
    const [artifact] = await readRegisteredArtifacts(ctx.input.api, s.task.id, s.originalRun.id, ["website.html"]);
    return { ...s, destruction, exactProviderDestroyed: destruction.actualDeleteAccepted && destruction.independentlyAbsent, platformDestructionBound: true, providerFixtureOperations: [{ phase: "historical-source-loss", operation: "exact-owned-sandbox-delete-and-confirm-absence", status: "confirmed", usage: "unavailable", cost: "unavailable" }], destroyedLease: gone.lease, survivingAttachmentVerified: artifact?.sha256 === s.artifact.sha256 && artifact.content === s.incoming };
  } catch (error) { await cleanupFailedWebsiteExport(ctx); throw error; }
}, gradeLostSandbox, {
  ...runtimePrivateSpec("workspaces.recover-lost-sandbox"), authentication: "human-session", expectedHumanMessageCount: 2, expectedRunCount: 4, attemptTimeoutMs: 1800000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 3 } }, setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["real-failed-destroyed-sandbox-and-attributed-surviving-attachment"] },
  sourceFiles: ["chat-catalog-domains/runtime-lost-sandbox.ts", "chat-catalog-domains/runtime-workspace-repair.ts", "chat-catalog-domains/runtime-daytona-target.ts", "chat-catalog-domains/runtime-daytona-destroy.ts", "chat-catalog-domains/runtime-daytona-destroy-worker.ts", "remote-native-bootstrap.ts", "registered-artifact.ts", "../../server/src/services/native-runtime/native-workspace-reconstruction.ts", "../../server/src/services/workspace-recovery.ts", "../../ui/src/components/WorkspaceReconstructionRecovery.tsx", "chat-scenarios/workspaces.yaml"],
  async verifySetup(ctx, s) {
    const old = s.originalRun as NativeFaultRun, ref = s.reference as NativeWorkspaceSyncReference;
    const [run, lease, artifacts] = await Promise.all([ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${old.id}`), ctx.input.api.get<EnvironmentLease>(`/api/environment-leases/${ref.leaseId}`), readRegisteredArtifacts(ctx.input.api, (s.task as Entity).id, old.id, ["website.html"])]);
    const c = checks(); c.add("real-failed-destroyed-sandbox-and-attributed-surviving-attachment", run.status === "failed" && run.nativePhase === "terminal_failure" && destroyedLeaseBound(lease, { companyId: ctx.input.fixtures.company.id, taskId: (s.task as Entity).id, runId: old.id, leaseId: ref.leaseId, sandboxId: ref.providerLeaseId, environmentId: (s.target as OwnedDaytonaTarget).environmentId }) && artifacts[0]?.content === s.incoming && await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.newer, "The exact old failed native source is independently destroyed; actual surviving source and newer human destination remain present before canonical guidance."); return c.result();
  },
  async act(ctx, s) {
    const api = ctx.input.api, task = s.task as Entity, old = s.originalRun as NativeFaultRun, source = ctx.input.page.url();
    await pollUntil({ label: "Canonical lost-source guidance before board decision", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.filter(row => row.status === "succeeded").length === 1 });
    const first = await observeRuntime(ctx, s); s.guidanceReply = first.reply; s.noReconstructionBeforeHuman = first.runs.length === 2 && first.runs.filter(row => row.agentId === (s.worker as Entity).id).length === 1;
    if (!s.noReconstructionBeforeHuman || await readFile(path.join(String(s.cwd), "website.html"), "utf8") !== s.newer) throw new Error("Canonical guidance created premature work or overwrote the newer human destination");
    await writeFile(path.join(String(s.cwd), "newer-human-website-preserved.html"), String(s.newer), { flag: "wx" });
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
    const summary = ctx.input.page.getByText("Continue from saved sources", { exact: true }); await expect(summary).toBeVisible(); await summary.click(); s.actualReconstructionUi = true;
    await ctx.input.page.getByLabel(/^website\.html \(/).check();
    const plan = "Copy the surviving website.html attachment byte-for-byte into recovered-website.html and register that actual copy as the downloadable recovered-website.html artifact. Keep the newer destination website.html and newer-human-website-preserved.html byte-for-byte unchanged. The destroyed sandbox's other unregistered state is unavailable; do not claim it recovered. Complete this same task without creating another task, redoing external actions, or regenerating missing sources.";
    const evidence = "The previous native result saved the attached website source. No email, deployment or other external action was authorized or performed. Do not repeat any external action; preserve the original failed run.";
    await ctx.input.page.getByLabel("Missing work and reconstruction plan", { exact: true }).fill(plan);
    await ctx.input.page.getByLabel("Previously completed external actions", { exact: true }).selectOption("not_performed");
    await ctx.input.page.getByLabel("Evidence and actions that must not be repeated", { exact: true }).fill(evidence);
    await ctx.input.page.getByLabel("Continue from these sources. The missing edits have not been recovered.", { exact: true }).check(); s.missingWorkAcknowledged = true;
    const responsePromise = ctx.input.page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname === `/api/issues/${task.id}/recovery-actions/reconstruct-workspace`);
    await ctx.input.page.getByRole("button", { name: "Rebuild and continue", exact: true }).click(); s.actualReconstructionStatus = (await responsePromise).status();
    const rebuilt = await pollUntil({ label: "Fresh supported worker reconstruction after actual routed human decision", deadlineAt: Date.now() + 360000,
      load: async () => ({ task: await api.get<Entity>(`/api/issues/${task.id}`), runs: await ctx.allRuns(), recovery: await api.get<RecoveryList>(`/api/issues/${task.id}/recovery-actions`) }),
      accept: v => v.task.status === "done" && v.runs.length === 3 && v.runs.filter(row => row.status === "succeeded").length === 2,
      reject: v => v.runs.length > 3 || v.runs.some(row => row.id !== old.id && ["failed", "cancelled", "timed_out"].includes(row.status)) ? "Actual reconstruction failed or admitted extra work" : undefined });
    const next = rebuilt.runs.find(row => row.agentId === (s.worker as Entity).id && row.id !== old.id)!;
    const actual = await api.get<NativeFaultRun>(`/api/heartbeat-runs/${next.id}`), action = rebuilt.recovery.actions.find(row => row.id === (s.action as IssueRecoveryAction).id)!, decision = record(action.evidence.executionReconciliation), reconstruction = record(decision.workspaceReconstruction);
    const context = record(actual.contextSnapshot), selectedSources = reconstruction.sources as Array<{ attachmentId: string; sha256: string }> | undefined;
    s.freshSessionBound = actual.runtimeMode === "native" && actual.nativeIssueId === task.id && actual.companyId === first.companyId && actual.agentId === (s.worker as Entity).id && context.forceFreshSession === true && context.previousRunId === old.id && context.workspaceReconstructionActionId === action.id && !actual.sessionIdBefore && !!actual.sessionIdAfter && actual.nativeSessionId !== old.nativeSessionId && next.status === "succeeded";
    s.decisionSourcesBound = reconstruction.schema === "paperclip.workspace-reconstruction.v1" && reconstruction.missingWork === plan && selectedSources?.length === 1 && selectedSources[0]?.attachmentId === (s.artifact as { attachmentId: string }).attachmentId && selectedSources[0].sha256 === (s.artifact as { sha256: string }).sha256 && decision.outcomeEvidence === evidence && decision.actionOutcome === "not_performed";
    const person = await api.get<{ user: { id: string } }>("/api/auth/get-session"), activity = await api.get<Array<{ action: string; actorType: string; actorId: string; entityId: string }>>(`/api/issues/${task.id}/activity`);
    s.humanDecisionBound = s.decisionSourcesBound === true && activity.some(row => row.action === "issue.workspace_reconstruction_authorized" && row.actorType === "user" && row.actorId === person.user.id && row.entityId === task.id);
    const [artifact] = await readRegisteredArtifacts(api, task.id, actual.id, ["recovered-website.html"]);
    s.reconstructedArtifactVerified = artifact?.content === s.incoming;
    s.newerWorkPreserved = await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.newer && await readFile(path.join(String(s.cwd), "newer-human-website-preserved.html"), "utf8") === s.newer;
    const original = await api.get<NativeFaultRun>(`/api/heartbeat-runs/${old.id}`); s.originalFailureRetained = original.status === "failed" && original.errorCode === old.errorCode && original.nativeSessionId === old.nativeSessionId;
    const events = await collectRunEvents<{ seq?: number; payload?: unknown }>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${old.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    s.originalEventsRetained = (s.originalEventReceipts as Array<{ seq: number; sha256: string }>).every(before => events.some(after => after.seq === before.seq && digest(after.payload) === before.sha256));
    await ctx.input.capture("lost-sandbox-reconstructed", "The original routed Website task rebuilt from selected surviving sources", "runtime-lost-sandbox-reconstructed.png");
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
    const before = (await ctx.allRuns()).map(row => row.id), followup = "The human used Continue from saved sources and the reconstruction run has finished. Inspect the actual surviving attachment, reconstructed website and original failed run. Report what was reconstructed, whether the newer human edits survived, and which destroyed or unattached work is still unavailable. Do not claim that missing work was recovered.";
    await sendChatMessage(ctx.input.page, followup);
    const final = await pollUntil({ label: "Phase-bound factual reconstruction report", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.source?.conversationState === "waiting" && v.runs.length === 4 && v.runs.filter(row => row.status === "succeeded").length === 3 });
    const replyRun = final.runs.find(row => !before.includes(row.id))!, comments = await api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === followup);
    s.confirmationBound = human.length === 1 && Array.isArray(replyRun.contextSnapshot?.wakeCommentIds) && replyRun.contextSnapshot.wakeCommentIds.length === 1 && replyRun.contextSnapshot.wakeCommentIds[0] === human[0]!.id;
    s.confirmationReply = comments.filter(row => row.createdByRunId === replyRun.id && row.authorAgentId === first.leadId).map(row => row.body).join("\n");
  },
  observe: observeRuntime,
  async verifyResult(ctx, s) { const source = ctx.input.page.url(), task = s.task as Entity; await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: "Website task", exact: true }).first()).toBeVisible(); await expect(ctx.input.page.getByText(/recovered-website\.html/).first()).toBeVisible(); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  async cleanup(ctx) { await cleanupFailedWebsiteExport(ctx); },
})];
