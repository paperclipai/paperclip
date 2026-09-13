import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test, expect, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  const body = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${body}`).toBe(true);
  return JSON.parse(body);
}

for (const { unfinishedWrite, stopResponse } of [{ unfinishedWrite: false, stopResponse: false }, { unfinishedWrite: true, stopResponse: false }, { unfinishedWrite: false, stopResponse: true }]) {
  test(`embedded ACP Stop: ${unfinishedWrite ? "Interrupt continues without replaying the write" : stopResponse ? "composer Stop preserves queued input and accepts a new direction" : "Interrupt delivers queued input in the same session"}`, async ({ page, request }) => {
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

      // Both actions stop the response; composer Stop must not create a task hold.
      let stopped;
      if (stopResponse) {
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
      if (stopResponse) {
        await expect(page.getByTestId("paused-composer-takeover")).toHaveCount(0);
        await expect(editor).toBeVisible();
        expect((await json(await request.get(`/api/issues/${issue.id}/tree-control/state`))).activePauseHold).toBeNull();
        await expect(page.getByRole("button", { name: "Resume task", exact: true })).toHaveCount(0);
        const saved = await json(await request.get(`/api/issues/${issue.id}/queued-comments`));
        expect(JSON.stringify(saved.entries)).toContain("List my recent Drive files.");
        expect((await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n")).toHaveLength(1);
        await editor.fill("Please continue with the saved request.");
        await page.getByRole("button", { name: "Send", exact: true }).click();
      }
      await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await json(await request.get(`/api/issues/${issue.id}/live-runs`))).length).toBe(0);
      const prompts = (await readFile(path.join(root, "prompts"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
      expect(prompts).toHaveLength(2);
      expect(new Set(prompts.map(prompt => prompt.sessionId)).size).toBe(1);
      // Interrupt delivers immediately; after Stop, the new direction includes saved input.
      const continuationPrompts = prompts.slice(1);
      expect(JSON.stringify(continuationPrompts)).toContain("List my recent Drive files.");
      expect(await readFile(path.join(root, "completed"), "utf8")).toBe("follow-up\n");
      const completedIssue = await json(await request.get(`/api/issues/${issue.id}`));
      expect(completedIssue.executionBlocker).toBeNull();
      expect(completedIssue.status).toBe("done");
      if (unfinishedWrite) expect(await readFile(path.join(root, "writes"), "utf8")).toBe(writesAtStop);
      await expect(page.getByRole("dialog")).toHaveCount(0);
    } finally {
      await request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } });
      await request.patch("/api/instance/settings/experimental", { data: { enableClassicTaskInterface: originalSettings.enableClassicTaskInterface } });
      await rm(root, { recursive: true, force: true });
    }
  });
}
