import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const person = vi.hoisted(() => ({ id: "riley", request: vi.fn(), dispose: vi.fn(async () => {}) }));
vi.mock("./identity-auth.js", () => ({ createAuthenticatedPerson: async () => person, enrollPrerequisitePerson: async () => {} }));
vi.mock("./internal-privacy.js", () => ({ mainPerson: async () => "owner" }));
vi.mock("./internal-support.js", async importOriginal => ({ ...await importOriginal<typeof import("./internal-support.js")>(),
  observeInternal: async (_ctx: unknown, state: Record<string, unknown>) => ({ companyId: "company", state }) }));
import { decisionSearchCases } from "./internal-decision-search.js";

function control() {
  const records = new Map<string, Record<string, unknown>>(); let issueCount = 0, questionCount = 0;
  const ownerFeed = { companyId: "company", items: [{ subject: { id: "hire" } }] };
  const resolverFeed = { companyId: "company", items: [{ subject: { id: "question-1" }, relatedIssue: { id: "task-1" }, resolverAudience: { addresseeUserId: "riley", effectiveResolverPolicy: "human_only" } }] };
  const api = {
    baseURL: "https://fixture.test",
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/attention?all=true&includeDismissed=true")) return ownerFeed;
      if (path === "/api/approvals/hire") return records.get("hire");
      if (path.endsWith("/interactions")) return [...records.values()].filter(row => row.issueId === path.split("/")[3]);
      throw new Error(`Unexpected public read ${path}`);
    }),
    post: vi.fn(async (path: string, body: Record<string, unknown>) => {
      if (path.endsWith("/projects")) return { id: "project", companyId: "company", ...body };
      if (path.endsWith("/issues")) return { id: `task-${++issueCount}`, companyId: "company", ...body };
      if (path.endsWith("/interactions")) {
        const row = { id: `question-${++questionCount}`, companyId: "company", issueId: path.split("/")[3], status: "pending", effectiveResolverPolicy: "human_only", ...body };
        records.set(row.id, row); return row;
      }
      if (path.endsWith("/respond")) {
        const id = path.split("/")[5]!; const row = { ...records.get(id), status: "answered", result: body, resolvedByUserId: "owner" };
        records.set(id, row); return row;
      }
      if (path.endsWith("/approvals")) { const row = { id: "hire", companyId: "company", status: "pending", ...body }; records.set("hire", row); return row; }
      throw new Error(`Unexpected public mutation ${path}`);
    }),
    postSensitive: vi.fn(async () => ({ id: "probe", token: "synthetic-attempt-private-probe" })),
    delete: vi.fn(async () => {}),
  };
  const ctx = { input: { api, nonce: "fixture", privateSecrets: [], page: { context: () => ({ browser: () => ({}) }) }, fixtures: { company: { id: "company" }, agent: { id: "ceo" } } } } as unknown as ChatCatalogContext;
  person.request.mockImplementation(async () => Response.json(resolverFeed));
  return { ctx, api, ownerFeed, resolverFeed, definition: decisionSearchCases[0]! };
}
beforeEach(() => {
  person.id = "riley"; person.request.mockReset(); person.dispose.mockClear();
  vi.stubGlobal("fetch", vi.fn(async (url: URL, options: RequestInit) => {
    expect(url.href).toBe("https://fixture.test/api/companies/company/attention?all=true");
    expect(options.headers).toEqual({ Authorization: "Bearer synthetic-attempt-private-probe" });
    return new Response(null, { status: 403 });
  }));
});
afterEach(() => vi.unstubAllGlobals());
it("actual observer independently reads Riley's session without borrowing the current human API", async () => {
  const c = control(); const state = await c.definition.setup(c.ctx); const writes = c.api.post.mock.calls.length;
  const o = await c.definition.observe(c.ctx, state) as { visibleAttention: unknown; resolverAttention: unknown; resolverUserId: string; permissionStatus: number };
  expect(person.request).toHaveBeenCalledExactlyOnceWith("/api/companies/company/attention?all=true&includeDismissed=true", "GET");
  expect(c.api.get.mock.calls.filter(([path]) => path.includes("/attention"))).toEqual([["/api/companies/company/attention?all=true&includeDismissed=true"]]);
  expect(o.visibleAttention).toEqual(c.ownerFeed); expect(o.resolverAttention).toEqual(c.resolverFeed); expect(o.resolverUserId).toBe("riley"); expect(o.permissionStatus).toBe(403);
  expect(c.api.post.mock.calls).toHaveLength(writes);
  await c.definition.cleanup?.(c.ctx, state); expect(person.dispose).toHaveBeenCalledOnce();
});
it.each(["owner-substitution", "different-person", "unauthenticated-feed"])("actual observer rejects %s", async kind => {
  const c = control(); const state = await c.definition.setup(c.ctx);
  if (kind === "owner-substitution") person.id = "owner";
  if (kind === "different-person") person.id = "other";
  if (kind === "unauthenticated-feed") person.request.mockResolvedValue(new Response(null, { status: 403 }));
  await expect(c.definition.observe(c.ctx, state)).rejects.toThrow();
  await c.definition.cleanup?.(c.ctx, state);
});
