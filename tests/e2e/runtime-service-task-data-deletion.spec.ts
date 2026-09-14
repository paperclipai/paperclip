import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { test, expect } from "@playwright/test";
import { createDb } from "../../packages/db/src/client";
import { executionWorkspaces } from "../../packages/db/src/schema/execution_workspaces";
import type { RuntimeService, RuntimeServiceDataDeletionPlan } from "../../packages/shared/src/runtime-services";

const exec = promisify(execFile);
async function git(cwd: string, ...args: string[]) { return (await exec("git", ["-C", cwd, ...args])).stdout.trim(); }

test("operator reviews and deletes real shared task files on mobile despite a lost response", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(90_000);
  const home = process.env.PAPERCLIP_TASK_DELETION_FIXTURE_HOME;
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
    const companyResponse = await page.request.post("/api/companies", { data: { name: "Task file deletion acceptance" } });
    expect(companyResponse.ok()).toBe(true); const company = await companyResponse.json();
    const projectResponse = await page.request.post(`/api/companies/${company.id}/projects`, { data: { name: "Preview app" } });
    expect(projectResponse.ok()).toBe(true); const project = await projectResponse.json();
    const primaryResponse = await page.request.post(`/api/projects/${project.id}/workspaces`, { data: { name: "Primary", cwd: base, isPrimary: true } });
    expect(primaryResponse.ok()).toBe(true); const primary = await primaryResponse.json();
    const taskResponse = await page.request.post(`/api/companies/${company.id}/issues`, { data: { title: "Develop preview app", projectId: project.id, status: "done" } });
    expect(taskResponse.ok()).toBe(true); const task = await taskResponse.json();
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
    const servicePath = `/api/companies/${company.id}/runtime-services/${services[0]!.id}`, reviewPath = `${servicePath}/data-deletion`;
    await page.setViewportSize({ width: 390, height: 760 }); await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto(`/${company.issuePrefix}/runtime-services/${services[0]!.id}`);
    const panel = page.getByRole("region", { name: "Workspace data deletion", exact: true });
    await panel.getByRole("button", { name: "Review data deletion", exact: true }).click();
    await expect(panel).toContainText("Preview app worktree"); await expect(panel).toContainText("Shared Git branch history is retained");
    await expect(panel.getByRole("link", { name: "Task API", exact: true })).toBeVisible();
    await expect(panel.getByRole("link", { name: `${task.identifier} · Develop preview app`, exact: true })).toBeVisible();
    await expect(panel.getByRole("button", { name: "Delete data permanently", exact: true })).toBeDisabled();
    expect(await fs.readFile(path.join(cwd, "dirty.txt"), "utf8")).toBe("Reviewed uncommitted task work");
    await panel.getByRole("checkbox").check();
    await panel.screenshot({ path: testInfo.outputPath("task-deletion-review-mobile.png") });
    const requests: unknown[] = [];
    await page.route(`**${reviewPath}`, async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      requests.push(route.request().postDataJSON());
      const accepted = await route.fetch(); expect(accepted.status()).toBe(202);
      await route.abort("failed"); // Real committed job; only its response is lost.
    });
    await panel.getByRole("button", { name: "Delete data permanently", exact: true }).click();
    await expect(panel).toContainText("Workspace data deleted", { timeout: 30_000 });
    await expect(panel.getByRole("checkbox")).toHaveCount(0); await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start", exact: true })).toHaveCount(0);
    const completed: RuntimeServiceDataDeletionPlan = await (await page.request.get(reviewPath)).json();
    expect(completed.deletion?.state).toBe("deleted"); expect(requests).toHaveLength(1);
    await expect(fs.lstat(cwd)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await fs.readFile(path.join(base, "source.txt"), "utf8")).toBe("Project source survives");
    expect(await git(base, "rev-parse", "runtime/app")).toBe(await git(base, "rev-parse", "main"));
    expect(await git(base, "worktree", "list", "--porcelain")).not.toContain(cwd);
    const peer: RuntimeService = await (await page.request.get(`/api/companies/${company.id}/runtime-services/${services[1]!.id}`)).json();
    expect(peer.dataDeletion?.id).toBe(completed.deletion?.id); expect(peer.dataDeletion?.state).toBe("deleted");
    const reopen = await page.request.patch(`/api/execution-workspaces/${workspace!.id}`, { data: { status: "active" } });
    expect(reopen.status()).toBe(409);
    const policy = await (await page.request.get(`/api/companies/${company.id}/runtime-service-policy`)).json();
    expect(policy.usage.serviceAllocations).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await panel.screenshot({ path: testInfo.outputPath("task-deletion-complete-mobile.png") });
    expect(errors).toEqual([]);
    const proof = testInfo.outputPath("task-data-deletion.json");
    await fs.writeFile(proof, JSON.stringify({ realApiAndController: true, fixtureWorkspaceSeed: true, sharedServices: services.map((service) => service.id),
      deletion: completed.deletion, lostResponseRecoveredByPolling: true, taskFilesRemoved: true, primarySourceAndBranchPreserved: true,
      oldWorkspaceReopenRejected: true, retainedCapacityReleased: true, pageErrors: errors }, null, 2));
    await testInfo.attach("task-data-deletion", { path: proof, contentType: "application/json" });
  } finally {
    await page.unrouteAll({ behavior: "wait" }); await db.$client.end({ timeout: 5 }); await fs.rm(root, { recursive: true, force: true });
  }
});
