import { expect } from "@playwright/test";
import { checks, project, task, sameTask, entity } from "./internal-support.js";
import { identityDefinition, identityObservation, observeIdentity } from "./identity-support.js";

export function gradeCompanyRename(value: unknown) {
  const c = checks(); const o = identityObservation(value);
  c.add("complete-company-evidence", !!o, "Public company, records and audit evidence is required.");
  if (!o) return c.result();
  const before = entity(o.state, "company"); const other = entity(o.state, "otherCompany");
  c.add("same-company-renamed", o.company.id === before.id && o.company.name === "Acorn Studio"
    && o.companies.filter(row => row.id === before.id).length === 1, "The saved identity changes on the original company ID.");
  c.add("other-company-preserved", o.companies.find(row => row.id === other.id)?.name === other.name
    && o.companies.length === o.state.companyCount, "A similarly named company remains unchanged and no duplicate company is created.");
  c.add("work-retained", sameTask(entity(o.state, "task"), o.tasks.find(row => row.id === entity(o.state, "task").id))
    && o.projects.some(row => row.id === entity(o.state, "project").id), "Original task and project remain attached to the same company.");
  c.add("agent-attributed-identity-change", o.activity.some(row => row.action === "company.updated" && row.entityId === before.id
    && row.agentId === o.leadId && row.details?.name === "Acorn Studio"), "The requested mutation is recorded for the acting CEO.");
  c.add("memberships-preserved", Array.isArray(o.state.membersBefore) && o.state.membersBefore.length > 0
    && JSON.stringify(o.state.membersBefore) === JSON.stringify(o.state.membersAfter), "The original member IDs, principals, roles and permissions remain unchanged.");
  return c.result();
}
export const companyIdentityCases = [identityDefinition("companies.rename-company", async ctx => {
  const company = await ctx.input.api.get(`/api/companies/${ctx.input.fixtures.company.id}`);
  const otherCompany = await ctx.input.api.post("/api/companies", { name: "Acorn Studios" });
  const p = await project(ctx); const t = await task(ctx, "Website task", p.id);
  const companies = await ctx.input.api.get<unknown[]>("/api/companies");
  return { company, otherCompany, companyCount: companies.length, project: p, task: t, membersBefore: await membershipSnapshot(ctx) };
}, gradeCompanyRename, {
  async observe(ctx, state) { state.membersAfter = await membershipSnapshot(ctx); return observeIdentity(ctx, state); },
  async verifyResult(ctx) {
    await ctx.input.page.reload({ waitUntil: "domcontentloaded" });
    await expect(ctx.input.page.getByText("Acorn Studio", { exact: true }).first()).toBeVisible();
    await expect(ctx.input.page.getByTestId("task-chat-composer-input")).toBeVisible();
  },
  async cleanup(ctx, state) { await ctx.input.api.delete(`/api/companies/${entity(state, "otherCompany").id}`, { allowNotFound: true }); },
})] as const;
async function membershipSnapshot(ctx: Parameters<typeof project>[0]) {
  const { members } = await ctx.input.api.get<{ members: Array<Record<string, unknown>> }>(`/api/companies/${ctx.input.fixtures.company.id}/members`);
  return members.map(row => ({ id: row.id, principalType: row.principalType, principalId: row.principalId,
    membershipRole: row.membershipRole, status: row.status, grants: row.grants })).sort((a, b) => String(a.id).localeCompare(String(b.id)));
}
