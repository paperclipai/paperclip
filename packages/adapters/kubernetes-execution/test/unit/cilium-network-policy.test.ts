import { describe, it, expect } from "vitest";
import { buildCiliumAgentEgressPolicy } from "../../src/orchestrator/cilium-network-policy.js";

describe("buildCiliumAgentEgressPolicy", () => {
  it("merges adapter and tenant FQDN allowlists, deduplicated and sorted", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      adapterAllowFqdns: ["*.anthropic.com", "github.com"],
      tenantAllowFqdns: ["github.com", "*.acme.io"],
      controlPlaneSelector: { matchLabels: { "paperclip.ai/role": "control-plane" } },
    });
    const fqdns = p.spec.egress[0].toFQDNs!.map((f: { matchPattern?: string; matchName?: string }) =>
      f.matchPattern ?? f.matchName,
    ).sort();
    expect(fqdns).toEqual(["*.acme.io", "*.anthropic.com", "github.com"]);
  });

  it("folds tenant Cilium DNS allowlist into the baseline FQDN set when supplied", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      adapterAllowFqdns: ["*.anthropic.com", "github.com"],
      tenantAllowFqdns: ["*.acme.io"],
      tenantCiliumDnsAllowlist: ["api.anthropic.com"],
      controlPlaneSelector: null,
    });
    const fqdns = p.spec.egress[0].toFQDNs!.map((f: { matchPattern?: string; matchName?: string }) =>
      f.matchPattern ?? f.matchName,
    );
    expect(fqdns).toEqual(["*.acme.io", "*.anthropic.com", "api.anthropic.com", "github.com"]);
  });

  it("folds tenant Cilium CIDRs into the same policy instead of emitting a second allow policy", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme",
      companyId: "c-1",
      companySlug: "acme",
      adapterAllowFqdns: [],
      tenantAllowFqdns: [],
      tenantCiliumEgressCidrs: ["172.20.0.0/12", "10.42.0.0/16", "10.42.0.0/16"],
      controlPlaneSelector: null,
    });
    expect(p.spec.egress).toEqual([{ toCIDR: ["10.42.0.0/16", "172.20.0.0/12"] }]);
  });

  it("uses matchPattern for wildcard FQDNs and matchName for exact FQDNs", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-x", companyId: "c-1", companySlug: "x",
      adapterAllowFqdns: ["*.anthropic.com", "api.openai.com"], tenantAllowFqdns: [],
      controlPlaneSelector: null,
    });
    const fqdns = p.spec.egress[0].toFQDNs!;
    expect(fqdns.find(f => f.matchPattern === "*.anthropic.com")).toBeDefined();
    expect(fqdns.find(f => f.matchName === "api.openai.com")).toBeDefined();
  });

  it("emits a separate egress rule for the in-cluster control plane endpoint", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      adapterAllowFqdns: [], tenantAllowFqdns: [],
      controlPlaneSelector: { matchLabels: { "paperclip.ai/role": "control-plane" } },
    });
    expect(p.spec.egress.some(r =>
      r.toEndpoints?.some(e => e.matchLabels?.["paperclip.ai/role"] === "control-plane"),
    )).toBe(true);
  });

  it("omits the control-plane endpoint rule when none provided (cross-cluster)", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-acme", companyId: "c-1", companySlug: "acme",
      adapterAllowFqdns: ["api.anthropic.com"], tenantAllowFqdns: [],
      controlPlaneSelector: null,
    });
    expect(p.spec.egress.some(r => r.toEndpoints)).toBe(false);
  });

  it("targets only agent-runtime pods", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-x", companyId: "c-1", companySlug: "x",
      adapterAllowFqdns: ["api.anthropic.com"], tenantAllowFqdns: [],
      controlPlaneSelector: null,
    });
    expect(p.spec.endpointSelector.matchLabels["paperclip.ai/role"]).toBe("agent-runtime");
  });

  it("returns an empty egress array when no FQDNs and no control plane (degenerate)", () => {
    const p = buildCiliumAgentEgressPolicy({
      namespace: "paperclip-x", companyId: "c-1", companySlug: "x",
      adapterAllowFqdns: [], tenantAllowFqdns: [],
      controlPlaneSelector: null,
    });
    expect(p.spec.egress).toEqual([]);
  });
});
