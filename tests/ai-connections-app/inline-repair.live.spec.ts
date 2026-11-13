import { test, expect } from "@playwright/test";

// Explicitly opt in with a disposable task/account and a real provider key.
// All writes use the UI. API reads only verify identity and execution outcomes.
const disposableMarker = process.env.AI_REPAIR_TEST_DISPOSABLE_MARKER;
const destructiveOptIn = process.env.AI_REPAIR_TEST_ALLOW_DESTRUCTIVE === "1";
const companyId = process.env.AI_CONNECTIONS_TEST_COMPANY_ID;
const issueId = process.env.AI_REPAIR_TEST_ISSUE_ID;
const connectionId = process.env.AI_REPAIR_TEST_CONNECTION_ID;
const providerKey = process.env.AI_REPAIR_TEST_KEY;
test.use({ trace: "off", video: "off" });
test.skip(!destructiveOptIn || !disposableMarker || !companyId || !issueId || !connectionId || !providerKey, "Live repair requires explicit disposable fixtures and a provider key");

test("repair the selected AI account inside the task and continue without another message", async ({ page, request }, testInfo) => {
  test.setTimeout(240_000);
  if (process.env.AI_REPAIR_TEST_NARROW === "1") await page.setViewportSize({ width: 390, height: 844 });
  // Fail before any mutation unless every target belongs to the same explicitly
  // marked disposable fixture. Never run this scenario against a remote host.
  const origin = new URL(testInfo.project.use.baseURL!);
  expect(origin.protocol).toBe("http:");
  expect(["127.0.0.1", "[::1]"]).toContain(origin.hostname);
  expect(disposableMarker).toMatch(/^[a-f0-9]{32}$/);
  const fixtureName = `AI Repair QA ${disposableMarker}`;
  const health = await (await request.get("/api/health")).json();
  expect(health.deploymentMode).toBe("local_trusted");
  const companies = await (await request.get("/api/companies")).json();
  const company = companies.find((company: { id: string }) => company.id === companyId);
  expect(company).toMatchObject({ id: companyId, name: fixtureName });
  const prefix = company.issuePrefix;
  const taskBefore = await (await request.get(`/api/issues/${issueId}`)).json();
  const agentBefore = await (await request.get(`/api/agents/${taskBefore.assigneeAgentId}`)).json();
  expect(taskBefore).toMatchObject({ companyId, title: fixtureName });
  expect(agentBefore).toMatchObject({ companyId, name: fixtureName, adapterType: "codex_local" });
  const agents = await (await request.get(`/api/companies/${companyId}/agents`)).json();
  expect(agents.map((agent: { id: string }) => agent.id)).toEqual([agentBefore.id]);
  const list = async () => (await (await request.get(`/api/companies/${companyId}/ai-connections`)).json()).connections;
  const before = await list();
  const accountBefore = before.find((connection: { id: string }) => connection.id === connectionId);
  expect(before).toHaveLength(1);
  expect(accountBefore).toMatchObject({ companyId, name: fixtureName, provider: "openai", method: "api_key", ownership: "personal" });
  expect(accountBefore.isDefault).toBe(true);
  expect(["connected", "revoked"]).toContain(accountBefore.status);

  await page.goto(`/${prefix}/apps/${connectionId}/permissions`);
  if (accountBefore.status === "connected") {
  await page.getByRole("button", { name: "Revoke identity", exact: true }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Revoke identity", exact: true }).click();
  }
  await expect(page.locator("header").getByText("Revoked", { exact: true })).toBeVisible();
  await page.goto(`/${prefix}/issues/${issueId}`);
  let proof = `QA-IN-CARD-REPAIR-${Date.now()}: 1147`;
  const pending = (await (await request.get(`/api/issues/${issueId}/interactions`)).json()).some((interaction: {kind: string; status: string; payload: {purpose?: string}}) => interaction.kind === "connection_intent" && interaction.status === "pending" && interaction.payload.purpose === "ai");
  if (pending) {
    const comments = await (await request.get(`/api/issues/${issueId}/comments`)).json();
    proof = comments.map((comment: {body: string}) => comment.body.match(/QA-IN-CARD-REPAIR-\d+: 1147/)?.[0]).filter(Boolean).at(-1);
    expect(proof).toBeTruthy();
  } else {
  await page.getByRole("textbox", { name: "editable markdown" }).fill(`Inline repair acceptance: calculate 31 * 37. Post exactly ${proof}, then mark Done. This first attempt should block on my revoked default; I will reconnect it inside this task. Do not change configuration, create subtasks, or modify files.`);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  }
  const fix = page.getByRole("button", { name: "Fix connection", exact: true });
  await expect(fix).toBeVisible({ timeout: 60_000 });
  await fix.click();
  const inline = page.getByTestId("ai-connection-inline-repair");
  await expect(inline.getByLabel("Connection name")).toHaveValue(accountBefore.name);
  await expect(inline.getByLabel("Connection name")).toBeDisabled();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await inline.getByRole("button", { name: /^(Back|Cancel)$/ }).click();
  await expect(page.getByTestId("ai-connection-inline-repair")).toHaveCount(0);
  await expect(page.getByTestId("connection-intent-focus-target").filter({ has: fix })).toBeFocused();
  await fix.click();
  await inline.getByRole("radio", { name: "OpenAI API", exact: true }).click();
  const keyField = inline.getByPlaceholder("Enter API key here");
  await expect(keyField).toBeVisible();
  await inline.screenshot({ path: testInfo.outputPath("inline-repair-before.png") });
  // Never include credentials in a failed action's error/trace output.
  try { await keyField.fill(providerKey!); } catch { throw new Error("Could not fill the private credential field"); }
  await inline.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(page.getByTestId("ai-connection-inline-repair")).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByText(proof, { exact: true })).toBeVisible({ timeout: 120_000 });
  await expect.poll(async () => (await (await request.get(`/api/issues/${issueId}`)).json()).status).toBe("done");
  const after = await list();
  expect(after).toHaveLength(before.length);
  expect(after.find((connection: { id: string }) => connection.id === connectionId)).toMatchObject({ id: connectionId, grantId: accountBefore.grantId, isDefault: true, status: "connected" });
  const agentAfter = await (await request.get(`/api/agents/${taskBefore.assigneeAgentId}`)).json();
  expect(agentAfter.adapterType).toBe(agentBefore.adapterType);
  expect(agentAfter.adapterConfig).toEqual(agentBefore.adapterConfig);
  expect(agentAfter.runtimeConfig).toEqual(agentBefore.runtimeConfig);
  await page.screenshot({ path: testInfo.outputPath("inline-repair-completed.png"), fullPage: true });
});
