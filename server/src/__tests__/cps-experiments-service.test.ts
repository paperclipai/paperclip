import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cpsExperimentsService } from "../services/cps-experiments.js";

let root = "";
let indexFile = "";

beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "cps-experiments-test-"));
  const fixtureDir = path.join(root, "sp-20260701T000000Z-fixture");
  await mkdir(fixtureDir, { recursive: true });
  await writeFile(path.join(fixtureDir, "JUDGMENT.json"), JSON.stringify({
    schema: "cps.experiment_judgment.v1",
    experiment_id: "sp-20260701T000000Z-fixture",
    result_verdict: "LOCAL_VALIDATION_KILL",
    promotion_verdict: "do_not_promote",
    data_fit: { status: "proxy" },
    rules_disclosure: { status: "partial" },
    next_action: { type: "archive", safe_to_delegate: true, prompt: "Archive with learning." },
  }), "utf8");
  const trackerDir = path.join(root, "experiment-tracker-20260701");
  await mkdir(trackerDir, { recursive: true });
  indexFile = path.join(trackerDir, "EXPERIMENTS_INDEX.json");
  await writeFile(indexFile, JSON.stringify({
    schema: "cps.experiment_index.v1",
    generated_utc: "2026-07-01T00:00:00.000Z",
    root: "/root/cps/var/self_practice",
    entry_count: 2,
    kind_counts: { strategy_experiment: 1, tool_or_repo_evaluation: 1 },
    status_counts: { ok: 2 },
    decision_counts: { KILL_ARCHIVE: 1, selective_adaptation: 1 },
    strategy_decision_counts: { KILL_ARCHIVE: 1 },
    eval_verdict_counts: { selective_adaptation: 1 },
    entries: [
      {
        id: "sp-20260701T000000Z-fixture",
        run_id: "20260701T000000Z",
        path: "sp-20260701T000000Z-fixture",
        absolute_path: fixtureDir,
        updated_utc: "2026-07-01T00:10:00.000Z",
        kind: "strategy_experiment",
        status: "ok",
        decision: "KILL_ARCHIVE",
        primary_json: "sp-20260701T000000Z-fixture/metrics.json",
        absolute_primary_json: "/root/cps/var/self_practice/sp-20260701T000000Z-fixture/metrics.json",
        files: ["metrics.json", "README.md"],
        summary: { mechanism: "fixture", failing_gates: ["oos"] },
      },
      {
        id: "tool-eval",
        updated_utc: "2026-07-01T00:05:00.000Z",
        kind: "tool_or_repo_evaluation",
        status: "ok",
        decision: "selective_adaptation",
        files: ["EVALUATION.json"],
        summary: { verdict: "selective_adaptation" },
      },
    ],
  }), "utf8");
});

afterAll(async () => {
  if (root) await rm(root, { recursive: true, force: true });
});

describe("cpsExperimentsService.overview", () => {
  it("returns a read-only normalized overview from the local index", async () => {
    const svc = cpsExperimentsService({ indexFile, staleAfterMs: Number.MAX_SAFE_INTEGER });
    const out = await svc.overview("company-1");

    expect(out.companyId).toBe("company-1");
    expect(out.source.present).toBe(true);
    expect(out.source.schema).toBe("cps.experiment_index.v1");
    expect(out.safety).toMatchObject({ readOnly: true, brokerActions: false, paidDataActions: false, signalPublishing: false });
    expect(out.counts.total).toBe(2);
    expect(out.counts.strategyByDecision.KILL_ARCHIVE).toBe(1);
    expect(out.entries[0].id).toBe("sp-20260701T000000Z-fixture");
    expect(out.entries[0].runId).toBe("20260701T000000Z");
    expect(out.entries[0].primaryJson).toBe("sp-20260701T000000Z-fixture/metrics.json");
    expect(out.entries[0].judgment?.result_verdict).toBe("LOCAL_VALIDATION_KILL");
    expect(out.entries[0].judgmentPath).toContain("JUDGMENT.json");
    expect(out.counts.judgmentByResultVerdict.LOCAL_VALIDATION_KILL).toBe(1);
    expect(out.counts.judgmentByPromotionVerdict.do_not_promote).toBe(1);
    expect(out.counts.judgmentByDataFit.proxy).toBe(1);
    expect(out.counts.judgmentByRulesDisclosure.partial).toBe(1);
    expect(out.recent).toHaveLength(2);
  });

  it("discovers the latest date-stamped tracker directory from self_practice", async () => {
    const older = path.join(root, "experiment-tracker-20260630");
    await mkdir(older, { recursive: true });
    await writeFile(path.join(older, "EXPERIMENTS_INDEX.json"), JSON.stringify({
      schema: "cps.experiment_index.v1",
      generated_utc: "2026-06-30T00:00:00.000Z",
      entry_count: 1,
      entries: [{ id: "older", updated_utc: "2026-06-30T00:00:00.000Z", kind: "strategy_experiment", status: "ok", decision: "KILL" }],
    }), "utf8");

    const svc = cpsExperimentsService({ selfPracticeDir: root, staleAfterMs: Number.MAX_SAFE_INTEGER });
    const out = await svc.overview("company-1");

    expect(out.source.indexPath).toBe(indexFile);
    expect(out.entries[0].id).toBe("sp-20260701T000000Z-fixture");
  });

  it("degrades safely when the index is absent", async () => {
    const svc = cpsExperimentsService({ indexFile: path.join(root, "missing.json") });
    const out = await svc.overview("company-1");

    expect(out.source.present).toBe(false);
    expect(out.source.stale).toBe(true);
    expect(out.entries).toEqual([]);
    expect(out.safety.readOnly).toBe(true);
  });

  it("queues bounded Paperclip run requests without executing them", async () => {
    const runRequestsDir = path.join(root, "run-requests");
    const svc = cpsExperimentsService({ runRequestsDir });
    const request = await svc.createRunRequest("company-1", {
      action: "run_next_safe_action",
      experimentId: "sp-20260701T000000Z-fixture",
      prompt: "Investigate this near miss with local data only.",
      maxRuntimeMinutes: 30,
    });

    expect(request.status).toBe("queued");
    expect(request.action).toBe("run_next_safe_action");
    expect(request.safety).toMatchObject({ brokerActions: false, signalPublishing: false, allowPaidData: false });
    const stored = JSON.parse(await readFile(request.path, "utf8"));
    expect(stored.id).toBe(request.id);
    const queue = await readFile(request.queuePath, "utf8");
    expect(queue).toContain(request.id);
  });

  it("writes append-only judgment feedback labels", async () => {
    const svc = cpsExperimentsService({ selfPracticeDir: root });
    const feedback = await svc.createJudgmentFeedback("company-1", {
      experimentId: "sp-20260701T000000Z-fixture",
      label: "too_optimistic",
      comment: "Conservative sequencing should dominate.",
    });

    expect(feedback.schema).toBe("cps.judgment_feedback.v1");
    expect(feedback.label).toBe("too_optimistic");
    expect(feedback.judgmentPath).toContain("JUDGMENT.json");
    const stored = JSON.parse(await readFile(feedback.path, "utf8"));
    expect(stored.comment).toBe("Conservative sequencing should dominate.");
    const queue = await readFile(feedback.queuePath, "utf8");
    expect(queue).toContain(feedback.id);
  });
});
