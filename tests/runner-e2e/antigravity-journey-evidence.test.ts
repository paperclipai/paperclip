import { readFileSync } from "node:fs";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { expect, it, vi } from "vitest";
import { antigravityEvidenceFixture, antigravityTurnFixture } from "./antigravity-journey-test-fixtures.js";
import { antigravityPrimaryOwner, gradeAntigravityJourney, gradeAntigravityJourneyTurn, sameAntigravityConversation, selectAntigravityIssueRun, validateAntigravityJourneyEvidence, verifyAntigravityJourneyTurn } from "./antigravity-journey-evidence.js";
import type { ConnectionApi } from "./connection-target.js";
import { observeRunProcesses } from "./copilot-local-fixtures.js";
import { readLinuxProcessStartedAt } from "../../packages/paperclip-runner/src/live/linux-process-start.js";

it("consumes the activity router's public runId summary rather than a full heartbeat row", () => {
  const service = readFileSync(new URL("../../server/src/services/activity.ts", import.meta.url), "utf8");
  const router = readFileSync(new URL("../../server/src/routes/activity.ts", import.meta.url), "utf8");
  const client = readFileSync(new URL("../../ui/src/api/activity.ts", import.meta.url), "utf8");
  expect(service).toMatch(/runsForIssue:[\s\S]*?\.select\(\{\s*runId: heartbeatRuns\.id/u);
  expect(router).toMatch(/router\.get\("\/issues\/:id\/runs"[\s\S]*?svc\.runsForIssue\(issue\.companyId, issue\.id/u);
  expect(client).toMatch(/interface RunForIssue\s*\{\s*runId: string/u);
  expect(selectAntigravityIssueRun([{ runId: "old", agentId: "agent" }, { runId: "new", agentId: "agent" }], "agent", ["old"])).toBe("new");
  expect(selectAntigravityIssueRun([], "agent", [])).toBeNull();
});
it.each([
  [{ id: "wrong-public-shape", agentId: "agent" }],
  [{ runId: "run", id: "conflicting", agentId: "agent" }],
  [{ runId: "run", agentId: "other" }],
  [{ runId: "run", agentId: "agent" }, { runId: "run", agentId: "agent" }],
  [{ runId: "run", agentId: "agent" }, { runId: "extra", agentId: "agent" }],
].map(summaries => ({ summaries })))("rejects an invalid or ambiguous public run summary %#", ({ summaries }) => {
  expect(() => selectAntigravityIssueRun(summaries, "agent", [])).toThrow("antigravity_evidence_");
});
it.skipIf(process.platform !== "darwin" || process.arch !== "arm64")("fetches the public runId and verifies the full owner before any host observation", async () => {
  const fixture = antigravityTurnFixture(), routes: string[] = []; let observed = false;
  const api = { origin: "http://127.0.0.1:3104", get: async (route: string) => {
    routes.push(route);
    if (route.endsWith("/runs")) return [{ runId: fixture.run.id, agentId: fixture.agentId }];
    return { ...fixture.run, companyId: "foreign" };
  } } as unknown as ConnectionApi;
  await expect(verifyAntigravityJourneyTurn({ ...fixture, api, deadlineAt: Date.now() + 1000,
    observeRun: async () => { observed = true; } })).rejects.toThrow("observed_run_binding");
  expect(routes).toEqual(["/api/issues/task/runs", "/api/heartbeat-runs/run-first"]);
  expect(observed).toBe(false);
});

it("accepts real-bound exact file evidence despite an unrelated genuine finish rejection", () => {
  const proof = gradeAntigravityJourneyTurn(antigravityTurnFixture());
  expect(proof.toolLifecycle).toEqual({ completedFileOperations: 2, failedFileOperations: 0, failedFinishOperations: 1 });
  const evidence = antigravityEvidenceFixture();
  expect(() => validateAntigravityJourneyEvidence(evidence)).not.toThrow();
  expect(gradeAntigravityJourney(evidence).every(check => check.passed)).toBe(true);
});

it("accepts Rust allocator and executor-hashed event IDs with independent source sequences", () => {
  const fixture = antigravityTurnFixture();
  const first = fixture.events[0]!;
  first.sourceEventId = first.payload.prpEvent.sourceEventId = `event_${fixture.run.runnerInstanceId}_0000000000000001`;
  expect(fixture.events[1]!.sourceEventId).toMatch(/^event_executor_[a-f0-9]{64}$/u);
  let controlSeq = 0;
  for (const row of fixture.events.filter(row => row.payload.prpEvent.sourceKind === "control_plane")) {
    row.sourceSeq = row.payload.prpEvent.sourceSeq = ++controlSeq;
  }
  expect(() => gradeAntigravityJourneyTurn(fixture)).not.toThrow();
});

const changes: Array<[string, (f: ReturnType<typeof antigravityTurnFixture>) => void]> = [
  ["different task", f => { f.attachment.issueId = "another-task"; }],
  ["different assignee", f => { f.issue.assigneeAgentId = "other-agent"; }],
  ["stale previous run", f => { f.afterRunIds.push(f.run.id); }],
  ["copied attachment", f => { f.attachment.originatingRunId = "old-run"; }],
  ["missing file", f => { f.downloadedBytes = Buffer.alloc(0); }],
  ["wrong actual bytes", f => { f.downloadedBytes[0] = 0; }],
  ["success claim without delivery", f => { f.run.resultJson.semanticToolReceipts = {}; }],
  ["narrative Done without committed result", f => { f.run.resultJson.finalizationPhase = "prepared"; }],
  ["unsettled cost accounting", f => { f.run.costAccountingPending = true; }],
  ["different selected connection", f => { f.run.contextSnapshot.aiConnection.connectionId = "ambient-connection"; }],
  ["different effective model", f => { f.run.runnerProfileJson.sessionCheckpoint.providerIdentity.effectiveModel = "automatic"; }],
  ["old candidate profile", f => { f.expectedProfileDigest = `sha256:${"c".repeat(64)}`; }],
  ["foreign native evidence", f => { f.events[0]!.payload.prpEvent.sourceInstanceId = "other-runner"; }],
  ["missing event ID", f => { delete (f.events[0] as any).sourceEventId; delete (f.events[0]!.payload.prpEvent as any).sourceEventId; }],
  ["empty event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = ""; }],
  ["oversized event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = "x".repeat(161); }],
  ["unsafe event ID", f => { f.events[0]!.sourceEventId = f.events[0]!.payload.prpEvent.sourceEventId = "event\nforeign"; }],
  ["duplicate event ID", f => { f.events[1]!.sourceEventId = f.events[1]!.payload.prpEvent.sourceEventId = f.events[0]!.sourceEventId; }],
  ["foreign envelope event ID", f => { f.events[0]!.payload.prpEvent.sourceEventId = "event_from_another_row"; }],
  ["foreign row event ID", f => { f.events[0]!.sourceEventId = "event_from_another_row"; }],
  ["foreign paired source", f => { f.events[0]!.sourceInstanceId = f.events[0]!.payload.prpEvent.sourceInstanceId = "foreign-runner"; }],
  ["replayed source sequence", f => { f.events[1]!.sourceSeq = f.events[1]!.payload.prpEvent.sourceSeq = f.events[0]!.sourceSeq; }],
  ["reordered control source sequence", f => { f.events.at(-1)!.sourceSeq = f.events.at(-1)!.payload.prpEvent.sourceSeq = 1; }],
  ["missing source sequence", f => { delete (f.events[0] as any).sourceSeq; delete (f.events[0]!.payload.prpEvent as any).sourceSeq; }],
  ["failed file read", f => { f.events[3]!.payload.prpEvent.payload.status = "failed"; }],
  ["terminal task with active lease", f => { f.lease.status = "active"; }],
  ["unobserved physical owner", f => { f.retirement.captured = false; }],
  ["missing primary birth", f => { delete (f.retirement as any).primaryOwner; }],
  ["forged primary birth", f => { f.retirement.primaryOwner.startedAt = "forged"; }],
  ["different primary run", f => { f.retirement.primaryOwner.runId = "another-run"; }],
  ["different primary PID", f => { f.retirement.primaryOwner.pid++; }],
  ["different primary OS birth", f => { f.retirement.primaryOwner.startedAt = "2026-10-29T00:00:01Z"; }],
  ["unverified primary argv", f => { (f.retirement.primaryOwner as any).perTurnArgvVerified = false; }],
  ["remaining native process", f => { f.retirement.remainingProcessCount = 1; }],
  ["PID reused", f => { f.retirement.identityChanged = true; }],
  ["native child still owns lifetime fence", f => { f.retirement.nativeFencesReacquired = false; }],
];
it.each(changes)("rejects %s rather than trusting Done prose", (_label, change) => {
  const fixture = antigravityTurnFixture(); change(fixture);
  expect(() => gradeAntigravityJourneyTurn(fixture)).toThrow("antigravity_evidence_");
});

it.each(["acpxRecordId", "agentSessionId", "backendSessionId", "normalizedSessionId", "workspaceDigest", "profileDigest", "effectiveModel"] as const)("rejects replaced native conversation %s", key => {
  const e = antigravityEvidenceFixture(); e.turnEvidence[1]!.conversation[key] = "replaced";
  expect(sameAntigravityConversation(e.turnEvidence[0]!, e.turnEvidence[1]!)).toBe(false);
});
it("allows the real session-scoped runner ID only with a different primary process birth", () => {
  const e = antigravityEvidenceFixture(), [first, second] = e.turnEvidence;
  second!.runnerInstanceId = first!.runnerInstanceId;
  expect(sameAntigravityConversation(first!, second!)).toBe(true);
  second!.retirement.primaryOwner = { ...first!.retirement.primaryOwner, runId: second!.runId };
  // A different sidecar/journal size does not prove a different primary Runner.
  second!.retirement.observedProcessCount++;
  expect(sameAntigravityConversation(first!, second!)).toBe(false);
});
it("binds the retained primary to the actual observer's per-turn argv, run, and OS birth", () => {
  const f = antigravityTurnFixture(), owner = f.retirement.primaryOwner;
  const observation = { captured: true, identityChanged: false, live: [], journal: [{ pid: owner.pid, parent: 1, start: owner.startedAt }], rootObserved: undefined,
    authorityCheck: { accepted: true, commandSha256: `sha256:${owner.commandSha256}`, authority: { pid: owner.pid, groupId: owner.groupId, startedAt: owner.startedAt, runId: owner.runId },
      observed: { pid: owner.pid, parent: 1, start: owner.startedAt } } };
  expect(antigravityPrimaryOwner(f.run, observation)).toEqual(owner);
  expect(antigravityPrimaryOwner(f.run, { ...observation, authorityCheck: { ...observation.authorityCheck, accepted: false } })).toBeUndefined();
  observation.authorityCheck.authority.runId = "another-run";
  expect(() => antigravityPrimaryOwner(f.run, observation)).toThrow("primary_owner_binding");
});
it.each(["", "c".repeat(64), "sha256:short", `sha256:${"C".repeat(64)}`, `sha256:${"c".repeat(65)}`])("rejects malformed shared-observer command digest %#", commandSha256 => {
  const f = antigravityTurnFixture(), owner = f.retirement.primaryOwner;
  expect(() => antigravityPrimaryOwner(f.run, { captured: true, identityChanged: false, live: [], rootObserved: undefined,
    journal: [{ pid: owner.pid, parent: 1, start: owner.startedAt }], authorityCheck: { accepted: true, commandSha256,
      authority: { pid: owner.pid, groupId: owner.groupId, startedAt: owner.startedAt, runId: owner.runId },
      observed: { pid: owner.pid, parent: 1, start: owner.startedAt } } })).toThrow("primary_owner_command_digest");
});
it.skipIf(!["darwin", "linux"].includes(process.platform))("normalizes the real live observer's tagged command digest for a bounded owned child", async () => {
  const runId = "hermetic-primary-owner", observer = observeRunProcesses();
  // No Runner/provider/model: two finite test-owned Node processes expose the
  // same argv/birth contract consumed by the selected local native observer.
  const script = `const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setTimeout(()=>{},3500)'],{stdio:'ignore'});
    process.on('SIGTERM',()=>{child.kill();setTimeout(()=>process.exit(0),50)});
    setTimeout(()=>{child.kill();process.exit(0)},4000);
    console.log('ready');`;
  const child = spawn(process.execPath, ["-e", script, "--", "--run-id", runId, "--lifecycle-mode", "per_turn"],
    { detached: true, stdio: ["ignore", "pipe", "ignore"], env: { PATH: process.env.PATH } });
  const exited = once(child, "exit");
  try {
    await once(child.stdout!, "data");
    const pid = child.pid!;
    const startedAt = process.platform === "linux" ? readLinuxProcessStartedAt(pid)
      : new Date(Date.parse(execFileSync("/bin/ps", ["-p", String(pid), "-o", "lstart="],
        { encoding: "utf8", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } }).trim())).toISOString();
    const run = { id: runId, processPid: pid, processGroupId: pid, processStartedAt: startedAt };
    let observation = observer.sample({ runId, pid, groupId: pid, startedAt });
    await vi.waitFor(() => {
      observation = observer.sample({ runId, pid, groupId: pid, startedAt });
      expect(observation.captured).toBe(true); expect(observation.journal.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 2500 });
    expect(observation.authorityCheck?.accepted).toBe(true);
    expect(observation.authorityCheck!.commandSha256).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const owner = antigravityPrimaryOwner(run, observation)!;
    expect(owner).toMatchObject({ runId, pid, groupId: pid, startedAt, perTurnArgvVerified: true });
    expect(owner.commandSha256).toBe(observation.authorityCheck!.commandSha256.slice("sha256:".length));
    expect(owner.commandSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(() => antigravityPrimaryOwner({ ...run, id: "different-run" }, observation)).toThrow("primary_owner_binding");
    expect(() => antigravityPrimaryOwner({ ...run, processStartedAt: "2026-01-01T00:00:00Z" }, observation)).toThrow("primary_owner_binding");
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
    await vi.waitFor(() => expect(observer.sample().live).toHaveLength(0), { timeout: 5000 });
  }
}, 10_000);

it("retains first completion as a snapshot when later task reopening changes coordinator pointers", () => {
  const first = antigravityTurnFixture(), observed = gradeAntigravityJourneyTurn(first);
  first.run.resultJson.authoritativeDecision = "in_progress";
  first.run.resultJson.assessmentId = "superseding-assessment";
  expect(observed.finalization.decision).toBe("done");
  expect(observed.finalization.assessmentId).toBe("assessment-run-first");
  expect(() => gradeAntigravityJourneyTurn(first)).toThrow("committed_done");
});

it("rejects an arbitrary retained native payload and altered download bytes", () => {
  const e = antigravityEvidenceFixture();
  (e.turnEvidence[0]!.conversation as any).rawNativePrompt = "private";
  expect(() => validateAntigravityJourneyEvidence(e)).toThrow("retained_shape");
  delete (e.turnEvidence[0]!.conversation as any).rawNativePrompt;
  e.turnEvidence[0]!.artifact.base64 = Buffer.from("not the proof").toString("base64");
  expect(() => validateAntigravityJourneyEvidence(e)).toThrow("retained_artifact");
});
