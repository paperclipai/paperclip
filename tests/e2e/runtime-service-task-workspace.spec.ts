import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

test("attachment and detachment feedback, retry identity, and stale polls on mobile", async ({ page }, testInfo) => {
  test.setTimeout(90_000);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-attachment-ui-"));
  let servicePath: string | null = null;
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Attachment interaction acceptance" } });
    expect(companyResponse.ok()).toBe(true);
    const company = await companyResponse.json();
    const issueResponse = await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Develop retained app", status: "todo" } });
    expect(issueResponse.ok()).toBe(true);
    const issue = await issueResponse.json();
    // Reserve an unstarted local row for navigation/cleanup. Page-only responses
    // represent a provisioned independent provider while exercising real UI.
    const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
      requestId: randomUUID(), name: "Retained preview", command: "node app.cjs", cwd: root, start: false,
    } });
    expect(created.ok()).toBe(true);
    const stored: RuntimeService = await created.json();
    servicePath = `/api/companies/${company.id}/runtime-services/${stored.id}`;
    const initial: RuntimeService = { ...stored, provider: "daytona", canAttachTaskWorkspace: true, taskWorkspace: null,
      state: "ready", desiredState: "running", startedAt: new Date().toISOString() };
    const attached: RuntimeService = { ...initial, revision: initial.revision + 1, issueId: issue.id,
      canAttachTaskWorkspace: false, taskWorkspace: { issueId: issue.id } };
    const detached: RuntimeService = { ...initial, revision: attached.revision + 1, issueId: null };
    let stalePoll = initial;
    // Keep returning a stale poll after the mutation to verify revision merging.
    await page.route(`**${servicePath}`, (route) => route.request().method() === "GET" ? route.fulfill({ json: stalePoll }) : route.continue());
    const requests: unknown[] = [];
    let loseResponse!: () => void;
    const responseGate = new Promise<void>((resolve) => { loseResponse = resolve; });
    await page.route(`**${servicePath}/attach-task`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (requests.length === 1) { await responseGate; await route.abort("failed"); }
      else await route.fulfill({ json: requests.length === 2 ? attached : { ...attached, revision: detached.revision + 1 } });
    });
    const detachRequests: unknown[] = [];
    let loseDetachResponse!: () => void;
    const detachResponseGate = new Promise<void>((resolve) => { loseDetachResponse = resolve; });
    await page.route(`**${servicePath}/detach-task`, async (route) => {
      detachRequests.push(route.request().postDataJSON());
      if (detachRequests.length === 1) { await detachResponseGate; await route.abort("failed"); }
      else { stalePoll = attached; await route.fulfill({ json: detached }); }
    });
    await page.setViewportSize({ width: 390, height: 760 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${company.issuePrefix}/runtime-services/${stored.id}`);
    await page.getByRole("button", { name: "Develop in a task", exact: true }).click();
    await page.getByRole("combobox", { name: "Development task" }).click();
    await page.getByPlaceholder("Find a task by title or identifier…").fill("Develop retained app");
    await page.getByRole("option", { name: `${issue.identifier} · Develop retained app`, exact: true }).click();
    const submit = page.getByRole("button", { name: "Attach task workspace", exact: true });
    await submit.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Attaching…", exact: true })).toBeDisabled();
    await expect(page.getByRole("combobox", { name: "Development task" })).toBeDisabled();
    await expect.poll(() => requests.length).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("attachment-pending-mobile.png"), fullPage: true });
    loseResponse();
    await expect(page.getByRole("alert")).toContainText("could not be confirmed");
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: "Retry attachment", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open development task", exact: true })).toBeVisible();
    expect(requests).toHaveLength(2); expect(requests[1]).toEqual(requests[0]);
    await expect(page.getByRole("link", { name: "Open development task", exact: true })).toHaveAttribute("href", `/${company.issuePrefix}/issues/${issue.id}`);
    await page.waitForResponse((response) => response.url().endsWith(servicePath!) && response.request().method() === "GET");
    await expect(page.getByRole("button", { name: "Develop in a task", exact: true })).toHaveCount(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("attachment-complete-mobile.png"), fullPage: true });
    const detach = page.getByRole("button", { name: "Detach task workspace", exact: true });
    await detach.focus(); await page.keyboard.press("Enter"); await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Detaching…", exact: true })).toBeDisabled();
    await expect.poll(() => detachRequests.length).toBe(1);
    await page.screenshot({ path: testInfo.outputPath("detachment-pending-mobile.png"), fullPage: true });
    loseDetachResponse();
    await expect(page.getByRole("alert")).toContainText("Detachment could not be confirmed");
    await page.getByRole("button", { name: "Retry detachment", exact: true }).click();
    await expect(page.getByRole("button", { name: "Develop in a task", exact: true })).toBeVisible();
    expect(detachRequests).toHaveLength(2); expect(detachRequests[1]).toEqual(detachRequests[0]);
    await page.waitForResponse((response) => response.url().endsWith(servicePath!) && response.request().method() === "GET");
    await expect(page.getByRole("link", { name: "Open development task", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("detachment-complete-mobile.png"), fullPage: true });
    // A new attachment starts with the accepted detachment revision, even
    // though the polling endpoint is still returning the former attachment.
    await page.getByRole("button", { name: "Develop in a task", exact: true }).click();
    await page.getByRole("button", { name: "Attach task workspace", exact: true }).click();
    await expect(page.getByRole("link", { name: "Open development task", exact: true })).toBeVisible();
    expect(requests[2]).toMatchObject({ expectedRevision: detached.revision, issueId: issue.id });
    expect(requests[2]).not.toEqual(requests[0]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath("reattachment-complete-mobile.png"), fullPage: true });
    const proofPath = testInfo.outputPath("attachment-retry.json");
    await fs.writeFile(proofPath, JSON.stringify({ requests, detachRequests, taskId: issue.id, provider: "page transport fixture", stalePollPreserved: true }, null, 2));
    await testInfo.attach("attachment-retry.json", { path: proofPath, contentType: "application/json" });
    expect(errors).toEqual([]);
  } finally {
    if (servicePath) {
      const current = await page.request.get(servicePath);
      if (current.ok()) { const service: RuntimeService = await current.json();
        const removed = await page.request.post(`${servicePath}/control`, { data: { requestId: randomUUID(), expectedRevision: service.revision, action: "delete" } });
        expect(removed.ok()).toBe(true);
      }
    }
    await fs.rm(root, { recursive: true, force: true });
  }
});
