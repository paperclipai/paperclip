import { expect, test } from "@playwright/test";

test("pin a project from the Projects list and open a task from its sidebar row", async ({ page, request }) => {
  const createdCompany = await request.post("/api/companies", { data: { name: "Project pinning" } });
  expect(createdCompany.ok()).toBe(true);
  const company = await createdCompany.json();
  const projectName = "Customer onboarding";
  const taskTitle = "Review the welcome email";
  const createdProject = await request.post(`/api/companies/${company.id}/projects`, {
    data: { name: projectName },
  });
  expect(createdProject.ok()).toBe(true);
  const project = await createdProject.json();
  const createdTask = await request.post(`/api/companies/${company.id}/issues`, {
    data: { title: taskTitle, projectId: project.id, status: "todo" },
  });
  expect(createdTask.ok()).toBe(true);
  const task = await createdTask.json();

  const projectsPath = `/${company.issuePrefix}/projects`;
  await page.goto(projectsPath);
  const main = page.getByRole("main");
  const nav = page.getByRole("navigation", { name: "Workspace navigation" });
  const folder = nav.getByRole("button", { name: projectName, exact: true });
  await main.getByRole("button", { name: `Pin ${projectName}`, exact: true }).click();
  await expect(page).toHaveURL((url) => url.pathname === projectsPath);
  await expect(folder).toHaveAttribute("aria-expanded", "false");

  await page.reload();
  await expect(folder).toHaveAttribute("aria-expanded", "false");
  const label = folder.locator("[data-cell-marquee]");
  const idleWidth = await label.evaluate((element) => element.getBoundingClientRect().width);
  await folder.hover();
  await expect.poll(() => label.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThan(idleWidth);

  await folder.press("Space");
  await expect(folder).toHaveAttribute("aria-expanded", "true");
  await expect(page).toHaveURL((url) => url.pathname === projectsPath);
  await nav.getByRole("link", { name: taskTitle }).click();
  await expect(page).toHaveURL((url) => url.pathname.includes(`/issues/${task.identifier}`));

  await page.goto(projectsPath);
  await main.getByRole("button", { name: `Unpin ${projectName}`, exact: true }).click();
  await expect(folder).toHaveCount(0);
});
