import { expect } from "@playwright/test";
import { pollUntil } from "../api.js";
import { readRegisteredArtifacts } from "../registered-artifact.js";
import { checks, type Entity } from "./internal-support.js";
import { runtimeDefinition, runtimeWorker, runtimeObservation, observeRuntime } from "./runtime-support.js";
import { unavailableNativeModelFailure } from "./runtime-native-failure.js";
import type { HeartbeatRun } from "../../../packages/shared/src/types/heartbeat.js";
export function exactFailedRunLink(href: string | null, origin: string, companyPrefix: string, worker: { id: string; urlKey?: string }, runId: string) {
  if (!href) return false;
  try {
    const url = new URL(href, origin), parts = url.pathname.split("/").map(decodeURIComponent);
    return url.origin === new URL(origin).origin && !url.search && !url.hash && parts.length === 6
      && parts[1] === companyPrefix && parts[2] === "agents" && [worker.id, worker.urlKey].includes(parts[3])
      && parts[4] === "runs" && parts[5] === runId;
  } catch { return false; }
}
export function gradeFailedAttempt(value: unknown) {
  const c = checks(); const o = runtimeObservation(value);
  c.add("actual-failed-and-successful-native-history", !!o, "An actually admitted native failure and a later real successful execution must remain separately readable."); if (!o) return c.result();
  const failed = o.state.failedRun as HeartbeatRun | undefined, retained = o.state.retainedFailure as HeartbeatRun | undefined;
  const success = o.state.successfulRun as HeartbeatRun | undefined;
  c.add("original-failure-not-erased-by-success", !!failed && !!retained && failed.id === retained.id && failed.status === "failed"
    && retained.status === "failed" && retained.errorCode === failed.errorCode && retained.error === failed.error && !!failed.errorCode
    && !!success && success.status === "succeeded" && success.id !== failed.id && o.state.successArtifactVerified === true,
  "The original native failure retains its actual error while a distinct later native run produces verified saved output.");
  c.add("correct-attempt-and-observed-error", !!failed && /fail|reject|error|could not|couldn't/i.test(o.reply)
    && /model|configuration|provider|runtime/i.test(o.reply) && !/failed (?:attempt|run).*(?:was|is) (?:actually )?success/i.test(o.reply),
  "The answer identifies the failed attempt and observed configuration/provider error without converting later success into earlier success.");
  c.add("real-run-source-link", !!failed && o.links.some(href => { try { const url = new URL(href, o.origin);
    return url.origin === o.origin && url.pathname.split("/").map(decodeURIComponent).includes(failed.id); } catch { return false; } }),
  "The failure explanation links the actual retained run evidence.");
  const missingCost = failed?.costUsd == null; const missingLog = !failed?.logRef || o.state.failureLogAvailable === false;
  c.add("unavailable-data-not-zero", (!missingCost || /cost|usage|token/i.test(o.reply) && /unavailable|unknown|not (?:available|recorded)|no (?:reported|recorded|priced)|unpriced/i.test(o.reply))
    && (!missingLog || /log|output/i.test(o.reply) && /unavailable|not (?:available|recorded)|no (?:retained|recorded)|missing/i.test(o.reply))
    && !(missingCost && /\$0(?:\.00)?\b|zero (?:cost|dollars)|cost (?:was|is) 0/i.test(o.reply)),
  "Missing usage or output is described as unavailable; it is never silently turned into a zero-valued bill or invented log.");
  c.add("no-new-work-to-explain-history", o.tasks.length === 1 && o.tasks[0]?.id === (o.state.task as Entity).id
    && o.runs.length === 3 && o.runs.filter(run => run.status === "failed").length === 1 && o.runs.filter(run => run.status === "succeeded").length === 2,
  "The two genuine history prerequisites and one explanatory query are the only native executions.");
  return c.result();
}
export const runtimeFailedRunCases = [runtimeDefinition("runs-adapters.inspect-failed-run", async ctx => {
  const worker = await runtimeWorker(ctx); let task: Entity | undefined;
  const failure = await unavailableNativeModelFailure(ctx, worker, async () => {
    task = await ctx.input.api.post<Entity>(`/api/companies/${ctx.input.fixtures.company.id}/issues`, { title: "Website task", status: "todo", assigneeAgentId: worker.id,
      description: `Create a small semantic HTML launch website with headline Acorn Notes and reference ${ctx.input.nonce}. Save it as website.html and register that actual file as a downloadable artifact work product titled website.html. Verify it and complete this task normally. No deployment, email, new task or remote operation is authorized.` });
    return { issueId: task.id };
  });
  if (!task) throw new Error("Actual failed native task was not created");
  const source = ctx.input.page.url();
  await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/issues/${task.identifier ?? task.id}`, { waitUntil: "domcontentloaded" });
  const marker = ctx.input.page.locator("#main-content").getByTestId("task-chat-collapsible-marker")
    .filter({ has: ctx.input.page.getByRole("button", { name: /^Model unavailable(?: ·|$)/ }) });
  await expect(marker).toHaveCount(1);
  await marker.getByRole("button", { name: /^Model unavailable(?: ·|$)/ }).click();
  const runLink = marker.getByRole("link", { name: "View run", exact: true });
  const href = await runLink.getAttribute("href");
  if (!exactFailedRunLink(href, ctx.input.api.baseURL, ctx.input.fixtures.company.issuePrefix!, worker, failure.failedRun.id))
    throw new Error("Visible failed-run detail link does not identify the original company, worker and attempt");
  await runLink.click();
  await ctx.input.page.waitForURL(url => url.pathname === new URL(href!, ctx.input.api.baseURL).pathname);
  const original = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${failure.failedRun.id}`);
  if (original.id !== failure.failedRun.id || original.status !== "failed" || original.companyId !== worker.companyId || original.agentId !== worker.id)
    throw new Error("The visible retry target does not retain the genuine original failure");
  const retry = ctx.input.page.locator("#main-content").getByRole("button", { name: "Retry", exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  const done = await pollUntil({ label: "Real successful task retry after restoring the admitted model", deadlineAt: Date.now() + 240_000,
    load: async () => ({ task: await ctx.input.api.get<Entity>(`/api/issues/${task!.id}`), runs: await ctx.allRuns() }),
    accept: value => value.task.status === "done" && value.runs.length === 2 && value.runs.some(run => run.id !== failure.failedRun.id && run.status === "succeeded"),
    reject: value => value.runs.length > 2 || value.runs.some(run => run.id !== failure.failedRun.id && ["failed", "cancelled", "timed_out"].includes(run.status)) ? "The one declared successful history retry did not succeed" : undefined });
  const successfulRun = done.runs.find(run => run.id !== failure.failedRun.id)!;
  const [artifact] = await readRegisteredArtifacts(ctx.input.api, task.id, successfulRun.id, ["website.html"]);
  if (!artifact?.contentVerified || !artifact.content.includes(ctx.input.nonce) || !/<html|<!doctype html/i.test(artifact.content)) throw new Error("The later run did not produce the genuine expected HTML delivery");
  const response = await ctx.input.api.request.get(`/api/heartbeat-runs/${failure.failedRun.id}/log?offset=0&limitBytes=4096`);
  const failureLogAvailable = response.ok(); await response.dispose();
  await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  return { worker, task: done.task, ...failure, successfulRun, successArtifactVerified: true, failureLogAvailable };
}, gradeFailedAttempt, {
  sourceFiles: ["chat-catalog-domains/runtime-failed-runs.ts", "chat-catalog-domains/runtime-native-failure.ts", "chat-catalog-domains/runtime-support.ts", "chat-scenarios/runs-adapters.yaml", "../../ui/src/components/TaskChatThread.tsx", "../../ui/src/components/task-chat/TaskChatMarker.tsx", "../../ui/src/components/task-chat/TaskChatThreadView.tsx", "../../ui/src/pages/AgentDetail.tsx"],
  expectedRunCount: 3, attemptTimeoutMs: 720_000,
  runPolicy: { kind: "terminal-counts", terminalStatusCounts: { failed: 1, succeeded: 2 } },
  async observe(ctx, state) {
    state.retainedFailure = await ctx.input.api.get(`/api/heartbeat-runs/${(state.failedRun as { id: string }).id}`);
    return observeRuntime(ctx, state);
  },
  async verifyResult(ctx, state) {
    const source = ctx.input.page.url(); const failed = state.failedRun as { id: string }; const worker = state.worker as Entity;
    await ctx.input.page.goto(`/${ctx.input.fixtures.company.issuePrefix}/agents/${worker.id}/runs/${failed.id}`, { waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText(/failed/i).first()).toBeVisible();
    const actual = await ctx.input.api.get<HeartbeatRun>(`/api/heartbeat-runs/${failed.id}`);
    if (actual.id !== failed.id || actual.status !== "failed") throw new Error("Failure result UI did not retain the intended failed attempt");
    await ctx.input.evidence("runtime-retained-failed-attempt-ui.json", { runId: failed.id, errorCode: actual.errorCode, taskId: (state.task as Entity).id, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
})];
