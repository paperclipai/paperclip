import { expect, test, type Page } from "@playwright/test";

/**
 * Regression: landing on an archived company's URL crashed the app with React
 * error #185. The Layout route-sync matched the URL against the full company
 * list and selected the archived company; the CompanyProvider bootstrap
 * resolver only accepted non-archived companies and immediately re-selected
 * an active one; the two effects ping-ponged the selection until React blew
 * the nested-update limit and unmounted the tree.
 *
 * Field shape: a workspace whose seeded primary company was archived — every
 * revisit of its remembered `/PREFIX/...` URL (first load and back/forward
 * navigations alike) produced a blank page.
 */

async function createCompany(page: Page, name: string): Promise<{ id: string; prefix: string }> {
  const res = await page.request.post("/api/companies", { data: { name } });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  return { id: company.id, prefix: company.issuePrefix ?? company.prefix ?? "E2E" };
}

function collectFatalErrors(page: Page): string[] {
  const fatal: string[] = [];
  page.on("pageerror", (err) => {
    fatal.push(`PAGEERROR: ${err.message}`);
  });
  page.on("console", async (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!/App shell crashed|Page render failed|Minified React error #185|Maximum update depth/.test(text)) {
      return;
    }
    fatal.push(`CONSOLE: ${text.slice(0, 300)}`);
  });
  return fatal;
}

test("landing on an archived company's URL does not crash the app", async ({ page }) => {
  const fatal = collectFatalErrors(page);

  const active = await createCompany(page, "Archived Loop Active");
  const archived = await createCompany(page, "Archived Loop Archived");
  const archiveRes = await page.request.patch(`/api/companies/${archived.id}`, {
    data: { status: "archived" },
  });
  expect(archiveRes.ok(), `archive failed ${archiveRes.status()}: ${await archiveRes.text()}`).toBe(true);

  // Field repro #1: a fresh load straight onto the archived company's
  // remembered URL (the first-open blank screen).
  await page.goto(`/${archived.prefix}/dashboard`);
  await page.waitForTimeout(2_500);
  expect(fatal, `crash on direct load of archived company URL:\n${fatal.join("\n")}`).toEqual([]);

  // Field repro #2: visit the active company, then return to the archived
  // company's URL with client-side history navigation (the "switched back"
  // crash).
  await page.goto(`/${active.prefix}/dashboard`);
  await page.waitForLoadState("networkidle");
  await page.goBack();
  await page.waitForTimeout(2_500);
  expect(fatal, `crash on back-navigation to archived company URL:\n${fatal.join("\n")}`).toEqual([]);

  // The app must have landed somewhere real, not a blank unmounted root.
  const rootContent = await page.locator("#root").innerText().catch(() => "");
  expect(rootContent.length).toBeGreaterThan(0);
});
