import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test.use({ trace: "retain-on-failure" });

test("financial entry reaches the server and invoice replay does not duplicate charges", async ({ page, request }, info) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Finance entry ${Date.now()}` } }));
  const api = `/api/companies/${company.id}`;
  try {
    await page.goto(`/${company.issuePrefix}/activity/costs`);
    await page.getByRole("button", { name: "Record or import charges" }).first().click();
    const dialog = page.getByRole("dialog");
    await dialog.getByLabel("Provider or biller").fill("anthropic");
    await dialog.getByLabel("Amount (USD)").fill("20.123456789");
    await dialog.getByLabel("Description").fill("Browser subscription");
    await info.attach("finance-entry-form", { body: await page.screenshot(), contentType: "image/png" });
    const saved = page.waitForResponse(response => response.url().endsWith("/finance-events") && response.request().method() === "POST");
    await dialog.getByRole("button", { name: "Record charge", exact: true }).last().click();
    expect((await saved).status()).toBe(201);
    await expect(page.getByText("Browser subscription", { exact: true })).toBeVisible();
    const invoice = { biller: "openai", externalId: "browser-finance-invoice", currency: "USD", lines: [{ externalId: "fee", kind: "fee", amountCents: "100", occurredAt: new Date().toISOString() }] };
    await json(await request.post(`${api}/accounting/invoices`, { data: invoice }));
    await json(await request.post(`${api}/accounting/invoices`, { data: invoice }));
    const rows = await json(await request.get(`${api}/costs/finance-events`));
    expect(rows).toHaveLength(2);
    expect(rows.find((row: { description: string }) => row.description === "Browser subscription").amountCentsExact).toBe("2012.3456789");
    expect((await json(await request.get(`${api}/costs/summary`))).spendCents).toBe(0);
    await info.attach("finance-entry", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await request.delete(api);
  }
});

test("real runs reach the ledger, stop at budget, and resume after a UI grant", async ({ page, request }, info) => {
  test.setTimeout(150_000);
  const root = await mkdtemp(path.join(os.tmpdir(), "accounting-browser-"));
  const command = path.join(root, "accounting-provider.mjs");
  const calls = path.join(root, "calls");
  // Exercise the production Claude adapter and heartbeat lifecycle without
  // credentials, network calls, provider variability, or paid inference.
  await writeFile(command, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
if (process.argv.includes('--version')) { console.log('2.1.0'); process.exit(0); }
for await (const chunk of process.stdin) {}
appendFileSync(${JSON.stringify(calls)}, 'run\\n');
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false,
  result: 'Accounting fixture completed.', total_cost_usd: 0.015,
  usage: { input_tokens: 7, cache_read_input_tokens: 11, output_tokens: 3 } }));
`, { mode: 0o755 });
  const company = await json(await request.post("/api/companies", { data: { name: `Accounting browser ${Date.now()}` } }));
  const companyApi = `/api/companies/${company.id}`;
  try {
    const agent = await json(await request.post(`${companyApi}/agents`, { data: {
      name: "Accounting fixture", role: "engineer", adapterType: "claude_local",
      adapterConfig: { engine: "cli", cwd: root, command, model: "claude-sonnet-4-6", env: { ANTHROPIC_API_KEY: "accounting-fixture-no-network" } },
      runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: true } },
    } }));
    await json(await request.post(`${companyApi}/budgets/policies`, { data: {
      scopeType: "agent", scopeId: agent.id, amount: 2, notifyEnabled: false,
    } }));
    const summary = async () => json(await request.get(`${companyApi}/costs/summary`));
    const callCount = async () => (await readFile(calls, "utf8").catch(() => "")).trim().split("\n").filter(Boolean).length;
    async function runFromBrowser(expectedCents: number) {
      await page.goto(`/${company.issuePrefix}/agents/${agent.id}`);
      const invoked = page.waitForResponse(response => response.url().includes("/heartbeat/invoke") && response.request().method() === "POST");
      await page.getByRole("button", { name: "Run now", exact: true }).click();
      const response = await invoked;
      expect(response.ok(), await response.text()).toBe(true);
      const run = await response.json();
      expect(run.id).toBeTruthy();
      await expect.poll(async () => (await json(await request.get(`/api/heartbeat-runs/${run.id}`))).status,
        { timeout: 40_000 }).toBe("succeeded");
      await expect.poll(async () => (await summary()).spendCents).toBe(expectedCents);
      return run.id as string;
    }
    const first = await runFromBrowser(1.5);
    const second = await runFromBrowser(3);
    expect(first).not.toBe(second);
    await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).status).toBe("paused");
    expect(await callCount()).toBe(2);

    // A manual board wake must respect the same stop as background scheduling.
    const blocked = await request.post(`/api/agents/${agent.id}/heartbeat/invoke`, { data: {} });
    expect(blocked.status()).toBe(409);
    const blockedBody = await blocked.json();
    expect(blockedBody.id).toBeUndefined();
    expect(blockedBody.error).toMatch(/budget|paused/i);
    expect(await callCount()).toBe(2);

    await page.goto(`/${company.issuePrefix}/costs`);
    await expect(page.getByText("Spending reached $0.03 against a limit of $0.02.", { exact: true })).toBeVisible();
    const ledger = page.locator('[data-slot="card"]').filter({ has: page.getByText("Inference ledger", { exact: true }) });
    await expect(ledger.getByText("$0.03", { exact: true })).toBeVisible();
    await info.attach("budget-stopped", { body: await page.screenshot(), contentType: "image/png" });
    const incident = page.locator('[data-slot="card"]').filter({ has: page.getByRole("button", { name: "Raise budget & resume", exact: true }) });
    await incident.getByPlaceholder("0.00").fill("0.10");
    const resolved = page.waitForResponse(response => response.url().includes("/budget-incidents/") && response.url().endsWith("/resolve"));
    await incident.getByRole("button", { name: "Raise budget & resume", exact: true }).click();
    expect((await resolved).ok()).toBe(true);
    await expect(page.getByRole("button", { name: "Raise budget & resume", exact: true })).toHaveCount(0);
    await expect.poll(async () => (await json(await request.get(`/api/agents/${agent.id}`))).status).toBe("idle");
    await runFromBrowser(4.5);
    expect(await callCount()).toBe(3);
    const totals = await summary();
    expect(totals).toMatchObject({ spendCents: 4.5, eventCount: 3, pendingRunCount: 0, pricingComplete: true });
    const byAgent = await json(await request.get(`${companyApi}/costs/by-agent`));
    expect(byAgent).toEqual([expect.objectContaining({ agentId: agent.id, costCents: 4.5, inputTokens: 21, cachedInputTokens: 33, outputTokens: 9 })]);
    await page.goto(`/${company.issuePrefix}/costs`);
    await expect(ledger.getByText("$0.05", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Raise budget & resume", exact: true })).toHaveCount(0);
    await info.attach("budget-resumed", { body: await page.screenshot(), contentType: "image/png" });
    await page.getByRole("button", { name: "Open accounting tools", exact: true }).click();
    await page.getByRole("button", { name: "Inspect stored totals", exact: true }).click();
    await expect(page.getByText("0 findings. Repairs only rebuild totals supported by the ledger.", { exact: true })).toBeVisible();
    await page.getByLabel("Invoice JSON").fill(JSON.stringify({ biller: "anthropic", externalId: "browser-invoice", currency: "USD", lines: [{
      externalId: "first-run", amountCents: "2.0000001", occurredAt: new Date().toISOString(), runId: first,
    }] }));
    await page.getByRole("button", { name: "Import invoice for review", exact: true }).click();
    await expect(page.getByText("Recorded: 1.5000000 cents · Difference: 0.5000001 cents", { exact: true })).toBeVisible();
    const correction = page.getByRole("button", { name: "Apply reviewed correction", exact: true });
    await expect(correction).toBeDisabled();
    await page.getByLabel("Invoice correction reason").fill("Verified against the fixture provider invoice");
    await correction.click();
    await expect.poll(async () => (await summary()).spendCentsExact).toBe("5.0000001");
    await expect(correction).toHaveCount(0);
    await page.getByRole("button", { name: "Inspect stored totals", exact: true }).click();
    await expect(page.getByText("0 findings. Repairs only rebuild totals supported by the ledger.", { exact: true })).toBeVisible();
    expect((await summary()).eventCount).toBe(3);
    expect(await callCount()).toBe(3);
    const [invoice] = await json(await request.get(`${companyApi}/accounting/invoices`));
    const review = await json(await request.get(`${companyApi}/accounting/invoices/${invoice.id}`));
    const history = await json(await request.get(`${companyApi}/accounting/events/${review.lines[0].matchedEventId}/adjustments`));
    expect(history).toEqual([expect.objectContaining({
      previousCents: "1.5000000", correctedCents: "2.0000001",
      previousPricing: { source: "provider_reported", version: "accounting-receipt/v1" },
      pricing: { source: "provider_invoice", evidence: "browser-invoice" },
    })]);
    await info.attach("invoice-reconciled", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await request.patch(`${companyApi}`, { data: { status: "archived" } });
    await rm(root, { recursive: true, force: true });
  }
});
