import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

for (const { unfinishedWrite, pause } of [{ unfinishedWrite: false, pause: false }, { unfinishedWrite: true, pause: false }, { unfinishedWrite: false, pause: true }]) {
  test(`embedded ACP Stop: ${unfinishedWrite ? "unknown action stays visibly blocked" : pause ? "composer pause requires Resume before continuation" : "go continues the same session with queued input"}`, async ({ page, request }) => {
    test.setTimeout(120_000);
    const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-stop-browser-"));
    const company = await json(await request.post("/api/companies", { data: { name: `ACP Stop ${Date.now()}` } }));
    const originalSettings = await json(await request.get("/api/instance/settings/experimental"));
    try {
      await json(await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: false } }));
      const owner = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
        name: "ACP Stop fixture", role: "engineer", adapterType: "claude_local",
        adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
          agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
          env: { PAPERCLIP_STOP_FIXTURE_ROOT: root, PAPERCLIP_STOP_FIXTURE_FINISH_TASK: "1", ...(unfinishedWrite ? { PAPERCLIP_STOP_FIXTURE_TOOL: "write" } : {}) },
        }, runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
      } }));
      const issue = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
        title: "ACP Stop continuation", status: "backlog", assigneeAgentId: owner.id,
      } }));
      await json(await request.patch(`/api/issues/${issue.id}`, { data: { status: "todo" } }));
      await expect.poll(async () => (await readFile(path.join(root, "prompts"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length, { timeout: 45_000 }).toBe(1);
      const [active] = await json(await request.get(`/api/issues/${issue.id}/live-runs`));
      expect(active).toBeTruthy();
      await page.goto(`/${company.issuePrefix}/issues/${issue.identifier}`);
      const editor = page.getByRole("textbox", { name: "editable markdown" });
      await editor.fill("List my recent Drive files.");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect.poll(async () => JSON.stringify(await json(await request.get(`/api/issues/${issue.id}/queued-comments`))))
        .toContain("List my recent Drive files.");

      // Run-level Stop leaves the task unpaused; composer Stop additionally pauses the task.
      let stopped;
      if (pause) {
        await page.getByRole("button", { name: "Stop", exact: true }).click();
      } else {
        await page.getByRole("button", { name: "Interrupt", exact: true }).click();
      }
      await expect.poll(async () => {
        stopped = await json(await request.get(`/api/heartbeat-runs/${active.id}`));
        return stopped.resultJson?.executionCancellation?.state;
      }, { timeout: 30_000 }).toBe("acknowledged");
      expect(stopped.status).toBe("cancelled");
      expect(stopped.resultJson.executionCancellation.state).toBe("acknowledged");
      const writesAtStop = unfinishedWrite ? await readFile(path.join(root, "writes"), "utf8") : null;
      await page.reload();
      if (unfinishedWrite) await expect(page.getByText("Work cannot start.", { exact: false })).toBeVisible();
      if (pause) {
        await expect(page.getByTestId("paused-composer-takeover")).toBeVisible();
        await expect(editor).toHaveCount(0);
        await expect(page.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
        const rejected = await request.post(`/api/issues/${issue.id}/comments`, { data: { body: "go" } });
        expect(rejected.status()).toBe(409);
        expect((await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n")).toHaveLength(1);
        expect(await readFile(path.join(root, "completed"), "utf8").catch(() => "")).toBe("");
        await page.getByRole("button", { name: "Resume task", exact: true }).click();
        const dialog = page.getByRole("dialog");
        await dialog.getByRole("checkbox").check();
        await dialog.getByRole("button", { name: "Resume work", exact: true }).click();
      } else {
        await editor.fill("go");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      }
      if (unfinishedWrite) {
        await expect(page.getByText("Work cannot start.", { exact: false })).toBeVisible();
        await expect(editor).toHaveText("");
        // Repeated user wakes preserve input without manufacturing attempts.
        for (const message of ["go again", "still waiting"]) {
          await editor.fill(message);
          const response = page.waitForResponse((candidate) =>
            candidate.request().method() === "POST" && candidate.url().endsWith(`/api/issues/${issue.identifier}/comments`));
          await page.getByRole("button", { name: "Send", exact: true }).click();
          expect((await response).ok()).toBe(true);
          await expect(editor).toHaveText("");
        }
        expect((await json(await request.get(`/api/issues/${issue.id}`))).executionBlocker).toBeTruthy();
        await page.waitForTimeout(1000);
        await expect(page.getByText("Couldn't start", { exact: false })).toHaveCount(0);
        expect(await json(await request.get(`/api/issues/${issue.id}/runs`))).toHaveLength(1);
        expect(await readFile(path.join(root, "writes"), "utf8")).toBe(writesAtStop);
        expect((await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n")).toHaveLength(1);
      } else {
        await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 30_000 });
        await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/live-runs`))).length).toBe(0);
        const prompts = (await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
        expect(prompts).toHaveLength(2);
        expect(new Set(prompts.map(prompt => prompt.sessionId)).size).toBe(1);
        // Resume delivers the queued follow-up in the same provider session.
        const continuationPrompts = pause ? prompts.slice(1) : [prompts.at(-1)];
        expect(JSON.stringify(continuationPrompts)).toContain("List my recent Drive files.");
        if (!pause) expect(JSON.stringify(continuationPrompts)).toContain("go");
        expect(await readFile(path.join(root, "completed"), "utf8")).toBe("follow-up\n");
        const completedIssue = await json(await request.get(`/api/issues/${issue.id}`));
        expect(completedIssue.executionBlocker).toBeNull();
        expect(completedIssue.status).toBe("done");
      }
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: originalSettings.enableClassicTaskInterface } });
      await rm(root, { recursive: true, force: true });
    }
  });
}
