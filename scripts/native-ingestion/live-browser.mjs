import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// Private acceptance helper. Configuration contains only an owned loopback
// origin, company/agent IDs and evidence paths; never provider credentials.
const config = JSON.parse(await readFile(process.argv[2], "utf8"));
const origin = new URL(config.origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)) throw new Error("Owned loopback application required");
const require = createRequire(join(config.repository, "package.json"));
const { chromium, expect } = require("@playwright/test");
const { createTaskThroughUi } = await import(pathToFileURL(join(config.repository, "tests/runner-e2e/user-actions.ts")).href);
await mkdir(config.evidenceDir, { recursive: true });
const evidence = { startedAt: new Date().toISOString(), config, journeys: [], status: "running" };
const save = () => writeFile(join(config.evidenceDir, "live-provider-result.json"), JSON.stringify(evidence, null, 2));
const api = async route => {
  const response = await fetch(new URL(route, origin));
  if (!response.ok) throw new Error(`Read ${route}: HTTP ${response.status}`);
  return response.json();
};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function poll(label, load, accept, deadlineMs = 180_000) {
  const deadline = Date.now() + deadlineMs;
  while (true) {
    const value = await load();
    if (accept(value)) return value;
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await pause(250);
  }
}
async function eventsFor(runId) {
  const result = [];
  while (true) {
    const page = await api(`/api/heartbeat-runs/${runId}/events?afterSeq=${result.at(-1)?.seq ?? 0}&limit=1000`);
    result.push(...page);
    if (page.length < 1000) return result;
  }
}
const runSummary = run => ({ id: run.id, status: run.status, runtimeMode: run.runtimeMode,
  driverKind: run.driverKind, providerSessionId: run.providerSessionId ?? run.sessionIdAfter ?? run.runnerProfileJson?.sessionCheckpoint?.providerSessionId,
  nativeSessionId: run.nativeSessionId,
  startedAt: run.startedAt, finishedAt: run.finishedAt, error: run.error,
  nativePhase: run.nativePhase, provider: run.runnerProfileJson?.nativeExecutionInput?.provider ?? run.runnerProfileJson?.provider,
  cancellation: run.resultJson?.nativeCancellation });
async function taskRuns(issueId) {
  const rows = await api(`/api/companies/${config.company.id}/heartbeat-runs?agentId=${config.agent.id}&limit=100`);
  const details = await Promise.all(rows.map(run => api(`/api/heartbeat-runs/${run.id}`)));
  return details.filter(run => run.nativeIssueId === issueId || run.contextSnapshot?.issueId === issueId);
}
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
  recordVideo: { dir: join(config.evidenceDir, "video"), size: { width: 1440, height: 1000 } } });
await context.tracing.start({ screenshots: true, snapshots: true });
const page = await context.newPage();
const visibleAgentText = async () => (await page.getByTestId("issue-detail-content")
  .getByTestId("task-chat-thread")
  .locator('[data-conversation-message="agent"] [data-conversation-text]:visible, [data-testid="task-chat-phase-interstitial"]:visible, [data-testid="task-chat-live-text"]:visible, [data-testid="task-chat-live-self-talk"]:visible')
  .allInnerTexts()).join("\n");
const normalizeVisible = value => String(value).replace(/[*_`#]/g, "").replace(/\s+/g, " ").trim();
let activeIssueId;
try {
  const health = await api("/api/health");
  const agent = await api(`/api/agents/${config.agent.id}`);
  if (agent.companyId !== config.company.id || agent.adapterType !== "paperclip_runner" || agent.adapterConfig?.provider !== "opencode")
    throw new Error("Configured agent is not the owned native OpenCode agent");
  evidence.health = { status: health.status, gitCommit: health.gitCommit ?? health.commit ?? health.version };
  evidence.provider = { adapterType: agent.adapterType, provider: agent.adapterConfig.provider, model: agent.adapterConfig.model };
  const marker = `LIVE-INGESTION-${Date.now()}`;
  const journey = { kind: "stream-tool-result-reload", marker, status: "running" };
  evidence.journeys.push(journey);
  const created = await createTaskThroughUi({ page, origin: origin.href, issuePrefix: config.company.issuePrefix,
    agentName: config.agent.name, title: `Native live ingestion ${marker}`, workMode: "standard", requireExplicitTitle: true,
    prompt: `Verify this isolated test task. First send a short progress message with ${marker}-START. Use the native Paperclip list_task_documents tool to inspect this task's documents and report the count. Then provide twelve numbered sentences about what this check proves. Include ${marker}-DONE in the final response and finish the task. Do not modify files or access unrelated tasks or services.` });
  activeIssueId = created.issueId; journey.issueId = created.issueId;
  await page.goto(new URL(`/${config.company.issuePrefix}/issues/${created.issueId}`, origin).href);
  const streaming = await poll("ordinary assistant delta visibly rendered before terminal", async () => {
    const runs = await taskRuns(created.issueId);
    const active = runs.find(run => run.status === "running");
    if (!active) return null;
    const text = normalizeVisible(await visibleAgentText());
    const visibleAt = Date.now();
    const rows = await eventsFor(active.id);
    const events = rows.map(row => row.payload?.prpEvent).filter(Boolean);
    if (rows.some(row => ["run.result.accepted", "run.terminal"].includes(row.eventType)
      || ["run.result.accepted", "run.terminal"].includes(row.payload?.prpEvent?.eventType))) return null;
    const sameItem = (left, right) => left.runId === right.runId && left.sourceInstanceId === right.sourceInstanceId
      && left.turnId === right.turnId && left.itemId === right.itemId;
    const delta = events.find(event => event?.eventType === "item.delta" && event.runId === active.id
      && event.payload.kind === "agentMessage" && normalizeVisible(event.payload.text).length >= 12
      && text.includes(normalizeVisible(event.payload.text)) && typeof event.itemId === "string"
      && !events.some(item => ["item.completed", "item.failed", "item.cancelled"].includes(item.eventType) && sameItem(item, event)));
    if (!delta) return null;
    // Re-read status after observing the matching UI text. A completed run
    // discovered on the next poll cannot establish streaming visibility.
    const observedRun = await api(`/api/heartbeat-runs/${active.id}`);
    if (observedRun.status !== "running" || observedRun.finishedAt || observedRun.nativePhase === "workspace_finalizing") return null;
    return { runId: active.id, sourceEventId: delta.sourceEventId, sourceSeq: delta.sourceSeq,
      emittedAt: delta.emittedAt, visibleText: text.slice(-1000), visibleAt,
      run: runSummary(observedRun), statusObservedAt: Date.now() };
  }, Boolean);
  journey.visibleDelta = streaming;
  journey.firstVisibleAt = streaming.visibleAt;
  journey.streamingRunStatuses = [streaming.run];
  journey.visibleBeforeTerminal = streaming.run.status === "running";
  expect(journey.visibleBeforeTerminal).toBe(true);
  await page.screenshot({ path: join(config.evidenceDir, "live-streaming.png"), fullPage: true });
  const finished = await poll("completed native run", () => taskRuns(created.issueId), runs =>
    runs.length > 0 && runs.every(run => !["queued", "running", "scheduled_retry"].includes(run.status)));
  journey.runs = finished.map(runSummary);
  if (finished.length !== 1 || finished[0].status !== "succeeded" || finished[0].runtimeMode !== "native")
    throw new Error(`Live run did not succeed: ${JSON.stringify(journey.runs)}`);
  const rows = await eventsFor(finished[0].id);
  const prp = rows.map(row => row.payload?.prpEvent).filter(Boolean);
  journey.eventCounts = Object.fromEntries([...new Set(prp.map(event => event.eventType))].map(type => [type, prp.filter(event => event.eventType === type).length]));
  journey.toolEvidence = prp.filter(event => event.eventType.startsWith("tool.")
    && JSON.stringify(event.payload).includes("list_task_documents"))
    .map(event => ({ eventType: event.eventType, sourceEventId: event.sourceEventId, sourceSeq: event.sourceSeq,
      name: event.payload.name, operation: event.payload.operation, status: event.payload.status }));
  expect(prp.some(event => event.eventType === "item.delta" && event.payload.kind === "agentMessage")).toBe(true);
  expect(journey.toolEvidence.some(event => event.eventType === "tool.execution.completed")).toBe(true);
  expect(prp.some(event => event.eventType === "run.result.accepted")).toBe(true);
  await expect.poll(visibleAgentText, { timeout: 30_000 }).toContain(`${marker}-DONE`);
  await page.screenshot({ path: join(config.evidenceDir, "live-result.png"), fullPage: true });
  await page.reload({ waitUntil: "domcontentloaded" });
  await expect.poll(visibleAgentText, { timeout: 30_000 }).toContain(`${marker}-DONE`);
  await page.screenshot({ path: join(config.evidenceDir, "live-reloaded.png"), fullPage: true });
  journey.persistedAfterReload = true; journey.status = "passed";
  activeIssueId = undefined;
  await save();

  const stopped = { kind: "stop-live-provider", status: "running" };
  evidence.journeys.push(stopped);
  const stopTask = await createTaskThroughUi({ page, origin: origin.href, issuePrefix: config.company.issuePrefix,
    agentName: config.agent.name, title: `Native live Stop ${marker}`, workMode: "standard", requireExplicitTitle: true,
    prompt: `This isolated task verifies the Stop control. First send a short progress message containing ${marker}-STOP-START. Then use your native shell tool to run exactly sleep 60 in the task workspace. Wait for the command and report only after it finishes. Do not modify files or use unrelated resources.` });
  activeIssueId = stopTask.issueId; stopped.issueId = stopTask.issueId;
  await page.goto(new URL(`/${config.company.issuePrefix}/issues/${stopTask.issueId}`, origin).href);
  const active = await poll("live provider tool execution", async () => {
    const runs = await taskRuns(stopTask.issueId);
    if (runs.length !== 1 || runs[0].status !== "running") return null;
    const events = await eventsFor(runs[0].id);
    const started = events.map(row => row.payload?.prpEvent).filter(event => event?.eventType === "tool.execution.started");
    stopped.startedTools = started.map(event => ({ name: event.payload.name, operation: event.payload.operation,
      sourceEventId: event.sourceEventId }));
    return started.some(event => /shell|bash|execute/i.test(String(event.payload.name) + String(event.payload.operation))) ? runs[0] : null;
  }, Boolean);
  stopped.activeRunId = active.id;
  await page.screenshot({ path: join(config.evidenceDir, "before-live-stop.png"), fullPage: true });
  stopped.requestedAt = Date.now();
  await page.getByTestId("task-chat-composer-stop").last().click();
  const afterStop = await poll("native cancellation acknowledgement", async () => {
    const runs = await taskRuns(stopTask.issueId);
    return runs.length === 1 ? await api(`/api/heartbeat-runs/${runs[0].id}`) : null;
  }, run => run?.status === "cancelled" && run.resultJson?.nativeCancellation?.dispatchState === "acknowledged");
  stopped.acknowledgedAt = Date.now(); stopped.run = runSummary(afterStop);
  expect(afterStop.id).toBe(active.id);
  await page.reload({ waitUntil: "domcontentloaded" });
  await pause(1000);
  stopped.runIdsAfterReload = (await taskRuns(stopTask.issueId)).map(run => run.id);
  expect(stopped.runIdsAfterReload).toEqual([active.id]);
  await page.screenshot({ path: join(config.evidenceDir, "after-live-stop.png"), fullPage: true });
  stopped.status = "passed"; activeIssueId = undefined;
  evidence.status = "passed";
} catch (error) {
  evidence.status = "failed";
  evidence.error = error instanceof Error ? { name: error.name, message: error.message, stack: error.stack } : String(error);
  await page.screenshot({ path: join(config.evidenceDir, "live-failure.png"), fullPage: true }).catch(() => undefined);
  if (activeIssueId) {
    // Cleanup uses the same visible Stop action; failure remains in evidence.
    const stop = page.getByTestId("task-chat-composer-stop").last();
    if (await stop.isVisible().catch(() => false)) await stop.click().catch(() => undefined);
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  await save();
  await context.tracing.stop({ path: join(config.evidenceDir, "live-provider-trace.zip") });
  await context.close(); await browser.close();
}
console.log(JSON.stringify({ status: evidence.status, evidenceDir: config.evidenceDir, journeys: evidence.journeys.map(journey =>
  ({ kind: journey.kind, status: journey.status, issueId: journey.issueId, runs: journey.runs ?? journey.run })) }));
if (evidence.status !== "passed") process.exitCode = 1;
