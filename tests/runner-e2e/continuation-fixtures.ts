import type { RunnerApi } from "./api.js";

/** Bare company creation does not populate its skill library. Match the
 * production onboarding setup before evaluating legacy API instructions. */
export async function prepareLegacyContinuationSkill(api: RunnerApi, companyId: string, agentId: string) {
  const key = "paperclipai/paperclip/paperclip";
  const skills = await api.get<Array<{ key: string }>>(`/api/companies/${companyId}/skills`);
  if (!skills.some(skill => skill.key === key)) throw new Error("Continuation fixture is missing the bundled Paperclip operational skill");
  await api.post(`/api/agents/${agentId}/skills/sync?companyId=${companyId}`, { desiredSkills: [key], mode: "add" });
}


/** Apply and verify both hard stops before any task can start. These are caps,
 * not estimates of provider invoices or unmetered local runtime costs. */
export async function prepareContinuationBudget(api: RunnerApi, companyId: string, agentId: string) {
  const budgetMonthlyCents = 1_000;
  await api.patch(`/api/companies/${companyId}/budgets`, { budgetMonthlyCents });
  await api.patch(`/api/agents/${agentId}/budgets`, { budgetMonthlyCents });
  const [company, agent] = await Promise.all([
    api.get<{ budgetMonthlyCents: unknown }>(`/api/companies/${companyId}`),
    api.get<{ budgetMonthlyCents: unknown }>(`/api/agents/${agentId}`),
  ]);
  if (company.budgetMonthlyCents !== budgetMonthlyCents || agent.budgetMonthlyCents !== budgetMonthlyCents)
    throw new Error("Continuation company and agent budget hard stops were not persisted");
  return { companyMonthlyCents: budgetMonthlyCents, agentMonthlyCents: budgetMonthlyCents };
}
