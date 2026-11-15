import { expect, test } from "@playwright/test";
import { newProjectButton } from "./product-journeys/project-context-flow.js";
import { storyArtifactDownloadLink } from "./story-artifact.js";
import { taskProperties } from "./product-journeys/task-properties.js";
import { showPropertyRow } from "./product-journeys/task-panel.js";
import type { JourneyContext, JourneyEvidence, TargetSession } from "./product-journeys/types.js";

const id = "11111111-2222-4333-8444-555555555555";

test("property reads select Properties from an open panel and exclude inactive duplicate rows", async ({ page }) => {
  const row = (value: string) => `<div data-property-row><span data-property-label="Project">Project</span><span data-property-value>${value}</span></div>`;
  await page.setContent(`<aside inert aria-hidden="true">${row("Stale project")}</aside>
    <aside><button role="tab" onclick="document.querySelector('#properties').hidden=false">Properties</button><section id="properties" hidden>${row("Saved project")}</section></aside>`);
  const property = await showPropertyRow(page, "Project");
  await expect(property.locator("[data-property-value]")).toHaveText("Saved project");
});

test("property reads cannot use an inert row when the panel has no open control", async ({ page }) => {
  await page.setContent('<aside inert aria-hidden="true"><div data-property-row><span data-property-label="Project">Project</span><span data-property-value>Saved project</span></div></aside>');
  await expect(showPropertyRow(page, "Project")).rejects.toThrow();
});

test("assignment opens the current side panel again after reload and verifies the saved user", async ({ page }) => {
  const origin = "https://assignment-controls.test", title = "Owned assignment task", userId = "owned-user";
  let assigned = false;
  await page.route(`${origin}/**`, async route => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === "/assign") {
      assigned = true;
      await route.fulfill({ json: {} });
      return;
    }
    await route.fulfill({ contentType: "text/html", body: pathname === "/QA/issues"
      ? `<a href="/QA/issues/QA-201">${title}</a>`
      : `<button aria-label="Toggle side panel" aria-pressed="false" onclick="const p=document.querySelector('aside');p.removeAttribute('inert');p.removeAttribute('aria-hidden');p.style.width='300px';this.setAttribute('aria-pressed','true')">Open</button>
        <aside inert aria-hidden="true" style="width:0;overflow:hidden"><div style="width:300px" data-property-row><span data-property-label="Assignee">Assignee</span><div data-property-value><button onclick="document.querySelector('#choices').hidden=false">${assigned ? "You" : "Unassigned"}</button></div></div></aside>
        <div id="choices" hidden><button onclick="fetch('/assign',{method:'POST'}).then(()=>this.parentElement.hidden=true)">Assign to me</button></div>` });
  });
  const context = { page, company: { issuePrefix: "QA" }, user: { id: userId }, capabilities: ["company", "board-user", "task-write"],
    fixtures: { backlogTask: { id, title, identifier: "QA-201" } }, api: { origin,
      get: async (route: string) => route.endsWith("/runs") ? [] : { assigneeUserId: assigned ? userId : null, assigneeAgentId: null, status: "backlog" } },
  } as unknown as JourneyContext;
  const evidence: JourneyEvidence = { checks: [], outcome: "passed", startingState: "recipe", phases: [], resourceDisposition: "released", privacy: "private" };
  await taskProperties(context, {} as TargetSession, "owned-campaign", evidence);
  expect(evidence.checks).toEqual([{ id: "assignment-persisted", passed: true }, { id: "no-agent-work", passed: true }]);
  await expect(page.getByRole("button", { name: "You", exact: true })).toBeVisible();
});

test("finds the attachment download link in legacy and Artifacts V1 markup only", async ({ page }) => {
  const markup = {
    legacy: `<a href="/api/attachments/${id}/content?download=1">Download</a>`,
    // Artifacts V1: an icon-only "Open raw" link precedes the icon-only download link.
    v1: `<span>slugify.zip</span><a href="/api/attachments/${id}/content" aria-label="Open raw slugify.zip"><svg width="8" height="8"></svg></a>`
      + `<a href="/api/attachments/${id}/content?download=1" download="slugify.zip" aria-label="Download slugify.zip"><svg width="8" height="8"></svg></a>`,
    none: `<a href="/api/attachments/${id}/content" aria-label="Open raw slugify.zip">Open</a>`
      + `<a href="/api/attachments/other/content?download=1" aria-label="Download other.zip">Download</a>`,
  };
  for (const kind of ["legacy", "v1"] as const) {
    await page.setContent(markup[kind]);
    await expect(storyArtifactDownloadLink(page, id)).toHaveAttribute("href", `/api/attachments/${id}/content?download=1`);
  }
  await page.setContent(markup.none);
  await expect(storyArtifactDownloadLink(page, id)).toHaveCount(0);
});

test("opens new-project creation with the previous or current toolbar label only", async ({ page }) => {
  for (const label of ["Add Project", "Create project"]) {
    await page.setContent(`<button>Create project template</button><button>${label}</button>`);
    await expect(newProjectButton(page)).toHaveText(label);
  }
  await page.setContent(`<button>Create project template</button><button>New issue</button>`);
  await expect(newProjectButton(page)).toHaveCount(0);
});
