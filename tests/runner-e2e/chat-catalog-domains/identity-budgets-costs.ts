import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect, type Locator } from "@playwright/test";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import { checks, entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, waitForReply, waitForTurnReplyLinks, probeAgentPermission } from "./identity-support.js";

/** The budget card remounts when its policy reloads, and a remount resets a typed draft. Resolve once the same
 * input node has stayed on the page for `stableMs` (bounded), so a following fill is not lost to a reload. */
export async function settledInput(input: Locator, stableMs = 1_000, timeoutMs = 15_000) {
  for (const deadlineAt = Date.now() + timeoutMs; Date.now() < deadlineAt;) {
    await input.evaluate(node => node.setAttribute("data-e2e-settle-mark", "1"));
    await new Promise(resolve => setTimeout(resolve, stableMs));
    if (await input.getAttribute("data-e2e-settle-mark").catch(() => null) === "1") return true;
  }
  return false;
}
export function gradeBudget(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("complete-budget-evidence", !!o, "Saved policy and browser-action evidence is required."); if (!o) return c.result();
  const overview = (value as { budget?: BudgetOverview }).budget;
  const worker = entity(o.state, "worker"); const other = entity(o.state, "other");
  const budget = overview?.policies.find(row => row.scopeType === "agent" && row.scopeId === worker.id);
  c.add("exact-monthly-dollar-policy", budget?.amount === 5000 && budget.metric === "billed_cents"
    && budget.windowKind === "calendar_month_utc" && budget.companyId === o.companyId && budget.isActive,
    "Morgan has the actual $50 USD monthly policy, expressed as cents.");
  c.add("human-control-after-guidance", o.state.beforeHumanAmount === 500 && o.state.humanSaved === true,
    "The agent's guidance leaves the original cap unchanged; only the explicit human budget control saves $50.");
  c.add("agent-policy-write-denied", o.state.agentWriteStatus === 403, "The same policy route rejects a real CEO agent bearer before the board saves it.");
  c.add("other-agent-policy-retained", overview?.policies.find(row => row.scopeType === "agent" && row.scopeId === other.id)?.amount === 500,
    "A similarly named worker's policy remains at its original $5 cap.");
  c.add("board-attribution", o.activity.some(row => row.action === "budget.policy_upserted" && row.actorType === "user"
    && row.details?.scopeId === worker.id && row.details?.amount === 5000 && !row.agentId), "The saved budget audit belongs to the board identity.");
  c.add("unchanged-employee-configuration", !!o.state.workerConfig && !!o.state.currentWorkerConfig
    && JSON.stringify(o.state.workerConfig) === JSON.stringify(o.state.currentWorkerConfig),
    "A budget decision does not replace policy enforcement with a prompt/configuration instruction.");
  return c.result();
}
export const budgetIdentityCases = [identityDefinition("budgets-costs.set-budget", async ctx => {
  const worker = await identityWorker(ctx); const other = await identityWorker(ctx, "Morgan Research");
  const workerConfig = await employeeConfiguration(ctx, worker.id);
  return { worker, other, workerConfig };
}, gradeBudget, {
  oracleVersion: "paperclip.chat-catalog.identity.set-budget.v3",
  sourceFiles: ["chat-catalog-domains/identity-support.ts", "chat-catalog-domains/internal-support.ts", "chat-catalog-domains/identity-budgets-costs.ts", "chat-rendered-links.ts", "chat-scenarios/budgets-costs.yaml"],
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
    // The run is recorded finished before its reply is saved, and the open conversation renders it later still;
    // read the reply's anchors only once that reply is on the page.
    await waitForTurnReplyLinks(ctx);
    const root = `/api/companies/${ctx.input.fixtures.company.id}`; const worker = entity(state, "worker");
    state.agentWriteStatus = await probeAgentPermission(ctx, `${root}/budgets/policies`, "POST", {
      scopeType: "agent", scopeId: worker.id, amount: 5000, windowKind: "calendar_month_utc" });
    state.beforeHumanAmount = (await ctx.input.api.get<BudgetOverview>(`${root}/budgets/overview`)).policies.find(row => row.scopeType === "agent" && row.scopeId === worker.id)?.amount;
    const source = ctx.input.page.url();
    const links = await ctx.input.page.locator(`[id^="comment-"] a[href]`).evaluateAll(rows => rows.map(row => row.getAttribute("href")!));
    const href = links.find(link => {
      const url = new URL(link, ctx.input.api.baseURL); if (url.origin !== ctx.input.api.baseURL) return false;
      const parts = url.pathname.split("/").map(decodeURIComponent); const index = parts.indexOf("agents");
      return index >= 0 && [worker.id, worker.urlKey].includes(parts[index + 1]) || url.searchParams.get("agentId") === worker.id;
    });
    if (!href) throw new Error("The budget guidance did not link the intended Morgan record");
    await ctx.input.page.locator(`[id^="comment-"] a[href=${JSON.stringify(href)}]`).first().click();
    if (!(await ctx.input.page.getByPlaceholder("0.00").isVisible())) await ctx.input.page.getByRole("link", { name: "Budgets", exact: true }).click();
    // The draft resets whenever the loaded policy changes; fill only after the
    // form shows the currently saved cap, and confirm the typed value stuck.
    const amount = ctx.input.page.getByPlaceholder("0.00");
    await expect(amount).toHaveValue((Number(state.beforeHumanAmount ?? 0) / 100).toFixed(2));
    // Act on the settled form: if the card still remounts and drops the typed amount, type it again (bounded).
    const save = ctx.input.page.getByRole("button", { name: "Update budget", exact: true });
    for (let attempt = 1; ; attempt++) {
      await settledInput(amount);
      if (await amount.inputValue() !== "50.00") { await amount.fill("50.00"); await expect(amount).toHaveValue("50.00"); }
      if (await save.click({ timeout: 5_000 }).then(() => true, () => false)) break;
      if (attempt >= 3) throw new Error("The budget form kept reloading and dropped the typed amount before it could be saved");
    }
    await expect(amount).toHaveValue("50.00"); state.humanSaved = true;
    await ctx.input.evidence("identity-human-budget-action.json", { workerId: worker.id, amountCents: 5000, url: ctx.input.page.url() });
    await ctx.input.page.goto(source, { waitUntil: "domcontentloaded" });
  },
  async observe(ctx, state) {
    const worker = entity(state, "worker");
    state.currentWorkerConfig = await employeeConfiguration(ctx, worker.id);
    return { ...await observeIdentity(ctx, state), budget: await ctx.input.api.get<BudgetOverview>(`/api/companies/${ctx.input.fixtures.company.id}/budgets/overview`) };
  },
})] as const;
async function employeeConfiguration(ctx: Parameters<typeof identityWorker>[0], id: string) {
  const config = await ctx.input.api.get<Record<string, unknown>>(`/api/agents/${id}/configuration`);
  return { adapterType: config.adapterType, adapterConfig: config.adapterConfig, runtimeConfig: config.runtimeConfig, instructions: config.instructions };
}
