import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { apiWakeFingerprint, createApiWakeAdmission, parseApiWakeAdmission, matchesApiWakeAdmission } from "./idle-api-wake-admission.js";

const token = "api-wake-vector-token";
const keyHash = createHash("sha256").update(token).digest("hex");
const input = { stackId: "vector-stack", ownerId: "00000000-0000-4000-8000-000000000001", capabilityGeneration: "a".repeat(64), challenge: "c".repeat(64) };
const fingerprint = apiWakeFingerprint({ ...input, keyHash });
const receipt = createApiWakeAdmission({ ...input, keys: [{ fingerprint, expiresAt: null }] });
describe("API wake receipt wire vectors", () => {
  it("uses exact domain-separated vectors and exports neither token nor database hash", () => {
    expect(fingerprint).toBe("6478041b90f4665eeca8403186fefedc456bf1322f38dab9fb89212eecaafd43");
    expect(JSON.stringify(receipt)).not.toContain(token);
    expect(JSON.stringify(receipt)).not.toContain(keyHash);
    expect(matchesApiWakeAdmission(receipt, { stackId: input.stackId, token, now: new Date("2099-01-01").getTime() })).toBe(true);
    expect(matchesApiWakeAdmission(receipt, { stackId: "other", token, now: 0 })).toBe(false);
    expect(matchesApiWakeAdmission(receipt, { stackId: input.stackId, token: "unknown", now: 0 })).toBe(false);
  });
  it("enforces board expiry and canonical unique bounded complete receipts", () => {
    const changedChallenge = createApiWakeAdmission({ ...input, challenge: "b".repeat(64), keys: receipt.keys });
    expect(matchesApiWakeAdmission(changedChallenge, { stackId: input.stackId, token, now: 0 })).toBe(false);
    const expiring = createApiWakeAdmission({ ...input, keys: [{ fingerprint, expiresAt: new Date(1000).toISOString() }] });
    expect(matchesApiWakeAdmission(expiring, { stackId: input.stackId, token, now: 999 })).toBe(true);
    expect(matchesApiWakeAdmission(expiring, { stackId: input.stackId, token, now: 1000 })).toBe(false);
    for (const invalid of [
      { ...receipt, generation: "b".repeat(64) }, { ...receipt, challenge: "b".repeat(64) },
      { ...receipt, extra: true }, { ...receipt, keys: [...receipt.keys, ...receipt.keys] },
      { ...receipt, keys: Array.from({ length: 1001 }, () => receipt.keys[0]) },
      { ...receipt, keys: [{ fingerprint, expiresAt: "2099-01-01" }] },
      { ...receipt, keys: [{ fingerprint: "d".repeat(64), expiresAt: null }, { fingerprint: "a".repeat(64), expiresAt: null }] },
    ]) expect(() => parseApiWakeAdmission(invalid)).toThrow();
  });
});
