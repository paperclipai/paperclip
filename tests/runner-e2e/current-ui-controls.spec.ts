import { expect, test } from "@playwright/test";
import { newProjectButton } from "./product-journeys/project-context-flow.js";
import { storyArtifactDownloadLink } from "./story-artifact.js";

const id = "11111111-2222-4333-8444-555555555555";

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
