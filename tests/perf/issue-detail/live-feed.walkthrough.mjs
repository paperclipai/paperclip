import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "@playwright/test";

// Opt-in: this sends jobs to an already configured agent in a disposable local
// test-drive project. No credentials, provider mocks, or production fixtures.
const target = process.env.PAPERCLIP_LAYOUT_LIVE_URL;
if (!target || !["localhost", "127.0.0.1", "[::1]"].includes(new URL(target).hostname)) {
  throw new Error("Set PAPERCLIP_LAYOUT_LIVE_URL to a disposable localhost task with a native Codex assignee.");
}
const output = path.resolve("test-results/task-layout/live-acceptance");
const api = (pathname) => new URL(pathname, target).href;
await fs.mkdir(output, { recursive: true });
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, recordVideo: { dir: output } });
const page = await context.newPage();
const cdp = await context.newCDPSession(page);
await cdp.send("Performance.enable");
await page.addInitScript(() => {
  const evidence = { frames: [], shifts: [] };
  window.taskLayoutEvidence = evidence;
  new PerformanceObserver((list) => evidence.shifts.push(...list.getEntries().map((entry) => entry.toJSON())))
    .observe({ type: "layout-shift", buffered: true });
  function sample() {
    const viewport = document.querySelector('[data-testid="task-chat-scroller"]');
    if (viewport) {
      const rect = viewport.getBoundingClientRect();
      const row = [...viewport.querySelectorAll("[data-thread-anchor]")].find((el) => el.getBoundingClientRect().bottom > rect.top);
      evidence.frames.push({ time: performance.now(), top: viewport.scrollTop, height: viewport.scrollHeight, anchor: row?.dataset.threadAnchor, offset: row ? row.getBoundingClientRect().top - rect.top : null, textLength: viewport.textContent.length, loading: Boolean(document.querySelector('[data-testid="task-chat-history-loading"]')) });
    }
    requestAnimationFrame(sample);
  }
  requestAnimationFrame(sample);
});

try {
  await page.goto(target);
  await page.locator('[data-testid="task-chat-thread"] [aria-busy="false"]').waitFor({ timeout: 90_000 });
  const issueKey = new URL(target).pathname.split("/").filter(Boolean).at(-1);
  const issueResponse = await page.request.get(api(`/api/issues/${issueKey}`));
  assert.ok(issueResponse.ok(), "Disposable task must be accessible");
  const issue = await issueResponse.json();
  const agent = await (await page.request.get(api(`/api/agents/${issue.assigneeAgentId}`))).json();
  assert.equal(agent.adapterType, "paperclip_runner");
  assert.equal(agent.adapterConfig.provider, "codex");
  const startedAt = Date.now();
  const editor = page.locator('[contenteditable="true"]').last();
  await editor.fill("Run a paced layout acceptance check only in this disposable project. Send three substantial progress messages explaining chat scroll stability, separated by read-only terminal checks of sum.mjs and a ten-second pause. Include a Markdown table and a JavaScript code block in your last progress message. Do not change files. Finish with a detailed answer in the conversation. Keep the run open for this sequence so I can test a follow-up.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(/Working for/).last().waitFor({ timeout: 30_000 });
  await page.screenshot({ path: path.join(output, "startup.png") });
  await page.waitForTimeout(12_000);
  const viewport = page.getByTestId("task-chat-scroller");
  await viewport.evaluate((el) => { el.scrollTop = Math.max(0, el.scrollTop - 800); });
  await page.waitForTimeout(150);
  const anchor = await viewport.evaluate((el) => {
    const rect = el.getBoundingClientRect();
    const row = [...el.querySelectorAll("[data-thread-anchor]")].find((item) => item.getBoundingClientRect().bottom > rect.top);
    return { id: row.dataset.threadAnchor, top: row.getBoundingClientRect().top - rect.top };
  });
  await page.screenshot({ path: path.join(output, "reading.png") });
  await page.waitForTimeout(10_000);
  await context.setOffline(true);
  await page.waitForTimeout(3000);
  await context.setOffline(false);
  await page.waitForTimeout(10_000);
  const offset = await viewport.evaluate((el, id) => {
    const row = [...el.querySelectorAll("[data-thread-anchor]")].find((item) => item.dataset.threadAnchor === id);
    return row.getBoundingClientRect().top - el.getBoundingClientRect().top;
  }, anchor.id);
  assert.ok(Math.abs(offset - anchor.top) <= 2, `Reading anchor moved ${offset - anchor.top}px`);
  await page.screenshot({ path: path.join(output, "reconnected.png") });
  await fs.writeFile(path.join(output, "reading-anchor.json"), JSON.stringify({ anchor, finalOffset: offset, delta: offset - anchor.top }, null, 2));
  await page.getByRole("button", { name: "Scroll to latest" }).click();
  await editor.fill("Include how expanded tool details should remain open after the run becomes persisted history.");
  await page.waitForFunction(() => {
    const el = document.querySelector('[data-testid="task-chat-scroller"]');
    return el && el.scrollHeight - el.scrollTop - el.clientHeight < 2;
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const steer = page.getByRole("button", { name: "Steer", exact: true });
  await steer.waitFor({ timeout: 30_000 });
  const deadline = Date.now() + 60_000;
  while (!(await steer.isEnabled()) && Date.now() < deadline) await page.waitForTimeout(500);
  await steer.click();
  await page.screenshot({ path: path.join(output, "steered.png") });
  await page.getByText(/Continued after steering/).last().waitFor({ timeout: 30_000 });
  await page.waitForFunction(() => !document.querySelector('[data-testid="task-chat-live-transcript"]')?.textContent?.includes("Working for"), undefined, { timeout: 180_000 });
  await page.waitForTimeout(5000);
  await page.screenshot({ path: path.join(output, "completed.png") });
  const runs = await (await page.request.get(api(`/api/issues/${issue.id}/runs`))).json();
  const run = runs.find((candidate) => new Date(candidate.createdAt).getTime() >= startedAt);
  assert.ok(run, "The submitted job must create a run");
  assert.equal(run.runtimeMode, "native");
  assert.equal(run.adapterType, "paperclip_runner");
  assert.equal(run.status, "succeeded");
  await fs.writeFile(path.join(output, "runtime.json"), JSON.stringify({
    runId: run.runId, runtimeMode: run.runtimeMode, adapterType: run.adapterType,
    provider: agent.adapterConfig.provider, model: agent.adapterConfig.model,
    status: run.status, startedAt: run.startedAt, finishedAt: run.finishedAt,
  }, null, 2));
  await fs.writeFile(path.join(output, "reading-anchor.json"), JSON.stringify({ anchor, finalOffset: offset, delta: offset - anchor.top }, null, 2));
  console.log(`Reading anchor delta: ${offset - anchor.top}px`);
} finally {
  await fs.writeFile(path.join(output, "layout.json"), JSON.stringify(await page.evaluate(() => window.taskLayoutEvidence)));
  await fs.writeFile(path.join(output, "performance.json"), JSON.stringify(await cdp.send("Performance.getMetrics"), null, 2));
  await context.close();
  await browser.close();
}
