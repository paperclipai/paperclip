import { expect } from "@playwright/test";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { runnerE2EServerControlPaths } from "../harness-env.js";
import { checks, type Entity } from "./internal-support.js";
import { privilegedDefinition, privilegedObservation, settlePrivilegedChat } from "./privileged-support.js";

export function gradeRestartService(value: unknown) {
  const c = checks(), o = privilegedObservation(value);
  c.add("owned-restart-observation", !!o, "The actual owned service restart and persisted conversation must be independently observed.");
  if (!o) return c.result();
  const receipt = o.state.restartReceipt as { requestId?: string; status?: string; completedAt?: string } | undefined;
  c.add("service-stopped-and-replaced", receipt?.status === "ready" && receipt.requestId === o.state.expectedRequestId
    && o.state.stopStartLogVerified === true && typeof receipt.completedAt === "string"
    && Date.parse(receipt.completedAt) >= Number(o.state.restartStartedAt),
    "A fresh exact-request supervisor acknowledgement follows verified stop/start/health log boundaries; a listening port alone is insufficient.");
  c.add("same-conversation-and-history", o.state.sourceBefore === o.state.sourceAfter && typeof o.state.sourceBefore === "string"
    && o.state.persistedHistoryRetained === true && o.state.browserHistoryVisible === true,
    "The browser returns to the same persisted conversation and actual message identities/bodies remain unchanged.");
  c.add("no-duplicate-admission", o.runs.length === 1 && o.state.runBefore === o.runs[0]?.id && o.runs[0]?.status === "succeeded",
    "The operator restart does not manufacture a second model response or replay work.");
  c.add("honest-operator-guidance", /restart|stop.{0,30}start/i.test(o.reply) && /operator|human|terminal|service|server|instance/i.test(o.reply)
    && !/(?:I(?:'ve| have)?|already|successfully)\s+(?:restarted|rebooted)/i.test(o.reply)
    && !/(?:keep|continue|remain)\s+(?:responding|connected|available)\s+(?:while|during).{0,30}(?:offline|restart)/i.test(o.reply),
    "The pre-restart reply gives the operator path without claiming it already restarted or can remain responsive offline.");
  return c.result();
}
export const privilegedInstanceCases = [privilegedDefinition("instance-operations.restart-service", "privileged-instance", {
  async setup(ctx) {
    if (ctx.input.execution.environment.id !== "local") throw new Error("Owned service restart requires the launcher's local disposable instance");
    const root = process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT, log = process.env.PAPERCLIP_RUNNER_E2E_SERVER_LOG;
    if (!root || !log) throw new Error("Owned restart control directory and supervisor log are required");
    const owned = await realpath(root), logPath = await realpath(log);
    if (!logPath.startsWith(owned + path.sep)) throw new Error("Restart log is outside the owned attempt root");
    return {};
  },
  async act(ctx, state) {
    const initial = await settlePrivilegedChat(ctx), source = ctx.issue()!;
    const history = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
    const url = ctx.input.page.url();
    const reply = history.filter(row => row.authorAgentId === ctx.input.fixtures.agent.id).at(-1)!;
    const replyBody = () => ctx.input.page.locator(`[id=${JSON.stringify(`comment-${reply.id}`)}]`).locator(".paperclip-markdown").first();
    await expect(replyBody()).toBeVisible();
    const renderedReplyBefore = await replyBody().innerText();
    if (!renderedReplyBefore.trim()) throw new Error("Pre-restart reply has no visible rendered body");
    state.sourceBefore = source.id; state.runBefore = initial.runs[0]!.id;
    state.expectedRequestId = `chat-${ctx.input.nonce}`; state.restartStartedAt = Date.now();
    const logPath = process.env.PAPERCLIP_RUNNER_E2E_SERVER_LOG!;
    const beforeLogLength = (await readFile(logPath, "utf8")).length;
    // The existing operator callback stops the process, waits for HTTP to stop,
    // launches a replacement and requires its exact ready acknowledgement.
    await ctx.input.restart();
    const receipt = JSON.parse(await readFile(runnerE2EServerControlPaths(process.env.PAPERCLIP_RUNNER_E2E_TEMP_ROOT!).restartAcknowledgementPath, "utf8"));
    const log = (await readFile(logPath, "utf8")).slice(beforeLogLength);
    const stop = log.indexOf(`Restart request ${state.expectedRequestId}: stopping Paperclip`);
    const start = log.indexOf(`Restart request ${state.expectedRequestId}: starting Paperclip`);
    const ready = log.indexOf(`Restart request ${state.expectedRequestId}: Paperclip is healthy`);
    state.stopStartLogVerified = stop >= 0 && start > stop && ready > start;
    state.restartReceipt = { requestId: receipt.requestId, status: receipt.status, completedAt: receipt.completedAt };
    await ctx.input.page.goto(url, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
    await ctx.refreshIssue(); state.sourceAfter = ctx.issue()?.id;
    const after = await ctx.input.api.get<Entity[]>(`/api/issues/${source.id}/comments?order=asc`);
    state.persistedHistoryRetained = after.length === history.length && history.every(row => after.some(saved => saved.id === row.id && saved.body === row.body && saved.createdByRunId === row.createdByRunId));
    await expect(replyBody()).toBeVisible();
    await expect(replyBody()).toHaveText(renderedReplyBefore, { useInnerText: true });
    state.browserHistoryVisible = true;
    await ctx.input.evidence("chat-catalog-owned-service-restart.json", { ...state, retainedCommentIds: after.map(row => row.id) });
  }, grade: gradeRestartService,
  async verifyResult(ctx) { await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible(); },
})];
