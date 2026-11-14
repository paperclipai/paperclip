import { expect, test } from "@playwright/test";
import { collectionFixture, type CollectionFixture } from "./fixture";

let fixture: CollectionFixture;
test.beforeAll(async ({ request }) => {
  fixture = await collectionFixture(request);
});

// Slash-command options for Markdown editors come from the company skills and
// routines lists. Mine has no editor, so it must not pay for either read.
test("Mine does not read company skills or routines", async ({ page }) => {
  const companyId = fixture.company.id;
  const reads: URL[] = [];
  page.on("request", item => { if (item.url().includes("/api/")) reads.push(new URL(item.url())); });
  await page.goto(`/${fixture.company.issuePrefix}/issues?view=mine`);
  await expect.poll(() => reads.some(url => url.pathname === `/api/companies/${companyId}/inbox/mine`)).toBe(true);
  // Shell reads start in the same pass as the inbox; allow late ones to start.
  await page.waitForTimeout(2_000);
  expect(reads.filter(url => url.pathname === `/api/companies/${companyId}/skills`)).toEqual([]);
  expect(reads.filter(url => url.pathname === `/api/companies/${companyId}/routines`)).toEqual([]);
});
