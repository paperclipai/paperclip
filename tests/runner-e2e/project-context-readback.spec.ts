import { expect, test, type Page } from "@playwright/test";
import { openProjectTaskThroughList, reopenProjectThroughList } from "./product-journeys/project-context-readback.js";

const origin = "https://project-context.test", projectName = "Journey QA project owned-campaign";
const taskTitle = "Journey QA project task owned-campaign", prompt = "I will review this task myself.";
const projectPath = "/QA/projects/owned-project-f962db91/issues", taskPath = "/QA/issues/QA-201";
const projectInput = { origin, issuePrefix: "QA", projectName, projectRef: "owned-project-f962db91" };
const taskInput = { origin, issuePrefix: "QA", projectName, taskTitle, prompt, taskRef: "QA-201" };

async function fixture(page: Page, changes: { missingProject?: boolean; wrongProject?: boolean; missingTask?: boolean; wrongTask?: boolean; wrongProperty?: boolean } = {}) {
  const requests: string[] = [];
  await page.route(`${origin}/**`, async route => {
    const path = new URL(route.request().url()).pathname;
    requests.push(path);
    // Layout can retain a hidden sidebar label. ProjectDetail renders its
    // production InlineEditor as h2; IssueRow has an overlay link with sr-only text.
    const sidebar = `<aside hidden><a href="/wrong-sidebar">${projectName}</a><a href="/wrong-task">${taskTitle}</a><p>${prompt}</p></aside>`;
    const body = path === "/QA/projects" ? `${sidebar}<main id="main-content">${changes.missingProject ? "" : `<a href="${changes.wrongProject ? "/QA/projects/foreign/issues" : projectPath}"><span>${projectName}</span></a>`}</main>`
      : path.includes("/projects/") ? `${sidebar}<main id="main-content"><h2>${projectName}</h2>${changes.missingTask ? "" : `<div data-issue-row-id="owned-task" style="position:relative;min-height:44px"><a style="position:absolute;inset:0" href="${changes.wrongTask ? "/QA/issues/QA-999" : taskPath}"><span class="sr-only">Open QA-201: ${taskTitle}</span></a><span>${taskTitle}</span></div>`}</main>`
        : `${sidebar}<main id="main-content"><h1>${taskTitle}</h1><p>${prompt}</p><button onclick="document.querySelector('#properties').hidden=false;this.hidden=true">Show properties</button><section id="properties" hidden><div data-property-row><span data-property-label="Project">Project</span><div data-property-value>${changes.wrongProperty ? "Other project" : projectName}</div></div></section></main>`;
    await route.fulfill({ contentType: "text/html", body: `<style>.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style>${body}` });
  });
  return requests;
}

test("reopens and reloads the owned project and task despite hidden duplicate sidebar labels", async ({ page }) => {
  const requests = await fixture(page);
  await reopenProjectThroughList({ ...projectInput, page });
  await openProjectTaskThroughList({ ...taskInput, page });
  expect(requests.filter(path => path === projectPath)).toHaveLength(2);
  expect(requests.filter(path => path === taskPath)).toHaveLength(2);
  await expect(page.locator("main#main-content [data-property-value]")).toContainText(projectName);
});

for (const [name, changes, code] of [
  ["missing project list row", { missingProject: true }, "project_context_project_open_failed"],
  ["wrong project route with a matching label", { wrongProject: true }, "project_context_project_open_failed"],
] as const) test(`rejects ${name} with a closed stage code`, async ({ page }) => {
  await fixture(page, changes);
  await expect(reopenProjectThroughList({ ...projectInput, page })).rejects.toMatchObject({ outcome: "failed", code, message: code });
});

for (const [name, changes, code] of [
  ["missing task in the project", { missingTask: true }, "project_context_project_task_open_failed"],
  ["wrong task route with a matching label", { wrongTask: true }, "project_context_project_task_open_failed"],
  ["wrong saved project property", { wrongProperty: true }, "project_context_project_property_failed"],
] as const) test(`rejects ${name} with a closed stage code`, async ({ page }) => {
  await fixture(page, changes);
  await page.goto(`${origin}${projectPath}`);
  await expect(openProjectTaskThroughList({ ...taskInput, page })).rejects.toMatchObject({ outcome: "failed", code, message: code });
});
