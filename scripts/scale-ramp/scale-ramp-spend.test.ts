import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { PaperclipClient, Redactor } from "./client.ts";
import { parseOptions, QUALIFIED_OPENCODE_MODEL } from "./config.ts";
import { checkSpend, estimateSpend } from "./estimate.ts";
import { EXIT, main } from "./main.ts";
import { Ramp } from "./ramp.ts";
import { prepareCompany } from "./setup.ts";
import { emptyState, fileStateStore, type RunState } from "./state.ts";
import { baseArgs, goodMetrics, harness, METRICS_URL, ORIGIN, PROVIDER_KEY, readResult, tempDir, TOKEN } from "./test-harness.ts";

describe("dry run and spend", () => {
  it("prints the plan and estimate and touches nothing", async () => {
    const out = await tempDir();
    const h = harness();
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--dry-run"], h.deps);
    assert.equal(code, EXIT.pass);
    assert.equal(h.fetchCalls(), 0);
    assert.deepEqual(await readdir(out), []);
    const text = h.out.join("\n");
    assert.match(text, /Ramp: 10 -> 50 -> 100 -> 200 -> 500 -> 1000 agents/);
    assert.match(text, /Estimated spend: \$\d/);
    assert.match(text, /retry_needed_zero \[finish-line\]/);
    assert.match(text, /Dry run: nothing was created or contacted/);
  });

  it("estimates tasks, sandbox-hours and cost from the steps", () => {
    const options = parseOptions(["--base-url", ORIGIN, "--target-kind", "test-stack", "--steps", "10,50", "--hold-minutes", "10", "--task-minutes", "5",
      "--drain-minutes", "10"], {}, 0);
    const estimate = estimateSpend(options);
    assert.equal(estimate.agents, 50);
    assert.equal(estimate.tasks, 10 * 2 + 50 * 2);
    assert.equal(estimate.maxTasks, 150);
    assert.equal(estimate.sandboxHours, 18.3);
    assert.equal(estimate.modelUsd, 3);
    assert.equal(estimate.totalUsd, 4.83);
  });

  it("requires --confirm-spend of at least the estimate above the threshold", async () => {
    const estimate = { totalUsd: 120 } as ReturnType<typeof estimateSpend>;
    assert.equal(checkSpend(estimate, 5, null).ok, false);
    assert.equal(checkSpend(estimate, 5, 100).ok, false);
    assert.equal(checkSpend(estimate, 5, 130).ok, true);
    assert.equal(checkSpend(estimate, 200, null).ok, true);
    const out = await tempDir();
    const h = harness();
    const code = await main(["--base-url", ORIGIN, "--target-kind", "test-stack", "--out", out, "--yes"], h.deps);
    assert.equal(code, EXIT.usage);
    assert.equal(h.fetchCalls(), 0);
    assert.match(h.err.join("\n"), /--confirm-spend/);
  });

  it("defaults to the qualified OpenCode model of the runner", async () => {
    const source = await readFile(path.join(import.meta.dirname, "../../packages/paperclip-runner/src/drivers/opencode/opencode-server-driver.ts"), "utf8");
    const match = /QUALIFIED_OPENCODE_MODEL\s*=\s*"([^"]+)"/.exec(source);
    assert.equal(match?.[1], QUALIFIED_OPENCODE_MODEL);
  });
});

describe("recorded model spend", () => {
  it("records model spend from Paperclip's cost records, which the run list does not carry", async () => {
    const out = await tempDir();
    const h = harness({ costPerRunUsd: 0.25 });
    await main(baseArgs(out, ["--steps", "2", "--drain-minutes", "0"]), h.deps);
    const result = await readResult(out);
    const finished = [...h.fake.runs.values()].filter(run => run.status === "succeeded").length;
    assert.ok(finished > 0);
    assert.equal(result.recordedSpendUsd, Math.round(finished * 25) / 100);
    assert.equal(result.steps[0]!.metrics.recordedSpendUsd, result.recordedSpendUsd);
    const capped = await tempDir();
    const h2 = harness({ costPerRunUsd: 3 });
    await main(baseArgs(capped, ["--steps", "2", "--hold-minutes", "20"]), h2.deps);
    assert.equal((await readResult(capped)).stop!.criterion, "spend_cap");
  });

  it("keeps the spend of a ramp that crosses a month boundary", async () => {
    const out = await tempDir();
    const h = harness({ costPerRunUsd: 0.25 });
    h.clock.t = Date.parse("2026-11-30T23:58:00.000Z");
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const result = await readResult(out);
    const finished = [...h.fake.runs.values()].filter(run => run.status === "succeeded");
    assert.ok(finished.some(run => new Date(run.finishedAt!).getUTCMonth() === 10), "some spend is in the earlier month");
    assert.ok(finished.some(run => new Date(run.finishedAt!).getUTCMonth() === 11), "some spend is in the later month");
    assert.equal(result.recordedSpendUsd, Math.round(finished.length * 25) / 100);
  });

  it("grades a run incomplete when some cost events have no known price", async () => {
    const out = await tempDir();
    const h = harness({ metricsUrl: METRICS_URL, metrics: goodMetrics, unpricedEventsPerAgent: 1 }, { PAPERCLIP_SCALE_METRICS_URL: METRICS_URL });
    await main(baseArgs(out, ["--steps", "2"]), h.deps);
    const result = await readResult(out);
    assert.equal(result.verdict, "incomplete");
    assert.ok(result.incompleteReasons.some(reason => /2 cost events have no known price/.test(reason)), result.incompleteReasons.join("; "));
    assert.match(result.sources.modelSpend!, /no known price/);
    assert.equal(result.unpricedCostEvents, 2);
    assert.match(await readFile(path.join(out, "scale-test-run", "SUMMARY.md"), "utf8"), /incomplete: 2 cost events have no known price/);
    assert.ok(h.out.some(line => /^Warning: \d+ cost events of this run have no known price/.test(line)));
  });

  it("stops on a conservative spend bound when cost events have no known price", async () => {
    const out = await tempDir();
    const h = harness({ costPerRunUsd: 0, unpricedEventsPerAgent: 1 }, { PAPERCLIP_SCALE_MODEL_USD_PER_TASK: "0.5" });
    const options = parseOptions(baseArgs(out, ["--steps", "2", "--hold-minutes", "20"]), h.deps.env, h.clock.now());
    const api = new PaperclipClient(options.target, TOKEN, h.deps.fetcher, h.clock, new Redactor([TOKEN]));
    const state: RunState = emptyState(options.label, options.target.baseUrl, h.clock.now());
    const store = fileStateStore(options.outDir);
    await prepareCompany({ api, options, state, store, credential: PROVIDER_KEY, log: () => {} });
    const outcome = await new Ramp({ api, clock: h.clock, fetcher: h.deps.fetcher, options, state, store, maxTasks: 100, spendCapUsd: 2, metricsToken: null,
      log: () => {}, shouldStop: () => false }).run();
    assert.equal(outcome.recordedSpendUsd, 0);
    assert.equal(outcome.stop!.criterion, "spend_cap");
    assert.match(outcome.stop!.reason, /no known price.*passed the cap of \$2/);
    assert.ok(outcome.tasksCreated >= 5 && outcome.tasksCreated <= 6, `tasks: ${outcome.tasksCreated}`);
  });

  it("stops when recorded spend cannot be read, and reports spend as not measured", async () => {
    const out = await tempDir();
    const h = harness({ failRequest: (method, route, count) => method === "GET" && route.endsWith("/costs/by-agent") && count > 2
      ? { status: 503, body: "{\"error\":\"unavailable\"}" } : null });
    const code = await main(baseArgs(out, ["--steps", "2", "--hold-minutes", "20"]), h.deps);
    const result = await readResult(out);
    assert.equal(code, EXIT.fail);
    assert.equal(result.stop!.criterion, "spend_unreadable");
    assert.match(result.stop!.reason, /could not be read 3 times in a row/);
    assert.equal(result.recordedSpendUsd, null);
    assert.match(result.sources.modelSpend!, /not measured/);
  });

});
