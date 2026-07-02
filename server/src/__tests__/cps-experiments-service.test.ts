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
    expect(feedback.routeToRole).toBeNull();
    expect(feedback.judgmentPath).toContain("JUDGMENT.json");
    const stored = JSON.parse(await readFile(feedback.path, "utf8"));
    expect(stored.comment).toBe("Conservative sequencing should dominate.");
    const queue = await readFile(feedback.queuePath, "utf8");
    expect(queue).toContain(feedback.id);
  });

  it("persists correction fields including blocker re-route", async () => {
    const svc = cpsExperimentsService({ selfPracticeDir: root });
    const feedback = await svc.createJudgmentFeedback("company-1", {
      experimentId: "sp-20260701T000000Z-fixture",
      label: "wrong_blocker",
      correctedVerdict: "DATA_BLOCKED",
      routeToRole: "data_engineering",
      comment: "Blocker is missing constituents data, not rules.",
    });

    expect(feedback.correctedVerdict).toBe("DATA_BLOCKED");
    expect(feedback.routeToRole).toBe("data_engineering");
    const stored = JSON.parse(await readFile(feedback.path, "utf8"));
    expect(stored.routeToRole).toBe("data_engineering");
    expect(stored.correctedVerdict).toBe("DATA_BLOCKED");
  });

  it("rejects unsupported routeToRole values", async () => {
    const svc = cpsExperimentsService({ selfPracticeDir: root });
    // The judgment schema enum is quant_review, not the roles-table quant_research.
    await expect(svc.createJudgmentFeedback("company-1", {
      experimentId: "sp-20260701T000000Z-fixture",
      label: "wrong_blocker",
      routeToRole: "quant_research",
    })).rejects.toThrow(/routeToRole/);
  });

  it("aggregates operator labels and dataset export status in the overview", async () => {
    const root2 = await mkdtemp(path.join(os.tmpdir(), "cps-experiments-labels-"));
    try {
      const expDir = path.join(root2, "exp-a");
      await mkdir(expDir, { recursive: true });
      await writeFile(path.join(expDir, "JUDGMENT.json"), JSON.stringify({
        schema: "cps.experiment_judgment.v1",
        experiment_id: "exp-a",
        result_verdict: "INCONCLUSIVE",
        promotion_verdict: "needs_review",
      }), "utf8");
      await writeFile(path.join(expDir, "PROGRESS.json"), JSON.stringify({
        schema: "cps.paper_progress.v1",
        paper_id: "exp-a",
        stages: [
          { stage: "intake", status: "done", at: "2026-07-02T00:00:00Z" },
          { stage: "decomposed", status: "done" },
          { stage: "inventory", status: "stuck", blocker: { kind: "tooling", human_required: false } },
          { stage: "data_check", status: "stuck", blocker: {
            kind: "data_subscription",
            human_required: true,
            simple_ask: "Subscribe to the IBKR US options add-on so we can pull SPY options history.",
            link: "https://www.interactivebrokers.com/en/pricing/research-news-marketdata.php",
          } },
          { stage: "replication", status: "pending" },
        ],
      }), "utf8");
      const trackerDir = path.join(root2, "experiment-tracker-20260702");
      await mkdir(trackerDir, { recursive: true });
      await writeFile(path.join(trackerDir, "EXPERIMENTS_INDEX.json"), JSON.stringify({
        schema: "cps.experiment_index.v1",
        generated_utc: "2026-07-02T00:00:00.000Z",
        entry_count: 1,
        entries: [{ id: "exp-a", updated_utc: "2026-07-02T00:00:00.000Z", kind: "strategy_experiment", status: "ok", decision: null, path: "exp-a", summary: {} }],
      }), "utf8");
      await writeFile(path.join(root2, "EXPERIMENT_JUDGMENTS.jsonl"), '{"experiment_id":"exp-a"}\n', "utf8");
      const evalsDir = path.join(root2, "evals");
      await mkdir(evalsDir, { recursive: true });
      await writeFile(path.join(evalsDir, "judgment_tinker_prompt_response.jsonl"), '{"prompt":"p","response":"r"}\n', "utf8");

      const svc = cpsExperimentsService({ selfPracticeDir: root2, evalsDir, staleAfterMs: Number.MAX_SAFE_INTEGER });
      await svc.createJudgmentFeedback("company-1", {
        experimentId: "exp-a",
        label: "disagree",
        correctedVerdict: "DATA_BLOCKED",
        routeToRole: "data_engineering",
        comment: "Needs historical constituents.",
      });
      const out = await svc.overview("company-1");

      expect(out.labels.total).toBe(1);
      expect(out.labels.byLabel.disagree).toBe(1);
      expect(out.labels.experimentsLabeled).toBe(1);
      const entry = out.entries.find((candidate) => candidate.id === "exp-a");
      expect(entry?.operatorLabels).toMatchObject({
        count: 1,
        latestLabel: "disagree",
        latestCorrectedVerdict: "DATA_BLOCKED",
        latestRouteToRole: "data_engineering",
      });
      expect(out.datasetExport.trainingRows).toBe(1);
      expect(out.datasetExport.tinkerRows).toBe(1);
      expect(out.datasetExport.evalRows).toBeNull();
      expect(out.datasetExport.evalMinLabels).toBe(100);
      expect(out.datasetExport.labeledJudgments).toBe(1);

      // Paper progress sidecar + operator actions: only stuck AND human_required
      // stages surface; the non-human tooling blocker must be excluded.
      expect(entry?.progress?.schema).toBe("cps.paper_progress.v1");
      expect(entry?.progressPath).toContain("PROGRESS.json");
      expect(out.operatorActions).toHaveLength(1);
      expect(out.operatorActions[0]).toMatchObject({
        experimentId: "exp-a",
        stage: "data_check",
        kind: "data_subscription",
        link: "https://www.interactivebrokers.com/en/pricing/research-news-marketdata.php",
      });
      expect(out.operatorActions[0].simpleAsk).toContain("IBKR");
    } finally {
      await rm(root2, { recursive: true, force: true });
    }
  });

  it("captures an idea intake: dir, snapshot files, progress sidecar, and queued decomposition", async () => {
    const root3 = await mkdtemp(path.join(os.tmpdir(), "cps-experiments-ideas-"));
    try {
      const runRequestsDir = path.join(root3, "paperclip-run-requests");
      const svc = cpsExperimentsService({ selfPracticeDir: root3, runRequestsDir });
      const idea = await svc.createIdeaIntake("company-1", {
        sourceType: "x_post",
        pastedText: "When $VIX spikes above 30 intraday, buying SPY at the close and selling at the next open wins 78% of the time since 2020.",
        title: "VIX spike fade",
      });

      expect(idea.schema).toBe("cps.idea_intake.v1");
      expect(idea.id).toMatch(/^idea-\d{8}T\d{6}-/);
      expect(idea.snapshot.fetchStatus).toBe("skipped");
      const source = await readFile(idea.snapshot.pastedTextPath, "utf8");
      expect(source).toContain("$VIX spikes above 30");
      const progress = JSON.parse(await readFile(idea.progressPath, "utf8"));
      expect(progress.schema).toBe("cps.paper_progress.v1");
      const stageStatus = Object.fromEntries(progress.stages.map((s: { stage: string; status: string }) => [s.stage, s.status]));
      expect(stageStatus.intake).toBe("done");
      expect(stageStatus.decomposed).toBe("in_progress");
      expect(stageStatus.replication).toBe("pending");
      const ideaJson = JSON.parse(await readFile(path.join(idea.dir, "IDEA.json"), "utf8"));
      expect(ideaJson.id).toBe(idea.id);
      // decomposition run request queued for the CPS consumer
      const queue = await readFile(path.join(runRequestsDir, "QUEUE.jsonl"), "utf8");
      const queued = queue.trim().split("\n").map((line) => JSON.parse(line));
      const decompose = queued.find((row) => row.id === idea.runRequestId);
      expect(decompose?.action).toBe("decompose_idea");
      expect(decompose?.experimentId).toBe(idea.id);
      expect(decompose?.safety).toMatchObject({ brokerActions: false, signalPublishing: false, allowPaidData: false, allowPaidCompute: false });
    } finally {
      await rm(root3, { recursive: true, force: true });
    }
  });

  it("rejects idea intakes without a real pasted snapshot or with unsafe URLs", async () => {
    const root3 = await mkdtemp(path.join(os.tmpdir(), "cps-experiments-ideas-bad-"));
    try {
      const svc = cpsExperimentsService({ selfPracticeDir: root3, runRequestsDir: path.join(root3, "rr") });
      await expect(svc.createIdeaIntake("company-1", { sourceType: "x_post", pastedText: "too short" }))
        .rejects.toThrow(/pastedText/);
      await expect(svc.createIdeaIntake("company-1", {
        sourceType: "article",
        pastedText: "A perfectly long enough pasted idea body for validation.",
        url: "ftp://example.com/x",
      })).rejects.toThrow(/http/);
      await expect(svc.createIdeaIntake("company-1", {
        sourceType: "article",
        pastedText: "A perfectly long enough pasted idea body for validation.",
        url: "http://127.0.0.1/admin",
      })).rejects.toThrow(/public/);
      await expect(svc.createIdeaIntake("company-1", {
        sourceType: "bad_type" as never,
        pastedText: "A perfectly long enough pasted idea body for validation.",
      })).rejects.toThrow(/sourceType/);
    } finally {
      await rm(root3, { recursive: true, force: true });
    }
  });

  it("reports the backtest queue as absent when the queue dir does not exist", async () => {
    const svc = cpsExperimentsService({ indexFile, backtestQueueDir: path.join(root, "no-such-queue") });
    const out = await svc.overview("company-1");

    expect(out.backtestQueue.present).toBe(false);
    expect(out.backtestQueue.summary).toBeNull();
    expect(out.backtestQueue.lastTick).toBeNull();
    expect(out.backtestQueue.starving).toBe(false);
    expect(out.backtestQueue.stopPresent).toBe(false);
  });

  it("summarizes E1 backtest queue depth, last tick, and worker reachability", async () => {
    const queueDir = path.join(root, "backtest-queue");
    await mkdir(queueDir, { recursive: true });
    await writeFile(path.join(queueDir, "queue.json"), JSON.stringify({
      schema: "fincli.backtest_queue.v1",
      updated_utc: "2026-07-02T11:00:00Z",
      requests: [
        { request_id: "BTQ-1", status: "PENDING", created_utc: "2026-07-02T10:00:00Z" },
        { request_id: "BTQ-2", status: "LEASED", created_utc: "2026-07-02T10:05:00Z" },
        { request_id: "BTQ-3", status: "COMPLETED", created_utc: "2026-07-02T09:00:00Z" },
        { request_id: "BTQ-4", status: "FAILED", created_utc: "2026-07-02T09:10:00Z" },
      ],
    }), "utf8");
    await writeFile(path.join(queueDir, "LAST_TICK.json"), JSON.stringify({
      schema: "fincli.backtest_queue_dispatcher_tick.v1",
      status: "COMPLETED",
      generated_utc: "2026-07-02T11:05:00Z",
      probed_workers: { lillith: "REACHABLE", "amd-minis": "UNREACHABLE" },
      reachable_workers: ["lillith"],
      leased: [{ request_id: "BTQ-2", worker: "lillith", pod: "Crypto Microstructure Pod" }],
    }), "utf8");

    const svc = cpsExperimentsService({ indexFile, backtestQueueDir: queueDir });
    const out = await svc.overview("company-1");

    expect(out.backtestQueue.present).toBe(true);
    expect(out.backtestQueue.summary).toMatchObject({
      total: 4, pending: 1, leased: 1, completed: 1, failed: 1,
    });
    expect(out.backtestQueue.oldestPendingAgeSeconds).toBeGreaterThan(0);
    expect(out.backtestQueue.lastTick).toMatchObject({
      status: "COMPLETED",
      atUtc: "2026-07-02T11:05:00Z",
      reachableWorkers: ["lillith"],
    });
    expect(out.backtestQueue.lastTick?.leased[0]).toMatchObject({ requestId: "BTQ-2", worker: "lillith" });
    // a worker is reachable, so pending work is not starving
    expect(out.backtestQueue.starving).toBe(false);
    expect(out.backtestQueue.stopPresent).toBe(false);
  });

  it("flags a starving queue and a STOP pause for the operator", async () => {
    const queueDir = path.join(root, "backtest-queue-starving");
    await mkdir(queueDir, { recursive: true });
    await writeFile(path.join(queueDir, "queue.json"), JSON.stringify({
      schema: "fincli.backtest_queue.v1",
      updated_utc: "2026-07-02T11:00:00Z",
      requests: [{ request_id: "BTQ-9", status: "PENDING", created_utc: "2026-07-02T08:00:00Z" }],
    }), "utf8");
    await writeFile(path.join(queueDir, "LAST_TICK.json"), JSON.stringify({
      status: "NO_REACHABLE_WORKERS",
      generated_utc: "2026-07-02T11:05:00Z",
      probed_workers: { lillith: "UNREACHABLE", "amd-minis": "UNREACHABLE" },
      reachable_workers: [],
      leased: [],
    }), "utf8");
    await writeFile(path.join(queueDir, "STOP"), "paused\n", "utf8");

    const svc = cpsExperimentsService({ indexFile, backtestQueueDir: queueDir });
    const out = await svc.overview("company-1");

    expect(out.backtestQueue.starving).toBe(true);
    expect(out.backtestQueue.stopPresent).toBe(true);
    expect(out.backtestQueue.lastTick?.status).toBe("NO_REACHABLE_WORKERS");
  });
});
