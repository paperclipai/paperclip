import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageEvidence } from "./evidence.js";
import { describe, expect, it } from "vitest";
import { accountingCase, accountingCases, accountingCommentBodies, accountingScreenshotFile } from "./accounting-cases.js";
import { gradeAccounting, type AccountingCheckpoint } from "./accounting-scoring.js";
import { parseRunnerSelectors, selectRunnerExecutions } from "./selectors.js";
function recording(id = "accounting-productive-neutral") {
  const probe = accountingCase(id), nonce = "nonce", agentId = "agent";
  const run = (i: number) => ({ id: `r${i}`, status: "succeeded", runtimeMode: "legacy", scheduledRetryAttempt: 0, contextSnapshot: {} as Record<string, any> });
  const comments = (runs: any[]) => runs.filter(r => r.status === "succeeded").flatMap(r => accountingCommentBodies(probe, nonce).map(body => ({ body, authorAgentId: agentId, createdByRunId: r.id })));
  const cleanIssue = { status: "done", executionRunId: null, scheduledRetry: null, monitorNextCheckAt: null, activeRecoveryAction: null };
  let checkpoints: AccountingCheckpoint[];
  if (probe.kind === "productive") {
    checkpoints = Array.from({ length: 5 }, (_, i) => {
      const step = i + 1, runs = Array.from({ length: step }, (_, n) => run(n));
      return { phase: `step-${step}`, issue: { ...cleanIssue, status: step < 5 ? "in_review" : "done" }, runs, comments: comments(runs),
        documents: Array.from({ length: step }, (_, n) => ({ key: `step-${n + 1}`, latestRevisionNumber: 1, body: `STEP ${n + 1}: ${n === 0 ? "START" : `VALUEnonceN${n + 1}`}` })),
        interactions: Array.from({ length: Math.min(step, 4) }, (_, n) => ({ id: `q${n}`, kind: "ask_user_questions", status: n === i && step < 5 ? "pending" : "answered" })),
      };
    });
  } else {
    const runs = [run(0), run(1), run(2)];
    for (let i = 1; i <= 2; i++) runs[i].contextSnapshot = { wakeReason: "issue_disposition_repair", legacyDispositionEpisode: { id: "r0", attempt: i, maxAttempts: 2 } };
    if (probe.kind === "approval") {
      runs[2].contextSnapshot = {};
      checkpoints = [{ phase: "approval", issue: { ...cleanIssue, status: "in_review" }, runs: runs.slice(0, 2), comments: comments(runs.slice(0, 2)), documents: [], interactions: [{ kind: "request_confirmation", status: "pending" }] },
        { phase: "completed", issue: cleanIssue, runs, comments: comments(runs), documents: [], interactions: [{ kind: "request_confirmation", status: "accepted" }] }];
    } else {
      const scheduled = { phase: "scheduled", issue: cleanIssue, runs: structuredClone(runs), comments: comments(runs), documents: [], interactions: [] };
      scheduled.runs[2].status = "scheduled_retry";
      const restarted = { ...structuredClone(scheduled), phase: "restarted" };
      if (probe.kind === "stop") runs[2].status = "cancelled";
      const finished = { phase: "after-due", issue: probe.kind === "stop" ? cleanIssue : { ...cleanIssue, status: "blocked", activeRecoveryAction: { ownerType: "board", attemptCount: 2 } }, runs, comments: comments(runs), documents: [], interactions: [] };
      checkpoints = [scheduled, restarted, finished];
    }
  }
  checkpoints.push({ ...structuredClone(checkpoints.at(-1)!), phase: "final" });
  return { probe, nonce, agentId, runtime: "legacy", checkpoints };
}
const failures = (r: ReturnType<typeof recording>) => gradeAccounting(r).filter(c => !c.passed).map(c => c.id);
describe("ACCT calibrated live accounting evidence", () => {
  it("retains every accounting screenshot through the existing evidence allowlist", async () => {
    const root = await mkdtemp(join(tmpdir(), "accounting-evidence-"));
    try {
      const files = ["step-1", "step-2", "step-3", "step-4", "step-5", "approval", "final"].map(accountingScreenshotFile);
      for (const file of files) await writeFile(join(root, file), Buffer.from("89504e470d0a1a0a", "hex"));
      const packaged = await packageEvidence({ privateDir: root, uploadDir: join(root, "packaged"), secrets: [], expectPassScreenshot: false });
      expect(packaged.leaks).toEqual([]);
      expect(packaged.files).toEqual(expect.arrayContaining(files));
      expect(files).toContain("final-state.png");
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it("discovers eight explicit-only real-provider cells and excludes unsupported native repair injection", () => {
    const cells = selectRunnerExecutions(parseRunnerSelectors(["--suite", "continuation-accounting"]));
    expect(cells).toHaveLength(8);
    expect(cells.filter(c => c.profile.generation === "native")).toHaveLength(2);
    expect(selectRunnerExecutions(parseRunnerSelectors(["--all"])).some(c => c.suite.id === "continuation-accounting")).toBe(false);
    expect(cells.every(c => c.requiredCredentials.includes("OPENAI_API_KEY"))).toBe(true);
  });
  it.each(accountingCases)("accepts a complete $id recording", c => expect(failures(recording(c.id))).toEqual([]));
  it("rejects a serialized array in place of the exact neutral comment", () => {
    const r = recording(), f = r.checkpoints.at(-1)!;
    for (const comment of f.comments) comment.body = JSON.stringify([comment.body]);
    expect(failures(r)).toEqual(["perturbation"]);
  });
  it.each(["accounting-productive-neutral", "accounting-exhaustion-noisy", "accounting-repair-stop", "accounting-repair-approval"])("rejects missing final evidence for %s", id => {
    const r = recording(id); r.checkpoints.pop(); expect(failures(r)).toContain("evidence");
  });
  it.each(["noise", "extra-run", "wrong-runtime", "pending-retry", "repair-debt", "wrong-document", "premature-document", "missing-answer", "missing-state", "rewritten-document", "deduplicated-noise"])("rejects productive %s", mutation => {
    const r = recording("accounting-productive-noisy"), f = r.checkpoints.at(-1)!;
    if (mutation === "deduplicated-noise") f.comments = f.comments.filter(c => !c.body.includes("N2:") && !c.body.includes("N3:"));
    if (mutation === "noise") f.comments = [];
    if (mutation === "extra-run") f.runs.push(structuredClone(f.runs[0]));
    if (mutation === "wrong-runtime") f.runs[0].runtimeMode = "native";
    if (mutation === "pending-retry") f.issue.scheduledRetry = { id: "retry" };
    if (mutation === "repair-debt") f.runs[1].contextSnapshot.dispositionRepairAttempt = 1;
    if (mutation === "wrong-document") r.checkpoints[2].documents[0].body = "wrong";
    if (mutation === "premature-document") r.checkpoints[0].documents.push({ key: "step-5", body: "premature" });
    if (mutation === "missing-state") delete f.issue.scheduledRetry;
    if (mutation === "rewritten-document") r.checkpoints[2].documents[0].latestRevisionNumber = 2;
    if (mutation === "missing-answer") f.interactions.pop();
    expect(failures(r).length).toBeGreaterThan(0);
  });
  it.each(["new-episode", "reset-attempt", "extra-repair", "user-comment", "restart-loss", "hidden-exhaustion"])("rejects exhausted repair %s", mutation => {
    const r = recording("accounting-exhaustion-noisy"), f = r.checkpoints.at(-1)!;
    if (mutation === "new-episode") f.runs[2].contextSnapshot.legacyDispositionEpisode.id = "new";
    if (mutation === "reset-attempt") f.runs[2].contextSnapshot.legacyDispositionEpisode.attempt = 1;
    if (mutation === "extra-repair") f.runs.push(structuredClone(f.runs[2]));
    if (mutation === "user-comment") f.comments.push({ authorUserId: "operator", body: "continue" });
    if (mutation === "restart-loss") r.checkpoints[1].runs[2].id = "replacement";
    if (mutation === "hidden-exhaustion") f.issue.activeRecoveryAction = null;
    expect(failures(r).length).toBeGreaterThan(0);
  });
  it("rejects Stop that still dispatched the provider", () => {
    const r = recording("accounting-repair-stop"); r.checkpoints.at(-1)!.runs[2].startedAt = "2026-09-22"; expect(failures(r)).toContain("stopped");
  });
  it("rejects pending approval competing with repair and declined approval continuing", () => {
    const r = recording("accounting-repair-approval"); r.checkpoints[0].issue.scheduledRetry = { id: "repair" }; r.checkpoints.at(-1)!.interactions[0].status = "rejected";
    expect(failures(r)).toEqual(expect.arrayContaining(["approval-owner", "approval-resumed"]));
  });
});
