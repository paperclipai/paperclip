import { verify } from "node:crypto";
import { cloudRuntimePublicKeyForKid } from "../cloud-runtime-identity.js";
import { getCloudStackContext } from "../cloud-instance.js";

/** Deployment identity covers the controller and every orphaned tar/Git child. */
export type WorkspaceWorker = {
  provider: "railway"; projectId: string; environmentId: string; serviceId: string; deploymentId: string;
};
export type WorkspaceStopBinding = { runId: string; ownerToken: string; worker: WorkspaceWorker };
export type WorkspaceWorkerStopProof = WorkspaceStopBinding & {
  v: 1; iss: "paperclip-cloud"; aud: "paperclip-workspace-worker-stop/v1"; sub: string;
  stopped: true; iat: number; exp: number;
};
function validWorker(worker: unknown): worker is WorkspaceWorker {
  if (!worker || typeof worker !== "object" || Array.isArray(worker)) return false;
  const value = worker as Record<string, unknown>;
  return value.provider === "railway" && ["projectId", "environmentId", "serviceId", "deploymentId"].every(key =>
    typeof value[key] === "string" && value[key].length > 0 && value[key].length <= 200);
}
export function currentWorkspaceWorker(env: NodeJS.ProcessEnv = process.env): WorkspaceWorker | undefined {
  const ids = [env.RAILWAY_PROJECT_ID, env.RAILWAY_ENVIRONMENT_ID, env.RAILWAY_SERVICE_ID, env.RAILWAY_DEPLOYMENT_ID];
  if (ids.some(id => !id?.trim())) return undefined;
  return { provider: "railway", projectId: ids[0]!, environmentId: ids[1]!, serviceId: ids[2]!, deploymentId: ids[3]! };
}
export function verifyWorkspaceWorkerStopReceipt(
  receipt: string, binding: WorkspaceStopBinding, env: NodeJS.ProcessEnv = process.env, now = new Date(),
): WorkspaceWorkerStopProof | null {
  try {
    if (receipt.length > 16_000 || !validWorker(binding.worker)) return null;
    const parts = receipt.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "EdDSA" || header.typ !== "paperclip-workspace-worker-stop+jwt" || typeof header.kid !== "string") return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), cloudRuntimePublicKeyForKid(env, header.kid), Buffer.from(parts[2], "base64url"))) return null;
    const proof = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as WorkspaceWorkerStopProof;
    const seconds = Math.floor(now.getTime()/1000);
    if (proof.v !== 1 || proof.iss !== "paperclip-cloud" || proof.aud !== "paperclip-workspace-worker-stop/v1"
      || !env.PAPERCLIP_CLOUD_STACK_ID || proof.sub !== env.PAPERCLIP_CLOUD_STACK_ID || proof.stopped !== true
      || proof.runId !== binding.runId || proof.ownerToken !== binding.ownerToken
      || !Number.isInteger(proof.iat) || !Number.isInteger(proof.exp) || proof.iat > seconds+30
      || proof.exp <= seconds || proof.exp <= proof.iat || proof.exp-proof.iat > 60
      || !validWorker(proof.worker) || Object.keys(binding.worker).some(key => proof.worker[key as keyof WorkspaceWorker] !== binding.worker[key as keyof WorkspaceWorker])) return null;
    return proof;
  } catch { return null; }
}
export type WorkspaceWorkerStopCheck =
  | { status: "verified"; proof: WorkspaceWorkerStopProof }
  | { status: "pending" }
  | { status: "unsupported" };


export async function requestWorkspaceWorkerStopProof(binding: WorkspaceStopBinding, options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date;
} = {}): Promise<WorkspaceWorkerStopCheck> {
  const env = options.env ?? process.env;
  const context = getCloudStackContext(env);
  const token = env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!context?.stackId || !context.cloudOrigin || !token || !validWorker(binding.worker)) return { status: "unsupported" };
  let origin: URL;
  try { origin = new URL(context.cloudOrigin); } catch { return { status: "unsupported" }; }
  if (origin.protocol !== "https:" || origin.username || origin.password) return { status: "unsupported" };
  try {
    const response = await (options.fetchImpl ?? fetch)(`${origin.origin}/v1/tenant/workspace-worker-stop`, {
      method: "POST", redirect: "error", headers: { authorization: `Bearer ${token}`, "x-paperclip-cloud-stack-id": context.stackId, "content-type": "application/json" },
      body: JSON.stringify(binding), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return { status: "pending" };
    const payload = await response.json() as { receipt?: unknown };
    const proof = typeof payload?.receipt === "string"
      ? verifyWorkspaceWorkerStopReceipt(payload.receipt, binding, env, options.now) : null;
    return proof ? { status: "verified", proof } : { status: "pending" };
  } catch { return { status: "pending" }; }
}
