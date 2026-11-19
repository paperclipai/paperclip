import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { authorizeMcpWakeAdmission, createMcpWakeAdmission, matchesMcpWakeClaim, parseMcpWakeAdmission } from "./wake-admission.js";
const context = { stackId: "mcp-vector-stack", ownerId: "00000000-0000-4000-8000-000000000001", capabilityGeneration: "a".repeat(64), challenge: "c".repeat(64) };
const token = "pcmcp_at_" + "x".repeat(43);
const tokenHash = createHash("sha256").update(token).digest("hex");
const future = "2099-01-01T00:00:00.000Z";
const make = () => createMcpWakeAdmission({ ...context, tokens: [{ profile: "personal-mcp", tokenKind: "access", tokenHash, expiresAt: future }] });
const request = { stackId: context.stackId, token, now: Date.parse("2098-01-01"), profile: "personal-mcp" as const, tokenKind: "access" as const };

describe("MCP OAuth sleep admission", () => {
  it("admits only the bound stack, lane and token before expiry without exporting credentials", () => {
    const receipt = make();
    const claim = authorizeMcpWakeAdmission(receipt, request)!;
    expect(claim).toBeDefined();
    expect(matchesMcpWakeClaim(receipt, claim, request.now)).toBe(true);
    expect(matchesMcpWakeClaim(receipt, claim, Date.parse(future))).toBe(false);
    for (const changed of [{ stackId: "foreign" }, { token: "unknown" }, { profile: "dot-mcp" as const },
      { tokenKind: "refresh" as const }, { now: Date.parse(future) }, { now: NaN }, { operation: "revoke" as const }]) {
      expect(authorizeMcpWakeAdmission(receipt, { ...request, ...changed })).toBeUndefined();
    }
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(JSON.stringify(receipt)).not.toContain(tokenHash);
    expect(parseMcpWakeAdmission(JSON.parse(JSON.stringify(receipt)))).toEqual(receipt);
    const rotated = createMcpWakeAdmission({ ...context, challenge: "d".repeat(64), tokens: [{ profile: "personal-mcp", tokenKind: "access", tokenHash, expiresAt: future }] });
    expect(rotated.lanes[0].keys[0].fingerprint).not.toBe(claim.fingerprint);
    expect(matchesMcpWakeClaim(rotated, claim, request.now)).toBe(false);
  });
  it("binds all four lanes and permits timeless inactivity only for renewable Dot refresh", () => {
    const tokens = (["personal-mcp", "dot-mcp"] as const).flatMap(profile => (["access", "refresh"] as const).map(tokenKind =>
      ({ profile, tokenKind, tokenHash, clientId: "test-client", expiresAt: profile === "dot-mcp" && tokenKind === "refresh" ? null : future })));
    const receipt = createMcpWakeAdmission({ ...context, tokens });
    expect(new Set(receipt.lanes.map(lane => lane.keys[0].fingerprint)).size).toBe(4);
    expect(authorizeMcpWakeAdmission(receipt, { ...request, profile: "dot-mcp", tokenKind: "refresh", clientId: "test-client", now: Date.parse("2199-01-01") })).toBeDefined();
    expect(authorizeMcpWakeAdmission(receipt, { ...request, profile: "dot-mcp", tokenKind: "refresh", clientId: "wrong-client" })).toBeUndefined();
    expect(() => createMcpWakeAdmission({ ...context, tokens: [{ ...tokens[0], expiresAt: null }] })).toThrow();
    expect(() => createMcpWakeAdmission({ ...context, tokens: Array.from({ length: 1001 }, () => tokens[0]) })).toThrow();
  });
  it("fails closed on unknown, altered, duplicate or foreign receipts and empty old-host enrollment", () => {
    const receipt = make();
    for (const altered of [undefined, { ...receipt, extra: true }, { ...receipt, generation: "b".repeat(64) },
      { ...receipt, ownerId: context.ownerId.replace(/1$/, "2") }, { ...receipt, lanes: [...receipt.lanes, ...receipt.lanes] },
      { ...receipt, lanes: [{ ...receipt.lanes[0], tokenKind: "refresh" }] }]) expect(() => parseMcpWakeAdmission(altered)).toThrow();
    expect(authorizeMcpWakeAdmission(createMcpWakeAdmission({ ...context, tokens: [] }), request)).toBeUndefined();
  });
});
