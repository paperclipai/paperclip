import { afterEach, expect, it, vi } from "vitest";
const captured = vi.hoisted(() => ({ deadlineAt: undefined as number | undefined }));
vi.mock("./api.js", async original => ({ ...await original<object>(), pollUntil: async (options: { deadlineAt: number }) => { captured.deadlineAt = options.deadlineAt; throw new Error("closed pure phase boundary"); } }));
vi.mock("./chat-catalog-domains/identity-auth.js", async original => ({ ...await original<object>(), createAuthenticatedPerson: async () => ({ id: "viewer", dispose: async () => {} }), enrollPrerequisitePerson: async () => {} }));
import { chatCatalogCases, loadChatCatalogImplementation } from "./chat-catalog-registry.js";
import type { ChatCatalogContext } from "./chat-catalog-contract.js";
const ids = ["companies.export-company", "projects.project-defaults", "questions-and-approvals.ambiguous-yes", "questions-and-approvals.review-plan", "questions-and-approvals.necessary-question", "task-coordination.block-on-design", "gateways-profiles.rotate-token", "gateways-profiles.create-gateway", "workspaces.preview-service", "assistant-connections.consent-read-only", "navigation-preferences.quick-search", "navigation-preferences.edit-profile", "navigation-preferences.broken-link", "projects.share-project"];
afterEach(() => { vi.useRealTimers(); captured.deadlineAt = undefined; });
it.each(ids)("actual %s callback enters its first native observation with the original deadline", async id => {
  vi.useFakeTimers(); vi.setSystemTime(200000);
  const ctx = { scenario: { id }, observationDeadlineAt: 630000, issue: () => ({ id: "source", conversationState: "waiting" }), refreshIssue: async () => {}, allRuns: async () => [],
    input: { nonce: "synthetic", execution: { id: `chat-features.runner-opencode.local.${id}` }, fixtures: { company: { id: "company" }, agent: { id: "ceo" } }, privateSecrets: [],
      page: { context: () => ({ browser: () => ({}) }) }, api: { get: async () => ({ user: { id: "owner" } }), post: async (_path: string, body: object) => ({ id: "saved", companyId: "company", ...body }) } },
  } as unknown as ChatCatalogContext;
  const selected = await loadChatCatalogImplementation(chatCatalogCases.find(row => row.scenarioId === id)!);
  const state = id === "projects.share-project" ? await selected.setup(ctx) : {};
  await expect(selected.act!(ctx, state)).rejects.toThrow("closed pure phase boundary"); expect(captured.deadlineAt).toBe(630000);
});
it("the shared plan module retains the unselected reject/revise180s phase", async () => {
  vi.useFakeTimers(); vi.setSystemTime(200000); const id = "questions-and-approvals.reject-and-revise";
  const selected = await loadChatCatalogImplementation(chatCatalogCases.find(row => row.scenarioId === id)!);
  await expect(selected.act!({ input: { execution: { id: `chat-features.runner-opencode.local.${id}` } }, observationDeadlineAt: 630000 } as unknown as ChatCatalogContext, {})).rejects.toThrow("closed pure phase boundary");
  expect(captured.deadlineAt).toBe(380000);
});
