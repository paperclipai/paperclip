/** Credential-free calibration of the measured selectors in a real browser.
 * Synthetic loopback HTML is deliberately not live Antigravity qualification. */
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import assert from "node:assert/strict";
import { assertAntigravityCleanComposer, assertAntigravityFileActivity, assertAntigravityReady, assertAntigravityTaskDone, selectAntigravityFromOrdinaryPicker } from "./antigravity-journey-ui.js";

const agent = "Antigravity QA synthetic", model = "gemini-3.8-flash-low";
const fixtures: Record<string, string> = {
  picker: `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><label><input type="radio" name="adapter">Google Antigravity Candidate</label><details><summary>Advanced</summary><label><input type="radio" name="adapter">Other harness</label></details><button>Configure agent</button></div><div hidden><label><input type="radio">Google Antigravity Candidate</label></div>`,
  "advanced-only": `<div role="dialog" aria-labelledby="picker"><h2 id="picker">Choose an adapter</h2><details open><summary>Advanced</summary><label><input type="radio">Google Antigravity Candidate</label></details><button>Configure agent</button></div>`,
  ready: `<div hidden><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button></div><h2>Your agent is ready</h2><button>Assign ${agent} a Task</button>`,
  "narrative-ready": `<p>The assistant says Your agent is ready.</p><h2>Finishing agent setup</h2><button disabled>Assign ${agent} a Task</button>`,
  done: `<div hidden data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)">Todo</button></div><div data-testid="issue-detail-header"><button aria-label="Change status (current: Done)"><svg><title>Done</title></svg></button></div><div role="menu" hidden>Done</div><p>Earlier task: Todo</p>`,
  "narrative-done": `<div data-testid="issue-detail-header"><button aria-label="Change status (current: Todo)"><svg><title>Done</title></svg></button></div><div hidden><button aria-label="Change status (current: Done)">Done</button></div><p>The task is Done</p>`,
  composer: `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div hidden data-testid="new-issue-paused-assignee-note">paused</div></div><div data-testid="new-issue-paused-assignee-note">unrelated paused agent</div>`,
  "paused-composer": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">${model}</span></button><div data-testid="new-issue-paused-assignee-note">paused</div></div>`,
  "wrong-model": `<div role="dialog" aria-labelledby="composer"><h2 id="composer">New task</h2><button aria-label="Select assignee">${agent}</button><button aria-label="Select model and effort"><span data-testid="task-chat-composer-model-label">gemini-3.8-flash-high</span></button><p>${model}</p></div>`,
  activity: `<button data-testid="task-chat-activity-phase-toggle" aria-expanded="false" onclick="this.setAttribute('aria-expanded','true');document.getElementById('history').hidden=false">Expand activity history</button><ul id="history" hidden><li data-activity-row="edit">Ran a command operation: edit, target: antigravity-proof.txt</li><li data-activity-row="read">Ran read file operation: read, target: antigravity-proof.txt</li><li data-activity-row="finish">Ran Paperclip finish · failed operation: execute</li></ul><p>Unrelated task failed</p>`,
  "wrong-file-activity": `<button data-testid="task-chat-activity-phase-toggle" aria-expanded="true">Collapse activity history</button><ul><li data-activity-row="edit">Ran a command · failed operation: edit, target: antigravity-proof.txt</li><li data-activity-row="read">Ran read file · failed operation: read, target: antigravity-proof.txt</li></ul><p>File work succeeded</p>`,
};
const server = createServer((request, response) => {
  const name = new URL(request.url ?? "/", "http://localhost").pathname.slice(1);
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(`<!doctype html><html><body>${fixtures[name] ?? "missing fixture"}</body></html>`);
});
await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const visit = async (fixture: string) => page.goto(`${origin}/${fixture}`);
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
  await visit("wrong-file-activity"); await assert.rejects(assertAntigravityFileActivity(page, 300));
  console.log("PASS synthetic Antigravity browser calibration: ordinary picker, readiness, actual Done, stale pause, exact Low model and file-activity status");
} finally {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
}
