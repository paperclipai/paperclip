/**
 * LET-402 G.4 — non-DB proof that the service-path step view reconstruction
 * carries `remoteUrl` end-to-end so the SSRF/egress guard fires when an MCP
 * apply step is loaded from the DB at execute time.
 *
 * The embedded-Postgres backed `capability-apply-service.test.ts` covers the
 * full DB-backed live=ON state machine, but that suite is skipped on hosts
 * where the embedded Postgres binary cannot start. This file deliberately
 * avoids the DB so the reconstruction wiring is validated on every CI/QA
 * host, including hosts where embedded Postgres is unavailable.
 */
import { describe, expect, it } from "vitest";
import { CAPABILITY_APPLY_ERROR_CODES } from "@paperclipai/shared";
import { rebuildStepViewFromRow } from "../services/capability-apply.js";
import { RealMcpApplyAdapter } from "../services/capability-apply-mcp-adapter.js";

describe("rebuildStepViewFromRow (LET-402 G.4 service-path wiring)", () => {
  it("preserves remoteUrl from targetRefJson on the rebuilt step view", () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: {
        catalogId: "verified/ok",
        label: "MCP",
        transport: "streamable_http",
        remoteUrl: "https://api.example.com/mcp",
      },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });
    expect(view.target.remoteUrl).toBe("https://api.example.com/mcp");
    expect(view.target.transport).toBe("streamable_http");
    expect(view.target.catalogId).toBe("verified/ok");
  });

  it("leaves remoteUrl undefined when the persisted target did not include one (stdio MCP)", () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: { catalogId: "verified/ok", label: "MCP", transport: "stdio" },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });
    expect(view.target.remoteUrl).toBeUndefined();
  });

  it("ignores non-string remoteUrl on the persisted row", () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: { catalogId: "verified/ok", label: "MCP", remoteUrl: 12345 },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });
    expect(view.target.remoteUrl).toBeUndefined();
  });
});

describe("rebuildStepViewFromRow + RealMcpApplyAdapter integration", () => {
  it("blocks an unsafe remoteUrl persisted on the row via EGRESS_BLOCKED (regression for QA finding #1)", async () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: {
        catalogId: "verified/ok",
        label: "MCP",
        transport: "streamable_http",
        remoteUrl: "http://169.254.169.254/latest/meta-data/",
      },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });

    const adapter = new RealMcpApplyAdapter();
    await expect(adapter.executeStep(view, { companyId: "c", planId: "p" })).rejects.toMatchObject({
      code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
    });
  });

  it("rejects a remote-transport row with no remoteUrl as EGRESS_BLOCKED (defense-in-depth)", async () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: { catalogId: "verified/ok", label: "MCP", transport: "sse" },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });

    const adapter = new RealMcpApplyAdapter();
    await expect(adapter.executeStep(view, { companyId: "c", planId: "p" })).rejects.toMatchObject({
      code: CAPABILITY_APPLY_ERROR_CODES.EGRESS_BLOCKED,
      details: expect.objectContaining({ reason: "missing_remote_url" }),
    });
  });

  it("accepts a stdio row with no remoteUrl (no outbound endpoint to guard)", async () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: { catalogId: "verified/ok", label: "MCP", transport: "stdio" },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });

    const adapter = new RealMcpApplyAdapter();
    const result = await adapter.executeStep(view, { companyId: "c", planId: "p" });
    expect(result.wouldExecute).toBe(true);
  });

  it("accepts a public remoteUrl through the same persisted-row path", async () => {
    const view = rebuildStepViewFromRow({
      ordinal: 0,
      kind: "add_mcp_server",
      riskClass: "external_write",
      targetRefJson: {
        catalogId: "verified/ok",
        label: "MCP",
        transport: "streamable_http",
        remoteUrl: "https://api.example.com/mcp",
      },
      annotationsJson: {},
      expectedNamedSecretsJson: [],
    });

    const adapter = new RealMcpApplyAdapter();
    const result = await adapter.executeStep(view, { companyId: "c", planId: "p" });
    expect(result.wouldExecute).toBe(true);
  });
});
