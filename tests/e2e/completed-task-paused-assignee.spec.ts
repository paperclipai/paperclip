import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

let cleanup: { companyId: string; enableClassicTaskInterface: boolean } | undefined;

test.afterEach(async ({ request }, testInfo) => {
  const state = cleanup;
  cleanup = undefined;
  if (!state) return;
  testInfo.setTimeout(15_000);
  const results = await Promise.allSettled([
    request.patch("/api/instance/settings/experimental", {
      data: { enableClassicTaskInterface: state.enableClassicTaskInterface }, timeout: 5_000,
    }),
    request.patch(`/api/companies/${state.companyId}`, { data: { status: "archived" }, timeout: 5_000 }),
  ]);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`Cleanup ${index}: ${String(result.reason)}`]
    : result.value.ok() ? [] : [`Cleanup ${index}: HTTP ${result.value.status()}`]);
  if (!failures.length) return;
  await testInfo.attach("cleanup-failure", {
    body: Buffer.from(JSON.stringify({ companyId: state.companyId, failures })), contentType: "application/json",
  });
  if (testInfo.status === "passed") throw new Error(failures.join("\n"));
});

for (const classic of [false, true]) {
  test(`${classic ? "classic" : "task chat"}: paused assignee warnings follow the task's current status without resuming the agent`, async ({ page, request }, testInfo) => {
    page.setDefaultTimeout(10_000);
    const settings = await json(await request.get("/api/instance/settings/experimental"));
    const company = await json(await request.post("/api/companies", {
      data: { name: `Completed task status ${randomUUID()}` },
    }));
    cleanup = { companyId: company.id, enableClassicTaskInterface: settings.enableClassicTaskInterface };
    await json(await request.patch("/api/instance/settings/experimental", {
      data: { enableClassicTaskInterface: classic },
    }));
    // This command is deliberately not a model adapter. Heartbeats are disabled
    // and the agent is paused before assignment, so the journey starts no work.
    const agent = await json(await request.post(`/api/companies/${company.id}/agents`, { data: {
      name: "Receipt implementation", role: "engineer", adapterType: "process",
      adapterConfig: { command: "/usr/bin/false" },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } },
    } }));
    await json(await request.post(`/api/agents/${agent.id}/pause`));
    const task = await json(await request.post(`/api/companies/${company.id}/issues`, { data: {
      title: "Receipt corrected and reviewed", status: "done", assigneeAgentId: agent.id,
      description: "Browser fixture: the saved receipt total is 6 USD. No provider or agent execution is used in this test.",
    } }));
    const initialAgent = await json(await request.get(`/api/agents/${agent.id}`));
    expect(initialAgent).toMatchObject({ id: agent.id, status: "paused", pauseReason: "manual" });
    const states: Array<{ requested: string; observed: string; warningVisible: boolean }> = [];
    const lifecycleWrites: string[] = [];
    page.on("request", outgoing => {
      if (!["GET", "HEAD", "OPTIONS"].includes(outgoing.method())
        && /\/api\/agents\/[^/]+\/(resume|pause|wakeup|heartbeat\/invoke)$/.test(new URL(outgoing.url()).pathname)) {
        lifecycleWrites.push(`${outgoing.method()} ${new URL(outgoing.url()).pathname}`);
      }
    });
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(`/${company.issuePrefix}/issues/${task.identifier}`);
    const notice = page.getByTestId("issue-assignee-paused-notice");
    const resume = page.getByRole("button", { name: "Resume agent", exact: true });
    const capture = async (name: string) => {
      const path = testInfo.outputPath(`${name}.png`);
      await page.screenshot({ path, fullPage: true });
      await testInfo.attach(name, { path, contentType: "image/png" });
    };
    const observe = async (status: string, warningVisible: boolean) => {
      await expect(page.getByText(task.title, { exact: true }).first()).toBeVisible();
      const statusLabel = status[0].toUpperCase() + status.slice(1);
      await expect(page.getByTestId("issue-detail-header").getByRole("button", {
        name: status === "blocked"
          ? /^Change status \(current: Blocked(?: · [^)]*)?\)$/
          : `Change status (current: ${statusLabel})`,
        exact: true,
      }).first()).toBeVisible();
      // Wait for the actual agent-backed controls and thread to render before
      // asserting absence; a title alone can appear before the agent map loads.
      await expect(page.getByRole("button", { name: /Receipt implementation/ }).first()).toBeVisible();
      await expect(page.getByRole("textbox", { name: "editable markdown" })).toBeVisible();
      if (warningVisible) {
        await expect(notice).toBeVisible();
        await expect(notice).toContainText("Receipt implementation is paused.");
        await expect(resume).toBeVisible();
      } else {
        await expect(notice).toHaveCount(0);
        await expect(resume).toHaveCount(0);
      }
      const currentTask = await json(await request.get(`/api/issues/${task.id}`));
      expect(currentTask).toMatchObject({ id: task.id, status, assigneeAgentId: agent.id });
      states.push({ requested: status, observed: currentTask.status, warningVisible });
    };
    await observe("done", false);
    await capture("completed-task-paused-agent");

    // Blocked is an explicit nonterminal disposition. A paused agent's Todo
    // task can legitimately be escalated to Blocked by recovery before the UI
    // observes it; that recovery behavior has separate database coverage.
    for (const status of ["blocked", "cancelled", "blocked", "done"]) {
      await json(await request.patch(`/api/issues/${task.id}`, { data: {
        status,
        ...(status === "blocked" ? {
          unblockDescriptor: { owner: "board", action: "Decide whether to resume the paused assignee." },
        } : {}),
      } }));
      await page.reload();
      await observe(status, status === "blocked");
      if (status === "cancelled" || (status === "blocked" && states.length === 2)) {
        await capture(`${status}-task-paused-agent`);
      }
    }

    const finalAgent = await json(await request.get(`/api/agents/${agent.id}`));
    const finalTask = await json(await request.get(`/api/issues/${task.id}`));
    const runs = await json<unknown[]>(await request.get(`/api/companies/${company.id}/heartbeat-runs?limit=100`));
    expect(finalAgent).toMatchObject({ id: agent.id, status: "paused", pauseReason: "manual" });
    expect(finalTask).toMatchObject({ id: task.id, status: "done", assigneeAgentId: agent.id });
    expect(runs).toEqual([]);
    expect(lifecycleWrites).toEqual([]);
    await testInfo.attach("task-status-persistence-proof", {
      body: Buffer.from(JSON.stringify({
        companyId: company.id, taskId: task.id, taskIdentifier: task.identifier,
        classic, states, initialAgent: { id: initialAgent.id, status: initialAgent.status, pauseReason: initialAgent.pauseReason },
        finalAgent: { id: finalAgent.id, status: finalAgent.status, pauseReason: finalAgent.pauseReason },
        finalTask: { id: finalTask.id, status: finalTask.status, assigneeAgentId: finalTask.assigneeAgentId },
        runs, lifecycleWrites,
      }, null, 2)),
      contentType: "application/json",
    });
  });
}
