import { randomUUID } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";

async function json<T = Record<string, any>>(response: APIResponse): Promise<T> {
  expect(response.ok(), `${response.status()}: ${await response.text()}`).toBe(true);
  return response.json();
}

let cleanup: { companyId: string; enableCases: boolean } | undefined;

test.afterEach(async ({ request }, testInfo) => {
  const state = cleanup;
  cleanup = undefined;
  if (!state) return;
  testInfo.setTimeout(15_000);
  const results = await Promise.allSettled([
    request.patch("/api/instance/settings/experimental", { data: { enableCases: state.enableCases }, timeout: 5_000 }),
    request.patch(`/api/companies/${state.companyId}`, { data: { status: "archived" }, timeout: 5_000 }),
  ]);
  const failures = results.flatMap((result, index) => result.status === "rejected"
    ? [`Cleanup ${index}: ${String(result.reason)}`]
    : result.value.ok() ? [] : [`Cleanup ${index}: HTTP ${result.value.status()}`]);
  if (!failures.length) return;
  await testInfo.attach("cleanup-failure", { body: Buffer.from(JSON.stringify({ companyId: state.companyId, failures })), contentType: "application/json" }).catch(() => undefined);
  // Keep the original journey failure; a cleanup error still fails a passing test.
  if (testInfo.status === "passed") throw new Error(failures.join("\n"));
});

test("browses passive cases and rolled-up task documents without starting work or editing", async ({ page }, testInfo) => {
  page.setDefaultTimeout(10_000);
  // Announcements can arrive after navigation and cover otherwise valid links.
  // Dismiss through the ordinary Board control, including after reloads.
  const dismissAnnouncement = page.getByRole("complementary", { name: "Paperclip announcements", exact: true })
    .getByRole("button", { name: "Dismiss announcement", exact: true });
  const dismissAnnouncements = async () => { await dismissAnnouncement.click(); };
  await page.addLocatorHandler(dismissAnnouncement, dismissAnnouncements);
  const api = page.request;
  const original = await json(await api.get("/api/instance/settings/experimental"));
  const company = await json(await api.post("/api/companies", { data: { name: `Read-only cases ${randomUUID()}` } }));
  const companyPath = `/api/companies/${company.id}`;
  cleanup = { companyId: company.id, enableCases: original.enableCases };
  await json(await api.patch("/api/instance/settings/experimental", { data: { enableCases: true } }));
  const project = await json(await api.post(`${companyPath}/projects`, { data: { name: "Receipt project" } }));
  const items = [{ description: "Tea", quantity: 2, unitPrice: 3 }];
  const delivery = { method: "email", recipient: { name: "Pacific customer" } };
  const checks = [{ phase: "triage", status: "passed" }, { phase: "review", status: "pending" }];
  const receipt = await json(await api.post(`${companyPath}/cases`, { data: {
    caseType: "receipt", key: "pacific-receipt", title: "Pacific receipt", status: "draft", projectId: project.id,
    summary: "A saved receipt awaiting review.", fields: { currency: "USD", total: 6, notes: "Read-only invoice", items, delivery, checks },
  } }));
  const research = [];
  for (const status of ["draft", "done"]) research.push(await json(await api.post(`${companyPath}/cases`, {
    data: { caseType: "research", key: `research-${status}`, title: `Research ${status}`, status, fields: { topic: "Receipt research" } },
  })));
  const task = await json(await api.post(`${companyPath}/issues`, { data: { title: "Receipt reference task", status: "todo", assigneeAgentId: null } }));
  await json(await api.post(`/api/cases/${receipt.id}/links`, { data: { issueId: task.id, role: "reference" } }));
  const documentPath = `/api/issues/${task.id}/documents/receipt`;
  const first = await json(await api.put(documentPath, { data: { format: "markdown", title: "Receipt", body: "# Receipt revision one\n\nTotal: 6. Currency pending." } }));
  await json(await api.put(documentPath, { data: { format: "markdown", title: "Receipt", body: "# Receipt revision two\n\nTotal: 6 USD. Currency verified.", baseRevisionId: first.latestRevisionId } }));
  const ids = [receipt.id, ...research.map(record => record.id)];
  expect(new Set(ids).size, "distinct case upsert keys must create three passive records").toBe(3);
  const snapshot = async () => ({
    cases: await Promise.all(ids.map(id => api.get(`/api/cases/${id}`).then(response => json(response)))),
    document: await json(await api.get(documentPath)),
    revisions: await json(await api.get(`${documentPath}/revisions`)),
    task: await json(await api.get(`/api/issues/${task.id}`)),
  });
  const before = await snapshot();
  const persistedFields = before.cases[0].fields;
  expect(persistedFields.items).toEqual(items);
  expect(persistedFields.delivery).toEqual(delivery);
  expect(persistedFields.checks).toEqual(checks);
  const caseWrites: string[] = [];
  page.on("request", request => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method()) && /\/api\/(cases\/|companies\/[^/]+\/case)/.test(request.url())) {
      caseWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
    }
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  // The agentless dashboard offers onboarding. Start on the ordinary task
  // list so this zero-agent fixture can use Cases navigation without setup.
  await page.goto(`/${company.issuePrefix}/issues`);
  await page.getByRole("link", { name: /^Cases\b/ }).first().click();
  const casePage = page.getByTestId("case-pages");
  const list = page.getByRole("region", { name: "Case list", exact: true });
  const choose = async (filter: string, option: string) => {
    if (!await page.getByLabel(`Filter by ${filter}`, { exact: true }).isVisible()) {
      await page.getByRole("button", { name: /^Filter cases/ }).click();
    }
    await page.getByLabel(`Filter by ${filter}`, { exact: true }).click();
    await page.getByRole("option", { name: option, exact: true }).click();
    await expect(page.getByRole("button", { name: `Filter by ${filter}`, exact: true })).toHaveText(option);
    await page.keyboard.press("Escape");
  };
  await expect(list.getByRole("link")).toHaveCount(3);
  await expect(casePage.getByRole("status")).toHaveText("3 cases");
  const controls = page.getByRole("toolbar", { name: "Case controls", exact: true });
  for (const name of ["Columns", "Filter cases", "Sort", "Group"]) {
    await expect(controls.getByRole("button", { name, exact: true })).toBeVisible();
  }
  await expect(controls.getByRole("button", { name: /Kanban|New case|Create case/i })).toHaveCount(0);
  await controls.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Identifier", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(list.getByText(receipt.identifier, { exact: true })).toHaveCount(0);
  await expect(list.getByRole("link", { name: /Pacific receipt/ })).toBeVisible();
  await controls.getByRole("button", { name: "Columns", exact: true }).click();
  await page.getByRole("menuitemcheckbox", { name: "Identifier", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect(list.getByText(receipt.identifier, { exact: true })).toBeVisible();
  await controls.getByRole("button", { name: "Sort", exact: true }).click();
  await page.getByRole("dialog", { name: "Sort cases", exact: true }).getByRole("button", { name: "Title", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.get("sort")).toBe("title");
  await expect.poll(() => new URL(page.url()).searchParams.get("dir")).toBe("asc");
  await expect(list.getByRole("link").first()).toContainText(receipt.title);
  await controls.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("dialog", { name: "Group cases", exact: true }).getByRole("button", { name: "Type", exact: true }).click();
  await page.keyboard.press("Escape");
  await expect.poll(() => new URL(page.url()).searchParams.get("group")).toBe("type");
  await expect(list.getByText("receipt", { exact: true })).toBeVisible();
  await expect(list.getByText("research", { exact: true })).toBeVisible();
  await controls.getByRole("button", { name: "Group", exact: true }).click();
  await page.getByRole("dialog", { name: "Group cases", exact: true }).getByRole("button", { name: "None", exact: true }).click();
  await page.keyboard.press("Escape");
  await choose("project", "No project");
  await expect(list.getByRole("link")).toHaveCount(2);
  await expect(controls.getByRole("button", { name: "Filter cases (1 active)", exact: true })).toBeVisible();
  await expect(list).not.toContainText(receipt.title);
  await choose("status", "Done");
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(list).toContainText("Research done");
  await page.getByRole("button", { name: "Clear filters", exact: true }).click();
  await page.getByRole("button", { name: /^Filter cases/ }).click();
  await page.getByLabel("Filter by type", { exact: true }).click();
  await page.getByRole("option", { name: "receipt", exact: true }).click();
  await page.keyboard.press("Escape");
  // Edit immediately: a pending type navigation must not be replaced by search.
  await page.getByRole("textbox", { name: "Search cases" }).fill("Pacific");
  await expect.poll(() => new URL(page.url()).searchParams.get("type")).toBe("receipt");
  await expect.poll(() => new URL(page.url()).searchParams.get("q")).toBe("Pacific");
  await expect(list.getByRole("link")).toHaveCount(1);
  await expect(casePage.getByRole("status")).toHaveText("1 case");
  const filteredUrl = page.url();
  await testInfo.attach("filtered-cases", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await list.getByRole("link", { name: /Pacific receipt/ }).click();
  await expect(casePage.getByRole("heading", { name: receipt.title, exact: true })).toBeVisible();
  const fields = page.getByRole("region", { name: "Case details", exact: true });
  await expect(fields.getByText("USD", { exact: true })).toBeVisible();
  await expect(fields.getByText("6", { exact: true })).toBeVisible();
  await expect(fields.getByText("Read-only invoice", { exact: true })).toBeVisible();
  const detailTable = fields.getByRole("table", { name: "Case fields", exact: true });
  expect(await detailTable.evaluate(element => getComputedStyle(element).fontFamily)).toContain("mono");
  for (const [key, value] of [
    ["items.description", "Tea"], ["items.quantity", "2"], ["items.unitPrice", "3"],
    ["delivery.method", "email"], ["delivery.recipient.name", "Pacific customer"],
    ["checks[0].phase", "triage"], ["checks[1].phase", "review"],
  ]) {
    const header = detailTable.getByRole("rowheader", { name: key, exact: true });
    await expect(header).toHaveAttribute("scope", "row");
    await expect(header.locator("..").getByRole("cell")).toHaveText(value);
  }
  await expect(detailTable.getByRole("rowheader", { name: /^items\[0\]/ })).toHaveCount(0);
  await expect(fields.locator("pre")).toHaveCount(0);
  const work = page.getByRole("region", { name: "Case work", exact: true });
  await expect(work).toContainText("No task linked");
  const workBounds = await work.boundingBox();
  const detailBounds = await fields.boundingBox();
  expect(workBounds).not.toBeNull();
  expect(detailBounds).not.toBeNull();
  expect(detailBounds!.y).toBeGreaterThanOrEqual(workBounds!.y + workBounds!.height);
  expect(detailBounds!.x).toBeCloseTo(workBounds!.x, 0);
  await expect(casePage.locator("summary").filter({ hasText: /^Activity$/ })).toHaveCount(0);
  await casePage.locator("summary").filter({ hasText: "Related tasks" }).click();
  await expect(casePage.getByText("Receipt reference task", { exact: true })).toBeVisible();
  await expect(casePage.getByRole("button", { name: /^(edit|save|restore|delete|change case status|retry handoff|cancel handoff)\b/i })).toHaveCount(0);
  await expect(casePage.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  const openReceipt = page.getByRole("region", { name: "Case documents", exact: true }).getByRole("button", { name: "Receipt", exact: true });
  await openReceipt.click();
  const dialog = page.getByRole("dialog", { name: "Receipt", exact: true });
  await expect(dialog.getByRole("heading", { name: "Receipt revision two", exact: true })).toBeVisible();
  await expect(dialog.getByRole("link", { name: task.identifier, exact: true })).toHaveAttribute("href", `/${company.issuePrefix}/issues/${task.identifier}#document-receipt`);
  await dialog.locator("summary").filter({ hasText: "Revision history" }).click();
  const history = dialog.locator("details").filter({ hasText: "Revision history" });
  await history.getByRole("button", { name: /^rev 1(?!\d)/ }).click();
  await expect(history.getByRole("heading", { name: "Receipt revision one", exact: true })).toBeVisible();
  await history.getByRole("button", { name: /^rev 2(?!\d)/ }).click();
  await expect(history.getByRole("heading", { name: "Receipt revision two", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: /^(edit|save|restore|delete)\b/i })).toHaveCount(0);
  await expect(dialog.locator('textarea, [contenteditable="true"]')).toHaveCount(0);
  await testInfo.attach("read-only-document-revisions", { body: await page.screenshot(), contentType: "image/png" });
  // The handler's own click moves focus. Keep it out of this focus-restoration
  // assertion, then resume ordinary dismissal before the next navigation.
  await page.removeLocatorHandler(dismissAnnouncement);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(openReceipt).toBeFocused();
  await page.addLocatorHandler(dismissAnnouncement, dismissAnnouncements);
  const auditLink = casePage.getByRole("link", { name: "View in Audit", exact: true });
  await expect(auditLink).toHaveAttribute("href", `/${company.issuePrefix}/activity?entityType=case&entityId=${receipt.id}`);
  await auditLink.click();
  await expect(page).toHaveURL(new RegExp(`/activity\\?entityType=case&entityId=${receipt.id}$`));
  await expect(page.getByRole("link", { name: `${receipt.identifier} · ${receipt.title}`, exact: true }).first()).toBeVisible();
  const audit = page.getByRole("list", { name: "Audit activity", exact: true });
  // The passive creation predates the shared audit entrypoint; its retained
  // case event must remain discoverable there, without a duplicate log row.
  const created = audit.getByRole("listitem").filter({ hasText: "case.created" });
  await expect(created).toHaveCount(1);
  await expect(created.getByRole("link", { name: `${receipt.identifier} · ${receipt.title}`, exact: true })).toHaveAttribute(
    "href", `/${company.issuePrefix}/cases/${receipt.identifier}`,
  );
  await page.getByRole("combobox", { name: "Action", exact: true }).click();
  await page.getByRole("option", { name: "Cases", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`entityId=${receipt.id}&action=case\\.$`));
  await expect(created).toHaveCount(1);
  await testInfo.attach("case-history-in-audit", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });
  await page.goBack();
  await expect(casePage.getByRole("heading", { name: receipt.title, exact: true })).toBeVisible();
  await page.getByRole("navigation", { name: "breadcrumb", exact: true }).getByRole("link", { name: "Cases", exact: true }).click();
  await expect(page).toHaveURL(filteredUrl);
  await page.reload();
  await expect(page.getByRole("textbox", { name: "Search cases" })).toHaveValue("Pacific");
  await page.getByRole("button", { name: /^Filter cases/ }).click();
  await expect(page.getByLabel("Filter by type", { exact: true })).toHaveText("receipt");
  await page.keyboard.press("Escape");
  await expect(list.getByRole("link")).toHaveCount(1);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(list.getByRole("link", { name: /Pacific receipt/ })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await list.getByRole("link", { name: /Pacific receipt/ }).click();
  await expect(casePage.getByRole("heading", { name: receipt.title, exact: true })).toBeVisible();
  await expect(detailTable.getByRole("rowheader", { name: "items.quantity", exact: true })).toBeVisible();
  await expect(detailTable.getByRole("rowheader", { name: "delivery.recipient.name", exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);
  await testInfo.attach("mobile-read-only-case", { body: await page.screenshot({ fullPage: true }), contentType: "image/png" });

  const after = await snapshot();
  const agents = await json<unknown[]>(await api.get(`${companyPath}/agents`));
  const runs = await json<unknown[]>(await api.get(`${companyPath}/heartbeat-runs?limit=20`));
  expect(after).toEqual(before);
  expect(after.cases.map(record => record.workIssueId)).toEqual([null, null, null]);
  expect(after.revisions.map((revision: { revisionNumber: number }) => revision.revisionNumber)).toEqual([2, 1]);
  expect(agents).toEqual([]);
  expect(runs).toEqual([]);
  expect(caseWrites).toEqual([]);
  await testInfo.attach("read-only-persistence-proof", { body: Buffer.from(JSON.stringify({ companyId: company.id, before, after, agents, runs, caseWrites }, null, 2)), contentType: "application/json" });
});
