import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { createDb } from "../../packages/db/src/client";
import { executionWorkspaces } from "../../packages/db/src/schema/execution_workspaces";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }

test("administrator configures retention, active tasks protect files, and expired data is deleted visibly", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(120_000);
  const home = process.env.PAPERCLIP_RETENTION_FIXTURE_HOME;
  if (!home || !path.basename(home).startsWith("paperclip-e2e-home-") || new URL(baseURL!).hostname !== "127.0.0.1") throw new Error("Task deletion requires its isolated fixture");
  const config = JSON.parse(await fs.readFile(path.join(home, "instances", "playwright-e2e", "config.json"), "utf8"));
  if (config.database?.mode !== "embedded-postgres" || config.server?.port !== Number(new URL(baseURL!).port)) throw new Error("Expected the isolated database and server");
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${config.database.embeddedPostgresPort}/paperclip`);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-task-delete-ui-")));
  const base = path.join(root, "project"), cwd = path.join(base, ".paperclip", "worktrees", "app");
  const errors: string[] = []; page.on("pageerror", (error) => errors.push(error.message));
  try {
    await fs.mkdir(base); await git(base, "init", "-b", "main"); await git(base, "config", "user.name", "Test"); await git(base, "config", "user.email", "test@example.test");
    await fs.writeFile(path.join(base, "source.txt"), "Project source survives"); await git(base, "add", "."); await git(base, "commit", "-m", "Initial source");
    await git(base, "worktree", "add", "-b", "runtime/app", cwd); await fs.mkdir(path.join(cwd, "api"));
    await fs.writeFile(path.join(cwd, "dirty.txt"), "Reviewed uncommitted task work");
    await fs.writeFile(path.join(cwd, "api", "app.db"), "Reviewed local app data");
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Data retention acceptance" } });
    expect(companyResponse.ok()).toBe(true); const company = await companyResponse.json();
    const projectResponse = await page.request.post(`/api/companies/${company.id}/projects`, { data: { name: "Preview app" } });
    expect(projectResponse.ok()).toBe(true); const project = await projectResponse.json();
    const primaryResponse = await page.request.post(`/api/projects/${project.id}/workspaces`, { data: { name: "Primary", cwd: base, isPrimary: true } });
    expect(primaryResponse.ok()).toBe(true); const primary = await primaryResponse.json();
    const taskResponse = await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Develop preview app", projectId: project.id, status: "todo" } });
    expect(taskResponse.ok(), await taskResponse.text()).toBe(true); const task = await taskResponse.json();
    // Seed the runtime-owned workspace and task binding; the board API does not create or assign these records.
    // Review, confirmation, admission and cleanup all use the real server.
    const [workspace] = await db.insert(executionWorkspaces).values({ companyId: company.id, projectId: project.id, projectWorkspaceId: primary.id,
      sourceIssueId: task.id, name: "Preview app worktree", mode: "isolated_workspace", strategyType: "git_worktree", providerType: "git_worktree",
      cwd, providerRef: cwd, branchName: "runtime/app", metadata: { createdByRuntime: true, gitBranchOwnershipVersion: 1 } }).returning();
    await db.$client`update issues set execution_workspace_id = ${workspace!.id} where id = ${task.id} and company_id = ${company.id}`;
    const services: RuntimeService[] = [];
    for (const [name, directory] of [["Task preview", cwd], ["Task API", path.join(cwd, "api")]]) {
      const response = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
        name, cwd: directory, command: "node worker.cjs", purpose: "worker", issueId: task.id, start: false, requestId: randomUUID(),
      } });
      expect(response.status(), await response.text()).toBe(202); const service: RuntimeService = await response.json();
      expect(service.executionWorkspaceId).toBe(workspace!.id); services.push(service);
    }
    const servicePath = `/api/companies/${company.id}/runtime-services/${services[0]!.id}`;
    const policyPath = `/api/companies/${company.id}/runtime-service-policy`;
    await page.setViewportSize({ width: 390, height: 760 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${company.issuePrefix}/runtime-services`);
    await page.getByRole("button", { name: "Company defaults and limits", exact: true }).click();
    const form = page.getByRole("form", { name: "Company defaults and limits", exact: true });
    const days = form.getByLabel("Retain unused data for days", { exact: true });
    await expect(days).toHaveValue("");
    await expect(form).toContainText("Leave blank to keep files until explicitly deleted");
    await days.fill("1"); await form.getByRole("button", { name: "Save company policy", exact: true }).click();
    await expect(form).toContainText("Company policy saved");
    expect((await (await page.request.get(policyPath)).json()).config.retainedDataSeconds).toBe(86400);
    await page.goto(`/${company.issuePrefix}/runtime-services/${services[0]!.id}`);
    const storage = page.getByRole("region", { name: "Workspace storage", exact: true });
    await expect(storage).toContainText("Data is protected from automatic deletion", { timeout: 20_000 });
    await expect(storage).toContainText("Complete or cancel every linked task");
    // Simulate two days passing only in this verified throwaway database. The
    // real controller, dependency checks, job, filesystem and UI remain live.
    const ageData = async () => db.$client.begin(async (tx) => {
      await tx`update runtime_service_company_policies set updated_at = now() - interval '2 days' where company_id = ${company.id}`;
      await tx`update runtime_services set created_at = now() - interval '2 days', updated_at = now() - interval '2 days', last_activity_at = now() - interval '2 days', stopped_at = now() - interval '2 days' where company_id = ${company.id}`;
      await tx`update execution_workspaces set updated_at = now() - interval '2 days' where company_id = ${company.id}`;
      await tx`update issues set updated_at = now() - interval '2 days' where company_id = ${company.id}`;
      await tx`update runtime_service_allocations set created_at = now() - interval '2 days', metadata = metadata - 'dataExpiration' where company_id = ${company.id}`;
    });
    await ageData();
    await expect.poll(async () => (await (await page.request.get(servicePath)).json()).retention.expiration.state).toBe("protected");
    expect((await (await page.request.get(servicePath)).json()).dataDeletion).toBeNull();
    expect(await fs.readFile(path.join(cwd, "dirty.txt"), "utf8")).toBe("Reviewed uncommitted task work");
    await storage.screenshot({ path: testInfo.outputPath("retention-protected-mobile.png") });
    const complete = await page.request.patch(`/api/issues/${task.id}`, { data: { status: "done" } });
    expect(complete.ok(), await complete.text()).toBe(true);
    await db.$client`update runtime_service_allocations set metadata = metadata - 'dataExpiration' where company_id = ${company.id}`;
    await expect(storage).toContainText("Eligible for permanent deletion after", { timeout: 20_000 });
    const scheduled: RuntimeService = await (await page.request.get(servicePath)).json();
    expect(Date.parse(scheduled.retention.expiration!.expiresAt!)).toBeGreaterThan(Date.now() + 23 * 3600_000);
    await storage.screenshot({ path: testInfo.outputPath("retention-scheduled-mobile.png") });
    await ageData();
    const deletion = page.getByRole("region", { name: "Workspace data deletion", exact: true });
    await expect(deletion).toContainText("Workspace data deleted", { timeout: 30_000 });
    await expect(deletion).toContainText("Requested by company data-retention policy (revision 1)");
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    const completed: RuntimeService = await (await page.request.get(servicePath)).json();
    expect(completed.dataDeletion).toMatchObject({ state: "deleted", reason: "retention", policyRevision: 1 });
    await expect(fs.lstat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(base, "source.txt"), "utf8")).toBe("Project source survives");
    expect(await git(base, "rev-parse", "runtime/app")).toBe(await git(base, "rev-parse", "main"));
    const peer: RuntimeService = await (await page.request.get(`/api/companies/${company.id}/runtime-services/${services[1]!.id}`)).json();
    expect(peer.dataDeletion?.id).toBe(completed.dataDeletion?.id);
    const policy = await (await page.request.get(policyPath)).json(); expect(policy.usage.serviceAllocations).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await deletion.screenshot({ path: testInfo.outputPath("retention-completed-mobile.png") });
    expect(errors).toEqual([]);
    const proof = testInfo.outputPath("retention-expiry.json");
    await fs.writeFile(proof, JSON.stringify({ realApiAndController: true, simulatedElapsedTime: true, realFilesystemDeletion: true,
      defaultRetentionDisabled: true, configuredThroughUi: true, activeTaskProtected: true, newlyCompletedTaskGetsFullInterval: true,
      deletion: completed.dataDeletion, projectAndBranchPreserved: true, sharedServicesDeletedTogether: true, capacityReleased: true, pageErrors: errors }, null, 2));
    await testInfo.attach("retention-expiry", { path: proof, contentType: "application/json" });
  } finally {
    await page.unrouteAll({ behavior: "wait" }); await db.$client.end({ timeout: 5 }); await fs.rm(root, { recursive: true, force: true });
  }
});
