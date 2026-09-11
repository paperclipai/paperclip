import { readFile } from "node:fs/promises";
import {
  test,
  expect,
  type APIRequestContext,
  type APIResponse,
  type Page,
} from "@playwright/test";

async function json(response: APIResponse) {
  const text = await response.text();
  expect(response.ok(), `${response.url()}: ${response.status()} ${text}`).toBe(
    true,
  );
  return JSON.parse(text);
}
async function task(
  request: APIRequestContext,
  companyId: string,
  data: Record<string, unknown>,
) {
  return json(
    await request.post(`/api/companies/${companyId}/issues`, {
      data: { title: "Composer stop acceptance", status: "backlog", ...data },
    }),
  );
}
async function running(
  request: APIRequestContext,
  issueId: string,
  adapter: "process" | "paperclip_runner",
) {
  let run:
    | { id: string; status: string; runtimeMode?: string; processPid?: number }
    | undefined;
  await expect
    .poll(
      async () => {
        const runs = await json(
          await request.get(`/api/issues/${issueId}/live-runs`),
        );
        run = runs.find(
          (candidate: { status: string }) => candidate.status === "running",
        );
        return !!run;
      },
      { timeout: 30_000 },
    )
    .toBe(true);
  let fullRun = await json(await request.get(`/api/heartbeat-runs/${run!.id}`));
  await expect
    .poll(
      async () => {
        fullRun = await json(
          await request.get(`/api/heartbeat-runs/${run!.id}`),
        );
        return fullRun.runtimeMode;
      },
      { timeout: 15_000 },
    )
    .toBe(adapter === "process" ? "legacy" : "native");
  if (adapter === "process") {
    await expect
      .poll(
        async () => {
          fullRun = await json(
            await request.get(`/api/heartbeat-runs/${run!.id}`),
          );
          return fullRun.processPid;
        },
        { timeout: 15_000 },
      )
      .toBeTruthy();
  }
  return fullRun;
}
async function reconcileDemoExecution(
  request: APIRequestContext,
  issueId: string,
  runId: string,
) {
  // These deterministic fixtures only print output. No external action occurred.
  // Master requires recorded outcomes before a cancelled provider can restart.
  const activity = await json(
    await request.get(`/api/issues/${issueId}/activity`),
  );
  const settled = activity.find(
    (entry: { action: string; runId: string }) =>
      entry.action === "issue.execution_recovery_settled" &&
      entry.runId === runId,
  );
  const recovery = await json(
    await request.get(`/api/issues/${issueId}/recovery-actions`),
  );
  const actionId = recovery.active?.id ?? settled?.details?.recoveryActionId;
  expect(actionId).toBeTruthy();
  await json(
    await request.post(`/api/issues/${issueId}/recovery-actions/resolve`, {
      data: {
        actionId,
        outcome: "restored",
        sourceIssueStatus: "todo",
        executionReconciliation: {
          runId,
          providerStopped: true,
          actionOutcome: "not_performed",
          outcomeEvidence:
            "The deterministic acceptance fixture only emits console/protocol output. The verified stopped process performed no external actions.",
        },
      },
    }),
  );
}

async function menu(page: Page, action: string) {
  await page
    .getByRole("button", { name: "More task actions", exact: true })
    .click();
  await page
    .locator('[data-slot="popover-content"]')
    .getByRole("button", { name: action, exact: true })
    .click();
}
function processAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

test.setTimeout(120_000);

for (const adapter of ["process", "paperclip_runner"] as const) {
  test(`${adapter}: queue, composer Stop, subtree pause/cancel, and resume`, async ({
    page,
    request,
  }, testInfo) => {
    test.skip(
      adapter === "paperclip_runner" && !process.env.PAPERCLIP_STOP_FAKE_CODEX,
      "Set PAPERCLIP_STOP_FAKE_CODEX and PAPERCLIP_RUNNER_BINARY for real runnerd with the deterministic provider.",
    );
    const company = await json(
      await request.post("/api/companies", {
        data: { name: `Composer Stop ${adapter} ${Date.now()}` },
      }),
    );
    const originalSettings = await json(
      await request.get("/api/instance/settings/experimental"),
    );
    const statusMetadata: Record<string, string | null>[] = [];
    page.on("websocket", (socket) => {
      socket.on("framereceived", ({ payload: frame }) => {
        try {
          const event = JSON.parse(
            typeof frame === "string" ? frame : frame.toString("utf8"),
          );
          if (
            event.companyId !== company.id ||
            event.type !== "heartbeat.run.status"
          )
            return;
          // Retain only scalar status routing evidence for this owned company,
          // never raw frames, provider output, errors, or tool payloads.
          const entry: Record<string, string | null> = {};
          for (const key of [
            "runId",
            "agentId",
            "status",
            "issueId",
            "deliveryId",
            "startedAt",
            "finishedAt",
          ] as const) {
            const value = event.payload?.[key];
            if (value === null || typeof value === "string") entry[key] = value;
          }
          if (typeof event.createdAt === "string")
            entry.eventCreatedAt = event.createdAt;
          statusMetadata.push(entry);
        } catch {
          // Non-JSON frames are irrelevant and are not retained.
        }
      });
    });
    try {
      await json(
        await request.patch("/api/instance/settings/experimental", {
          data: { enableClassicTaskInterface: false, enableNativeRunner: true },
        }),
      );
      async function agent(name: string) {
        return json(
          await request.post(`/api/companies/${company.id}/agents`, {
            data: {
              name,
              role: "engineer",
              adapterType: adapter,
              adapterConfig:
                adapter === "process"
                  ? {
                      command: process.execPath,
                      args: [
                        "-e",
                        "console.log('stop fixture ready'); setInterval(() => console.log('working'), 200);",
                      ],
                      graceSec: 1,
                    }
                  : { provider: "codex", model: "gpt-5.1-codex-mini" },
              runtimeConfig: {
                heartbeat: { enabled: false, wakeOnDemand: true },
              },
            },
          }),
        );
      }
      const owner = await agent("Stop fixture parent");
      const childOwner = await agent("Stop fixture child");
      const otherOwner = await agent("Stop fixture unrelated");
      const parent = await task(request, company.id, {
        assigneeAgentId: owner.id,
      });
      const child = await task(request, company.id, {
        title: "Child work",
        parentId: parent.id,
        assigneeAgentId: childOwner.id,
      });
      const completed = await task(request, company.id, {
        title: "Finished child",
        parentId: parent.id,
        status: "done",
      });
      const other = await task(request, company.id, {
        title: "Unrelated work",
        assigneeAgentId: otherOwner.id,
      });
      for (const issue of [parent, child, other])
        await json(
          await request.patch(`/api/issues/${issue.id}`, {
            data: { status: "todo" },
          }),
        );
      const parentRun = await running(request, parent.id, adapter);
      const childRun = await running(request, child.id, adapter);
      const otherRun = await running(request, other.id, adapter);
      if (adapter === "paperclip_runner") {
        // A run row becomes live before its provider turn starts. Prove that the
        // deterministic provider is active before attempting interruption.
        await expect
          .poll(
            async () => {
              const calls = await readFile(
                process.env.PAPERCLIP_STOP_CODEX_LOG!,
                "utf8",
              ).catch(() => "");
              return calls.split("turn/start").length - 1;
            },
            { timeout: 30_000 },
          )
          .toBeGreaterThanOrEqual(3);
      }
      expect(parentRun.runtimeMode).toBe(
        adapter === "process" ? "legacy" : "native",
      );
      await page.goto(`/${company.issuePrefix}/issues/${parent.identifier}`);
      const stop = page.getByRole("button", { name: "Stop", exact: true });
      await expect(stop).toBeVisible({ timeout: 30_000 });
      const editor = page.getByRole("textbox", { name: "editable markdown" });
      await editor.fill("Please check mobile too.");
      await expect(stop).toHaveCount(0);
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await expect(stop).toBeVisible();
      const comments = await json(
        await request.get(`/api/issues/${parent.id}/comments`),
      );
      expect(JSON.stringify(comments)).toContain("Please check mobile too.");
      const queue = await json(
        await request.get(`/api/issues/${parent.id}/queued-comments`),
      );
      expect(JSON.stringify(queue.entries)).toContain(
        "Please check mobile too.",
      );

      let dispatchedAt = 0;
      page.on("request", (req) => {
        if (req.method() === "POST" && req.url().endsWith("/tree-holds"))
          dispatchedAt = Date.now();
      });
      const clickedAt = Date.now();
      await stop.click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      for (const run of [parentRun, childRun]) {
        await expect
          .poll(
            async () =>
              (await json(await request.get(`/api/heartbeat-runs/${run.id}`)))
                .status,
            { timeout: 35_000 },
          )
          .toBe("cancelled");
      }
      const stoppedAt = Date.now();
      expect(dispatchedAt - clickedAt).toBeLessThan(2000);
      expect(dispatchedAt).toBeGreaterThan(0);
      if (adapter === "process") {
        expect(parentRun.processPid).toBeTruthy();
        await expect
          .poll(() => processAlive(parentRun.processPid), { timeout: 3000 })
          .toBe(false);
        await expect
          .poll(() => processAlive(childRun.processPid), { timeout: 3000 })
          .toBe(false);
      } else {
        const finalRun = await json(
          await request.get(`/api/heartbeat-runs/${parentRun.id}`),
        );
        expect(finalRun.resultJson?.nativeCancellation?.dispatchState).toBe(
          "acknowledged",
        );
        expect(
          await readFile(process.env.PAPERCLIP_STOP_CODEX_LOG!, "utf8"),
        ).toContain("turn/interrupt");
      }
      await testInfo.attach(`${adapter}-timing`, {
        body: JSON.stringify({
          clickToRequestMs: dispatchedAt - clickedAt,
          requestToStoppedMs: stoppedAt - dispatchedAt,
        }),
        contentType: "application/json",
      });
      expect(
        (
          await json(
            await request.get(`/api/issues/${parent.id}/tree-control/state`),
          )
        ).activePauseHold,
      ).toBeTruthy();
      expect(
        (await json(await request.get(`/api/heartbeat-runs/${otherRun.id}`)))
          .status,
      ).toBe("running");
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      if (adapter === "paperclip_runner") {
        await expect(
          page.getByRole("button", { name: /^Run cancelled/ }),
        ).toHaveClass(/text-muted-foreground/);
      }
      await page.reload();
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      // Cross the isolated server's ten-second scheduler interval repeatedly.
      for (let i = 0; i < 3; i++) {
        await new Promise((resolve) => setTimeout(resolve, 10_000));
        expect(
          await json(await request.get(`/api/issues/${parent.id}/live-runs`)),
        ).toEqual([]);
        expect(
          await json(await request.get(`/api/issues/${child.id}/live-runs`)),
        ).toEqual([]);
      }
      await menu(page, "Resume subtree");
      await page.getByRole("dialog").getByRole("checkbox").check();
      await page
        .getByRole("dialog")
        .getByRole("button", { name: "Resume subtree", exact: true })
        .click();
      await expect(page.getByRole("dialog")).toHaveCount(0);
      // The recovery policy parks these stopped tasks. Releasing the hold must
      // leave them parked, even with Wake agents selected; no implicit replay.
      expect(await json(await request.get(`/api/issues/${parent.id}/live-runs`))).toEqual([]);
      expect(await json(await request.get(`/api/issues/${child.id}/live-runs`))).toEqual([]);
      await reconcileDemoExecution(request, parent.id, parentRun.id);
      await reconcileDemoExecution(request, child.id, childRun.id);
      const resumedParentRun = await running(request, parent.id, adapter);
      const resumedChildRun = await running(request, child.id, adapter);
      expect(resumedParentRun.id).not.toBe(parentRun.id);
      expect(resumedChildRun.id).not.toBe(childRun.id);
      await menu(page, "Pause subtree");
      await expect(page.getByRole("dialog")).toHaveCount(0);
      await expect(
        page.getByText("Subtree is paused.", { exact: true }),
      ).toBeVisible();
      await menu(page, "Cancel subtree...");
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "Cancel subtree?" }),
      ).toBeVisible();
      await expect(
        dialog.locator('textarea, input[type="checkbox"]'),
      ).toHaveCount(0);
      await dialog.getByRole("button", { name: "Keep tasks" }).click();
      expect(
        (await json(await request.get(`/api/issues/${parent.id}`))).status,
      ).not.toBe("cancelled");
      await menu(page, "Cancel subtree...");
      await dialog
        .getByRole("button", { name: "Cancel 2 tasks", exact: true })
        .click();
      await expect
        .poll(
          async () =>
            (await json(await request.get(`/api/issues/${child.id}`))).status,
        )
        .toBe("cancelled");
      expect(
        (await json(await request.get(`/api/issues/${parent.id}`))).status,
      ).toBe("cancelled");
      expect(
        (await json(await request.get(`/api/issues/${completed.id}`))).status,
      ).toBe("done");
      expect(
        (await json(await request.get(`/api/heartbeat-runs/${otherRun.id}`)))
          .status,
      ).toBe("running");
      // The child was never opened, so no child run-history cache can hide a
      // missing task association. Observe this new run's retryable terminal
      // delivery before judging the final notification state.
      await expect
        .poll(
          () =>
            statusMetadata.find(
              (entry) =>
                entry.runId === resumedChildRun.id &&
                entry.status === "cancelled" &&
                typeof entry.deliveryId === "string" &&
                entry.deliveryId.length > 0,
            ),
          // The real status-delivery sweep runs every 15 seconds.
          { timeout: 20_000 },
        )
        .toMatchObject({
          runId: resumedChildRun.id,
          issueId: child.id,
          status: "cancelled",
        });
      await expect(
        page.getByRole("button", { name: "Dismiss notification" }),
      ).toHaveCount(0);
      await page.screenshot({
        path: testInfo.outputPath(`${adapter}-cancelled.png`),
      });
    } finally {
      const statusEvidence = JSON.stringify(statusMetadata, null, 2);
      // The company is disposable and scoped to this test invocation.
      await request.patch(`/api/companies/${company.id}`, {
        data: { status: "archived" },
      });
      await request.patch("/api/instance/settings/experimental", {
        data: {
          enableClassicTaskInterface:
            originalSettings.enableClassicTaskInterface,
          enableNativeRunner: originalSettings.enableNativeRunner,
        },
      });
      await testInfo.attach("owned-company-status-metadata", {
        body: statusEvidence,
        contentType: "application/json",
      });
    }
  });
}
