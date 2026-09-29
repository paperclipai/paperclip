import { test, expect } from "@playwright/test";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { seedWorkspaceBootstrap } from "./seed.mjs";

// Opt-in: requires the isolated test-drive launched with this suite's Git shim.
// Never attach these fault-injection tests to a regular development instance.
const base = process.env.WORKSPACE_BOOTSTRAP_TEST_URL;
test.skip(!base, "Launch the disposable workspace-bootstrap test-drive; see README.md");

for (const persistent of [false, true]) {
  test(persistent ? "exhausts the shared retry budget with an actionable stop" : "recovers and completes through the task UI without manual Retry", async ({ page }, info) => {
    const fixture = await seedWorkspaceBootstrap(base!, persistent);
    const api = async (route: string) => {
      const response = await page.request.get(`${base}/api${route}`);
      expect(response.ok(), await response.text()).toBeTruthy();
      return response.json();
    };
    const title = `${persistent ? "Bound persistent failure" : "Recover and preserve work"} ${Date.now()}`;
    await page.goto(`${base}/${fixture.prefix}/dashboard`);
    const announcement = page.getByRole("button", { name: "Dismiss announcement" });
    if (await announcement.isVisible()) await announcement.click();
    await page.getByRole("link", { name: "Tasks", exact: true }).click();
    await page.getByRole("button", { name: "New Task", exact: true }).last().click();
    await page.getByRole("textbox", { name: "Task title", exact: true }).fill(title);
    await page.getByRole("button", { name: "Assignee", exact: true }).click();
    await page.getByRole("button", { name: fixture.agentName, exact: true }).click();
    // Let the closing popover unmount before clicking another popover trigger.
    await expect(page.getByRole("textbox", { name: "Search assignees...", includeHidden: true })).toHaveCount(0);
    // The preceding popover's focus restoration can consume the first click.
    await expect(async () => {
      if (!await page.getByRole("textbox", { name: "Search projects..." }).isVisible()) {
        await page.getByRole("button", { name: "Project", exact: true }).click();
      }
      await expect(page.getByRole("textbox", { name: "Search projects..." })).toBeVisible({ timeout: 1_000 });
    }).toPass({ timeout: 10_000, intervals: [1_000] });
    await page.getByRole("button", { name: fixture.projectName, exact: true }).click();
    await expect(page.getByRole("textbox", { name: "Search projects...", includeHidden: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Create Task", exact: true }).click();
    const taskLink = page.getByRole("complementary").getByRole("link", { name: title, exact: true });
    await expect(taskLink).toBeVisible();
    // Follow the UI's actual persisted link, including across task-tab state.
    const href = await taskLink.getAttribute("href");
    expect(href).toBeTruthy();
    await page.goto(new URL(href!, base).href);
    const tasks = await api(`/companies/${fixture.companyId}/issues`);
    const task = tasks.find((row: { title: string }) => row.title === title);
    const runs = async () => (await api(`/companies/${fixture.companyId}/heartbeat-runs`)).filter((row: { agentId: string }) => row.agentId === fixture.agentId);
    await expect.poll(async () => (await runs()).some((row: { errorCode: string }) => row.errorCode === "workspace_git_scan_timeout"), { timeout: 30_000 }).toBe(true);
    await expect(page.getByText(/Agent resumes in/)).toBeVisible();
    await page.screenshot({ path: info.outputPath("scheduled-retry.png"), fullPage: true });
    await expect.poll(async () => (await api(`/issues/${task.id}`)).status, { timeout: 150_000 }).toBe(persistent ? "blocked" : "done");
    // The worker updates the task before its process exit is persisted.
    await expect.poll(async () => (await runs()).filter((row: { status: string }) => ["running", "queued", "scheduled_retry"].includes(row.status)).length).toBe(0);
    const history = await runs();
    expect(history).toHaveLength(persistent ? 3 : 2);
    expect(history.filter((row: { status: string }) => row.status === "succeeded")).toHaveLength(persistent ? 0 : 1);
    if (persistent) {
      await expect(page.getByText("Workspace scan timed out", { exact: true })).toBeVisible();
      await expect(page.getByText("No live execution path", { exact: true })).toHaveCount(0);
      await page.waitForTimeout(35_000);
      expect(await runs()).toHaveLength(3);
    } else {
      await expect(page.getByText(/Workspace recovered automatically\./)).toBeVisible();
      const project = await api(`/projects/${fixture.projectId}`);
      const sourceCopy = project.workspaces.find((row: { name: string }) => row.name === "Source copy");
      const completed = history.find((row: { status: string }) => row.status === "succeeded");
      // The worker already verified the managed copy with its run-scoped API.
      // Independently confirm the configured source was never overwritten.
      expect(sourceCopy).toBeTruthy();
      expect(completed.scheduledRetryAttempt).toBe(1);
      expect(await readFile(path.join(fixture.source, "README.md"), "utf8")).toBe("Existing uncommitted work\n");
    }
    await page.reload();
    await expect(page.getByRole("button", { name: new RegExp(`^Change status \\(current: ${persistent ? "Blocked" : "Done"}`) }).first()).toBeVisible();
    await expect(page.getByText(/Agent resumes in/)).toHaveCount(0);
    await page.screenshot({ path: info.outputPath("settled-task.png"), fullPage: true });
  });
}
