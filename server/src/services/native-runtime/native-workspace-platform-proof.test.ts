import { generateKeyPairSync, sign } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { verifyWorkspaceWorkerStopReceipt, requestWorkspaceWorkerStopProof, currentWorkspaceWorker } from "./native-workspace-platform-proof.js";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const env = { PAPERCLIP_CLOUD_STACK_ID: "stack", PAPERCLIP_CLOUD_API_ORIGIN: "https://cloud.example", PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN: "fixture-token", PAPERCLIP_CLOUD_RUNTIME_IDENTITY_JWKS: JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test", alg: "EdDSA", use: "sig" }] }) };
const worker = { provider: "railway" as const, projectId: "project", environmentId: "environment", serviceId: "service", deploymentId: "old-deployment" };
const binding = { runId: "run", ownerToken: "owner", worker };
const now = new Date("2099-01-01T00:00:00Z");
function receipt(overrides = {}) {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", kid: "test", typ: "paperclip-workspace-worker-stop+jwt" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ v: 1, iss: "paperclip-cloud", aud: "paperclip-workspace-worker-stop/v1", sub: "stack", ...binding, stopped: true, iat: now.getTime()/1000, exp: now.getTime()/1000+60, ...overrides })).toString("base64url");
  return `${header}.${payload}.${sign(null, Buffer.from(`${header}.${payload}`), privateKey).toString("base64url")}`;
}
describe("workspace platform stop proof", () => {
  it("accepts only signed proof for the exact stack, owner, run and full stopped deployment", () => {
    expect(verifyWorkspaceWorkerStopReceipt(receipt(), binding, env, now)).toMatchObject({ stopped: true, worker });
    for (const invalid of [{ sub: "other-stack" }, { runId: "other-run" }, { ownerToken: "other-owner" }, { stopped: false }, { exp: now.getTime()/1000-1 }, { worker: { ...worker, deploymentId: "other" } }, { aud: "paperclip-cloud-control/v1" }]) {
      expect(verifyWorkspaceWorkerStopReceipt(receipt(invalid), binding, env, now)).toBeNull();
    }
    expect(verifyWorkspaceWorkerStopReceipt(receipt().slice(0,-5)+"wrong", binding, env, now)).toBeNull();
  });
  it("fails closed on live, unknown, unreachable and unsigned platform responses", async () => {
    for (const response of [{ stopped: false }, { stopped: true }, { receipt: "forged" }]) {
      const fetchImpl = vi.fn().mockResolvedValue(Response.json(response));
      expect(await requestWorkspaceWorkerStopProof(binding, { env, now, fetchImpl })).toBeNull();
    }
    expect(await requestWorkspaceWorkerStopProof(binding, { env, now, fetchImpl: vi.fn().mockRejectedValue(new Error("offline")) })).toBeNull();
    expect(await requestWorkspaceWorkerStopProof(binding, { env, now, fetchImpl: vi.fn().mockResolvedValue(Response.json({ receipt: receipt() })) })).toMatchObject({ stopped: true });
  });
  it("records a complete platform identity, and does not guess legacy ownership", () => {
    expect(currentWorkspaceWorker({ RAILWAY_PROJECT_ID: "project", RAILWAY_ENVIRONMENT_ID: "environment", RAILWAY_SERVICE_ID: "service", RAILWAY_DEPLOYMENT_ID: "old-deployment" })).toEqual(worker);
    expect(currentWorkspaceWorker({ RAILWAY_DEPLOYMENT_ID: "old-deployment" })).toBeUndefined();
  });
});
