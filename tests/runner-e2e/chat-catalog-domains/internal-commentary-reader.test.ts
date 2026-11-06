import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
const install = vi.hoisted(() => vi.fn(async (context: { restoreOwner(): void }) => context.restoreOwner()));
vi.mock("./identity-auth.js", () => ({ installIdentitySession: install }));
vi.mock("../api.js", () => ({ RunnerApi: class {
  baseURL = "http://127.0.0.1:3100";
  setBrowserSession() {}
  async getRunObservation() { return []; }
  async get() { return {}; }
} }));
import { installCommentaryReader } from "./internal-commentary-reader.js";

function fixture() {
  let apiUser = "owner"; let browserUser = "owner";
  let source: { id: string; companyId: string; conversationUserId: string; conversationAgentId: string } | undefined;
  const state = { browserOverride: undefined as string | undefined, sourceOverride: undefined as string | undefined };
  let response: Response;
  let cancel: MockInstance<ReadableStream["cancel"]>;
  const transport = vi.fn(async () => {
    response = Response.json({ user: { id: state.browserOverride ?? browserUser } });
    cancel = vi.spyOn(response.body!, "cancel");
    return response;
  });
  vi.stubGlobal("fetch", transport);
  const context = { cookies: vi.fn(async () => [{ name: "session", value: browserUser === "owner" ? "owned-test-cookie" : "reader-test-cookie" }]),
    request: { get: vi.fn(async () => response!) }, restoreOwner() { browserUser = "owner"; } };
  const api = { baseURL: "http://127.0.0.1:3100", get: vi.fn(async () => ({ user: { id: apiUser } })),
    setBrowserSession: vi.fn(() => { apiUser = "owner"; }),
    post: vi.fn(async () => source = { id: "source", companyId: "11111111-1111-4111-8111-111111111111", conversationUserId: state.sourceOverride ?? apiUser, conversationAgentId: "lead" }) };
  const evidence = vi.fn(async () => undefined);
  const page = { context: () => context, reload: vi.fn(async () => undefined) };
  const ctx = { scenario: { id: "activity.agent-feedback" }, input: { api, page, evidence, fixtures: { company: { id: "11111111-1111-4111-8111-111111111111" }, agent: { id: "lead" } } },
    refreshIssue: vi.fn(async () => undefined), issue: () => source } as unknown as ChatCatalogContext;
  const person = { id: "casey", installSessionOn: vi.fn(async () => { browserUser = "casey"; }),
    bindApiSession: vi.fn(() => { apiUser = "casey"; }) } as unknown as Parameters<typeof installCommentaryReader>[1];
  return { ctx, person, api, context, state, evidence, transport, get response() { return response!; }, get cancel() { return cancel!; }, current: () => ({ apiUser, browserUser }) };
}
beforeEach(() => { install.mockClear(); });
afterEach(() => { vi.unstubAllGlobals(); });
describe("real commentary reader identity lifetime", () => {
  it("aligns real API/browser/conversation identities and restores the original owner only once", async () => {
    const f = fixture(); const selected = await installCommentaryReader(f.ctx, f.person, "owner");
    expect(f.current()).toEqual({ apiUser: "casey", browserUser: "casey" });
    expect(selected.receipt).toEqual({ ownerId: "owner", readerId: "casey", apiUserId: "casey", browserUserId: "casey", sourceIssueId: "source", sourceConversationUserId: "casey" });
    expect(JSON.stringify(f.evidence.mock.calls)).not.toMatch(/owned-test-cookie|session=/);
    expect(fetch).toHaveBeenCalledWith(new URL("/api/auth/get-session", f.api.baseURL), expect.objectContaining({ headers: { Cookie: "session=reader-test-cookie", Origin: f.api.baseURL } }));
    await selected.restore(); await selected.restore();
    expect(f.current()).toEqual({ apiUser: "owner", browserUser: "owner" });
    expect(install).toHaveBeenCalledOnce(); expect(f.cancel).not.toHaveBeenCalled();
    expect(f.response.bodyUsed).toBe(true); expect(f.response.body?.locked).toBe(true);
  });
  it("restores genuine owner sessions after a browser/API identity mismatch", async () => {
    const f = fixture(); f.state.browserOverride = "different-reader";
    await expect(installCommentaryReader(f.ctx, f.person, "owner")).rejects.toThrow("same real reader");
    expect(f.current()).toEqual({ apiUser: "owner", browserUser: "owner" });
    expect(f.evidence).not.toHaveBeenCalled();
  });
  it("rejects a conversation owned by a different person, retaining no false identity receipt", async () => {
    const f = fixture(); f.state.sourceOverride = "owner";
    await expect(installCommentaryReader(f.ctx, f.person, "owner")).rejects.toThrow("actual reader");
    expect(f.current()).toEqual({ apiUser: "owner", browserUser: "owner" });
    expect(f.evidence).not.toHaveBeenCalled();
  });
  it("disposes an unread denied browser response without leaking its body or creating a reader", async () => {
    const f = fixture(); const denied = new Response("private denial body must not escape", { status: 403 });
    const cancel = vi.spyOn(denied.body!, "cancel"); f.transport.mockImplementation(async () => denied);
    const error = await installCommentaryReader(f.ctx, f.person, "owner").catch(error => error);
    expect(error.message).toBe("Commentary browser session could not be independently read");
    expect(error.message).not.toContain("private denial"); expect(cancel).toHaveBeenCalledOnce();
    expect(f.current()).toEqual({ apiUser: "owner", browserUser: "owner" }); expect(f.evidence).not.toHaveBeenCalled();
  });
  it("preserves a malformed successful JSON failure instead of masking it with locked-stream cancellation", async () => {
    const f = fixture(); const malformed = new Response("invalid JSON");
    const cancel = vi.spyOn(malformed.body!, "cancel"); f.transport.mockImplementation(async () => malformed);
    await expect(installCommentaryReader(f.ctx, f.person, "owner")).rejects.toBeInstanceOf(SyntaxError);
    expect(cancel).not.toHaveBeenCalled(); expect(f.current()).toEqual({ apiUser: "owner", browserUser: "owner" });
    expect(f.evidence).not.toHaveBeenCalled();
  });
  it("rejects substituting the existing private owner for a distinct excluded reader", async () => {
    const f = fixture(); f.person.id = "owner";
    await expect(installCommentaryReader(f.ctx, f.person, "owner")).rejects.toThrow("distinct real owner and reader");
    expect(f.person.installSessionOn).not.toHaveBeenCalled(); expect(install).not.toHaveBeenCalled();
  });
  it("requires a genuine restorable owner browser session before switching", async () => {
    const f = fixture(); f.context.cookies.mockResolvedValue([]);
    await expect(installCommentaryReader(f.ctx, f.person, "owner")).rejects.toThrow("genuine browser session");
    expect(f.person.installSessionOn).not.toHaveBeenCalled();
  });
});
