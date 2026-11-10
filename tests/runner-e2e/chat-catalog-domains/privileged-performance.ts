import { chatCatalogNativePhaseDeadline, chatCatalogNativePhaseIsTimely, chatCatalogNativePhaseRemainingBudget } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import os from "node:os";
import { pollUntil } from "../api.js";
import { sendChatMessage } from "../chat-flow.js";
import { checks, type Entity } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat } from "./privileged-support.js";
interface FixtureReport {
  scope: string; commentCount: number; rowCount: number; markdownCount: number;
  mountMs: number; latestMs: number; maximumMs: number; totalMs: number; commitCount: number;
  environment: { platform: string; architecture: string; node: string; cpuModel: string; cpuCount: number; browser: string; viewport: unknown; measuredAt: string };
  fixtureSha256: string;
}
export function gradeLongThreadPerformance(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("actual-performance-observation", !!o, "A documented fixed-fixture measurement and attributed interpretation turn are required."); if (!o) return c.result();
  const report = o.state.performanceReport as FixtureReport | undefined;
  c.add("fixed-fixture-measured", !!report && report.commentCount === 469 && report.rowCount === 487 && report.markdownCount === 150
    && [report.mountMs, report.latestMs, report.maximumMs, report.totalMs].every(value => Number.isFinite(value) && value >= 0)
    && report.commitCount >= 1 && report.fixtureSha256.length === 64 && !!report.environment.browser && !!report.environment.measuredAt,
    "Actual browser profiler values, fixed data size, source hash and measurement environment are retained together.");
  const phase = o.state.interpretation as { attributed?: boolean; reply?: string; humanCommentId?: string; runId?: string } | undefined;
  const reply = phase?.reply ?? "";
  c.add("report-bound-native-reply", phase?.attributed === true && !!phase.humanCommentId && !!phase.runId && !!reply
    && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded" && run.agentId === o.leadId),
    "The interpretation is the actual second native reply to the exact persisted human report, not initial guidance or a fabricated result.");
  // The interpretation is free-form analysis: correct replies round
  // ("~470 comments", "~0.27s"), propose other sizes ("50 comments") and
  // combine phases, so parsing its numbers or words rejects valid answers.
  // Code grades the measured report and that the reply is the attributed
  // answer to it; a reviewer reads the interpretation itself.
  return c.result();
}
const performance = privilegedDefinition("developer-labs.long-thread-performance", "privileged-performance", {
  async setup() { return {}; },
  async act(ctx, state) {
    const first = await settlePrivilegedChat(ctx), source = ctx.input.page.url(), page = ctx.input.page;
    state.initialGuidanceRunId = first.runs[0]!.id;
    const numeric = async (id: string) => Number((await page.getByTestId(id).innerText()).replace(/\s*ms$/, ""));
    let report: FixtureReport;
    try {
      await page.goto(new URL("/tests/perf/long-thread", ctx.input.api.baseURL).href, { waitUntil: "domcontentloaded" });
      await expect(page.getByTestId("issue-chat-long-thread-perf")).toBeVisible();
      await expect.poll(() => numeric("perf-mount-duration")).toBeGreaterThanOrEqual(0);
      const browser = await page.evaluate(() => navigator.userAgent);
      report = { scope: "one fixed synthetic long-thread UI fixture; direct-render mount and profiler timings", commentCount: 469,
        rowCount: await numeric("perf-fixture-row-target"), markdownCount: await numeric("perf-fixture-markdown-rows"),
        mountMs: await numeric("perf-mount-duration"), latestMs: await numeric("perf-latest-duration"), maximumMs: await numeric("perf-max-duration"),
        totalMs: await numeric("perf-total-duration"), commitCount: await numeric("perf-commit-count"),
        fixtureSha256: createHash("sha256").update(await readFile(new URL("../../../ui/src/fixtures/issueChatLongThreadFixture.ts", import.meta.url))).digest("hex"),
        environment: { platform: os.platform(), architecture: os.arch(), node: process.versions.node, cpuModel: os.cpus()[0]?.model ?? "unavailable",
          cpuCount: os.cpus().length, browser, viewport: page.viewportSize(), measuredAt: new Date().toISOString() } };
      state.performanceReport = report;
      await ctx.input.evidence("chat-catalog-long-thread-measurement.json", report);
      await ctx.input.capture("long-thread-performance", "Actual fixed-fixture render measurements", "long-thread-performance.png");
    } finally { await page.goto(source, { waitUntil: "domcontentloaded" }); }
    // Declared operator companion step: facts only, no desired conclusion or threshold.
    const message = `Here is the report from my owned documented long-thread fixture. Please interpret the measured behavior and its limits:\n\n${JSON.stringify(report!)}`;
    await sendChatMessage(page, message, chatCatalogNativePhaseRemainingBudget(ctx));
    const final = await pollUntil({ label: "Actual native interpretation of the measured report", deadlineAt: chatCatalogNativePhaseDeadline(ctx, Date.now() + 150_000),
      load: async () => { await ctx.refreshIssue(); return { issue: ctx.issue(), runs: await ctx.allRuns() }; },
      accept: o => chatCatalogNativePhaseIsTimely(ctx) && o.issue?.conversationState === "waiting" && o.runs.length === 2 && o.runs.every(run => run.status === "succeeded") });
    const run = final.runs.find(run => run.id !== first.runs[0]!.id)!;
    const comments = await ctx.input.api.get<Entity[]>(`/api/issues/${ctx.issue()!.id}/comments?order=asc`);
    const human = comments.filter(comment => !comment.authorAgentId && comment.body === message);
    const replies = comments.filter(comment => comment.authorAgentId === ctx.input.fixtures.agent.id && comment.createdByRunId === run.id);
    const profile = await ctx.input.api.get<{ runnerProfileJson?: { nativeExecutionInput?: { task?: { prompt?: string } } } }>(`/api/heartbeat-runs/${run.id}`);
    state.interpretation = { humanCommentId: human[0]?.id, runId: run.id, reply: replies.map(row => row.body).join("\n"),
      attributed: human.length === 1 && replies.length > 0 && profile.runnerProfileJson?.nativeExecutionInput?.task?.prompt?.includes(human[0]!.id) === true
        && replies.every(reply => Date.parse(reply.createdAt!) >= Date.parse(human[0]!.createdAt!)) };
    await ctx.input.evidence("chat-catalog-long-thread-interpretation.json", state.interpretation);
  }, grade: gradeLongThreadPerformance,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
});
performance.oracleVersion = "paperclip.chat-catalog.privileged.long-thread-performance.v3"; performance.expectedRunCount = 2; performance.expectedHumanMessageCount = 2; performance.attemptTimeoutMs = 600_000;
performance.sourceFiles = [...performance.sourceFiles, "../../ui/src/pages/IssueChatLongThreadPerf.tsx", "../../ui/src/fixtures/issueChatLongThreadFixture.ts"];
export const privilegedPerformanceCases = [performance];
