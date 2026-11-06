import { expect, it, vi } from "vitest";
import { prepareChatCatalogRespondent } from "./chat-catalog-respondent.js";
import type { ChatFlowInput } from "./chat-flow.js";
const descriptor = { scenarioId: "cases.handoff-same-task", respondingAgent: { kind: "case-primary-owner", name: "Morgan", role: "engineer", canAssignTasks: true } } as const;
function fixture() {
  const persisted = { id: "morgan", companyId: "company", name: "Morgan", role: "engineer", lifecycleState: "ready", status: "idle", permissions: { canCreateAgents: false }, access: { grants: [{ permissionKey: "tasks:assign" }] } };
  const api = { post: vi.fn(async (_path: string, _payload: unknown) => persisted), patch: vi.fn(async (_path: string, _payload: unknown) => persisted), get: vi.fn(async () => persisted), delete: vi.fn(async (_path: string, _options: unknown) => {}) };
  const input = { api, nonce: "fixture", workspacePath: "/owned/synthetic", evidence: vi.fn(async () => {}), fixtures: { company: { id: "company" }, agent: { id: "ceo", name: "CEO", companyId: "company" }, environment: { id: "environment" }, secretRefs: {} },
    execution: { environment: { id: "local" }, profile: { credential: "OPENAI_API_KEY", buildAgent: () => ({ name: "CEO", role: "ceo", permissions: { canCreateAgents: true } }) } } } as unknown as ChatFlowInput;
  return { input, api, persisted };
}
it("uses a separate actual engineer principal and only the declared assignment grant", async () => {
  const { input, api } = fixture(); const originalFixtures = input.fixtures;
  await prepareChatCatalogRespondent(input, descriptor);
  expect(input.fixtures).toBe(originalFixtures); expect(input.fixtures.agent).toEqual({ id: "morgan", name: "Morgan", companyId: "company" });
  expect(api.post.mock.calls[0]?.[1]).toMatchObject({ name: "Morgan", role: "engineer", reportsTo: "ceo", permissions: { canCreateAgents: false } });
  expect(api.patch.mock.calls[0]?.[1]).toEqual({ canCreateAgents: false, canAssignTasks: true });
});
it("preserves default CEO fixtures and refuses another scenario before any mutation", async () => {
  const { input, api } = fixture(); await prepareChatCatalogRespondent(input);
  expect(input.fixtures.agent.id).toBe("ceo"); expect(api.post).not.toHaveBeenCalled();
  await expect(prepareChatCatalogRespondent(input, { ...descriptor, scenarioId: "cases.create-case" })).rejects.toThrow("Unsupported responding-agent");
  expect(api.post).not.toHaveBeenCalled();
});
it("retires a partially prepared respondent and preserves CEO identity on grant failure", async () => {
  const { input, api } = fixture(); api.patch.mockRejectedValueOnce(new Error("public grant failed"));
  await expect(prepareChatCatalogRespondent(input, descriptor)).rejects.toThrow("public grant failed");
  expect(input.fixtures.agent.id).toBe("ceo"); expect(api.delete).toHaveBeenCalledWith("/api/agents/morgan", { allowNotFound: true });
});
