import { expect, test } from "@playwright/test";
import { collectionFixture, type CollectionFixture } from "./fixture";

let fixture: CollectionFixture;
test.beforeAll(async ({ request }) => {
  fixture = await collectionFixture(request);
});

// The sidebar wants active projects and the inbox wants archived ones too.
// One includeArchived read serves both.
test("Mine reads the company project list once", async ({ page }) => {
  const path = `/api/companies/${fixture.company.id}/projects`;
  const reads: URL[] = [];
  page.on("request", item => {
    const url = new URL(item.url());
    if (url.pathname === path) reads.push(url);
  });
  const inbox = page.waitForResponse(item => new URL(item.url()).pathname === `/api/companies/${fixture.company.id}/inbox/mine` && item.ok());
  await page.goto(`/${fixture.company.issuePrefix}/issues?view=mine`);
  // Mine's own read has completed, so the inbox and the sidebar have both
  // mounted their project consumers.
  await inbox;
  await expect.poll(() => reads.some(url => url.searchParams.get("includeArchived") === "true")).toBe(true);
  // The live-updates socket may refresh the shared list once after it opens;
  // that is the same read. An active-only read means the payload was fetched twice.
  expect(reads.filter(url => url.searchParams.get("includeArchived") !== "true")).toEqual([]);
  expect(reads.length).toBeGreaterThanOrEqual(1);
});
