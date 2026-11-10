import { chatCatalogOriginalPhaseDeadline } from "../chat-catalog-contract.js";
import { expect } from "@playwright/test";
import type { BudgetOverview } from "../../../packages/shared/src/types/budget.js";
import { checks, entity } from "./internal-support.js";
import { identityDefinition, identityObservation, identityWorker, observeIdentity, waitForReply, probeAgentPermission } from "./identity-support.js";

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
  async act(ctx, state) {
    await waitForReply(ctx, chatCatalogOriginalPhaseDeadline(ctx));
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
    await ctx.input.page.getByPlaceholder("0.00").fill("50.00");
    await ctx.input.page.getByRole("button", { name: "Update budget", exact: true }).click();
    await expect(ctx.input.page.getByPlaceholder("0.00")).toHaveValue("50.00"); state.humanSaved = true;
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
