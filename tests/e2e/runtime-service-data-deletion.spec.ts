import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { RuntimeService, RuntimeServiceDataDeletionPlan } from "../../packages/shared/src/runtime-services";

for (const scenario of ["independent allocation", "task sandboxes"] as const) test(`mobile ${scenario} data deletion review, lost response, controller failure and fresh retry`, async ({ page }, testInfo) => {
  test.setTimeout(100_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-deletion-ui-"));
  const privateFile = path.join(root, "dirty-source.txt");
  await fs.writeFile(privateFile, "An external checkout must survive the deletion control");
  let servicePath: string | undefined, release: (() => void) | undefined;
  const pageErrors: string[] = []; page.on("pageerror", (error) => pageErrors.push(error.message));
  try {
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Data deletion interaction acceptance" } });
    expect(companyResponse.ok()).toBe(true); const company = await companyResponse.json();
    const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
      requestId: randomUUID(), name: "Shared preview", command: "node app.cjs", cwd: root, start: false,
    } });
    expect(created.status()).toBe(202); const stored: RuntimeService = await created.json();
    servicePath = `/api/companies/${company.id}/runtime-services/${stored.id}`;
    const reviewPath = `${servicePath}/data-deletion`;
    await page.setViewportSize({ width: 390, height: 760 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${company.issuePrefix}/runtime-services/${stored.id}`);
    const panel = page.getByRole("region", { name: "Workspace data deletion", exact: true });
    await panel.getByRole("button", { name: "Review data deletion", exact: true }).click();
    // This first review and rejected deletion go through the real API. No path
    // can be erased merely because a local service points at an existing folder.
    await expect(panel).toContainText("Its files cannot be deleted through this control");
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await expect(panel.getByRole("button", { name: "Delete data permanently", exact: true })).toBeDisabled();
    const external: RuntimeServiceDataDeletionPlan = await (await page.request.get(reviewPath)).json();
    const rejected = await page.request.post(reviewPath, { data: { requestId: randomUUID(), confirmedAllocationId: external.allocationId, planToken: external.planToken, confirm: true } });
    expect(rejected.status()).toBe(409);
    expect(await fs.readFile(privateFile, "utf8")).toBe("An external checkout must survive the deletion control");
    await panel.screenshot({ path: testInfo.outputPath("external-workspace-blocked-mobile.png") });

    // The rest is explicitly a provider transport fixture. It exercises the
    // browser's interaction/recovery, not remote compute or data destruction.
    const initial: RuntimeServiceDataDeletionPlan = { ...external, provider: "daytona", scope: "independent_allocation", blockers: [], includesHostMirror: true,
      planToken: "a".repeat(64), services: [{ id: stored.id, name: "Shared preview", state: "stopped" }, { id: randomUUID(), name: "Shared API worker", state: "stopped" }], deletion: null,
      ...(scenario === "task sandboxes" ? { scope: "task_workspace" as const, workspace: { id: randomUUID(), name: "App task checkout", providerType: "git_worktree", preservesBranchHistory: true },
        remoteSandboxes: [{ provider: "daytona", id: randomUUID(), name: "Task app sandbox", deleted: false }, { provider: "daytona", id: randomUUID(), name: "Task worker sandbox", deleted: false }] } : {}),
    };
    const pending: RuntimeServiceDataDeletionPlan = { ...initial, planToken: "b".repeat(64), deletion: {
      id: randomUUID(), state: "pending", attempts: 0, error: null, requestedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), completedAt: null, retryAt: null,
    } };
    const failed: RuntimeServiceDataDeletionPlan = { ...pending, planToken: "c".repeat(64), remoteSandboxes: pending.remoteSandboxes?.map((sandbox, index) => ({ ...sandbox, deleted: index === 0 })), deletion: { ...pending.deletion!, state: "failed", attempts: 1,
      updatedAt: new Date(Date.now() + 1000).toISOString(), error: "Data deletion could not be confirmed. Restore the provider connection and retry.", retryAt: null } };
    const retrying: RuntimeServiceDataDeletionPlan = { ...failed, planToken: "d".repeat(64), deletion: { ...failed.deletion!, state: "pending", error: null, updatedAt: new Date(Date.now() + 2000).toISOString() } };
    const complete: RuntimeServiceDataDeletionPlan = { ...retrying, planToken: "e".repeat(64), deletion: { ...retrying.deletion!, state: "deleted", attempts: 2,
      updatedAt: new Date(Date.now() + 3000).toISOString(), completedAt: new Date(Date.now() + 3000).toISOString() } };
    let polled = initial;
    const requests: Record<string, unknown>[] = [];
    const gate = new Promise<void>((resolve) => { release = resolve; });
    await page.route(`**${reviewPath}`, async (route) => {
      if (route.request().method() === "GET") { await route.fulfill({ json: polled }); return; }
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) { await gate; await route.abort("failed"); }
      else await route.fulfill({ status: 202, json: requests.length === 2 ? pending : retrying });
    });
    await page.reload();
    await panel.getByRole("button", { name: "Review data deletion", exact: true }).click();
    await expect(panel.getByRole("link", { name: "Shared API worker", exact: true })).toBeVisible();
    await expect(panel).toContainText(scenario === "task sandboxes" ? "retained local checkout will be deleted" : "retained host copy");
    if (scenario === "task sandboxes") { await expect(panel).toContainText("Task app sandbox"); await expect(panel).toContainText("Task worker sandbox"); await expect(panel).toContainText("Shared Git branch history is retained"); }
    await expect(panel.getByRole("button", { name: "Delete data permanently", exact: true })).toBeDisabled();
    await panel.getByRole("checkbox").check();
    await panel.screenshot({ path: testInfo.outputPath("deletion-confirmation-mobile.png") });
    await panel.getByRole("button", { name: "Delete data permanently", exact: true }).focus();
    await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await expect(panel.getByRole("button", { name: "Requesting deletion…", exact: true })).toBeDisabled();
    await expect.poll(() => requests.length).toBe(1);
    await expect(panel.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    release!();
    await expect(panel.getByRole("alert")).toContainText("could not be confirmed");
    await panel.getByRole("button", { name: "Retry deletion request", exact: true }).click();
    await expect(panel).toContainText("Deleting workspace data…");
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    await page.waitForResponse((response) => response.url().endsWith(reviewPath) && response.request().method() === "GET");
    await expect(panel).toContainText("Deleting workspace data…");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    await expect(panel.getByRole("alert")).toHaveCount(0);
    polled = failed;
    await expect(panel).toContainText("Data deletion needs attention");
    if (scenario === "task sandboxes") await expect(panel).toContainText("Task app sandbox · daytona · Deletion confirmed");
    await expect(panel.getByRole("button", { name: "Retry data deletion", exact: true })).toBeDisabled();
    await panel.screenshot({ path: testInfo.outputPath("deletion-failed-mobile.png") });
    await panel.getByRole("checkbox").check();
    await panel.getByRole("button", { name: "Retry data deletion", exact: true }).click();
    await expect(panel).toContainText("Deleting workspace data…");
    expect(requests).toHaveLength(3); expect(requests[2]!.requestId).not.toEqual(requests[0]!.requestId);
    expect(requests[2]!.planToken).toBe(failed.planToken);
    polled = complete;
    await expect(panel).toContainText("Workspace data deleted");
    await expect(panel.getByRole("checkbox")).toHaveCount(0);
    await expect(panel.getByRole("button")).toHaveCount(0);
    polled = pending;
    await page.waitForResponse((response) => response.url().endsWith(reviewPath) && response.request().method() === "GET");
    await expect(panel).toContainText("Workspace data deleted");
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath("deletion-complete-mobile.png") });
    expect(pageErrors).toEqual([]);
    const proofPath = testInfo.outputPath("data-deletion-interaction.json");
    await fs.writeFile(proofPath, JSON.stringify({ scenario, provider: "page transport fixture", realApiExternalWorkspaceRejected: true, externalFilesPreserved: true,
      ...(scenario === "task sandboxes" ? { bothRemoteSandboxesReviewed: true, retainedHostCheckoutReviewed: true, partialProviderProgressDisplayed: true } : {}),
      sharedServicesReviewed: 2, explicitConfirmationRequired: true, repeatedSubmissionPrevented: true, uncertainRequestReplayed: true,
      failureRetryRequiresFreshConfirmation: true, stalePollDidNotRegress: true, requests, pageErrors }, null, 2));
    await testInfo.attach("data-deletion-interaction", { path: proofPath, contentType: "application/json" });
  } finally {
    release?.(); await page.unrouteAll({ behavior: "wait" });
    if (servicePath) {
      const response = await page.request.get(servicePath);
      if (response.ok()) { const current: RuntimeService = await response.json();
        expect((await page.request.post(`${servicePath}/control`, { data: { requestId: randomUUID(), expectedRevision: current.revision, action: "delete" } })).ok()).toBe(true);
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
