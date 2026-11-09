import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { projectIdleMcpWakeProof, type IdleMcpCredentialRow } from "./idle-wake-proof.js";
import { authorizeMcpWakeAdmission } from "./wake-admission.js";
const token = "pcmcp_rt_" + "x".repeat(43);
const input = { stackId: "stack", ownerId: "00000000-0000-4000-8000-000000000001", capabilityGeneration: "a".repeat(64), challenge: "c".repeat(64),
  personalResource: "https://tenant.example/mcp/paperclip", dotResource: "https://tenant.example/mcp/runner", personalEnabled: true, dotEnabled: true, now: 0 };
const row: IdleMcpCredentialRow = { grantId: "grant", companyId: "company", clientId: "pcmcp_client_test", resource: input.dotResource, purpose: "agent", scopes: ["paperclip:agent", "offline_access"],
  tokenHash: createHash("sha256").update(token).digest("hex"), tokenKind: "refresh", tokenExpiresAt: null, tokenUsedAt: null,
  dotBindingId: "binding", dotProvider: "openai_dot", dotStatus: "connected", dotGeneration: 1, dotPairingHash: null, dotChallengeHash: null,
  agentStatus: "active", membershipRole: "owner" };
describe("MCP credential owner projection", () => {
  it("retains Dot renewable refresh but binds its actual client and tenant scope", () => {
    const proof = projectIdleMcpWakeProof([row], input);
    expect(proof.grantIds).toEqual(["grant"]);
    expect(proof.dotBindingIds).toEqual(["binding"]);
    const request = { stackId: "stack", token, clientId: row.clientId, profile: "dot-mcp" as const, tokenKind: "refresh" as const, now: 0 };
    expect(authorizeMcpWakeAdmission(proof.admission, request)).toBeDefined();
    expect(authorizeMcpWakeAdmission(proof.admission, { ...request, clientId: "other" })).toBeUndefined();
    expect(JSON.stringify(proof.admission)).not.toContain(row.tokenHash);
  });
  it("preserves inactive, unfamiliar, pairing and changed-authority obligations", () => {
    for (const change of [{ tokenUsedAt: new Date() }, { dotProvider: "grok_bot" }, { dotStatus: "pairing" }, { dotGeneration: 0 },
      { dotPairingHash: "pending" }, { dotChallengeHash: "pending" }, { membershipRole: "viewer" }, { agentStatus: "terminated" },
      { resource: "https://other.example/mcp/runner" }, { tokenExpiresAt: new Date(0) }]) {
      expect(projectIdleMcpWakeProof([{ ...row, ...change }], input).grantIds).toEqual([]);
    }
    expect(projectIdleMcpWakeProof([row], { ...input, dotEnabled: false }).grantIds).toEqual([]);
  });
  it("does not export an unbounded personal/access token, used refresh, or overlarge projection", () => {
    expect(projectIdleMcpWakeProof([{ ...row, tokenKind: "access" }], input).grantIds).toEqual([]);
    const personal = { ...row, resource: input.personalResource, purpose: "personal", scopes: ["paperclip:read"], tokenExpiresAt: new Date(1000) };
    expect(projectIdleMcpWakeProof([personal], input).grantIds).toEqual(["grant"]);
    expect(projectIdleMcpWakeProof([personal], input).dotBindingIds).toEqual([]);
    expect(() => projectIdleMcpWakeProof(Array.from({ length: 1001 }, () => row), input)).toThrow();
  });
});
