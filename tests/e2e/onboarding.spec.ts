import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

function makeTempDir(prefix: string) {
  const allowedTmpRoot = "/private/tmp";
  return fs.mkdtempSync(path.join(fs.existsSync(allowedTmpRoot) ? allowedTmpRoot : os.tmpdir(), prefix));
}

function createBrownfieldRepo() {
  const dir = makeTempDir("paperclip-e2e-brownfield-");
  fs.mkdirSync(path.join(dir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "paperclip-e2e-brownfield",
      dependencies: { react: "latest", express: "latest" },
      devDependencies: { typescript: "latest", vite: "latest" },
    }),
  );
  fs.writeFileSync(path.join(dir, "tsconfig.json"), "{}");
  fs.writeFileSync(path.join(dir, "vite.config.ts"), "export default {};\n");
  fs.writeFileSync(path.join(dir, "src", "App.tsx"), "export function App() { return null; }\n");
  return dir;
}

function createGreenfieldRepo() {
  const dir = makeTempDir("paperclip-e2e-greenfield-");
  fs.writeFileSync(path.join(dir, "README.md"), "# Empty product idea\n");
  return dir;
}

function createLargeRepo() {
  const dir = makeTempDir("paperclip-e2e-large-");
  for (let i = 0; i < 5_050; i += 1) {
    fs.mkdirSync(path.join(dir, `pkg-${String(i).padStart(4, "0")}`));
  }
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "paperclip-e2e-large" }));
  return dir;
}

async function scanFolder(page: Page, folderPath: string, setupFocus?: string) {
  await page.goto("/onboarding");
  await expect(page.getByRole("heading", { name: "Choose a project folder" })).toBeVisible();
  await page.getByLabel("Absolute folder path").fill(folderPath);
  if (setupFocus) {
    await page
      .getByLabel("Setup focus (optional)")
      .fill(setupFocus);
  }
  await page.getByRole("button", { name: "Scan folder" }).click();
}

async function expectReviewStep(page: Page) {
  await expect(page.getByRole("heading", { name: "Review recommended setup" })).toBeVisible({ timeout: 30_000 });
}

async function findCompanyByName(page: Page, companyName: string) {
  const companiesRes = await page.request.get("/api/companies");
  expect(companiesRes.ok()).toBe(true);
  const companies = await companiesRes.json();
  const company = companies.find((entry: { name: string }) => entry.name === companyName);
  expect(company).toBeTruthy();
  return company as { id: string; issuePrefix: string; name: string };
}

test.describe("First-run onboarding", () => {
  test("scans a brownfield repo, allows squad/model review edits, and applies setup", async ({ page }) => {
    const repoPath = createBrownfieldRepo();
    const companyName = `E2E Brownfield ${Date.now()}`;

    await scanFolder(page, repoPath, "Stabilize the UI and API for a demo-ready MVP.");
    await expectReviewStep(page);

    await expect(page.getByLabel("Company name")).toHaveValue(/Paperclip E2e Brownfield/);
    await expect(page.getByLabel("Operating focus")).toHaveValue("Stabilize the UI and API for a demo-ready MVP.");
    await expect(page.getByLabel("Starter issue title")).toHaveValue("Run Codebase Health Audit and Diagnostics");
    await expect(page.getByLabel("Starter issue description")).toHaveValue(/Build a repo-grounded diagnostics packet/);
    await expect(page.getByText("Optional secrets can be configured after setup")).toBeVisible();
    await expect(page.getByText("GitHub token")).toBeVisible();
    await expect(page.getByText("PROJECT_RUNTIME_ENV")).toBeVisible();
    await expect(page.getByText("WEBHOOK_SIGNING_SECRET")).toBeVisible();
    await expect(page.getByText("Use existing Codex login")).toBeVisible();
    await expect(page.getByText("Use existing Google/Antigravity login")).toBeVisible();

    await expect(page.getByLabel("Research & Insights Lead model")).toHaveValue("gemini-3.5-flash");
    await expect(page.getByLabel("Research & Insights Lead model")).toBeDisabled();

    await page.getByLabel("Research & Insights Lead provider").selectOption("codex_local");
    await expect(page.getByLabel("Research & Insights Lead provider")).toHaveValue("codex_local");

    await page.getByLabel("Company name").fill(companyName);
    await page.getByRole("button", { name: "Create setup" }).click();
    await expect(page).toHaveURL(/\/issues\//, { timeout: 30_000 });
    await expect(page.getByText("Finish deferred setup")).toBeVisible();
    await expect(page.getByRole("button", { name: "Start first audit" })).toBeVisible();
    await expect(page.getByText("The starter issue is parked until you intentionally launch it.")).toBeVisible();
    await expect(page.getByText("Local OAuth/session setup is not confirmed yet")).toBeVisible();
    await expect(page.getByRole("link", { name: "Configure secrets" })).toHaveAttribute("href", /\/company\/settings\/secrets/);
    await expect(page.getByRole("link", { name: "Configure MCPs" })).toHaveAttribute("href", /\/instance\/settings\/adapters/);
    const starterIssuePath = new URL(page.url()).pathname;

    const company = await findCompanyByName(page, companyName);

    const agentsRes = await page.request.get(`/api/companies/${company.id}/agents`);
    expect(agentsRes.ok()).toBe(true);
    const agents = await agentsRes.json();
    expect(agents.map((agent: { adapterType: string }) => agent.adapterType)).toEqual(
      expect.arrayContaining(["claude_local", "codex_local"]),
    );
    expect(agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ role: "researcher", adapterType: "codex_local" }),
      ]),
    );

    const issuesBeforeStartRes = await page.request.get(`/api/companies/${company.id}/issues`);
    expect(issuesBeforeStartRes.ok()).toBe(true);
    const issuesBeforeStart = await issuesBeforeStartRes.json();
    const starterIssueBeforeStart = issuesBeforeStart.find((issue: { title: string }) =>
      issue.title === "Run Codebase Health Audit and Diagnostics"
    ) as { id: string; title: string; status: string; originKind: string; assigneeAgentId: string | null } | undefined;
    expect(starterIssueBeforeStart).toEqual(expect.objectContaining({
      title: "Run Codebase Health Audit and Diagnostics",
      status: "backlog",
      originKind: "onboarding",
    }));
    expect(starterIssueBeforeStart?.assigneeAgentId).toBeTruthy();

    const assigneeRuntimeRes = await page.request.patch(
      `/api/agents/${starterIssueBeforeStart!.assigneeAgentId}?companyId=${company.id}`,
      {
        data: {
          runtimeConfig: {
            heartbeat: {
              enabled: false,
              intervalSec: 300,
              wakeOnDemand: false,
              cooldownSec: 10,
              maxConcurrentRuns: 1,
            },
          },
        },
      },
    );
    expect(assigneeRuntimeRes.ok()).toBe(true);

    await page.getByRole("button", { name: "Start first audit" }).click();
    await expect.poll(async () => {
      const res = await page.request.get(`/api/issues/${starterIssueBeforeStart!.id}`);
      expect(res.ok()).toBe(true);
      const updated = await res.json();
      return updated.status;
    }).toBe("todo");

    await page.goto(starterIssuePath);
    await expect(page.getByText("Finish deferred setup")).toBeVisible();
    await expect(page.getByText("Confirm or reuse Codex, Claude, and Antigravity OAuth sessions")).toBeVisible();
    await page.getByRole("button", { name: "Refresh setup checks" }).click();
    await expect(page.getByTestId("onboarding-setup-item-local_auth")).toContainText("Pending");
    await page.getByRole("button", { name: "Mark local auth complete" }).click();
    await expect(page.getByTestId("onboarding-setup-item-local_auth")).toContainText("Completed");
    await page.getByRole("button", { name: "Dismiss setup reminder" }).click();
    await expect(page.getByText("Finish deferred setup")).toBeHidden();
    await page.goto(starterIssuePath);
    await expect(page.getByText("Finish deferred setup")).toBeHidden();

    const projectsRes = await page.request.get(`/api/companies/${company.id}/projects`);
    expect(projectsRes.ok()).toBe(true);
    const [project] = await projectsRes.json();
    expect(project).toBeTruthy();

    const workspacesRes = await page.request.get(`/api/projects/${project.id}/workspaces?companyId=${company.id}`);
    expect(workspacesRes.ok()).toBe(true);
    const workspaces = await workspacesRes.json();
    expect(workspaces).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ cwd: repoPath, sourceType: "local_path", isPrimary: true }),
      ]),
    );

    const issuesRes = await page.request.get(`/api/companies/${company.id}/issues`);
    expect(issuesRes.ok()).toBe(true);
    const issues = await issuesRes.json();
    expect(issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          title: "Run Codebase Health Audit and Diagnostics",
          status: "todo",
          originKind: "onboarding",
        }),
      ]),
    );
  });

  test("turns an empty folder into a scaffold planning review without file-write instructions", async ({ page }) => {
    await scanFolder(page, createGreenfieldRepo(), "Build a focused SaaS MVP.");
    await expectReviewStep(page);

    await expect(page.getByLabel("Starter issue title")).toHaveValue("Design the First Approved Product Scaffold");
    await expect(page.getByLabel("Starter issue description")).toHaveValue(/Do not write scaffold files until the plan is approved\./);
  });

  test("keeps restricted directories on scan with a clear error", async ({ page }) => {
    // Use "/etc" rather than the macOS-only "/private/etc" alias so the
    // sensitive-root rejection fires on both macOS (where /etc → /private/etc)
    // and the Linux CI runner.
    await scanFolder(page, "/etc");

    await expect(page.getByRole("heading", { name: "Choose a project folder" })).toBeVisible();
    await expect(page.getByText("Path targets a sensitive system or credential directory")).toBeVisible();
  });

  test("continues large-repo safety-limit scans into the recommended review", async ({ page }) => {
    await scanFolder(page, createLargeRepo(), "Audit a large existing codebase without blocking setup.");
    await expectReviewStep(page);

    await expect(page.getByText("Large project scan reached the bounded sampling limit")).toBeVisible();
    await expect(page.getByLabel("Starter issue title")).toHaveValue("Run Codebase Health Audit and Diagnostics");
    await expect(page.getByText("Optional secrets can be configured after setup")).toBeVisible();
  });
});
