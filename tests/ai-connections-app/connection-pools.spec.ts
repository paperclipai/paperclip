import { expect, test, type APIRequestContext } from "@playwright/test";
import type { AiConnectionList, AiConnectionPool, AppDefinition } from "@paperclipai/shared";

// Exercise the full shipped app and an installed router, with real persistence.
// No browser routes, credentials, providers, or pool APIs are mocked. Opt in
// only against a loopback test-drive company with existing saved accounts.
const companyId = process.env.AI_CONNECTIONS_TEST_COMPANY_ID;
test.skip(process.env.PAPERCLIP_CONNECTION_POOL_E2E !== "1" || !companyId, "Opt in with an isolated connection-pool test drive");
let prefix: string;
let connector: AppDefinition;
let accounts: AiConnectionList["connections"];
const poolsPath = `/api/companies/${companyId}/ai-connection-pools`;
async function listPools(request: APIRequestContext): Promise<AiConnectionPool[]> {
  const response = await request.get(poolsPath);
  expect(response.ok()).toBe(true);
  return response.json();
}

test.beforeAll(async ({ request }, testInfo) => {
  const origin = new URL(testInfo.project.use.baseURL!);
  expect(origin.protocol).toBe("http:");
  expect(["127.0.0.1", "[::1]"]).toContain(origin.hostname);
  const health = await (await request.get("/api/health")).json();
  expect(health).toMatchObject({ status: "ok", bootstrapStatus: "ready", deploymentMode: "local_trusted" });
  const company = await (await request.get(`/api/companies/${companyId}`)).json();
  expect(company.name).toMatch(/test drive|e2e/i);
  prefix = company.issuePrefix;
  const gallery = await (await request.get(`/api/companies/${companyId}/tools/gallery`)).json();
  connector = gallery.apps.find((app: AppDefinition) => app.aiConnectionRouter && app.availability?.available);
  expect(connector, "Install and enable a router plugin, then opt in to the instance flag").toBeTruthy();
  const list: AiConnectionList = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
  expect(list.canManageConnections).toBe(true);
  accounts = list.connections.filter((account, index, all) => account.status === "connected" && all.findIndex(candidate => candidate.id === account.id) === index).slice(0, 2);
  expect(accounts, "Use two pre-existing authorized accounts").toHaveLength(2);
});

test("operator-enabled routing has no experimental settings control", async ({ page, request }) => {
  const response = await request.get("/api/instance/settings/experimental");
  expect(response.ok()).toBe(true);
  expect(await response.json()).toMatchObject({ enableAiConnectionRouters: true });
  await page.goto(`/${prefix}/company/settings/instance/experimental`);
  await expect(page.getByRole("heading", { name: "Experimental", exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Experimental features", exact: true })).toBeVisible();
  await expect(page.getByText("AI connection routers", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("switch", { name: "Toggle AI connection routers experimental setting", exact: true })).toHaveCount(0);
});

test("native catalog setup, account edits, conflicts and removal persist through the full app", async ({ page, request }) => {
  test.setTimeout(90_000);
  const originalPools = await listPools(request);
  const originalAccountIds = (await (await request.get(`/api/companies/${companyId}/ai-connections`)).json()).connections.map((account: { id: string }) => account.id).sort();
  let poolId: string | undefined;
  try {
    await page.goto(`/${prefix}/dashboard`);
    await page.getByRole("link", { name: "Connectors", exact: true }).click();
    await page.getByRole("button", { name: `Add connection pool ${connector.name}`, exact: true }).click();
    await expect(page.getByRole("heading", { name: "Add a connection pool", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Continue", exact: true })).toBeDisabled();
    await expect(page.getByRole("link", { name: "Connect a new account", exact: true })).toHaveAttribute("target", "_blank");
    for (const account of accounts) await page.getByRole("checkbox", { name: account.name, exact: true }).check();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await page.getByRole("button", { name: `Move ${accounts[1]!.name} up`, exact: true }).click();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    for (const account of accounts) await expect(page.getByRole("checkbox", { name: account.name, exact: true })).toBeChecked();
    await page.getByRole("button", { name: "Continue", exact: true }).click();
    await expect(page.getByRole("list", { name: "Connection order" }).getByRole("listitem").first()).toContainText(accounts[1]!.name);
    await page.getByRole("button", { name: "Create pool", exact: true }).click();
    await expect(page).toHaveURL(/\/apps\/[a-f0-9-]+\/permissions$/);
    poolId = new URL(page.url()).pathname.split("/").at(-2)!;
    const saved = async () => (await listPools(request)).find(pool => pool.id === poolId)!;
    expect(await saved()).toMatchObject({ enabled: false, mode: "round_robin", thresholdPercent: 90 });
    expect((await saved()).members.map(member => member.binding.connectionId)).toEqual([accounts[1]!.id, accounts[0]!.id]);
    await expect(page.getByRole("link", { name: "Settings", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "Review", exact: true })).toHaveCount(0);
    await expect(page.getByRole("checkbox", { name: "Enable this pool", exact: true })).not.toBeChecked();
    await expect(page.getByRole("region", { name: "Used by", exact: true })).toContainText("No agents yet.");

    const name = `Pool E2E ${Date.now()}`;
    await page.getByRole("button", { name: "Rename app", exact: true }).click();
    await page.getByRole("textbox", { name: "App name", exact: true }).fill(name);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await page.getByRole("button", { name: `Remove ${accounts[0]!.name}`, exact: true }).click();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(async () => (await saved()).members.length).toBe(1);
    await page.reload();
    await expect(page.getByRole("list", { name: "Connection order" }).getByRole("listitem")).toHaveCount(1);
    await page.getByRole("button", { name: "Add connections", exact: true }).click();
    const picker = page.getByRole("dialog", { name: "Add connections", exact: true });
    await picker.getByRole("checkbox", { name: accounts[0]!.name, exact: true }).check();
    await picker.getByRole("button", { name: "Done", exact: true }).click();
    await page.getByRole("checkbox", { name: "Enable this pool", exact: true }).check();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(async () => (await saved()).enabled).toBe(true);
    await page.reload();
    await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
    await expect(page.getByRole("checkbox", { name: "Enable this pool", exact: true })).toBeChecked();
    await expect(page.getByRole("list", { name: "Connection order" }).getByRole("listitem")).toHaveCount(2);

    // Two real pages keep their reviewed revisions. A stale save must not
    // overwrite a newer edit, and refreshing must recover the latest version.
    const other = await page.context().newPage();
    await other.goto(page.url());
    await expect(other.getByRole("heading", { name, level: 1 })).toBeVisible();
    await page.getByRole("checkbox", { name: "Enable this pool", exact: true }).uncheck();
    await page.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect.poll(async () => (await saved()).enabled).toBe(false);
    await other.getByRole("button", { name: "Save changes", exact: true }).click();
    await expect(other.getByRole("alert")).toContainText(/changed|reload/i);
    expect((await saved()).enabled).toBe(false);
    await other.close();

    await page.getByRole("button", { name: "Manage connection pool", exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove connection", exact: true }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation).toContainText("The connections in this pool are kept.");
    await confirmation.getByRole("button", { name: "Cancel", exact: true }).click();
    expect(await saved()).toBeTruthy();
    await page.getByRole("link", { name: "All connectors", exact: true }).click();
    await page.getByRole("button", { name: `Manage ${name} connection`, exact: true }).click();
    await page.getByRole("menuitem", { name: "Remove connection", exact: true }).click();
    await page.getByRole("alertdialog").getByRole("button", { name: "Remove connection", exact: true }).click();
    await expect(page.getByRole("alertdialog")).toHaveCount(0);
    await expect.poll(async () => (await listPools(request)).map(pool => pool.id).sort()).toEqual(originalPools.map(pool => pool.id).sort());
    await expect(page.getByRole("button", { name: `Open ${name} permissions`, exact: true })).toHaveCount(0);
    const remaining = await (await request.get(`/api/companies/${companyId}/ai-connections`)).json();
    expect(remaining.connections.map((account: { id: string }) => account.id).sort()).toEqual(originalAccountIds);
  } finally {
    // Cleanup only this test's own disposable pool, through the normal API.
    if (poolId) {
      const pool = (await listPools(request)).find(pool => pool.id === poolId);
      if (pool) expect((await request.delete(`${poolsPath}/${poolId}`, { data: { expectedRevision: pool.revision } })).ok()).toBe(true);
    }
  }
});

test("an unavailable dynamic router stays on an actionable setup page", async ({ page }) => {
  await page.goto(`/${prefix}/apps/connect?${new URLSearchParams({ source: "ai-router-0000" })}`);
  await expect(page.getByRole("alert")).toContainText("This connection pool plugin is unavailable. Enable it in Plugins.");
  await expect(page).toHaveURL(/\/apps\/connect\?/);
});

test("a saved pool shows its configured agents with avatars and profile links", async ({ page, request }) => {
  const pools = await listPools(request);
  const response = await request.get(`/api/companies/${companyId}/agents`);
  expect(response.ok()).toBe(true);
  const agents = await response.json() as Array<{ id: string; name: string; status: string; runtimeConfig: { aiConnection?: { mode: string; connectionId?: string } } }>;
  const pool = pools.find(candidate => agents.some(agent => agent.status !== "terminated" && agent.runtimeConfig.aiConnection?.mode === "router" && agent.runtimeConfig.aiConnection.connectionId === candidate.id));
  test.skip(!pool, "Bind a test agent to a saved pool to verify populated usage");
  const expected = agents.filter(agent => agent.status !== "terminated" && agent.runtimeConfig.aiConnection?.mode === "router" && agent.runtimeConfig.aiConnection.connectionId === pool!.id).sort((a, b) => a.name.localeCompare(b.name));
  await page.goto(`/${prefix}/apps/${pool!.id}/permissions`);
  const usedBy = page.getByRole("region", { name: "Used by", exact: true });
  await expect(usedBy.getByRole("link")).toHaveCount(expected.length);
  for (const agent of expected) {
    const link = usedBy.getByRole("link", { name: agent.name, exact: true });
    await expect(link).toHaveAttribute("href", `/${prefix}/agents/${agent.id}`);
    await expect(link.locator('[data-slot="agent-avatar"]')).toBeVisible();
  }
});
