import { describe, expect, it, vi } from "vitest";
import { uploadFactualQueryAttachment } from "../chat-query-attachments.js";
vi.mock("../chat-query-attachments.js", async importOriginal => ({ ...await importOriginal<typeof import("../chat-query-attachments.js")>(), uploadFactualQueryAttachment: vi.fn(async () => ({ id: "customer-brief-upload" })) }));
import { customerBugFacts, preservesCustomerBugFacts, gradeIntegratorCaseCreation, integratorCaseCreationCases } from "./integrator-case-create.js";
function valid() {
  const brief = { id: "brief", issueId: "primary", companyId: "company", key: "brief", body: Object.values(customerBugFacts).join("\n") };
  const workflow = { id: "workflow", issueId: "primary", companyId: "company", key: "workflow", body: "Morgan investigates, saves findings, then hands this same primary task to its next owner for review." };
  const revision = (doc: typeof brief) => ({ id: `${doc.id}-revision`, documentId: doc.id, issueId: "primary", key: doc.key, body: doc.body, createdByAgentId: "ceo", createdByRunId: "source-run", createdAt: "2026-10-26T12:00:00Z" });
  return { scenarioId: "cases.create-case", origin: "https://fixture.test", companyId: "company", leadId: "ceo", state: { project: { id: "project" }, task: { id: "source-brief" }, worker: { id: "morgan" } },
    tasks: [{ id: "source-brief", title: "Customer bug brief" }, { id: "primary", companyId: "company", title: "Customer checkout bug", assigneeAgentId: "morgan" }], projects: [], goals: [], comments: [], documents: [], revisions: [], humanQueries: [], activity: [], reply: "Created the case and started Morgan's investigation on its primary task.", links: ["/ACORN/cases/case", "/ACORN/issues/primary"],
    cases: [{ id: "case", companyId: "company", projectId: "project", workIssueId: "primary", fields: structuredClone(customerBugFacts) }],
    handoffs: { case: [{ id: "kickoff", caseId: "case", version: 1, issueId: "primary", toAgentId: "morgan", actorId: "ceo", sourceRunId: "source-run", state: "delivered" }] }, taskDocuments: { primary: [workflow, brief] },
    documentVersions: { "primary:workflow": [revision(workflow)], "primary:brief": [revision(brief)] },
    runs: [{ id: "source-run", agentId: "ceo", status: "succeeded" }, { id: "investigation", agentId: "morgan", status: "running", contextSnapshot: { issueId: "primary" }, startedAt: "2026-10-26T12:01:00Z" }] };
}
describe("real case kickoff independent controls", () => {
  it("requires the real primary task, first Morgan dispatch and original saved documents", () => {
    expect(gradeIntegratorCaseCreation(valid()).passed).toBe(true);
    expect(gradeIntegratorCaseCreation(undefined).passed).toBe(false);
    const passive = valid(); passive.cases[0]!.workIssueId = "";
    expect(gradeIntegratorCaseCreation(passive).passed).toBe(false);
    const late = valid(); late.documentVersions["primary:brief"][0]!.createdAt = "2026-10-26T12:02:00Z";
    expect(gradeIntegratorCaseCreation(late).passed).toBe(false);
    const otherOwner = valid(); otherOwner.taskDocuments.primary[1]!.issueId = "source-brief";
    expect(gradeIntegratorCaseCreation(otherOwner).passed).toBe(false);
    const wrongWorker = valid(); wrongWorker.handoffs.case[0]!.toAgentId = "riley";
    expect(gradeIntegratorCaseCreation(wrongWorker).passed).toBe(false);
    const repaired = valid(); repaired.documentVersions["primary:brief"][0]!.body = "Investigate a bug.";
    expect(gradeIntegratorCaseCreation(repaired).passed).toBe(false);
    expect(gradeIntegratorCaseCreation({ ...valid(), links: ["/ACORN/cases/case"] }).passed).toBe(false);
  });
  it("accepts changed wording of factual fields but rejects swapped expected/observed behavior", () => {
    const paraphrase = { customer: "Acorn Test Shop", issue: "Checkout stops responding", browser: "Safari 18 on iPhone 15", steps: ["Add the trial item", "Fill the test address", "Press Pay"], expectedBehavior: "An order confirmation should be shown", observedBehavior: "Without confirmation; customer is not charged" };
    expect(preservesCustomerBugFacts(paraphrase)).toBe(true);
    expect(preservesCustomerBugFacts({ ...paraphrase, expectedBehavior: "No order confirmation appears" })).toBe(false);
    expect(preservesCustomerBugFacts({ ...paraphrase, browser: "Chrome on Android" })).toBe(false);
    expect(preservesCustomerBugFacts({ ...paraphrase, observedBehavior: "Order confirmation appears and customer is charged" })).toBe(false);
  });
});

it("places the genuine customer brief on the canonical conversation's normal document surface", async () => {
  const source = { id: "standing-chat", title: "Chat with CEO" }; let saved: Record<string, unknown> | undefined;
  const created: string[] = []; const patches: Array<{ path: string; body: unknown }> = [];
  const api = {
    get: async (path: string) => path.endsWith("/documents/brief") ? saved : path.startsWith("/api/agents/") ? { lifecycleState: "ready" } : { enableCases: false },
    patch: async (path: string, body: unknown) => { patches.push({ path, body }); return {}; },
    post: async (path: string, body: Record<string, unknown>) => { created.push(path); return { ...body, id: path.endsWith("/projects") ? "project" : "morgan" }; },
    putSensitive: async (path: string, body: Record<string, unknown>) => { expect(path).toBe("/api/issues/standing-chat/documents/brief"); saved = { ...body, issueId: source.id }; return saved; },
  };
  const ctx = { input: { nonce: "offline", api, fixtures: { company: { id: "company" }, agent: { id: "ceo" }, environment: { id: "environment" }, secretRefs: {} }, execution: { environment: { id: "local" }, profile: { credential: "ANTHROPIC_API_KEY", buildAgent: () => ({}) } } },
    refreshIssue: async () => {}, issue: () => source } as unknown as Parameters<typeof integratorCaseCreationCases[0]["setup"]>[0];
  const state = await integratorCaseCreationCases[0]!.setup(ctx);
  expect((state.task as { id: string }).id).toBe(source.id);
  expect(saved?.body).toContain(customerBugFacts.customer);
  expect(uploadFactualQueryAttachment).toHaveBeenLastCalledWith(ctx, { filename: "customer-bug-brief.md", body: saved?.body });
  expect((state.factualContextAttachment as { id: string }).id).toBe("customer-brief-upload");
  expect(created.some(path => path.endsWith("/issues"))).toBe(false);
  expect(patches).toContainEqual({ path: "/api/issues/standing-chat", body: { projectId: "project" } });
  await integratorCaseCreationCases[0]!.cleanup!(ctx, state);
});
