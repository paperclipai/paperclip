import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { forbidden } from "../errors.js";
import { accessService } from "./access.js";
import { isAgentInSubtree } from "./authorization.js";

const gatewayPort = z.number().int().min(1024).max(65535);
const slotSchema = z.object({
  port: gatewayPort,
  adminUrl: z.string().url(),
  adminTokenFile: z.string().min(1),
});
const policySchema = z.object({
  companyId: z.string().uuid(),
  projectId: z.string().uuid(),
  gatewayHost: z.string().url(),
  paperclipApiUrl: z.string().url(),
  profileConfig: z.record(z.string(), z.unknown()),
  allowReportingLineHires: z.boolean().default(false),
}).and(z.union([
  z.object({
    slots: z.array(slotSchema).min(1).max(256),
    ports: z.never().optional(),
    adminUrl: z.never().optional(),
    adminTokenFile: z.never().optional(),
  }),
  z.object({ adminUrl: z.string().url(), adminTokenFile: z.string().min(1),
    ports: z.tuple([gatewayPort]), slots: z.never().optional() }),
])).transform(policy => {
  if (policy.slots !== undefined) return { ...policy, slots: policy.slots };
  const { ports, adminUrl, adminTokenFile, ...common } = policy;
  return { ...common, slots: [{ port: ports[0], adminUrl, adminTokenFile }] };
});
export type Policy = z.infer<typeof policySchema>;

export function origin(value: string): URL {
  const url = new URL(value);
  if (
    !(url.protocol === "https:" || (url.protocol === "http:" && url.hostname === "127.0.0.1")) ||
    url.username || url.password || url.search || url.hash || url.pathname !== "/"
  ) throw new Error("Hermes lifecycle needs a private HTTPS or IPv4 loopback origin");
  return url;
}

export async function loadManagedHermesPolicy(companyId: string) {
  const file = process.env.PAPERCLIP_HERMES_PROFILE_POLICY_FILE;
  if (!file) throw new Error("No managed Hermes profile policy is configured");
  const contents = await readFile(file, "utf8");
  const policy = policySchema.parse(JSON.parse(contents));
  if (policy.companyId !== companyId) throw new Error("Managed Hermes profiles are unavailable for this company");
  const ports = new Set<number>();
  const managementOrigins = new Set<string>();
  const tokenFiles = new Set<string>();
  for (const slot of policy.slots) {
    const managementOrigin = origin(slot.adminUrl).origin;
    if (ports.has(slot.port) || managementOrigins.has(managementOrigin) || tokenFiles.has(slot.adminTokenFile)) {
      throw new Error("Each managed Hermes gateway needs its own port, Dashboard origin, and credential file");
    }
    ports.add(slot.port);
    managementOrigins.add(managementOrigin);
    tokenFiles.add(slot.adminTokenFile);
  }
  origin(policy.gatewayHost);
  origin(policy.paperclipApiUrl);
  return { policy, digest: createHash("sha256").update(contents).digest("hex") };
}

export async function assertManagedHermesReportingLine(
  db: Db, companyId: string, requester: string, manager: string | null | undefined,
) {
  const decision = await accessService(db).decide({
    actor: { type: "agent", agentId: requester, companyId, source: "agent_key" },
    action: "agents:create",
    resource: { type: "company", companyId },
  });
  if (!decision.allowed || !manager || !await isAgentInSubtree(db, companyId, requester, manager)) {
    throw forbidden("Choose a manager within your authorized reporting line");
  }
}

export async function approvedManagedHermesPolicy(companyId: string) {
  let binding;
  try {
    binding = await loadManagedHermesPolicy(companyId);
  } catch {
    throw forbidden("No operator-approved managed Hermes configuration is available for this company");
  }
  if (!binding.policy.allowReportingLineHires) {
    throw forbidden("The operator has not approved managed Hermes hiring in this reporting line");
  }
  return binding;
}
