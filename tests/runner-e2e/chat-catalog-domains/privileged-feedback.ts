import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { expect } from "@playwright/test";
import type { FeedbackTrace, FeedbackTraceBundle, FeedbackVote } from "../../../packages/shared/src/types/feedback.js";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { prepareRuntimeWorkerGate, readRuntimeTaskGate, releaseRuntimeWorker } from "./runtime-busy-worker.js";
import { probeAgentPermission, cleanupIdentityProbes } from "./identity-support.js";
import { prepareOwnedCli, runOwnedCli, cleanupOwnedCli } from "./privileged-cli-support.js";
import { privilegedDefinition, privilegedObservation, companionPhase } from "./privileged-support.js";
const pendingFixtures = new WeakMap<Parameters<typeof prepareRuntimeWorkerGate>[0], { gate: Awaited<ReturnType<typeof prepareRuntimeWorkerGate>>; taskId?: string }>();
const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** CLI exports use stored ZIP entries. Independently compare every local entry,
 * reject hidden extras and unsafe names, and scan every actual archive byte. */
export function storedArchiveEntries(bytes: Buffer): Map<string, Buffer> {
  const rows = new Map<string, Buffer>(); let offset = 0;
  while (offset + 4 <= bytes.length && bytes.readUInt32LE(offset) === 0x04034b50) {
    if (offset + 30 > bytes.length || bytes.readUInt16LE(offset + 6) & 9 || bytes.readUInt16LE(offset + 8) !== 0) throw new Error("Unsupported feedback archive entry");
    const compressed = bytes.readUInt32LE(offset + 18), size = bytes.readUInt32LE(offset + 22), nameSize = bytes.readUInt16LE(offset + 26), extraSize = bytes.readUInt16LE(offset + 28);
    const begin = offset + 30 + nameSize + extraSize, end = begin + compressed;
    const name = bytes.subarray(offset + 30, offset + 30 + nameSize).toString("utf8");
    if (compressed !== size || end > bytes.length || !name || name.startsWith("/") || name.split("/").includes("..") || name.includes("\\") || rows.has(name)) throw new Error("Unsafe or inconsistent feedback archive entry");
    rows.set(name, bytes.subarray(begin, end)); offset = end;
  }
  if (!rows.size || offset + 4 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) throw new Error("Missing feedback ZIP directory");
  return rows;
}
export function interruptedBundleMatches(bundle: FeedbackTraceBundle, ids: { company: string; issue: string; run: string; agent: string; comment: string }) {
  const run = bundle.paperclipRun;
  const runFile = bundle.files.find(f => f.path === "paperclip/run.json"), eventsFile = bundle.files.find(f => f.path === "paperclip/run-events.json");
  if (!runFile || !eventsFile) return false;
  try {
    const saved = JSON.parse(runFile.contents) as Record<string, unknown>, events = JSON.parse(eventsFile.contents) as Array<{ runId?: string; agentId?: string; seq?: number }>;
    return bundle.companyId === ids.company && bundle.issueId === ids.issue && bundle.envelope.targetId === ids.comment
      && run?.id === ids.run && run.companyId === ids.company && run.agentId === ids.agent && run.status === "cancelled"
      && saved.id === ids.run && saved.status === "cancelled" && saved.agentId === ids.agent && saved.companyId === ids.company
      && events.length > 0 && events.every(e => e.runId === ids.run) && Number(run.eventCount) === events.length;
  } catch { return false; }
}
export function gradeFeedbackBundle(value: unknown) {
  const c = checks(), o = privilegedObservation(value); c.add("actual-local-feedback-export", !!o, "A real human-owned scoped CLI export and retained interrupted-work trace are required."); if (!o) return c.result();
  c.add("board-only-report-boundary", o.state.agentReportStatus === 403 && o.state.cliExecuted === true, "The actual agent cannot read feedback traces; an isolated human CLI actor performs the export.");
  c.add("interrupted-work-not-fabricated-failure", o.state.workerWasReallyWaiting === true && o.state.cancelledBeforeCanonical === true
    && o.state.exportedInterruptionMatches === true && o.runs.some(r => r.id === o.state.workerRunId && r.status === "cancelled")
    && o.state.originalTraceUnchanged === true, "The original actual cancelled run, source-attributed comment and exact retained events survive export; cancellation is never relabeled as a failed native/model outcome.");
  c.add("owned-local-bytes-and-scope", o.state.bundleWithinOwnedDirectory === true && o.state.exportCompanyMatches === true && o.state.exportIssueMatches === true
    && o.state.fullTraceBytesMatch === true && o.state.archiveBytesMatch === true && typeof o.state.zipSha256 === "string" && Number(o.state.zipBytes) > 0
    && o.state.noPrivateCredentialBytes === true && o.state.remoteSharingUnchanged === true && o.state.bundlePublished === false,
    "Actual JSON and archive bytes match the intended company/issue trace only, remain private and do not enable remote sharing.");
  const report = o.state.exportReport as { attributed?: boolean; reply?: string } | undefined;
  c.add("truthful-native-location-and-contents", report?.attributed === true && report.reply?.includes(String(o.state.localOutputDirectory)) === true
    && /feedback|vote/i.test(report.reply) && /trace|event/i.test(report.reply) && /cancel|interrupt/i.test(report.reply)
    && !/published|uploaded|shared publicly|model fail|failed native/i.test(report.reply), "The actual follow-up reports the real local location, scope and interrupted-work evidence without publishing or relabeling it.");
  return c.result();
}
const feedback = privilegedDefinition("cli-operations.feedback-bundle", "privileged-feedback", {
  async setup(ctx) {
    const gate = await prepareRuntimeWorkerGate(ctx, { taskBound: true }); const pending = { gate, taskId: undefined as string | undefined }; pendingFixtures.set(ctx, pending);
    const marker = `Waiting for operator brief ${ctx.input.nonce}`;
    const task = await ctx.input.api.post<Entity>(`${gate.company}/issues`, { title: "Interrupted local feedback fixture", status: "todo", assigneeAgentId: gate.worker.id,
      description: `First post one normal task comment saying exactly ${JSON.stringify(marker)}. Then run ${gate.gate.command} once and wait for the human brief. Do not mark this task complete or replace the script. This is an owned interruption fixture.` });
    pending.taskId = task.id;
    const sharingBefore = await ctx.input.api.get<{ feedbackDataSharingPreference?: string }>("/api/instance/settings/general");
    const running = await pollUntil({ label: "Actual worker comment and native waiting process", deadlineAt: Date.now() + 150000,
      load: async () => ({ runs: await ctx.allRuns(), comments: await ctx.input.api.get<Entity[]>(`/api/issues/${task.id}/comments?order=asc`), waiting: await readRuntimeTaskGate(ctx, gate.gate, task.id, gate.worker.id) }),
      accept: o => o.waiting === "waiting" && o.runs.length === 1 && o.runs[0]?.status === "running" && o.runs[0].agentId === gate.worker.id
        && o.comments.some(c => c.authorAgentId === gate.worker.id && c.createdByRunId === o.runs[0]!.id && c.body === marker),
      reject: o => o.runs.some(r => ["failed", "cancelled", "timed_out", "succeeded"].includes(r.status)) ? "Interruption prerequisite finished before the actual held native boundary" : undefined });
    const run = running.runs[0]!, comment = running.comments.find(c => c.body === marker && c.createdByRunId === run.id)!;
    await ctx.input.api.post(`/api/heartbeat-runs/${run.id}/cancel`, {});
    await pollUntil({ label: "Actual board cancellation before feedback request", deadlineAt: Date.now() + 60000, load: () => ctx.allRuns(), accept: runs => runs.length === 1 && runs[0]?.status === "cancelled" });
    await ctx.input.api.patch(`/api/issues/${task.id}`, { status: "backlog" });
    await releaseRuntimeWorker({ gate: gate.gate });
    const vote = await ctx.input.api.post<FeedbackVote>(`/api/issues/${task.id}/feedback-votes`, { targetType: "issue_comment", targetId: comment.id,
      vote: "down", reason: "The operator interrupted this unfinished fixture before completion; retain the original cancelled run and events for local review.", allowSharing: false });
    const trace = await pollUntil({ label: "Actual human feedback trace retained locally", deadlineAt: Date.now() + 30000,
      load: () => ctx.input.api.get<FeedbackTrace[]>(`/api/issues/${task.id}/feedback-traces`), accept: rows => rows.length === 1 && rows[0]?.feedbackVoteId === vote.id });
    const agentReportStatus = await probeAgentPermission(ctx, `/api/issues/${task.id}/feedback-traces`, "GET");
    return { worker: gate.worker, gate: gate.gate, task, workerRunId: run.id, workerCommentId: comment.id, traceId: trace[0]!.id,
      traceBefore: { id: trace[0]!.id, targetId: trace[0]!.targetId, status: trace[0]!.status, destination: trace[0]!.destination, exportId: trace[0]!.exportId },
      sharingPreferenceBefore: sharingBefore.feedbackDataSharingPreference, workerWasReallyWaiting: true, cancelledBeforeCanonical: true, agentReportStatus, ...(await prepareOwnedCli(ctx)) };
  },
  async act(ctx, state) {
    await pollUntil({ label: "Canonical human-export guidance settled", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000),
      load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.issue?.conversationState === "waiting" && o.runs.length === 2 && o.runs.filter(r => r.status === "succeeded").length === 1 && o.runs.filter(r => r.status === "cancelled").length === 1) });
    const prior = await ctx.allRuns(); const company = ctx.input.fixtures.company.id, task = state.task as Entity;
    const output = path.join(String(state.operatorDirectory), "feedback-export");
    const result = JSON.parse(await runOwnedCli(ctx, ["feedback", "export", "--company-id", company, "--issue-id", task.id, "--out", output, "--json"])); state.cliExecuted = true;
    const directory = await realpath(output), root = await realpath(String(state.operatorDirectory));
    state.bundleWithinOwnedDirectory = directory.startsWith(root + path.sep) && result.outputDir === output && result.zipPath === output + ".zip";
    if (!state.bundleWithinOwnedDirectory) throw new Error("Feedback CLI output escapes its exact owned local destination");
    const indexBytes = await readFile(path.join(directory, "index.json")), index = JSON.parse(indexBytes.toString()) as { companyId: string; summary: { total: number; issues: string[] }; files: { fullTraces: string[]; traces: string[]; votes: string[] } };
    state.exportCompanyMatches = index.companyId === company; state.exportIssueMatches = index.summary.total === 1
      && index.summary.issues.length === 1 && index.summary.issues[0] === (task.identifier ?? task.id) && index.files.fullTraces.length === 1 && index.files.traces.length === 1 && index.files.votes.length === 1;
    if (!state.exportIssueMatches) throw new Error("Feedback export contains unexpected company or issue scope");
    const traceDir = index.files.fullTraces[0]!;
    if (path.basename(traceDir) !== traceDir) throw new Error("Unexpected feedback trace directory");
    const bundleBytes = await readFile(path.join(directory, "full-traces", traceDir, "bundle.json")), bundle = JSON.parse(bundleBytes.toString()) as FeedbackTraceBundle;
    state.exportedInterruptionMatches = interruptedBundleMatches(bundle, { company, issue: task.id, run: String(state.workerRunId), agent: (state.worker as Entity).id, comment: String(state.workerCommentId) });
    const actual = await ctx.input.api.get<FeedbackTraceBundle>(`/api/feedback-traces/${state.traceId}/bundle`);
    state.fullTraceBytesMatch = JSON.stringify(bundle) === JSON.stringify(actual);
    const zip = await readFile(result.zipPath), archive = storedArchiveEntries(zip);
    const archivePrefix = path.basename(directory) + "/";
    const expected = new Map<string, Buffer>([["index.json", indexBytes]]);
    for (const group of ["votes", "traces"] as const) for (const name of index.files[group]) {
      if (path.basename(name) !== name) throw new Error("Unexpected exported feedback filename");
      expected.set(`${group}/${name}`, await readFile(path.join(directory, group, name)));
    }
    expected.set(`full-traces/${traceDir}/bundle.json`, bundleBytes);
    for (const file of bundle.files) {
      if (path.isAbsolute(file.path) || file.path.split(/[\\/]/).includes("..")) throw new Error("Unsafe local trace output path");
      expected.set(`full-traces/${traceDir}/${file.path}`, Buffer.from(file.contents));
    }
    state.archiveBytesMatch = archive.size === expected.size && [...expected].every(([file, bytes]) => archive.get(archivePrefix + file)?.equals(bytes));
    state.zipBytes = zip.length; state.zipSha256 = sha(zip);
    state.noPrivateCredentialBytes = [indexBytes, bundleBytes, zip].every(bytes => !(ctx.input.privateSecrets ?? []).some(secret => secret && bytes.includes(Buffer.from(secret))));
    if (!state.noPrivateCredentialBytes) throw new Error("Private credential bytes detected in local feedback output; matched content withheld");
    const after = await ctx.input.api.get<FeedbackTrace>(`/api/feedback-traces/${state.traceId}`), before = state.traceBefore as Record<string, unknown>;
    state.originalTraceUnchanged = ["id", "targetId", "status", "destination", "exportId"].every(key => after[key as keyof FeedbackTrace] === before[key]);
    const sharingAfter = await ctx.input.api.get<{ feedbackDataSharingPreference?: string }>("/api/instance/settings/general");
    state.remoteSharingUnchanged = sharingAfter.feedbackDataSharingPreference === state.sharingPreferenceBefore && before.status === "local_only" && after.status === "local_only" && after.destination == null && after.exportId == null;
    state.bundlePublished = false; state.localOutputDirectory = directory;
    const receipt = { localOutputDirectory: directory, zipSha256: state.zipSha256, zipBytes: state.zipBytes, companyId: company, issueId: task.id,
      feedbackTraceId: state.traceId, originalRunId: state.workerRunId, originalRunStatus: "cancelled", originalAgentId: (state.worker as Entity).id,
      exportedContents: ["scoped feedback vote", "trace metadata", "original cancelled run", "retained run events"], exactLocalBytesVerified: state.fullTraceBytesMatch,
      remoteSharingEnabled: false, publicAttachmentCreated: false, outcomeKind: "operator interrupted unfinished work; not a model failure or failed-native run" };
    await ctx.input.evidence("chat-catalog-local-feedback-export-receipt.json", receipt);
    const message = `The human operator exported this local review bundle and retained the original interrupted work evidence. These are the observed facts; please report its location and contents without publishing it:\n\n${JSON.stringify(receipt)}`;
    await sendChatMessage(ctx.input.page, message, chatCatalogNativePhaseRemainingBudget(ctx)); state.exportReport = await companionPhaseForCancelled(ctx, prior.map(r => r.id), message);
  }, grade: gradeFeedbackBundle, async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
// companionPhase's default all-succeeded assertion intentionally does not apply to this retained cancelled fixture.
async function companionPhaseForCancelled(ctx: Parameters<typeof companionPhase>[0], prior: string[], message: string) {
  const result = await pollUntil({ label: "Native reply to local interrupted-work export receipt", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150000),
    load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
    accept: o => chatCatalogNativePhaseIsTimely(ctx) && (o.issue?.conversationState === "waiting" && o.runs.length === prior.length + 1 && o.runs.filter(r => r.status === "succeeded").length === 2 && o.runs.filter(r => r.status === "cancelled").length === 1) });
  const run = result.runs.find(r => !prior.includes(r.id) && r.agentId === ctx.input.fixtures.agent.id)!;
  const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`), human = comments.filter(c => !c.authorAgentId && c.body === message);
  const replies = comments.filter(c => c.authorAgentId === ctx.input.fixtures.agent.id && c.createdByRunId === run.id);
  const profile = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
  return { humanCommentId: human[0]?.id, runId: run.id, reply: replies.map(c => c.body).join("\n"),
    attributed: human.length === 1 && replies.length > 0 && profile.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true
      && replies.every(c => Date.parse(c.createdAt!) >= Date.parse(human[0]!.createdAt!)) };
}
feedback.expectedRunCount = 3; feedback.expectedHumanMessageCount = 2; feedback.attemptTimeoutMs = 900000;
feedback.runPolicy = { kind: "terminal-counts", terminalStatusCounts: { succeeded: 2, cancelled: 1 } };
feedback.cleanup = async (ctx, state) => { try { const pending = pendingFixtures.get(ctx);
    if (pending) { const runs = await ctx.allRuns(); for (const run of runs.filter(r => r.agentId === pending.gate.worker.id && ["queued", "running"].includes(r.status))) await ctx.input.api.post(`/api/heartbeat-runs/${run.id}/cancel`, {}); await releaseRuntimeWorker({ gate: pending.gate.gate }); pendingFixtures.delete(ctx); }
    await releaseRuntimeWorker(state); } finally { try { await cleanupIdentityProbes(ctx); } finally { await cleanupOwnedCli(ctx); } } };
feedback.sourceFiles = [...feedback.sourceFiles, "chat-catalog-domains/privileged-cli-support.ts", "chat-catalog-domains/identity-support.ts", "chat-catalog-domains/runtime-busy-worker.ts", "../../cli/src/index.ts", "../../cli/src/commands/client/feedback.ts", "../../server/src/services/feedback.ts"];
export const privilegedFeedbackCases = [feedback];
