import { createHmac, verify } from "node:crypto";
import { z } from "zod";
import { cloudRuntimePublicKeyForKid } from "./cloud-runtime-identity.js";
import { getCloudStackContext } from "./cloud-instance.js";

const bindingSchema = z.object({
  companyId: z.string().uuid(), issueId: z.string().uuid(), runId: z.string().uuid(),
  leaseId: z.string().uuid(), ownerToken: z.string().uuid(), provider: z.literal("daytona"),
  providerLeaseId: z.string().uuid(),
});
export type SandboxAbsenceBinding = z.infer<typeof bindingSchema>;
export type SandboxAbsenceProof = SandboxAbsenceBinding & {
  v: 1; iss: "paperclip-cloud"; aud: "paperclip-sandbox-absence/v1"; sub: string;
  absent: true; iat: number; exp: number;
};

export function verifySandboxAbsenceReceipt(receipt: string, binding: SandboxAbsenceBinding,
  env: NodeJS.ProcessEnv = process.env, now = new Date()): SandboxAbsenceProof | null {
  try {
    const parsed = bindingSchema.safeParse(binding);
    if (receipt.length > 16_000 || !parsed.success) return null;
    const parts = receipt.split(".");
    if (parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) return null;
    const header = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
    if (header.alg !== "EdDSA" || header.typ !== "paperclip-sandbox-absence+jwt" || typeof header.kid !== "string") return null;
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`, "ascii"), cloudRuntimePublicKeyForKid(env, header.kid), Buffer.from(parts[2], "base64url"))) return null;
    const proof = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as SandboxAbsenceProof;
    const seconds = Math.floor(now.getTime() / 1000);
    if (proof.v !== 1 || proof.iss !== "paperclip-cloud" || proof.aud !== "paperclip-sandbox-absence/v1"
      || !env.PAPERCLIP_CLOUD_STACK_ID || proof.sub !== env.PAPERCLIP_CLOUD_STACK_ID || proof.absent !== true
      || Object.keys(parsed.data).some(key => proof[key as keyof SandboxAbsenceBinding] !== parsed.data[key as keyof SandboxAbsenceBinding])
      || !Number.isInteger(proof.iat) || !Number.isInteger(proof.exp) || proof.iat > seconds + 30
      || proof.exp <= seconds || proof.exp <= proof.iat || proof.exp - proof.iat > 60) return null;
    return proof;
  } catch { return null; }
}

export async function requestSandboxAbsenceProof(binding: SandboxAbsenceBinding, options: {
  env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; now?: Date;
} = {}): Promise<{ proof: SandboxAbsenceProof; receipt: string } | null> {
  const env = options.env ?? process.env;
  const context = getCloudStackContext(env);
  const secret = env.PAPERCLIP_AUTH_SECRET ?? env.BETTER_AUTH_SECRET;
  const parsed = bindingSchema.safeParse(binding);
  if (!context?.stackId || !context.primaryHost || !context.cloudOrigin || !secret?.trim() || !parsed.success) return null;
  try {
    const origin = new URL(context.cloudOrigin);
    const host = new URL(`https://${context.primaryHost}`);
    if (origin.protocol !== "https:" || origin.username || origin.password || host.hostname !== context.primaryHost.toLowerCase()) return null;
    const capability = createHmac("sha256", secret).update(`paperclip-cloud-sandbox-absence-v1\n${host.hostname}`).digest("hex");
    const response = await (options.fetchImpl ?? fetch)(`${origin.origin}/v1/tenant/sandbox-absence`, {
      method: "POST", redirect: "error", signal: AbortSignal.timeout(10_000),
      headers: { authorization: `Bearer ${capability}`, "x-paperclip-cloud-tenant-host": host.hostname, "content-type": "application/json" },
      body: JSON.stringify(parsed.data),
    });
    if (!response.ok) return null;
    const payload = await response.json() as { receipt?: unknown };
    if (typeof payload.receipt !== "string") return null;
    const proof = verifySandboxAbsenceReceipt(payload.receipt, binding, env, options.now);
    return proof ? { proof, receipt: payload.receipt } : null;
  } catch { return null; }
}
