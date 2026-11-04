import { createHmac, verify } from "node:crypto";
import { z } from "zod";
import { cloudRuntimePublicKeyForKid } from "./cloud-runtime-identity.js";
import { getCloudStackContext } from "./cloud-instance.js";

const bindingSchema = z.object({
  companyId: z.string().uuid(), issueId: z.string().uuid(), runId: z.string().uuid(),
  leaseId: z.string().uuid(), ownerToken: z.string().uuid(), provider: z.literal("daytona"),
  providerLeaseId: z.string().uuid(),
}).strict();
const cleanupBindingSchema = z.object({
  purpose: z.literal("cleanup"), companyId: z.string().uuid(), environmentId: z.string().uuid(),
  leaseId: z.string().uuid(), heartbeatRunId: z.string().uuid().nullable(),
  provider: z.literal("daytona"), providerLeaseId: z.string().uuid(),
}).strict();
export type SandboxAbsenceBinding = z.infer<typeof bindingSchema>;
export type SandboxCleanupAbsenceBinding = z.infer<typeof cleanupBindingSchema>;
export type SandboxCleanupAbsenceProof = SandboxCleanupAbsenceBinding & {
  v: 1; iss: "paperclip-cloud"; aud: "paperclip-sandbox-cleanup-absence/v1"; sub: string;
  absent: true; iat: number; exp: number;
};
export type SandboxAbsenceProof = SandboxAbsenceBinding & {
  v: 1; iss: "paperclip-cloud"; aud: "paperclip-sandbox-absence/v1"; sub: string;
  absent: true; iat: number; exp: number;
};

export function verifySandboxAbsenceReceipt(receipt: string, binding: SandboxAbsenceBinding,
  env: NodeJS.ProcessEnv = process.env, now = new Date()): SandboxAbsenceProof | null {
  const parsed = bindingSchema.safeParse(binding);
  return parsed.success ? verifyReceipt(receipt, parsed.data, "sandbox-absence", env, now) as SandboxAbsenceProof | null : null;
}

export function verifySandboxCleanupAbsenceReceipt(receipt: string, binding: SandboxCleanupAbsenceBinding,
  env: NodeJS.ProcessEnv = process.env, now = new Date()): SandboxCleanupAbsenceProof | null {
  const parsed = cleanupBindingSchema.safeParse(binding);
  return parsed.success ? verifyReceipt(receipt, parsed.data, "sandbox-cleanup-absence", env, now) as SandboxCleanupAbsenceProof | null : null;
}

function verifyReceipt(receipt: string, binding: Record<string, unknown>, purpose: string,
  env: NodeJS.ProcessEnv, now: Date): Record<string, unknown> | null {
  try {
    if (receipt.length > 16_000) return null;
    const parts = receipt.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "EdDSA" || header.typ !== `paperclip-${purpose}+jwt` || typeof header.kid !== "string") return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), cloudRuntimePublicKeyForKid(env, header.kid), Buffer.from(parts[2], "base64url"))) return null;
    const proof = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const seconds = Math.floor(now.getTime() / 1000);
    if (proof.v !== 1 || proof.iss !== "paperclip-cloud" || proof.aud !== `paperclip-${purpose}/v1`
      || !env.PAPERCLIP_CLOUD_STACK_ID || proof.sub !== env.PAPERCLIP_CLOUD_STACK_ID || proof.absent !== true
      || Object.keys(binding).some(key => proof[key] !== binding[key])
      || !Number.isInteger(proof.iat) || !Number.isInteger(proof.exp) || proof.iat > seconds + 30
      || proof.exp <= seconds || proof.exp <= proof.iat || proof.exp - proof.iat > 60) return null;
    return proof;
  } catch { return null; }
}

export async function requestSandboxAbsenceProof(binding: SandboxAbsenceBinding, options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date;
} = {}): Promise<{ proof: SandboxAbsenceProof; receipt: string } | null> {
  const parsed = bindingSchema.safeParse(binding);
  if (!parsed.success) return null;
  const receipt = await requestReceipt(parsed.data, options);
  if (!receipt) return null;
  const proof = verifySandboxAbsenceReceipt(receipt, parsed.data, options.env, options.now);
  return proof ? { proof, receipt } : null;
}

/** Cleanup-only observation: never grants continuation authority to a run. */
export async function inspectCloudSandboxCleanupAbsence(lease: {
  id: string; companyId: string; environmentId: string | null; heartbeatRunId: string | null;
  provider: string | null; providerLeaseId: string | null;
}, options: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date } = {}) {
  const parsed = cleanupBindingSchema.safeParse({ purpose: "cleanup", companyId: lease.companyId,
    environmentId: lease.environmentId, leaseId: lease.id, heartbeatRunId: lease.heartbeatRunId,
    provider: lease.provider, providerLeaseId: lease.providerLeaseId });
  if (!parsed.success) return undefined;
  const receipt = await requestReceipt(parsed.data, options);
  if (!receipt || !verifySandboxCleanupAbsenceReceipt(receipt, parsed.data, options.env, options.now)) return undefined;
  return { providerLeaseId: parsed.data.providerLeaseId, state: "destroyed" as const };
}

async function requestReceipt(binding: Record<string, unknown>, options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch;
}): Promise<string | null> {
  const env = options.env ?? process.env;
  const context = getCloudStackContext(env);
  const secret = env.PAPERCLIP_AUTH_SECRET ?? env.BETTER_AUTH_SECRET;
  if (!context?.stackId || !context.primaryHost || !context.cloudOrigin || !secret?.trim()) return null;
  try {
    const origin = new URL(context.cloudOrigin);
    const host = new URL(`https://${context.primaryHost}`);
    if (origin.protocol !== "https:" || origin.username || origin.password || host.hostname !== context.primaryHost.toLowerCase()) return null;
    const capability = createHmac("sha256", secret).update(`paperclip-cloud-sandbox-absence-v1\n${host.hostname}`).digest("hex");
    const response = await (options.fetchImpl ?? fetch)(`${origin.origin}/v1/tenant/sandbox-absence`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${capability}`, "x-paperclip-cloud-tenant-host": host.hostname, "content-type": "application/json" },
      body: JSON.stringify(binding),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { receipt?: unknown };
    if (typeof payload.receipt !== "string") return null;
    return payload.receipt;
  } catch { return null; }
}
