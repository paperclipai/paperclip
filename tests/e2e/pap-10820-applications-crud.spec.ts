import { expect, test, type APIRequestContext, type Page } from "@playwright/test";

// PAP-10820 — QA harness for application edit, status lifecycle, and delete
// covering Phases 2/3/4 of the [PAP-10805] applications page work. The spec
// boots the shared local_trusted Playwright webServer (see playwright.config),
// seeds applications and connections through the board API, then drives the
// Tools → Applications UI for each action and captures screenshots.

type SeedResult = {
  companyId: string;
  prefix: string;
};

const SCREENSHOT_DIR = "test-results";
const APP_PREFIX = `qa10820-${Date.now().toString(36)}`;

async function discoverCompany(request: APIRequestContext): Promise<SeedResult> {
  const res = await request.post("/api/companies", {
    data: { name: `PAP-10820 applications CRUD ${Date.now()}` },
  });
  expect(res.ok(), `create company failed ${res.status()}: ${await res.text()}`).toBe(true);
  const company = await res.json();
  expect(company?.id, "expected created company id").toBeTruthy();
  return {
    companyId: company.id,
    prefix: company.issuePrefix ?? company.prefix ?? company.urlKey ?? "E2E",
  };
}

async function createApplication(
  request: APIRequestContext,
  companyId: string,
  body: { name: string; description?: string; type?: string },
): Promise<{ id: string; name: string }> {
  const res = await request.post(`/api/companies/${companyId}/tools/applications`, {
    data: { type: "mcp_http", ...body },
  });
  if (!res.ok()) throw new Error(`create app failed ${res.status()}: ${await res.text()}`);
  return res.json();
}

async function createConnection(
  request: APIRequestContext,
  companyId: string,
  data: { applicationName?: string; applicationId?: string; name: string; transport?: string; config?: object },
): Promise<{ id: string; applicationId: string }> {
  const res = await request.post(`/api/companies/${companyId}/tools/connections`, {
    data: {
      transport: "remote_http",
      config: { url: "https://fixture.example/mcp" },
      enabled: true,
      status: "active",
      ...data,
    },
  });
  if (!res.ok()) throw new Error(`create connection failed ${res.status()}: ${await res.text()}`);
  return res.json();
}

async function gotoApplications(page: Page, prefix: string) {
  await page.goto(`/${prefix}/tools/applications`);
}

async function expandApplicationRow(page: Page, name: string) {
  // The row uses `Expand <name>` / `Collapse <name>` accessible labels so we
  // wait for the toggle and only click when collapsed.
  const expand = page.getByRole("button", { name: new RegExp(`^Expand ${name}$`) });
  if (await expand.isVisible().catch(() => false)) {
    await expand.click();
  }
}

test.describe.serial("PAP-10820 applications CRUD", () => {
  let seed: SeedResult;

  test.beforeAll(async ({ request }) => {
    seed = await discoverCompany(request);
  });

  test.afterAll(async ({ request }) => {
    if (!seed?.companyId) return;
    await request.delete(`/api/companies/${seed.companyId}`).catch(() => undefined);
  });

  test("Phase 2: edit + duplicate-name conflict", async ({ page, request }) => {
    const first = `${APP_PREFIX}-edit-original`;
    const second = `${APP_PREFIX}-edit-conflict`;
    const renamed = `${APP_PREFIX}-edit-renamed`;
    const description = "Updated description for PAP-10820 QA";

    await createApplication(request, seed.companyId, { name: first, description: "Initial description" });
    await createApplication(request, seed.companyId, { name: second });

    await gotoApplications(page, seed.prefix);
    await page.getByPlaceholder("Search applications…").fill(APP_PREFIX);
    await expect(page.getByText(first, { exact: true })).toBeVisible({ timeout: 15_000 });

    // Open edit dialog
    await page.getByRole("button", { name: `Actions for ${first}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();

    const editDialog = page.getByRole("dialog");
    await expect(editDialog.getByRole("heading", { name: "Edit application" })).toBeVisible();
    await editDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-edit-dialog-open.png` });

    // Rename + new description
    const nameInput = editDialog.getByLabel("Name");
    await nameInput.fill(renamed);
    await editDialog.getByLabel("Description").fill(description);
    await editDialog.getByRole("button", { name: "Save changes" }).click();

    // Dialog closes; table reflects the new values
    await expect(editDialog).toBeHidden({ timeout: 10_000 });
    await page.getByPlaceholder("Search applications…").fill(renamed);
    await expect(page.getByText(renamed, { exact: true })).toBeVisible();
    await expect(page.getByText(description, { exact: false })).toBeVisible();

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-edit-saved-table.png`, fullPage: true });

    // Now attempt to rename the renamed app to the existing `second` — should
    // show the friendly conflict error (no crash, no 500, dialog stays open).
    await page.getByRole("button", { name: `Actions for ${renamed}` }).click();
    await page.getByRole("menuitem", { name: "Edit" }).click();
    const conflictDialog = page.getByRole("dialog");
    await conflictDialog.getByLabel("Name").fill(second);
    await conflictDialog.getByRole("button", { name: "Save changes" }).click();

    await expect(
      conflictDialog.getByText("Another application already uses that name."),
    ).toBeVisible({ timeout: 10_000 });
    await expect(conflictDialog).toBeVisible();
    await conflictDialog.screenshot({
      path: `${SCREENSHOT_DIR}/pap-10820-edit-duplicate-conflict.png`,
    });

    await page.keyboard.press("Escape");
  });

  test("Phase 3: status lifecycle + disabled-app denial", async ({ page, request }) => {
    const appName = `${APP_PREFIX}-lifecycle-app`;
    const connName = `${APP_PREFIX}-lifecycle-conn`;
    const connection = await createConnection(request, seed.companyId, {
      applicationName: appName,
      name: connName,
    });
    const applicationId = connection.applicationId;

    await gotoApplications(page, seed.prefix);
    await page.getByPlaceholder("Search applications…").fill(APP_PREFIX);
    await expect(page.getByText(appName, { exact: true })).toBeVisible({ timeout: 15_000 });

    // --- Disable flow with impact summary
    await page.getByRole("button", { name: `Actions for ${appName}` }).click();
    await page.getByRole("menuitem", { name: "Disable" }).click();

    const disableDialog = page.getByRole("dialog");
    await expect(disableDialog.getByRole("heading", { name: "Disable application" })).toBeVisible();
    await expect(disableDialog.getByText("Impact summary")).toBeVisible();
    // Should show 1 connection affected.
    await expect(disableDialog.getByText(/^1$/)).toBeVisible();
    await disableDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-disable-impact-dialog.png` });
    await disableDialog.getByRole("button", { name: "Disable application" }).click();

    await expect(disableDialog).toBeHidden({ timeout: 10_000 });
    // Force the badge filter to "all visibility" so disabled apps stay visible.
    // (default is __all so it's already visible). Wait for the status badge.
    await expect(
      page.getByRole("row", { name: new RegExp(appName) }).getByText("disabled", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // --- Policy test: a tool call through the connection of a disabled app
    // must be denied with `deny_disabled_application`.
    const policyRes = await request.post(`/api/companies/${seed.companyId}/tools/policy/test`, {
      data: {
        companyId: seed.companyId,
        actor: { actorType: "user", actorId: "qa-bot" },
        request: {
          connectionId: connection.id,
          toolName: "noop",
          arguments: {},
        },
      },
    });
    expect(policyRes.ok(), `policy test failed ${policyRes.status()}: ${await policyRes.text()}`).toBe(true);
    const policy = await policyRes.json();
    expect(policy.decision.decision).toBe("deny");
    expect(policy.decision.allowed).toBe(false);
    expect(policy.decision.reasonCode).toBe("deny_disabled_application");

    // --- Reactivate from row menu
    await page.getByRole("button", { name: `Actions for ${appName}` }).click();
    await page.getByRole("menuitem", { name: "Reactivate" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(appName) }).getByText("active", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // --- Policy test: now the disabled denial is gone. We expect either an
    // explicit allow or a non-disabled deny (catalog/profile gating). We
    // assert only the absence of the `deny_disabled_application` reason.
    const recheckRes = await request.post(`/api/companies/${seed.companyId}/tools/policy/test`, {
      data: {
        companyId: seed.companyId,
        actor: { actorType: "user", actorId: "qa-bot" },
        request: {
          connectionId: connection.id,
          toolName: "noop",
          arguments: {},
        },
      },
    });
    expect(recheckRes.ok()).toBe(true);
    const recheck = await recheckRes.json();
    expect(recheck.decision.reasonCode).not.toBe("deny_disabled_application");

    // --- Archive flow: destructive variant of the impact dialog
    await page.getByRole("button", { name: `Actions for ${appName}` }).click();
    await page.getByRole("menuitem", { name: "Archive" }).click();
    const archiveDialog = page.getByRole("dialog");
    await expect(archiveDialog.getByRole("heading", { name: "Archive application" })).toBeVisible();
    await expect(archiveDialog.getByText("Impact summary")).toBeVisible();
    await archiveDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-archive-impact-dialog.png` });
    await archiveDialog.getByRole("button", { name: "Archive application" }).click();
    await expect(archiveDialog).toBeHidden({ timeout: 10_000 });

    // Visibility filter excludes archived by default for "active" but with
    // __all and "hidden" includes archived; we use __all which is the default.
    await expect(
      page.getByRole("row", { name: new RegExp(appName) }).getByText("archived", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    // Reactivate the archived app
    await page.getByRole("button", { name: `Actions for ${appName}` }).click();
    await page.getByRole("menuitem", { name: "Reactivate" }).click();
    await expect(
      page.getByRole("row", { name: new RegExp(appName) }).getByText("active", { exact: true }),
    ).toBeVisible({ timeout: 10_000 });

    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-lifecycle-reactivated.png`, fullPage: true });
  });

  test("Phase 4: delete guard + clean delete", async ({ page, request }) => {
    const guardedAppName = `${APP_PREFIX}-guarded-delete-app`;
    const cleanAppName = `${APP_PREFIX}-clean-delete-app`;

    // Guarded: app with a connection
    const guardedConn = await createConnection(request, seed.companyId, {
      applicationName: guardedAppName,
      name: `${APP_PREFIX}-guarded-delete-conn`,
    });
    const guardedAppId = guardedConn.applicationId;

    // Clean: app without connections
    const cleanApp = await createApplication(request, seed.companyId, { name: cleanAppName });

    await gotoApplications(page, seed.prefix);
    await page.getByPlaceholder("Search applications…").fill(APP_PREFIX);
    await expect(page.getByText(guardedAppName, { exact: true })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(cleanAppName, { exact: true })).toBeVisible();

    // --- Guarded delete: pre-confirm copy
    await page.getByRole("button", { name: `Actions for ${guardedAppName}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const guardedDialog = page.getByRole("dialog");
    await expect(guardedDialog.getByText("delete is blocked while connections exist")).toBeVisible();
    await guardedDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-delete-blocked-precheck.png` });

    // Attempt the delete anyway — server returns 409 and the same dialog
    // surfaces the error inline.
    await guardedDialog.getByRole("button", { name: "Delete application" }).click();
    await expect(
      guardedDialog.getByText(/connection/i).first(),
    ).toBeVisible({ timeout: 10_000 });
    await guardedDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-delete-409-inline.png` });

    // Confirm the application still exists.
    const stillThere = await request.get(`/api/companies/${seed.companyId}/tools/applications`);
    expect(stillThere.ok()).toBe(true);
    const stillBody = await stillThere.json();
    expect(stillBody.applications.some((a: { id: string }) => a.id === guardedAppId)).toBe(true);
    await page.keyboard.press("Escape");

    // --- Clean delete: safe-delete copy then row disappears.
    await page.getByRole("button", { name: `Actions for ${cleanAppName}` }).click();
    await page.getByRole("menuitem", { name: "Delete" }).click();
    const cleanDialog = page.getByRole("dialog");
    await expect(cleanDialog.getByText("No connections are attached")).toBeVisible();
    await cleanDialog.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-delete-clean-precheck.png` });
    await cleanDialog.getByRole("button", { name: "Delete application" }).click();
    await expect(cleanDialog).toBeHidden({ timeout: 10_000 });

    // The row should be gone from the table.
    await expect(page.getByText(cleanAppName, { exact: true })).toBeHidden({ timeout: 10_000 });
    await page.screenshot({ path: `${SCREENSHOT_DIR}/pap-10820-delete-clean-after.png`, fullPage: true });

    // Verify via API that the application is gone.
    const after = await request.get(`/api/companies/${seed.companyId}/tools/applications`);
    expect(after.ok()).toBe(true);
    const afterBody = await after.json();
    expect(afterBody.applications.some((a: { id: string }) => a.id === cleanApp.id)).toBe(false);
  });
});
