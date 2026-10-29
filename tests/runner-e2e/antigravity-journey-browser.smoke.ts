/** Credential-free calibration of the measured selectors in a real browser.
 * Synthetic loopback HTML is deliberately not live Antigravity qualification. */
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import path from "node:path";
import { assertAntigravityCleanComposer, assertAntigravityFileActivity, assertAntigravityReady, assertAntigravityTaskDone, inspectAntigravityArtifact, openAntigravityAgentFromRoster, selectAntigravityFromOrdinaryPicker } from "./antigravity-journey-ui.js";

const agent = "Antigravity QA synthetic", model = "gemini-3.8-flash-low";
const artifactPath = "/api/attachments/synthetic-proof/content", artifactBytes = Buffer.from("Synthetic file viewer calibration\n");
const fixtures: Record<string, string> = {
  artifact: `<article><a href="${artifactPath}">Download</a><button aria-label="Open in tab: antigravity-proof.txt" onclick="document.getElementById('file-viewer').hidden=false">Open in tab</button></article><p><a href="/api/attachments/older-proof/content">Download antigravity-proof.txt</a></p><div id="file-viewer" hidden><pre aria-label="antigravity-proof.txt raw text">${artifactBytes.toString("utf8")}</pre><a download aria-label="Download antigravity-proof.txt" href="${artifactPath}?download=1">Download</a></div>`,
  dashboard: `<aside><a href="/roster">Agents</a><a href="/wrong-agent">An older agent</a></aside><nav aria-label="breadcrumb"><a href="/roster">Agents</a></nav><main>Ready confirmation after closing composer</main>`,
  roster: `<aside><a href="/roster">Agents</a><a href="/wrong-agent">${agent}</a></aside><main><div role="toolbar" aria-label="Agents controls"><input aria-label="Search agents"></div><a href="/wrong-agent"><span>${agent} older</span>Engineer idle</a><a href="/owned-agent"><span>${agent}</span>Engineer idle</a><a hidden href="/wrong-agent"><span>${agent}</span>Engineer idle</a></main>`,
  "owned-agent": `<main><h1>${agent}</h1></main>`,
  picker: `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><label><input type="radio" name="adapter">Google Antigravity Candidate</label><details><summary>Advanced</summary><label><input type="radio" name="adapter">Other harness</label></details><button>Configure agent</button></div><div hidden><label><input type="radio">Google Antigravity Candidate</label></div>`,
  "advanced-only": `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><details open><summary>Advanced</summary><label><input type="radio">Google Antigravity Candidate</label></details><button>Configure agent</button></div>`,
  ready: `<div hidden><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button></div><h2>Your agent is ready</h2><button>Assign ${agent} a Task</button>`,
  "narrative-ready": `<p>The assistant says Your agent is ready.</p><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button>`,
  done: `<div hidden data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)">Todo</button></div><div data-testid="issue-detail-header"><button aria-label="Change status (current: Done)"><svg><title>Done</title></svg></button></div><div role="menu" hidden>Done</div><p>Earlier task: Todo</p>`,
  "narrative-done": `<div data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)"><svg><title>Done</title></svg></button></div><div hidden><button aria-label="Change status (current: Done)">Done</button></div><p>The task is Done</p>`,
  composer: `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div hidden data-testid="new-issue-paused-assignee-note">paused</div></div><div data-testid="new-issue-paused-assignee-note">unrelated paused agent</div>`,
  "paused-composer": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div data-testid="new-issue-paused-assignee-note">paused</div></div>`,
  "wrong-model": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">gemini-3.8-flash-high</span></button><p>${model}</p></div>`,
};
// The activity calibration bundles the shipped adapter and React renderer.
// No hand-authored activity markup can accidentally validate invented copy.
const activityBundle = await build({ stdin: { loader: "tsx", resolveDir: path.resolve(import.meta.dirname, "../../ui"), contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import { TaskChatRunnerActivityGroup } from './src/components/task-chat/TaskChatRunnerActivityGroup';
  import { transcriptToTaskChatItems } from './src/components/task-chat/transcript-adapter';
  const route = new URL(location.href).pathname.slice(1);
  const legacy = route.startsWith('legacy-'), scenario = route.replace(/^legacy-/, '');
  const target = scenario === 'wrong-target-activity' ? 'backup/antigravity-proof.txt' : 'antigravity-proof.txt';
  const event = (operation, status, executionId, name = 'client_' + operation + '_file') => ({
    kind: 'provider_activity', ts: '2026-10-29T00:00:00Z', family: 'tool_execution',
    eventType: status === 'running' ? 'tool.execution.started' : 'tool.execution.completed', status,
    title: 'Tool execution', summary: 'Native file operation',
    payload: { name, operation, target, status, executionId, transport: 'builtin' },
  });
  const entries = [event('edit', 'completed', 'edit'), event('read', 'completed', 'read'),
    event('execute', 'failed', 'finish', 'paperclip_paperclip_finish')];
  if (scenario === 'failed-read-activity') entries.unshift(event('read', 'failed', 'failed-read'));
  if (scenario === 'interrupted-edit-activity') entries.unshift(event('edit', 'interrupted', 'interrupted-edit'));
  if (scenario === 'running-read-activity') entries.unshift(event('read', 'running', 'running-read'));
  if (scenario === 'pending-read-activity') entries.unshift(event('read', 'pending', 'pending-read'));
  if (scenario === 'failed-renderer-activity') entries.unshift({ ...event('read', 'completed', 'failed-renderer'), status: 'failed' });
  if (scenario === 'interrupted-renderer-activity') entries.unshift({ ...event('edit', 'completed', 'interrupted-renderer'), status: 'interrupted' });
  if (scenario === 'write-activity') entries[0] = event('write', 'completed', 'write');
  const running = legacy && ['running-read-activity', 'pending-read-activity'].includes(scenario);
  const transcript = legacy ? entries.flatMap(entry => {
    const { operation, target, executionId } = entry.payload;
    const call = { kind: 'tool_call', ts: entry.ts, toolUseId: executionId,
      name: operation === 'read' ? 'Running client_view_file' : operation === 'edit' ? 'exec_command' : operation === 'write' ? 'write' : 'paperclip_paperclip_finish',
      input: { operation, target } };
    if (['interrupted', 'pending'].includes(entry.status)) return [call];
    return [call, { kind: 'tool_result', ts: entry.ts, toolUseId: executionId, isError: entry.status === 'failed',
      delta: entry.status === 'running', content: entry.status === 'failed' ? 'Operation rejected' : 'Synthetic actual tool result' }];
  }) : entries;
  const items = transcriptToTaskChatItems(transcript, { runId: 'synthetic-run', agentName: 'Synthetic agent', running });
  createRoot(document.getElementById('activity-root')).render(<TaskChatRunnerActivityGroup item={{ id: 'synthetic-phase', kind: 'activity_phase',
    active: running, summary: '', items }} />);
` }, bundle: true, write: false, format: "iife", platform: "browser", jsx: "automatic", tsconfig: path.resolve(import.meta.dirname, "../../ui/tsconfig.json"),
  define: { "process.env.NODE_ENV": '"production"', "import.meta.env": "{}" }, logLevel: "silent" });
const server = createServer((request, response) => {
  const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
  if (name === artifactPath.slice(1)) {
    response.writeHead(200, { "Content-Type": "text/plain", "Content-Disposition": 'attachment; filename="antigravity-proof.txt"' }).end(artifactBytes); return;
  }
  if (name === "activity-client.js") { response.writeHead(200, { "Content-Type": "text/javascript" }).end(activityBundle.outputFiles[0]!.text); return; }
  if (name.endsWith("activity")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><head><style>svg{width:14px;height:14px}button{display:block}</style></head><body><button onclick="document.getElementById('activity-root').hidden=false;this.remove()">More messages</button><div id="activity-root" hidden></div><p>The file work succeeded; unrelated task failed.</p><script src="/activity-client.js"></script></body></html>`); return;
  }
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${fixtures[name] ?? "missing fixture"}</body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const visit = async (fixture: string) => page.goto(`${origin}/${fixture}`);
  await visit("dashboard"); await openAntigravityAgentFromRoster(page, agent, 300);
  assert.equal(new URL(page.url()).pathname, "/owned-agent");
  await visit("artifact"); await inspectAntigravityArtifact(page, "synthetic-proof", artifactBytes, 1000);
  await visit("picker"); await selectAntigravityFromOrdinaryPicker(page, 300);
  assert.equal(await page.getByRole("radio", { name: "Google Antigravity Candidate", exact: true }).isChecked(), true);
  await visit("advanced-only"); await assert.rejects(selectAntigravityFromOrdinaryPicker(page, 300));
  await visit("ready"); await assertAntigravityReady(page, agent, 300);
  await visit("narrative-ready"); await assert.rejects(assertAntigravityReady(page, agent, 300));
  await visit("done"); await assertAntigravityTaskDone(page, 300);
  await visit("narrative-done"); await assert.rejects(assertAntigravityTaskDone(page, 300));
  await visit("composer"); await assertAntigravityCleanComposer(page, agent, model, 300);
  await visit("paused-composer"); await assert.rejects(assertAntigravityCleanComposer(page, agent, model, 300));
  await visit("wrong-model"); await assert.rejects(assertAntigravityCleanComposer(page, agent, model, 300));
  await visit("activity"); await assertAntigravityFileActivity(page, 300);
  await visit("write-activity"); await assertAntigravityFileActivity(page, 300);
  for (const fixture of ["failed-read-activity", "interrupted-edit-activity", "running-read-activity", "failed-renderer-activity", "interrupted-renderer-activity", "wrong-target-activity"]) {
    await visit(fixture);
    let rejected = false;
    try { await assertAntigravityFileActivity(page, 300); } catch { rejected = true; }
    assert.ok(rejected, `${fixture}: ${await page.locator("body").innerText()}`);
  }
  for (const fixture of ["legacy-activity", "legacy-write-activity"]) {
    await visit(fixture); await assertAntigravityFileActivity(page, 300);
    assert.equal(await page.locator('[data-activity-family="tool_execution"]').count(), 0);
  }
  for (const fixture of ["legacy-failed-read-activity", "legacy-interrupted-edit-activity", "legacy-running-read-activity", "legacy-pending-read-activity", "legacy-wrong-target-activity"]) {
    await visit(fixture);
    let rejected = false;
    try { await assertAntigravityFileActivity(page, 300); } catch { rejected = true; }
    assert.ok(rejected, `${fixture}: ${await page.locator("body").innerText()}`);
  }
  console.log("PASS Antigravity browser calibration: More messages plus production transcript adapter/activity renderer for canonical provider activity and native legacy tool calls/results; completed read/edit/write, exact target, failed/interrupted/running/pending rejection and unrelated failed finish");
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
