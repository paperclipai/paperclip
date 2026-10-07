import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, test, type APIResponse } from "@playwright/test";

async function json(response: APIResponse) {
  expect(response.ok(), `${response.status()} ${await response.text()}`).toBe(true);
  return response.json();
}

test.use({ trace: "retain-on-failure" });

test("provider quotas keep accounts separate, preserve unknown usage, and retain readings through refresh failures", async ({ page, request }, info) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Quota review ${Date.now()}` } }));
  const api = `/api/companies/${company.id}`;
  const capturedAt = new Date().toISOString();
  const accounts = [
    { provider: "openai", accountKey: "personal", accountLabel: "Personal subscription", ok: true, capturedAt,
      windows: [{ label: "5h", usedPercent: 42, resetsAt: null, valueLabel: null }] },
    { provider: "openai", accountKey: "team", accountLabel: "Team subscription", ok: true, capturedAt,
      windows: [{ label: "7d", usedPercent: null, resetsAt: null, valueLabel: null }] },
  ];
  let refreshFails = false;
  try {
    const agent = await json(await request.post(`${api}/agents`, { data: { name: "Quota fixture", role: "engineer", adapterType: "process" } }));
    await json(await request.post(`${api}/cost-events`, { data: { agentId: agent.id, provider: "openai", model: "gpt-5",
      billingType: "metered_api", costCents: 125, inputTokens: 100, outputTokens: 10, occurredAt: capturedAt } }));
    // Exercise the actual page with deterministic provider responses; no live
    // account credential or quota service is involved in screenshot evidence.
    await page.route(`**${api}/costs/quota-windows`, route => route.fulfill({ json: refreshFails
      ? accounts.map(account => ({ ...account, ok: false, windows: [], errorFamily: "provider_unavailable", error: "raw provider command failed: secret diagnostic" }))
      : accounts }));
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.clock.install();
    await page.goto(`/${company.issuePrefix}/activity/costs`);
    await page.getByRole("tab", { name: "Providers", exact: true }).click();
    const personal = page.locator("section").filter({ has: page.getByText("Personal subscription", { exact: true }) });
    const team = page.locator("section").filter({ has: page.getByText("Team subscription", { exact: true }) });
    const providerCard = page.locator('[data-slot="card"]').filter({ has: personal });
    // Announcement timing is unrelated to quota behavior; keep its floating
    // card from covering the evidence when the provider card scrolls into view.
    const screenshotOptions = { style: '[aria-label="Paperclip announcements"] { visibility: hidden; }' };
    await expect(personal.getByRole("progressbar", { name: "5h: 42%" })).toBeVisible();
    await expect(team.getByText("Usage not reported", { exact: true })).toBeVisible();
    await expect(team.getByRole("progressbar")).toHaveCount(0);
    await info.attach("provider-quota-multiple-accounts-and-unknown-usage", { body: await providerCard.screenshot(screenshotOptions), contentType: "image/png" });

    refreshFails = true;
    const refresh = page.waitForResponse(response => response.url().endsWith("/costs/quota-windows"));
    await page.clock.fastForward(300_001);
    await refresh;
    await expect(personal.getByRole("progressbar", { name: "5h: 42%" })).toBeVisible();
    await expect(team.getByText("Usage not reported", { exact: true })).toBeVisible();
    await expect(personal.getByText("Showing the last available quota. Updates will resume automatically.", { exact: true })).toBeVisible();
    await expect(page.getByText("raw provider command failed", { exact: false })).toHaveCount(0);
    await info.attach("provider-quota-refresh-failure-retains-readings", { body: await providerCard.screenshot(screenshotOptions), contentType: "image/png" });
  } finally {
    await request.delete(api);
  }
});

test("existing Finance reports display API charges and credits without the deferred entry tools", async ({ page, request }, info) => {
  const company = await json(await request.post("/api/companies", { data: { name: `Finance entry ${Date.now()}` } }));
  const api = `/api/companies/${company.id}`;
  try {
    await page.goto(`/${company.issuePrefix}/activity/costs`);
    await expect(page.getByRole("tab", { name: "Finance", exact: true })).toBeVisible();
    await expect(page.getByText("Recent financial events", { exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Record or import charges" })).toHaveCount(0);
    await expect(page.getByText("Accounting health", { exact: true })).toHaveCount(0);

    // Existing integrations keep using the original finance-events endpoint.
    const charge = { biller: "anthropic", eventKind: "platform_fee", direction: "debit", currency: "USD", occurredAt: new Date().toISOString() };
    const saved = await request.post(`${api}/finance-events`, { data: { ...charge,
      idempotencyKey: "browser-subscription", amountCents: "2012.3456789", description: "Browser subscription" } });
    expect(saved.status()).toBe(201);
    await json(await request.post(`${api}/finance-events`, { data: { ...charge,
      eventKind: "credit_refund", direction: "credit", amountCents: "200", description: "Subscription refund" } }));
    await json(await request.post(`${api}/finance-events`, { data: { ...charge,
      currency: "EUR", amountCents: "300", description: "European platform fee" } }));
    const invoice = { biller: "openai", externalId: "browser-finance-invoice", currency: "USD", lines: [{ externalId: "fee", kind: "fee", amountCents: "100", occurredAt: new Date().toISOString() }] };
    await json(await request.post(`${api}/accounting/invoices`, { data: invoice }));
    await json(await request.post(`${api}/accounting/invoices`, { data: invoice }));
    const rows = await json(await request.get(`${api}/costs/finance-events`));
    expect(rows).toHaveLength(4);
    expect(rows.find((row: { description: string }) => row.description === "Browser subscription").amountCentsExact).toBe("2012.3456789");
    expect((await json(await request.get(`${api}/costs/summary`))).spendCents).toBe(0);
    expect(await json(await request.get(`${api}/costs/finance-summary`))).toMatchObject({
      debitCentsExact: "2112.3456789", creditCentsExact: "200.0000000", netCentsExact: "1912.3456789", eventCount: 3,
      currencies: expect.arrayContaining([expect.objectContaining({ currency: "EUR", netCentsExact: "300.0000000" })]),
    });
    await page.reload();
    const headline = page.locator('[data-slot="card"]').filter({ has: page.getByText("Recorded charges", { exact: true }) });
    await expect(headline.getByText("$19.12", { exact: true })).toBeVisible();
    await expect(headline.getByText("$21.12 debits", { exact: true })).toBeVisible();
    await expect(headline.getByText("$2.00 credits", { exact: true })).toBeVisible();
    await expect(page.getByText("Recent financial events", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Browser subscription", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: "Finance", exact: true }).click();
    for (const label of ["Finance ledger", "By biller", "Financial event mix", "Recent financial events", "Browser subscription", "Subscription refund", "European platform fee"]) {
      await expect(page.getByText(label, { exact: true })).toBeVisible();
    }
    await expect(page.getByText("Finance headline totals are USD only.", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Record or import charges" })).toHaveCount(0);
    await expect(page.getByText("Accounting health", { exact: true })).toHaveCount(0);
    await info.attach("existing-finance-reports", { body: await page.screenshot(), contentType: "image/png" });
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
    const spend = page.locator('[data-slot="card"]').filter({ has: page.getByText("Inference spend", { exact: true }) });
    await expect(spend.getByText("$0.03", { exact: true })).toBeVisible();
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
    await expect(spend.getByText("$0.05", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Raise budget & resume", exact: true })).toHaveCount(0);
    await info.attach("budget-resumed", { body: await page.screenshot(), contentType: "image/png" });
    // Recovery and invoice review remain operator APIs; their UI is deferred.
    expect((await json(await request.get(`${companyApi}/accounting/inspect`))).findings).toEqual([]);
    const invoice = await json(await request.post(`${companyApi}/accounting/invoices`, { data: { biller: "anthropic", externalId: "browser-invoice", currency: "USD", lines: [{
      externalId: "first-run", amountCents: "2.0000001", occurredAt: new Date().toISOString(), runId: first,
    }] } }));
    const review = await json(await request.get(`${companyApi}/accounting/invoices/${invoice.id}`));
    const line = review.lines[0];
    expect(line).toMatchObject({ status: "difference", recordedCents: "1.5000000", differenceCents: "0.5000001" });
    const correction = { idempotencyKey: `invoice-line:${line.id}`, invoiceLineId: line.id,
      expectedCents: line.recordedCents, correctedCents: line.amountCents,
      reason: "Verified against the fixture provider invoice", pricing: { source: "provider_invoice", evidence: invoice.externalId } };
    const correctionPath = `${companyApi}/accounting/events/${line.matchedEventId}/adjustments`;
    expect((await request.post(correctionPath, { data: { ...correction, reason: "" } })).status()).toBe(400);
    expect((await summary()).spendCentsExact).toBe("4.5000000");
    await json(await request.post(correctionPath, { data: correction }));
    await json(await request.post(correctionPath, { data: correction }));
    await expect.poll(async () => (await summary()).spendCentsExact).toBe("5.0000001");
    expect((await json(await request.get(`${companyApi}/accounting/inspect`))).findings).toEqual([]);
    expect((await summary()).eventCount).toBe(3);
    expect(await callCount()).toBe(3);
    const history = await json(await request.get(`${companyApi}/accounting/events/${review.lines[0].matchedEventId}/adjustments`));
    expect(history).toEqual([expect.objectContaining({
      previousCents: "1.5000000", correctedCents: "2.0000001",
      previousPricing: { source: "provider_reported", version: "accounting-receipt/v1" },
      pricing: { source: "provider_invoice", evidence: "browser-invoice" },
    })]);
    await page.reload();
    await expect(spend.getByText("$0.05", { exact: true })).toBeVisible();
    await info.attach("operator-corrected-costs", { body: await page.screenshot(), contentType: "image/png" });
  } finally {
    await request.patch(`${companyApi}`, { data: { status: "archived" } });
    await rm(root, { recursive: true, force: true });
  }
});
