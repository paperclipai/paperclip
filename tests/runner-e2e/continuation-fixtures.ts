import type { RunnerApi } from "./api.js";

/** Bare company creation does not populate its skill library. Match the
 * production onboarding setup before evaluating legacy API instructions. */
export async function prepareLegacyContinuationSkill(api: RunnerApi, companyId: string, agentId: string) {
  const key = "paperclipai/paperclip/paperclip";
  const skills = await api.get<Array<{ key: string }>>(`/api/companies/${companyId}/skills`);
  if (!skills.some(skill => skill.key === key)) throw new Error("Continuation fixture is missing the bundled Paperclip operational skill");
  await api.post(`/api/agents/${agentId}/skills/sync?companyId=${companyId}`, { desiredSkills: [key], mode: "add" });
}
