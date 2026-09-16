import { expect, test } from "@playwright/test";

test("project creation and repository configuration persist on a short mobile viewport", async ({ page }) => {
  test.setTimeout(120_000);
  const createdCompany = await page.request.post("/api/companies", { data: { name: "Repository UX" } });
  expect(createdCompany.ok()).toBe(true);
  const company = await createdCompany.json();
  await page.goto(`/${company.issuePrefix}/projects`);
  await page.getByRole("button", { name: "Add Project", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.getByRole("textbox", { name: "Project name" })).toBeFocused();
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Repository acceptance");
  await expect(dialog.getByText("Source repos", { exact: true })).toBeVisible();
  await expect(dialog.getByText("Goal", { exact: true })).toHaveCount(0);
  await expect(dialog.getByPlaceholder("https://github.com/org/repo")).toHaveCount(0);
  await dialog.getByRole("button", { name: "Create project", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  const projects = await (await page.request.get(`/api/companies/${company.id}/projects`)).json();
  const project = projects.find((item: { name: string }) => item.name === "Repository acceptance");
  expect(project).toBeTruthy();
  // Seed existing selections through the real workspace API. Provider discovery
  // and create authorization are separately covered by server integration tests.
  for (let index = 1; index <= 40; index += 1) {
    const response = await page.request.post(`/api/projects/${project.id}/workspaces`, { data: {
      name: `org/repo-${index}`, repoUrl: `https://github.com/org/repo-${index}`, metadata: { githubRepositoryId: String(index) },
    } });
    expect(response.ok()).toBe(true);
  }
  const legacy = await page.request.post(`/api/projects/${project.id}/workspaces`, { data: { name: "Legacy", repoUrl: "https://git.example/org/legacy" } });
  expect(legacy.ok()).toBe(true);
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto(`/${company.issuePrefix}/projects/${project.id}/overview`);
  await expect(page).toHaveURL(/\/configuration$/);
  await expect(page.getByRole("tab", { name: "Overview", exact: true })).toHaveCount(0);
  const section = page.getByRole("region", { name: "Repositories", exact: true });
  await expect(section.getByText("org/repo-40", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Remove org/repo-40", exact: true }).click();
  await section.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(section.getByRole("status")).toHaveText("Changes saved");
  await expect(section.getByText("org/repo-40", { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(section.getByText("org/repo-40", { exact: true })).toHaveCount(0);
  await expect(section.getByText("org/repo-39", { exact: true })).toBeVisible();
  await section.getByRole("button", { name: "Edit", exact: true }).click();
  await section.getByRole("textbox", { name: "Existing repo URL" }).fill("https://git.example/org/updated");
  await section.getByRole("button", { name: "Save URL" }).click();
  await page.reload();
  await expect(section.getByText("https://git.example/org/updated", { exact: true })).toBeVisible();
  await expect(page.getByText("Set the KEY to the env var name", { exact: false })).toHaveCount(0);
  await expect(page.getByText("Applied to all runs for tasks in this project.", { exact: false })).toHaveCount(0);
  const created = page.getByText("Created", { exact: true });
  await created.scrollIntoViewIfNeeded();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const persisted = await (await page.request.get(`/api/projects/${project.id}`)).json();
  expect(persisted.workspaces.filter((workspace: { metadata?: { githubRepositoryId?: string } }) => workspace.metadata?.githubRepositoryId)).toHaveLength(39);
});

test("a short new-project dialog keeps actions visible and rejects unavailable selections without a partial project", async ({ page }) => {
  const company = await (await page.request.post("/api/companies", { data: { name: "Repository picker" } })).json();
  const repos = Array.from({ length: 80 }, (_, index) => ({ id: String(index + 1), fullName: `org/repo-${index + 1}`, url: `https://github.com/org/repo-${index + 1}`, connections: ["Fixture account"], private: true }));
  // Only discovery is simulated. Submission reaches the real authorization
  // boundary and must reject these unavailable provider identities atomically.
  await page.route(`**/api/companies/${company.id}/project-repositories`, (route) => route.fulfill({ json: { repositories: repos, connectionCount: 1, failedConnectionCount: 0 } }));
  await page.setViewportSize({ width: 390, height: 420 });
  await page.goto(`/${company.issuePrefix}/projects`);
  await page.getByRole("button", { name: "Add Project", exact: true }).first().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox", { name: "Project name" }).fill("Rejected draft");
  await dialog.getByRole("button", { name: "Add GitHub repo", exact: true }).click();
  await page.getByPlaceholder("Search GitHub repos…").fill("org/repo-80");
  await page.getByRole("option").filter({ hasText: "org/repo-80" }).click();
  await dialog.getByRole("button", { name: "Add another repo", exact: true }).click();
  await page.getByPlaceholder("Search GitHub repos…").fill("org/repo-79");
  await page.getByRole("option").filter({ hasText: "org/repo-79" }).click();
  const submit = dialog.getByRole("button", { name: "Create project", exact: true });
  const bounds = await submit.boundingBox();
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(420);
  await submit.click();
  await expect(dialog.getByRole("alert")).toContainText("no longer available");
  await expect(dialog.getByRole("textbox", { name: "Project name" })).toHaveValue("Rejected draft");
  await expect(dialog.getByText("org/repo-80", { exact: true })).toBeVisible();
  const projects = await (await page.request.get(`/api/companies/${company.id}/projects`)).json();
  expect(projects).toHaveLength(0);
});
