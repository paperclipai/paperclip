/**
 * LET-402 / LET-140-G.4 — focused unit tests for the real MCP apply adapter.
 *
 * These tests do NOT touch the DB or capability_apply_events. They drive the
 * adapter module directly so its guards (catalog allowlist, egress, named
 * secrets, idempotent step key, mutation digest) can be exercised without
 * the surrounding state machine.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_APPLY_ERROR_CODES, type CapabilityApplyStep } from "@paperclipai/shared";
import {
  CapabilityApplyAdapterError,
  DefaultCatalogAllowlist,
  RealMcpApplyAdapter,
  StubMcpApplyAdapter,
  assertEgressAllowed,
  buildMutationDigest,
  buildStepKey,
  getExecutorAdapter,
} from "../services/capability-apply-mcp-adapter.js";

function step(overrides: Partial<CapabilityApplyStep> = {}): CapabilityApplyStep {
  return {
    stepId: "step-0",
    ordinal: 0,
    kind: "add_mcp_server",
    target: { catalogId: "verified/x", label: "MCP", namedSecretRefs: [] },
    riskClass: "external_write",
    annotations: {},
    sideEffects: [],
    secretSummary: [],
    state: "pending",
    ...overrides,
  };
}

describe("getExecutorAdapter", () => {
  it("returns stub when capabilityApplyLive is false", () => {
    const a = getExecutorAdapter({ capabilityApplyLive: false });
    expect(a.kind).toBe("stub");
  });
  it("returns real adapter when capabilityApplyLive is true", () => {
    const a = getExecutorAdapter({ capabilityApplyLive: true });
    expect(a.kind).toBe("real");
  });
});

describe("DefaultCatalogAllowlist", () => {
  it("accepts verified/ prefixed ids", () => {
    expect(new DefaultCatalogAllowlist().isAllowed("verified/github")).toBe(true);
  });
  it("rejects missing or unverified ids", () => {
    const a = new DefaultCatalogAllowlist();
    expect(a.isAllowed(undefined)).toBe(false);
    expect(a.isAllowed("")).toBe(false);
    expect(a.isAllowed("smithery/random")).toBe(false);
    expect(a.isAllowed("unverified/marketplace")).toBe(false);
  });
  it("accepts explicit ids configured at construction", () => {
    const a = new DefaultCatalogAllowlist(["mcp:official:github"]);
    expect(a.isAllowed("mcp:official:github")).toBe(true);
    expect(a.isAllowed("mcp:official:other")).toBe(false);
  });
});

describe("assertEgressAllowed", () => {
  const FIELD = "step[0].target.remoteUrl";

  it("returns silently for nullish url (no remote step)", () => {
    expect(() => assertEgressAllowed(undefined, FIELD)).not.toThrow();
    expect(() => assertEgressAllowed(null, FIELD)).not.toThrow();
  });

  it.each([
    ["http://example.com/mcp"],
    ["https://api.example.com/path"],
    ["https://198.51.100.7/mcp"], // TEST-NET-2: not in our forbidden ranges
    ["https://203.0.113.10/mcp"], // TEST-NET-3
  ])("allows public URL %s", (url) => {
    expect(() => assertEgressAllowed(url, FIELD)).not.toThrow();
  });

  it.each([
    ["ftp://example.com/mcp"],
    ["file:///etc/passwd"],
    ["javascript:alert(1)"],
  ])("blocks non-http scheme %s", (url) => {
    expect(() => assertEgressAllowed(url, FIELD)).toThrowError(
      expect.objectContaining({ code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED }),
    );
  });

  it("blocks unparseable URLs", () => {
    expect(() => assertEgressAllowed("not a url", FIELD)).toThrowError(CapabilityApplyAdapterError);
  });

  it.each([
    ["http://localhost/x"],
    ["http://service.localhost/x"],
    ["http://0.0.0.0/x"],
    ["http://127.0.0.1/x"],
    ["http://10.0.0.5/x"],
    ["http://172.16.0.1/x"],
    ["http://172.31.255.254/x"],
    ["http://192.168.0.1/x"],
    ["http://169.254.169.254/latest/meta-data/"], // IMDS
    ["http://169.254.1.1/x"], // link-local
    ["http://224.0.0.1/x"], // multicast
    ["http://0.0.0.1/x"], // reserved leading-zero
  ])("blocks host-local / private / IMDS %s", (url) => {
    expect(() => assertEgressAllowed(url, FIELD)).toThrowError(
      expect.objectContaining({ code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED }),
    );
  });

  it("blocks IPv6 loopback / unique-local / link-local", () => {
    expect(() => assertEgressAllowed("http://[::1]/x", FIELD)).toThrow();
    expect(() => assertEgressAllowed("http://[fc00::1]/x", FIELD)).toThrow();
    expect(() => assertEgressAllowed("http://[fd00::1]/x", FIELD)).toThrow();
    expect(() => assertEgressAllowed("http://[fe80::1]/x", FIELD)).toThrow();
  });

  it("does not silently accept 172.32.x (outside 172.16-31 RFC1918 block)", () => {
    expect(() => assertEgressAllowed("http://172.32.0.1/x", FIELD)).not.toThrow();
  });
});

describe("buildStepKey / buildMutationDigest", () => {
  it("step key is deterministic given (planId, ordinal, kind)", () => {
    const s = step({ ordinal: 4, kind: "add_skill_ref" });
    expect(buildStepKey("plan-A", s)).toBe("apply:plan-A:4:add_skill_ref");
    expect(buildStepKey("plan-A", s)).toBe(buildStepKey("plan-A", s));
  });

  it("mutation digest is content-addressable and order-insensitive on secret refs", () => {
    const a = buildMutationDigest(step({ target: { catalogId: "verified/x", label: "MCP", namedSecretRefs: ["B", "A"] } }));
    const b = buildMutationDigest(step({ target: { catalogId: "verified/x", label: "MCP", namedSecretRefs: ["A", "B"] } }));
    expect(a).toBe(b);
    expect(a.length).toBe(32);
  });

  it("mutation digest changes when catalog id changes", () => {
    const a = buildMutationDigest(step({ target: { catalogId: "verified/x", label: "MCP", namedSecretRefs: [] } }));
    const b = buildMutationDigest(step({ target: { catalogId: "verified/y", label: "MCP", namedSecretRefs: [] } }));
    expect(a).not.toBe(b);
  });

  it("mutation digest does NOT depend on the free-form label (which carries no auth weight)", () => {
    const a = buildMutationDigest(step({ target: { catalogId: "verified/x", label: "MCP one", namedSecretRefs: [] } }));
    const b = buildMutationDigest(step({ target: { catalogId: "verified/x", label: "MCP two", namedSecretRefs: [] } }));
    expect(a).toBe(b);
  });
});

describe("StubMcpApplyAdapter (live=OFF)", () => {
  it("returns wouldExecute=true and a deterministic step key without touching outside state", async () => {
    const a = new StubMcpApplyAdapter();
    const res = await a.executeStep(step({ ordinal: 2 }), { companyId: "c", planId: "p" });
    expect(res.wouldExecute).toBe(true);
    expect(res.stepKey).toBe("apply:p:2:add_mcp_server");
    expect(res.mutationDigest.length).toBe(32);
  });
});

describe("RealMcpApplyAdapter (live=ON, mocked deps)", () => {
  it("happy path for verified catalog with no secrets", async () => {
    const a = new RealMcpApplyAdapter();
    const res = await a.executeStep(step(), { companyId: "c", planId: "p" });
    expect(res.wouldExecute).toBe(true);
  });

  it("refuses non-allowlisted catalog with CATALOG_NOT_ALLOWLISTED", async () => {
    const a = new RealMcpApplyAdapter();
    await expect(
      a.executeStep(step({ target: { catalogId: "smithery/random", label: "x", namedSecretRefs: [] } }), {
        companyId: "c",
        planId: "p",
      }),
    ).rejects.toMatchObject({ code: CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED });
  });

  it("refuses missing catalog id with CATALOG_NOT_ALLOWLISTED", async () => {
    const a = new RealMcpApplyAdapter();
    await expect(
      a.executeStep(step({ target: { catalogId: undefined, label: "x", namedSecretRefs: [] } }), {
        companyId: "c",
        planId: "p",
      }),
    ).rejects.toMatchObject({ code: CAPABILITY_APPLY_ERROR_CODES.CATALOG_NOT_ALLOWLISTED });
  });

  it("refuses private-IP remoteUrl with EGRESS_BLOCKED via injected url extractor", async () => {
    const a = new RealMcpApplyAdapter({
      getRemoteUrl: () => "http://10.0.0.1/mcp",
    });
    await expect(a.executeStep(step(), { companyId: "c", planId: "p" })).rejects.toMatchObject({
      code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
    });
  });

  it("reads remoteUrl from step.target without an injected extractor (LET-402 G.4 plumbing)", async () => {
    const a = new RealMcpApplyAdapter();
    await expect(
      a.executeStep(
        step({
          target: {
            catalogId: "verified/x",
            label: "MCP",
            transport: "streamable_http",
            remoteUrl: "http://169.254.169.254/latest/meta-data/",
            namedSecretRefs: [],
          },
        }),
        { companyId: "c", planId: "p" },
      ),
    ).rejects.toMatchObject({ code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED });
  });

  it("fails closed when transport is remote (sse/streamable_http) but remoteUrl is missing", async () => {
    const a = new RealMcpApplyAdapter();
    for (const transport of ["sse", "streamable_http"] as const) {
      await expect(
        a.executeStep(
          step({
            target: {
              catalogId: "verified/x",
              label: "MCP",
              transport,
              namedSecretRefs: [],
            },
          }),
          { companyId: "c", planId: "p" },
        ),
      ).rejects.toMatchObject({
        code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
        details: expect.objectContaining({ reason: "missing_remote_url" }),
      });
    }
  });

  it("allows stdio transport with no remoteUrl (local process MCP)", async () => {
    const a = new RealMcpApplyAdapter();
    const res = await a.executeStep(
      step({
        target: {
          catalogId: "verified/x",
          label: "MCP",
          transport: "stdio",
          namedSecretRefs: [],
        },
      }),
      { companyId: "c", planId: "p" },
    );
    expect(res.wouldExecute).toBe(true);
  });

  it("refuses missing named secret with NAMED_SECRET_NOT_FOUND", async () => {
    const a = new RealMcpApplyAdapter({
      secretReferenceResolver: { async hasNamedSecret() { return false; } },
    });
    await expect(
      a.executeStep(
        step({ target: { catalogId: "verified/x", label: "x", namedSecretRefs: ["FOO_TOKEN"] } }),
        { companyId: "c", planId: "p" },
      ),
    ).rejects.toMatchObject({ code: CAPABILITY_APPLY_ERROR_CODES.NAMED_SECRET_NOT_FOUND });
  });

  it("accepts a step whose resolver confirms every named secret", async () => {
    const seen: string[] = [];
    const a = new RealMcpApplyAdapter({
      secretReferenceResolver: {
        async hasNamedSecret(_cid, name) {
          seen.push(name);
          return true;
        },
      },
    });
    const res = await a.executeStep(
      step({ target: { catalogId: "verified/x", label: "x", namedSecretRefs: ["A_TOKEN", "B_TOKEN"] } }),
      { companyId: "c", planId: "p" },
    );
    expect(res.wouldExecute).toBe(true);
    expect(seen).toEqual(["A_TOKEN", "B_TOKEN"]);
  });

  it("remove_mcp_server bypasses catalog allowlist (removal is always permitted)", async () => {
    const a = new RealMcpApplyAdapter();
    const res = await a.executeStep(
      step({
        kind: "remove_mcp_server",
        riskClass: "internal_safe",
        target: { catalogId: undefined, label: "old server", namedSecretRefs: [] },
      }),
      { companyId: "c", planId: "p" },
    );
    expect(res.wouldExecute).toBe(true);
  });

  it("internal_safe skill / tool ref steps bypass catalog + egress guards", async () => {
    const a = new RealMcpApplyAdapter();
    for (const kind of ["add_skill_ref", "remove_skill_ref", "add_tool_ref", "remove_tool_ref"] as const) {
      const res = await a.executeStep(
        step({ kind, riskClass: "internal_safe", target: { label: "ref", namedSecretRefs: [] } }),
        { companyId: "c", planId: "p" },
      );
      expect(res.wouldExecute).toBe(true);
    }
  });
});
