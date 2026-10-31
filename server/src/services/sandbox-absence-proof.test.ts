import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { inspectCloudSandboxCleanupAbsence, requestSandboxAbsenceProof, verifySandboxAbsenceReceipt,
  verifySandboxCleanupAbsenceReceipt } from "./sandbox-absence-proof.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const binding = { companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), leaseId: randomUUID(),
  ownerToken: randomUUID(), provider: "daytona" as const, providerLeaseId: randomUUID() };
const env = { PAPERCLIP_CLOUD_STACK_ID: "fixture-stack", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test",
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "fleet-token", PAPERCLIP_PRIMARY_HOST: "fixture.paperclip.test", PAPERCLIP_AUTH_SECRET: "fixture-secret",
  PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "EdDSA", use: "sig" }] }) };
const now = new Date("2099-01-01T00:00:00Z"), seconds = now.getTime() / 1000;
function receipt(overrides: Record<string, unknown> = {}, purpose = "sandbox-absence", source: Record<string, unknown> = binding) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "fixture", typ: `paperclip-${purpose}+jwt` })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: `paperclip-${purpose}/v1`, sub: "fixture-stack",
    ...source, absent: true, iat: seconds, exp: seconds + 60, ...overrides })).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}
describe("sandbox absence proof", () => {
  it("requires signed, fresh proof for every exact source and physical owner field", () => {
    expect(verifySandboxAbsenceReceipt(receipt(), binding, env, now)).toMatchObject({ ...binding, absent: true });
    for (const overrides of [
      ...Object.keys(binding).map(key => ({ [key]: key === "provider" ? "other" : randomUUID() })),
      { sub: "foreign-stack" }, { absent: false }, { aud: "paperclip-workspace-worker-stop/v1" }, { iss: "other" },
      { iat: seconds + 31, exp: seconds + 60 }, { exp: seconds }, { exp: seconds + 61 },
    ]) expect(verifySandboxAbsenceReceipt(receipt(overrides), binding, env, now)).toBeNull();
    expect(verifySandboxAbsenceReceipt(receipt().slice(0, -8) + "tampered", binding, env, now)).toBeNull();
  });
  it("uses a host-bound purpose capability, never the fleet token or a browser credential", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ receipt: receipt() }));
    expect(await requestSandboxAbsenceProof(binding, { env, now, fetchImpl })).toMatchObject({ proof: { absent: true } });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.example.test/v1/tenant/sandbox-absence");
    expect(init.headers).toEqual({ authorization: `Bearer ${createHmac("sha256", "fixture-secret").update("paperclip-cloud-sandbox-absence-v1\nfixture.paperclip.test").digest("hex")}`,
      "content-type": "application/json", "x-paperclip-cloud-tenant-host": "fixture.paperclip.test" });
    expect(JSON.parse(init.body)).toEqual(binding);
    expect(init.redirect).toBe("error");
  });
  it("keeps outages, authentication errors, missing configuration and unsigned answers inconclusive", async () => {
    for (const answer of [{ absent: false }, { absent: true }, { receipt: "forged" }, { receipt: receipt({ ownerToken: randomUUID() }) }])
      expect(await requestSandboxAbsenceProof(binding, { env, now, fetchImpl: vi.fn().mockResolvedValue(Response.json(answer)) })).toBeNull();
    expect(await requestSandboxAbsenceProof(binding, { env, now, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).toBeNull();
    expect(await requestSandboxAbsenceProof(binding, { env, now, fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 403 })) })).toBeNull();
    const fetchImpl = vi.fn();
    expect(await requestSandboxAbsenceProof(binding, { env: {}, now, fetchImpl })).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("cleanup-only sandbox absence", () => {
  const cleanup = { purpose: "cleanup" as const, companyId: binding.companyId, environmentId: randomUUID(),
    leaseId: binding.leaseId, heartbeatRunId: null as string | null, provider: binding.provider, providerLeaseId: binding.providerLeaseId };
  const lease = { id: cleanup.leaseId, ...cleanup };
  const signed = (overrides: Record<string, unknown> = {}) => receipt(overrides, "sandbox-cleanup-absence", cleanup);
  it.each([null, binding.runId])("accepts exact absence with nullable run %s without issuing a run receipt", async heartbeatRunId => {
    const source = { ...cleanup, heartbeatRunId };
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ receipt: receipt({}, "sandbox-cleanup-absence", source) }));
    expect(await inspectCloudSandboxCleanupAbsence({ ...lease, heartbeatRunId }, { env, now, fetchImpl }))
      .toEqual({ providerLeaseId: cleanup.providerLeaseId, state: "destroyed" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://cloud.example.test/v1/tenant/sandbox-absence");
    expect(JSON.parse(init.body)).toEqual(source);
    expect(init.headers.authorization).not.toContain(env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN);
    expect(init.redirect).toBe("error");
  });
  it("requires every binding, current stack, signature and freshness, and rejects recovery receipts", () => {
    expect(verifySandboxCleanupAbsenceReceipt(signed(), cleanup, env, now)).toMatchObject(cleanup);
    for (const overrides of [
      ...Object.keys(cleanup).map(key => ({ [key]: randomUUID() })),
      { sub: "foreign-stack" }, { absent: false }, { aud: "paperclip-sandbox-absence/v1" }, { iss: "other" },
      { iat: seconds + 31 }, { exp: seconds }, { exp: seconds + 61 },
    ]) expect(verifySandboxCleanupAbsenceReceipt(signed(overrides), cleanup, env, now)).toBeNull();
    expect(verifySandboxCleanupAbsenceReceipt(signed().slice(0, -8) + "tampered", cleanup, env, now)).toBeNull();
    expect(verifySandboxCleanupAbsenceReceipt(receipt(), cleanup, env, now)).toBeNull();
    expect(verifySandboxAbsenceReceipt(signed(), binding, env, now)).toBeNull();
  });
  it("keeps old Clouds, outages, invalid replies and unconfigured instances inconclusive", async () => {
    for (const answer of [{ absent: false }, { absent: true }, { receipt: "forged" }, { receipt: signed({ heartbeatRunId: binding.runId }) }])
      expect(await inspectCloudSandboxCleanupAbsence(lease, { env, now, fetchImpl: vi.fn().mockResolvedValue(Response.json(answer)) })).toBeUndefined();
    for (const status of [400, 401, 403, 503]) expect(await inspectCloudSandboxCleanupAbsence(lease,
      { env, now, fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status })) })).toBeUndefined();
    expect(await inspectCloudSandboxCleanupAbsence(lease, { env, now, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).toBeUndefined();
    const fetchImpl = vi.fn();
    expect(await inspectCloudSandboxCleanupAbsence(lease, { env: {}, now, fetchImpl })).toBeUndefined();
    for (const change of [{ provider: "other" }, { environmentId: null }, { providerLeaseId: "invalid" }])
      expect(await inspectCloudSandboxCleanupAbsence({ ...lease, ...change }, { env, now, fetchImpl })).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
