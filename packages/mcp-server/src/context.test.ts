import { describe, expect, it, vi } from "vitest";
import { PaperclipApiClient } from "./client.js";
import {
  CompanyAccessError,
  RequestContext,
  assertPathCompanyAccess,
} from "./context.js";

const BOUND = "11111111-1111-1111-1111-111111111111";
const OTHER = "99999999-9999-9999-9999-999999999999";

describe("RequestContext company access", () => {
  it("resolves the bound company when none is supplied", () => {
    const ctx = new RequestContext({ companyId: BOUND, agentId: "a1" });
    expect(ctx.resolveCompanyId()).toBe(BOUND);
    expect(ctx.resolveCompanyId(null)).toBe(BOUND);
    expect(ctx.resolveCompanyId("  ")).toBe(BOUND);
  });

  it("allows an explicit company that matches the bound company", () => {
    const ctx = new RequestContext({ companyId: BOUND });
    expect(ctx.resolveCompanyId(BOUND)).toBe(BOUND);
    expect(() => ctx.assertCompanyAccess(BOUND)).not.toThrow();
  });

  it("rejects a company-pinned actor targeting a different company", () => {
    const ctx = new RequestContext({ companyId: BOUND });
    expect(() => ctx.resolveCompanyId(OTHER)).toThrow(CompanyAccessError);
    expect(() => ctx.assertCompanyAccess(OTHER)).toThrow(CompanyAccessError);
  });

  it("defers to the REST route for an unpinned actor (no bound company)", () => {
    const ctx = new RequestContext({ agentId: "a1" });
    // No bound company: an explicit company is required but not second-guessed
    // at the MCP layer — the REST route's own assertCompanyAccess governs.
    expect(ctx.resolveCompanyId(OTHER)).toBe(OTHER);
    expect(() => ctx.assertCompanyAccess(OTHER)).not.toThrow();
    expect(() => ctx.resolveCompanyId()).toThrow(/companyId is required/);
  });

  it("resolves the bound agent, and requires one when unset", () => {
    expect(new RequestContext({ agentId: "a1" }).resolveAgentId()).toBe("a1");
    expect(new RequestContext({ agentId: "a1" }).resolveAgentId("a2")).toBe("a2");
    expect(() => new RequestContext({}).resolveAgentId()).toThrow(/agentId is required/);
  });

  it("guards company-scoped raw API paths and ignores non-company paths", () => {
    const ctx = new RequestContext({ companyId: BOUND });
    expect(() => assertPathCompanyAccess(ctx, `/companies/${OTHER}/issues`)).toThrow(
      CompanyAccessError,
    );
    expect(() => assertPathCompanyAccess(ctx, `/companies/${BOUND}/issues`)).not.toThrow();
    // Issue/approval-keyed paths carry no company segment; REST enforces them.
    expect(() => assertPathCompanyAccess(ctx, "/issues/PAP-1/comments")).not.toThrow();
  });
});

describe("PaperclipApiClient wires the request-scoped context", () => {
  function makeClient(companyId: string | null) {
    return new PaperclipApiClient({
      apiUrl: "http://localhost:3100/api",
      apiKey: "token-123",
      companyId,
      agentId: "22222222-2222-2222-2222-222222222222",
      runId: null,
    });
  }

  it("blocks a cross-company call before any REST request is made", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = makeClient(BOUND);
    expect(() => client.context.resolveCompanyId(OTHER)).toThrow(CompanyAccessError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("exposes the bound identity through context", () => {
    const client = makeClient(BOUND);
    expect(client.context.companyId).toBe(BOUND);
    expect(client.context.resolveCompanyId()).toBe(BOUND);
  });
});
