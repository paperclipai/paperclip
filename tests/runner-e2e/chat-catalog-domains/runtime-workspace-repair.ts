import { randomUUID, createHash } from "node:crypto";
import { mkdir, readFile, realpath, lstat, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { IssueRecoveryAction } from "../../../packages/shared/src/types/issue.js";
import type { EnvironmentLease } from "../../../packages/shared/src/types/environment.js";
import type { NativeWorkspaceSyncReference } from "../../../server/src/services/native-runtime/native-workspace-sync.js";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { collectRunEvents } from "../run-observations.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { createOwnedDaytonaTarget, deleteOwnedDaytonaTarget, type OwnedDaytonaTarget } from "./runtime-daytona-target.js";
import { runtimeDefinition, runtimeObservation, runtimeWorker, observeRuntime } from "./runtime-support.js";
import type { NativeFaultRun } from "./runtime-native-fault.js";
import { runtimePrivateSpec } from "./runtime-private.js";
type RecoveryList = { active?: IssueRecoveryAction; actions: IssueRecoveryAction[] };
type WorkspaceView = { workspace: { id: string; companyId: string; cwd: string }; issueId?: string };
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const targets = new WeakMap<ChatCatalogContext, OwnedDaytonaTarget>();
export function failedExportBound(input: { run: NativeFaultRun; action: IssueRecoveryAction; lease: EnvironmentLease; companyId: string; taskId: string; agentId: string; environmentId: string; acceptedResult: boolean }) {
  const { run, action, lease } = input, ref = record(record(run.runnerProfileJson).nativeWorkspaceSync);
  return input.acceptedResult && run.companyId === input.companyId && run.agentId === input.agentId && run.nativeIssueId === input.taskId && run.runtimeMode === "native" && run.status === "failed" && run.nativePhase === "terminal_failure"
    && ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(action.cause) && ["active", "escalated"].includes(action.status) && action.ownerType === "board" && action.companyId === input.companyId && action.sourceIssueId === input.taskId && action.evidence.runId === run.id && action.returnOwnerAgentId === input.agentId
    && ref.state === "prepared" && ref.workspaceId === lease.executionWorkspaceId && ref.leaseId === lease.id && ref.providerLeaseId === lease.providerLeaseId && /^[a-f0-9]{64}$/.test(String(ref.descriptorSha256)) && /^[a-f0-9]{64}$/.test(String(ref.baselineSha256))
    && lease.companyId === input.companyId && lease.environmentId === input.environmentId && lease.issueId === input.taskId && lease.heartbeatRunId === run.id && lease.provider === "daytona" && !!lease.providerLeaseId;
}
/** Actual new target + genuine native work. The only host mutation is an explicit
 * newer human edit AFTER the native baseline was captured, causing a real merge
 * conflict. Neither a run state nor recovery row is written by the fixture. */
export async function prepareFailedWebsiteExport(ctx: ChatCatalogContext) {
  const target = await createOwnedDaytonaTarget(ctx); targets.set(ctx, target);
  if (target.qualifiedHarness !== "codex") throw new Error("Workspace export fixture requires the selected actual qualified Codex harness");
  const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT;
  if (!root) throw new Error("Remote destination requires the owned attempt root");
  const ownedRoot = await realpath(root), cwd = path.join(ownedRoot, `website-export-${ctx.input.nonce}`);
  await mkdir(cwd, { mode: 0o700 });
  if (await realpath(cwd) !== cwd) throw new Error("Remote export destination is not the actual owned directory");
  const baseline = `<!doctype html><html><body><h1>Acorn baseline ${ctx.input.nonce}</h1></body></html>\n`;
  const newer = `<!doctype html><html><body><h1>Newer human headline ${ctx.input.nonce}</h1><p>Keep this human pricing edit.</p></body></html>\n`;
  const incoming = `<!doctype html><html><body><h1>Acorn recovered website ${ctx.input.nonce}</h1><p>Remote saved product draft.</p><button>Join the list</button></body></html>\n`;
  await writeFile(path.join(cwd, "website.html"), baseline, { flag: "wx" });
  const api = ctx.input.api, companyId = ctx.input.fixtures.company.id;
  const project = await api.post<Entity>(`/api/companies/${companyId}/projects`, { name: `Website recovery ${ctx.input.nonce}`, executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", environmentId: target.environmentId, workspaceStrategy: { type: "project_primary" } } });
  const source = await api.post<Entity>(`/api/projects/${project.id}/workspaces`, { name: "Owned recovery destination", sourceType: "local_path", cwd, isPrimary: true });
  await api.patch(`/api/projects/${project.id}`, { executionWorkspacePolicy: { enabled: true, defaultMode: "shared_workspace", defaultProjectWorkspaceId: source.id, environmentId: target.environmentId, workspaceStrategy: { type: "project_primary" } } });
  const base = ctx.input.execution.profile.buildAgent({ environmentId: target.environmentId, environmentFixtureId: "daytona", workspacePath: cwd, secretRefs: ctx.input.fixtures.secretRefs, executionId: ctx.input.nonce });
  const { cwd: _cwd, ...config } = base.adapterConfig as Record<string, unknown>;
  const worker = await runtimeWorker(ctx, "Morgan", { defaultEnvironmentId: target.environmentId, adapterConfig: config });
  for (const scope of [{ scopeType: "company", scopeId: companyId }, { scopeType: "agent", scopeId: worker.id }]) await api.post(`/api/companies/${companyId}/budgets/policies`, { ...scope, amount: 500, hardStopEnabled: true, isActive: true, unpricedUsagePolicy: "allow" });
  const task = await api.post<Entity>(`/api/companies/${companyId}/issues`, { title: "Website task", projectId: project.id, status: "todo", assigneeAgentId: worker.id,
    description: `In this actual remote task workspace, first run node -e 'setTimeout(()=>console.log("Preparation finished"),20000)' and wait for its real output. Then replace website.html with exactly ${JSON.stringify(incoming)}. Register that actual website.html as a downloadable artifact work product titled website.html. Save a task comment identifying the saved page. Finish normally. Do not create other tasks, contact anyone, publish, or start services.` });
  const prepared = await pollUntil({ label: "Actual remote native baseline captured before newer human destination edit", deadlineAt: Date.now() + 240000, intervalMs: 250,
    load: async () => { const runs = (await ctx.allRuns()).filter(row => row.agentId === worker.id); const run = runs[0] && await api.get<NativeFaultRun>(`/api/heartbeat-runs/${runs[0].id}`); return { runs, run, reference: record(record(run?.runnerProfileJson).nativeWorkspaceSync) }; },
    accept: value => value.runs.length === 1 && value.run?.status === "running" && value.reference.state === "prepared",
    reject: value => value.runs.length > 1 || value.runs.some(row => ["succeeded", "failed", "cancelled", "timed_out"].includes(row.status)) ? "The real remote baseline was not captured before native completion" : undefined });
  const run = prepared.run!, reference = prepared.reference as unknown as NativeWorkspaceSyncReference;
  const workspace = await api.get<WorkspaceView>(`/api/issues/${task.id}/workspace`);
  if (workspace.workspace.id !== reference.workspaceId || workspace.workspace.companyId !== companyId || await realpath(workspace.workspace.cwd) !== cwd || await readFile(path.join(cwd, "website.html"), "utf8") !== baseline) throw new Error("The actual prepared remote baseline does not bind the owned unchanged host destination");
  await writeFile(path.join(cwd, "website.html"), newer, "utf8");
  const failed = await pollUntil({ label: "Genuine accepted remote Website result with export merge conflict", deadlineAt: Date.now() + 360000,
    load: async () => ({ run: await api.get<NativeFaultRun>(`/api/heartbeat-runs/${run.id}`), recovery: await api.get<RecoveryList>(`/api/issues/${task.id}/recovery-actions`) }),
    accept: value => value.run.status === "failed" && value.run.nativePhase === "terminal_failure" && !!value.recovery.active && ["native_workspace_sync_out_unrecoverable", "native_workspace_sync_out_retry_exhausted"].includes(value.recovery.active.cause),
    reject: value => ["succeeded", "cancelled", "timed_out"].includes(value.run.status) ? "Actual remote execution did not produce the required failed export context" : undefined });
  const action = failed.recovery.active!, lease = await api.get<EnvironmentLease>(`/api/environment-leases/${reference.leaseId}`);
  const events = await collectRunEvents<{ seq?: number; payload?: unknown }>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${run.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
  const acceptedResult = events.some(row => record(record(row.payload).prpEvent).eventType === "run.result.accepted");
  if (!failedExportBound({ run: failed.run, action, lease, companyId, taskId: task.id, agentId: worker.id, environmentId: target.environmentId, acceptedResult }) || await readFile(path.join(cwd, "website.html"), "utf8") !== newer) throw new Error("The actual export failure lacks accepted result, source attribution or preservation of the newer destination");
  const [artifact] = await readRegisteredArtifacts(api, task.id, run.id, ["website.html"]);
  if (!artifact || artifact.content !== incoming || artifact.sha256 !== digest(incoming)) throw new Error("The actual saved remote attachment is not the retained expected website source");
  return { target, worker, task, project, cwd, baseline, newer, incoming, workspace, reference, originalRun: failed.run, originalEventReceipts: events.map(row => ({ seq: row.seq, sha256: digest(JSON.stringify(row.payload)) })), action, lease, artifact, acceptedResult, newerEditPreserved: true };
}
export async function cleanupFailedWebsiteExport(ctx: ChatCatalogContext) { const target = targets.get(ctx); if (target) { await deleteOwnedDaytonaTarget(ctx, target); targets.delete(ctx); } }
export function repairGuidance(reply: string) { return /recover|repair|reconcil|compar|retained|saved (?:source|work|files)/i.test(reply) && /newer|human edit|current (?:edit|destination|file)/i.test(reply) && /human|board|operator|your (?:decision|approval)|you (?:can|must|need)/i.test(reply) && !/(?:I(?:'ve| have)?|already|successfully)\s+(?:recovered|restored|overwritten|replaced)|all (?:files|work).*(?:recovered|restored)/i.test(reply); }
export function gradeWorkspaceRepair(value: unknown) {
  const c = checks(), o = runtimeObservation(value); c.add("real-failed-export-and-held-newer-destination", !!o, "A genuinely accepted native result must fail physical export against actual newer human edits."); if (!o) return c.result(); const s = o.state;
  c.add("same-actual-source-and-honest-human-guidance", s.failedSourceBound === true && s.newerHeldBeforeHuman === true && repairGuidance(String(s.guidanceReply)), "Canonical chat identifies retained work/newer edits and directs the board repair path without performing a board-only attestation or claiming recovery.");
  c.add("unresolved-conflict-stays-held", s.firstRepairBlocked === true && s.noPrematureNewNativeWork === true && s.firstNewerPreserved === true, "The first actual authorized recovery cannot overwrite a newer destination; failure/uncertainty remains visible.");
  c.add("actual-human-comparison-and-verified-physical-recovery", s.humanComparedActualSources === true && s.newerBackupVerified === true && s.actualPhysicalCopyback === true && s.finalRecoveryStatus === "recovered" && s.recoveryActorBound === true, "Actual source bytes were compared; the human's newer version survives durably and exact retained remote files are physically restored with run/lease/descriptor receipts.");
  const reply = String(s.confirmationReply ?? "");
  c.add("phase-bound-accurate-result-and-loss-report", s.confirmationBound === true && /recover|restor|saved|copied|preserv/i.test(reply) && /newer|backup|human edit/i.test(reply) && !/all (?:missing|lost) (?:work|files).*(?:recovered|restored)|nothing (?:was |is )?lost/i.test(reply), "A subsequent factual human turn receives its own native reply reporting actual recovered sources and preserved newer work without claiming unsupported recovery.");
  c.add("original-failure-and-scope-retained", s.originalFailureRetained === true && s.originalEventsRetained === true && s.acceptedResultNotReplayed === true && o.tasks.length === 1 && o.tasks[0]?.id === (s.task as Entity).id && o.runs.length === 3 && o.runs.every(row => row.status === "succeeded"), "The original failure cause/action and accepted result remain inspectable; normal finalization completes that same result without another provider turn, alongside only two declared controller turns.");
  return c.result();
}
const spec = runtimePrivateSpec("recovery.workspace-repair");
export const runtimeWorkspaceRepairCases = [runtimeDefinition("recovery.workspace-repair", async ctx => { try { return await prepareFailedWebsiteExport(ctx); } catch (error) { await cleanupFailedWebsiteExport(ctx); throw error; } }, gradeWorkspaceRepair, {
  authentication: "human-session", expectedHumanMessageCount: 2, expectedRunCount: 3, attemptTimeoutMs: 1500000,
  ...spec,
  setupPolicy: { readiness: "preserve-scenario", invariantCheckIds: ["actual-board-owned-failed-export-newer-destination-held"] },
  sourceFiles: ["chat-catalog-domains/runtime-workspace-repair.ts", "chat-catalog-domains/runtime-daytona-target.ts", "chat-catalog-domains/runtime-support.ts", "registered-artifact.ts", "../../server/src/services/workspace-recovery.ts", "../../server/src/services/native-runtime/native-workspace-sync.ts", "../../ui/src/components/WorkspaceExportRecovery.tsx", "chat-scenarios/recovery.yaml"],
  async verifySetup(ctx, s) {
    const run = await ctx.input.api.get<NativeFaultRun>(`/api/heartbeat-runs/${(s.originalRun as NativeFaultRun).id}`), recovery = await ctx.input.api.get<RecoveryList>(`/api/issues/${(s.task as Entity).id}/recovery-actions`);
    const action = recovery.actions.find(row => row.id === (s.action as IssueRecoveryAction).id), lease = await ctx.input.api.get<EnvironmentLease>(`/api/environment-leases/${(s.reference as NativeWorkspaceSyncReference).leaseId}`);
    s.failedSourceBound = !!action && failedExportBound({ run, action, lease, companyId: ctx.input.fixtures.company.id, taskId: (s.task as Entity).id, agentId: (s.worker as Entity).id, environmentId: (s.target as OwnedDaytonaTarget).environmentId, acceptedResult: s.acceptedResult === true });
    const c = checks(); c.add("actual-board-owned-failed-export-newer-destination-held", s.failedSourceBound === true && await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.newer, "Actual native terminal export failure, accepted retained attachment, exact source lease and newer destination persist before the canonical query."); return c.result();
  },
  async act(ctx, s) {
    const api = ctx.input.api, task = s.task as Entity, original = s.originalRun as NativeFaultRun, actionId = (s.action as IssueRecoveryAction).id;
    await pollUntil({ label: "Canonical recovery guidance from its actual native source run", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.source?.conversationState === "waiting" && v.runs.length === 2 && v.runs.filter(row => row.status === "succeeded").length === 1 });
    const first = await observeRuntime(ctx, s); s.guidanceReply = first.reply;
    s.newerHeldBeforeHuman = await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.newer; s.noPrematureNewNativeWork = first.runs.length === 2;
    if (!s.newerHeldBeforeHuman) throw new Error("Canonical chat overwrote the newer human destination before authorized reconciliation");
    await api.post(`/api/issues/${task.id}/recovery-actions/recover-workspace`, { actionId, runId: original.id, idempotencyKey: randomUUID() });
    const blocked = await pollUntil({ label: "Real recovery holds the unresolved destination conflict", deadlineAt: Date.now() + 240000,
      load: () => api.get<RecoveryList>(`/api/issues/${task.id}/recovery-actions`), accept: v => record(v.actions.find(row => row.id === actionId)?.evidence.workspaceRecovery).status === "blocked" });
    s.firstRepairBlocked = record(blocked.actions.find(row => row.id === actionId)?.evidence.workspaceRecovery).status === "blocked";
    s.firstNewerPreserved = await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.newer;
    const [actualSource] = await readRegisteredArtifacts(api, task.id, original.id, ["website.html"]); const newer = await readFile(path.join(String(s.cwd), "website.html"), "utf8");
    s.humanComparedActualSources = actualSource?.content === s.incoming && newer === s.newer && actualSource.content !== newer;
    if (!s.humanComparedActualSources) throw new Error("The human reconciliation does not have the exact actual retained remote and current destination bytes");
    const backup = path.join(String(s.cwd), "newer-human-website-preserved.html"); await writeFile(backup, newer, { flag: "wx" });
    s.newerBackupVerified = (await lstat(backup)).isFile() && await realpath(backup) === backup && await readFile(backup, "utf8") === s.newer;
    // The human chooses the verified remote version after durably preserving
    // their newer version. Restoring the known original baseline resolves only
    // this explicit conflict; normal board recovery performs the actual export.
    await writeFile(path.join(String(s.cwd), "website.html"), String(s.baseline), "utf8");
    await api.post(`/api/issues/${task.id}/recovery-actions/recover-workspace`, { actionId, runId: original.id, idempotencyKey: randomUUID() });
    const repaired = await pollUntil({ label: "Actual retained source physically recovered through board-owned service", deadlineAt: Date.now() + 300000,
      load: async () => ({ recovery: await api.get<RecoveryList>(`/api/issues/${task.id}/recovery-actions`), run: await api.get<NativeFaultRun>(`/api/heartbeat-runs/${original.id}`), operations: await api.get<Array<{ id: string; phase: string; companyId: string; heartbeatRunId: string; status: string; metadata: Record<string, unknown> }>>(`/api/execution-workspaces/${(s.workspace as WorkspaceView).workspace.id}/workspace-operations`) }),
      accept: v => record(v.recovery.actions.find(row => row.id === actionId)?.evidence.workspaceRecovery).status === "recovered" && v.run.status === "succeeded" });
    s.finalRecoveryStatus = "recovered"; const ref = record(record(repaired.run.runnerProfileJson).nativeWorkspaceSync), leaseRef = s.reference as NativeWorkspaceSyncReference;
    s.actualPhysicalCopyback = ref.state === "finalized" && !!ref.finalHostSha256 && repaired.operations.some(row => row.phase === "workspace_recovery" && row.status === "succeeded" && row.companyId === first.companyId && row.heartbeatRunId === original.id && row.metadata.leaseId === leaseRef.leaseId && row.metadata.providerLeaseId === leaseRef.providerLeaseId && row.metadata.descriptorSha256 === ref.descriptorSha256 && row.metadata.finalHostSha256 === ref.finalHostSha256)
      && await readFile(path.join(String(s.cwd), "website.html"), "utf8") === s.incoming && await readFile(backup, "utf8") === s.newer;
    const activity = await api.get<Array<{ action: string; entityId: string; actorType: string; actorId: string; runId?: string }>>(`/api/companies/${first.companyId}/activity?limit=100`), person = await api.get<{ user: { id: string } }>("/api/auth/get-session");
    s.recoveryActorBound = activity.filter(row => row.action === "issue.workspace_recovery_requested" && row.entityId === task.id && row.runId === original.id && row.actorType === "user" && row.actorId === person.user.id).length === 2;
    const retainedAction = repaired.recovery.actions.find(row => row.id === actionId);
    const retainedEvents = await collectRunEvents<{ seq?: number; payload?: unknown }>((afterSeq, limit) => api.get(`/api/heartbeat-runs/${original.id}/events?afterSeq=${afterSeq}&limit=${limit}`));
    s.originalFailureRetained = repaired.run.id === original.id && retainedAction?.cause === (s.action as IssueRecoveryAction).cause && retainedAction.evidence.runId === original.id && (s.originalRun as NativeFaultRun).status === "failed";
    s.originalEventsRetained = (s.originalEventReceipts as Array<{ seq: number; sha256: string }>).every(before => retainedEvents.some(after => after.seq === before.seq && digest(JSON.stringify(after.payload)) === before.sha256));
    s.acceptedResultNotReplayed = retainedEvents.filter(row => record(record(row.payload).prpEvent).eventType === "run.result.accepted").length === 1 && retainedEvents.filter(row => { const event = record(record(row.payload).prpEvent); return event.eventType === "turn.started" && event.sourceKind === "runner"; }).length === 1;
    const beforeRuns = (await ctx.allRuns()).map(row => row.id), followup = "The board recovery has finished. Please inspect the saved website and recovery receipts, and report exactly which files were recovered, whether my newer human edits were preserved, and any work that is still missing. Do not retry the failed task or claim unsupported recovery.";
    await sendChatMessage(ctx.input.page, followup);
    const finished = await pollUntil({ label: "Factual physical recovery report in its own native reply phase", deadlineAt: Date.now() + 180000, load: async () => { await ctx.refreshIssue(); return { source: ctx.issue(), runs: await ctx.allRuns() }; }, accept: v => v.source?.conversationState === "waiting" && v.runs.length === 3 && v.runs.every(row => row.status === "succeeded") });
    const next = finished.runs.find(row => !beforeRuns.includes(row.id))!, comments = await api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(row => !row.authorAgentId && row.body === followup);
    s.confirmationBound = human.length === 1 && Array.isArray(next.contextSnapshot?.wakeCommentIds) && next.contextSnapshot.wakeCommentIds.length === 1 && next.contextSnapshot.wakeCommentIds[0] === human[0]!.id;
    s.confirmationReply = comments.filter(row => row.createdByRunId === next.id && row.authorAgentId === first.leadId).map(row => row.body).join("\n");
  },
  async observe(ctx, s) { return observeRuntime(ctx, s); },
  async verifyResult(ctx, s) { const source = ctx.input.page.url(), task = s.task as Entity; await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" }); await expect(ctx.input.page.getByRole("heading", { name: "Website task", exact: true }).first()).toBeVisible(); await expect(ctx.input.page.getByText(/saved work recovered|workspace|failed/i).first()).toBeVisible(); await ctx.input.capture("workspace-repair-result", "Actual task retains recovery history and recovered saved work", "runtime-workspace-repair.png"); await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" }); },
  async cleanup(ctx) { await cleanupFailedWebsiteExport(ctx); },
})];
