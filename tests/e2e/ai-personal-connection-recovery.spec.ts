import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { json } from "./agent-chat.shared";

test("missing onboarding key offers personal Claude setup in chat and resumes once", async ({ page, request }) => {
  test.setTimeout(120_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "personal-ai-recovery-"));
  const original = await json(await request.get("/api/instance/settings/experimental"));
  const company = await json(await request.post("/api/companies", { data: { name: `Personal AI recovery ${Date.now()}` } }));
  try {
    await json(await request.patch("/api/instance/settings/experimental", { data: { enableAgentChat: true, enableClassicTaskInterface: false } }));
    const definition = await json(await request.post(`/api/companies/${company.id}/user-secret-definitions`, {
      data: { key: "ANTHROPIC_API_KEY", name: "ANTHROPIC_API_KEY for onboarding" },
    }));
    await writeFile(path.join(root, "continued"), "ready");
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Chief of Staff", role: "general", adapterType: "claude_local",
      adapterConfig: { engine: "acp", cwd: root, stateDir: path.join(root, "state"),
        agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(path.resolve("scripts/mcp-fixtures/servers/acp-stop-agent.mjs"))}`,
        env: { ANTHROPIC_API_KEY: { type: "user_secret_ref", key: definition.key, version: "latest", required: true },
          PAPERCLIP_STOP_FIXTURE_ROOT: root } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    } }));
    const chatPath = `/api/companies/${company.id}/chats/${agent.id}`;
    await page.goto(`/${company.issuePrefix}/chats/${agent.id}`);
    await page.getByTestId("task-chat-composer-input").locator('[contenteditable="true"]').fill("Say hello.");
    await page.getByTestId("task-chat-composer-send").click();
    await expect(page.getByText("Connect your Claude account", { exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText("Chief of Staff needs your own AI connection.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Try again", exact: true })).toHaveCount(0);
    const chat = await json(await request.get(chatPath));
    // Real pre-dispatch failure, not a seeded card or mocked Paperclip response.
    const before = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`));
    expect(before).toHaveLength(1);
    const failed = await json(await request.get(`/api/heartbeat-runs/${before[0].id}`));
    expect(failed).toMatchObject({ status: "failed", errorCode: "configuration_incomplete", responsibleUserId: "local-board",
      resultJson: { configurationIncomplete: { reason: "secret_binding_missing", missingBindings: [expect.objectContaining({ errorCode: "user_secret_missing" })] } } });
    const sourceRunId = before[0].id;
    await test.info().attach("missing-personal-ai-card", { body: await page.screenshot(), contentType: "image/png" });

    await page.getByRole("button", { name: "Connect Claude", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await page.getByRole("button", { name: "Use API key instead", exact: true }).click();
    await page.getByPlaceholder("Enter API key here").fill("paperclip-e2e-personal-claude-key");
    await page.getByRole("button", { name: "Connect", exact: true }).click();
    await expect(page.getByRole("button", { name: "Use connection and continue", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Use connection and continue", exact: true }).click();
    await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("Claude connected", { exact: true })).toBeVisible();
    await expect.poll(async () => {
      const after = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`));
      return after.filter((run: { id: string; status: string }) => run.id !== sourceRunId).map((run: { status: string }) => run.status);
    }).toEqual(["succeeded"]);
    const updatedAgent = await json(await request.get(`/api/agents/${agent.id}`));
    expect(updatedAgent.runtimeConfig.aiConnection).toMatchObject({ provider: "anthropic", mode: "responsible_user" });
    const { connections: accounts } = await json(await request.get(`/api/companies/${company.id}/ai-connections`));
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({ provider: "anthropic", ownership: "personal", ownerUserId: "local-board", status: "connected" });
    const after = await json(await request.get(`/api/companies/${company.id}/heartbeat-runs`));
    const resumed = await json(await request.get(`/api/heartbeat-runs/${after.find((run: { id: string }) => run.id !== sourceRunId).id}`));
    expect(resumed.contextSnapshot.aiConnection).toMatchObject({ connectionId: accounts[0].id, responsibleUserId: "local-board" });
    await expect.poll(async () => (await json(await request.get(`/api/issues/${chat.id}`))).status).toBe("in_review");
    await page.reload();
    await expect(page.getByText("Answered the pending follow-up once.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Connect Claude", exact: true })).toHaveCount(0);
    await test.info().attach("personal-ai-repair-resumed", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await Promise.allSettled([
      request.patch(`/api/companies/${company.id}`, { data: { status: "archived" } }),
      request.patch("/api/instance/settings/experimental", { data: original }),
    ]);
    await rm(root, { recursive: true, force: true });
  }
});
