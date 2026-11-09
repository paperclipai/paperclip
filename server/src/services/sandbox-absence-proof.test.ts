import { createHmac, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { requestSandboxAbsenceProof, verifySandboxAbsenceReceipt } from "./sandbox-absence-proof.js";

const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const binding = { companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), leaseId: randomUUID(),
  ownerToken: randomUUID(), provider: "daytona" as const, providerLeaseId: randomUUID() };
const env = { PAPERCLIP_CLOUD_STACK_ID: "fixture-stack", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example.test",
  PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "fleet-token", PAPERCLIP_PRIMARY_HOST: "fixture.paperclip.test", PAPERCLIP_AUTH_SECRET: "fixture-secret",
  PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "fixture", alg: "EdDSA", use: "sig" }] }) };
const now = new Date("2099-01-01T00:00:00Z"), seconds = now.getTime() / 1000;
function receipt(overrides: Record<string, unknown> = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "fixture", typ: "paperclip-sandbox-absence+jwt" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: "paperclip-sandbox-absence/v1", sub: "fixture-stack",
    ...binding, absent: true, iat: seconds, exp: seconds + 60, ...overrides })).toString("base64url");
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
