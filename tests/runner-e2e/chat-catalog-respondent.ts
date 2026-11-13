import { pollUntil } from "./api.js";
import { codexSubscriptionAgentConfig } from "./codex-subscription-fixture.js";
import type { ChatFlowInput } from "./chat-flow.js";
import type { ChatCatalogCase } from "./chat-catalog-contract.js";
type Respondent = ChatFlowInput["fixtures"]["agent"] & {
  role: string; lifecycleState: string; status: string; permissions?: { canCreateAgents?: boolean };
  access?: { grants?: Array<{ permissionKey: string }> };
};
/** The original CEO remains a company fixture. This narrowly selected case gets
 * a separate real engineer principal; no visible-name or authority substitution. */
export async function prepareChatCatalogRespondent(input: ChatFlowInput, descriptor?: Pick<ChatCatalogCase, "scenarioId" | "respondingAgent">) {
  if (!descriptor?.respondingAgent) return;
  const policy = descriptor.respondingAgent;
  if (descriptor.scenarioId !== "cases.handoff-same-task" || Object.keys(policy).length !== 4 || policy.kind !== "case-primary-owner" || policy.name !== "Morgan" || policy.role !== "engineer" || policy.canAssignTasks !== true)
    throw new Error("Unsupported responding-agent fixture policy");
  const original = input.fixtures.agent;
  const base = input.execution.profile.buildAgent({ environmentId: input.fixtures.environment.id, environmentFixtureId: input.execution.environment.id,
    workspacePath: input.workspacePath, secretRefs: input.fixtures.secretRefs, executionId: `${input.nonce}-case-owner` });
  const payload = { ...base, name: policy.name, role: policy.role, title: "Case investigator", reportsTo: original.id,
    capabilities: "Investigates customer cases and preserves findings when handing the same task to a reviewer.", permissions: { canCreateAgents: false },
    runtimeConfig: { ...(base.runtimeConfig as Record<string, unknown>), heartbeat: { enabled: false, maxConcurrentRuns: 1, maxDailyRuns: 3, maxDailyCostCents: 500 } } };
  const created = await input.api.post<Respondent>(`/api/companies/${input.fixtures.company.id}/agents`, input.execution.profile.credential === "CODEX_AUTH_JSON"
    ? codexSubscriptionAgentConfig(payload, process.env, input.fixtures.company.id) : payload);
  try {
    await input.api.patch(`/api/agents/${created.id}/permissions`, { canCreateAgents: false, canAssignTasks: true });
    const actual = await pollUntil({ label: "actual Morgan case-owner respondent", deadlineAt: Date.now() + 45_000,
      load: () => input.api.get<Respondent>(`/api/agents/${created.id}`),
      accept: row => row.lifecycleState === "ready" && ["idle", "active"].includes(row.status)
        && row.name === "Morgan" && row.role === "engineer" && row.companyId === input.fixtures.company.id
        && row.permissions?.canCreateAgents === false && row.access?.grants?.some(grant => grant.permissionKey === "tasks:assign") === true });
    input.fixtures.agent = { id: actual.id, name: actual.name, companyId: actual.companyId };
    await input.evidence("chat-catalog-responding-agent.json", { originalCompanyCEOId: original.id, actualRespondingAgentId: actual.id,
      actualName: actual.name, actualRole: actual.role, canCreateAgents: actual.permissions?.canCreateAgents, requiredGrant: "tasks:assign", fixturePolicy: policy });
  } catch (error) { input.fixtures.agent = original; await input.api.delete(`/api/agents/${created.id}`, { allowNotFound: true }); throw error; }
}
