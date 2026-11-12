import { expect, test, type Page } from "@playwright/test";

/**
 * Archived-company URL handling.
 *
 * Regression (React #185): landing on an archived company's URL crashed the
 * app — the Layout route-sync selected the archived company while the
 * CompanyProvider bootstrap resolver rejected it, and the two effects
 * ping-ponged the selection until React blew the nested-update limit.
 *
 * Policy: stale state (remembered paths, browser history, bookmarks,
 * restored tabs) keeps depositing users into archived companies long after
 * archiving, so a cold arrival bounces to an active company with a toast.
 * A deliberate visit — selecting the archived company from the companies
 * list — sticks, so its pages stay reachable.
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
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!/App shell crashed|Page render failed|Minified React error #185|Maximum update depth/.test(text)) {
      return;
    }
    fatal.push(`CONSOLE: ${text.slice(0, 300)}`);
  });
  return fatal;
}

test("archived company URLs bounce cold arrivals and honor deliberate visits", async ({ page }) => {
  const fatal = collectFatalErrors(page);

  const active = await createCompany(page, "Archived Loop Active");
  const archived = await createCompany(page, "Archived Loop Archived");
  const archiveRes = await page.request.patch(`/api/companies/${archived.id}`, {
    data: { status: "archived" },
  });
  expect(archiveRes.ok(), `archive failed ${archiveRes.status()}: ${await archiveRes.text()}`).toBe(true);

  // The e2e server is shared across specs, so other companies exist and the
  // bounce may pick any active one; the contract is only "not the archived
  // company's routes anymore".
  const awayFromArchived = (url: URL) =>
    url.pathname.endsWith("/dashboard") && !url.pathname.startsWith(`/${archived.prefix}/`);

  // Cold arrival #1: a fresh load straight onto the archived company's
  // remembered URL (previously the first-open blank-screen crash) bounces
  // to an active company.
  await page.goto(`/${archived.prefix}/dashboard`);
  await page.waitForURL(awayFromArchived, { timeout: 15_000 });
  await expect(page.getByText("Archived Loop Archived is archived")).toBeVisible();
  expect(fatal, `crash on direct load of archived company URL:\n${fatal.join("\n")}`).toEqual([]);

  // Cold arrival #2: re-arrival at the archived URL (previously the
  // "switched back" crash) bounces the same way.
  await page.goto(`/${archived.prefix}/issues`);
  await page.waitForURL(awayFromArchived, { timeout: 15_000 });
  expect(fatal, `crash on re-arrival at archived company URL:\n${fatal.join("\n")}`).toEqual([]);

  // Deliberate visit: selecting the archived company from the companies list
  // sticks — no bounce — so its pages (and the way back to unarchiving) stay
  // reachable.
  await page.goto(`/${active.prefix}/companies`);
  await page.waitForLoadState("networkidle");
  await page.getByText("Archived Loop Archived").first().click();
  await page.waitForURL(new RegExp(`/${archived.prefix}/`), { timeout: 15_000 });
  await page.waitForTimeout(1_500);
  expect(page.url()).toMatch(new RegExp(`/${archived.prefix}/`));
  expect(fatal, `crash during deliberate archived visit:\n${fatal.join("\n")}`).toEqual([]);

  const rootContent = await page.locator("#root").innerText().catch(() => "");
  expect(rootContent.length).toBeGreaterThan(0);
});
