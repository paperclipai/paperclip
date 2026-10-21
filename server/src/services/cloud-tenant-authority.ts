import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { z } from "zod";
import { logger } from "../middleware/logger.js";
import { getCloudStackContext } from "./cloud-instance.js";
import { instanceSettingsService } from "./instance-settings.js";

/** Shared by authenticated request admission and delayed work admission. */
export async function resolveOwnerInstanceAdmin(db: Db, stackRole: string): Promise<boolean> {
  if (stackRole !== "owner") return false;
  try {
    return (await instanceSettingsService(db).getExperimental()).enableOwnerInstanceAdmin === true;
  } catch (err) {
    logger.warn({ err }, "Failed to resolve enableOwnerInstanceAdmin for cloud tenant owner; treating elevation as disabled");
    return false;
  }
}

const portfolioSchema = z.object({ stacks: z.array(z.object({
  stackSlug: z.string().min(1), role: z.enum(["owner", "admin", "member", "support", "viewer"]), isCurrent: z.boolean(),
})).max(1_000) });

type CloudOwnerIdentity = { userId: string; origin: string; stackId: string; stackSlug: string; tokenFingerprint: string };
export type CurrentCloudOwnerAuthority = Readonly<CloudOwnerIdentity & { role: "owner" | "admin" | "member" | "support" | "viewer"; checkedAtMs: number }>;

function currentIdentity(userId: string): CloudOwnerIdentity | null {
  const context = getCloudStackContext();
  const token = process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN?.trim();
  if (!userId || !context?.cloudOrigin || !context.stackId || !context.stackSlug || !token) return null;
  try {
    const origin = new URL(context.cloudOrigin);
    if (!["https:", "http:"].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== "/") return null;
    return { userId, origin: origin.origin, stackId: context.stackId, stackSlug: context.stackSlug,
      tokenFingerprint: createHash("sha256").update(token).digest("hex") };
  } catch { return null; }
}

/** Uncached, bounded current Cloud authority. Call before taking task locks. */
export async function loadCurrentCloudOwnerAuthority(userId: string): Promise<CurrentCloudOwnerAuthority | null> {
  const identity = currentIdentity(userId);
  if (!identity) return null;
  try {
    const response = await fetch(new URL("/v1/tenant/portfolio", identity.origin), {
      method: "GET", redirect: "error", cache: "no-store", signal: AbortSignal.timeout(10_000),
      headers: { accept: "application/json", authorization: `Bearer ${process.env.PAPERCLIP_CLOUD_TENANT_SERVER_TOKEN!.trim()}`,
        "x-paperclip-cloud-user-id": userId, "x-paperclip-cloud-stack-id": identity.stackId },
    });
    if (!response.ok) return null;
    const parsed = portfolioSchema.safeParse(await response.json());
    if (!parsed.success) return null;
    const current = parsed.data.stacks.filter(stack => stack.isCurrent);
    if (current.length !== 1 || current[0]!.stackSlug !== identity.stackSlug ||
      parsed.data.stacks.filter(stack => stack.stackSlug === identity.stackSlug).length !== 1) return null;
    return Object.freeze({ ...identity, role: current[0]!.role, checkedAtMs: Date.now() });
  } catch { return null; }
}

/** Correlate a fresh remote read with the exact deployment/user being applied. */
export function isCurrentCloudTenantAuthority(userId: string, authority?: CurrentCloudOwnerAuthority | null): authority is CurrentCloudOwnerAuthority {
  const identity = currentIdentity(userId);
  return !!authority && !!identity && authority.userId === identity.userId && authority.origin === identity.origin &&
    authority.stackId === identity.stackId && authority.stackSlug === identity.stackSlug && authority.tokenFingerprint === identity.tokenFingerprint &&
    authority.checkedAtMs <= Date.now() && Date.now() - authority.checkedAtMs <= 10_000;
}

/** Recheck both deployment identity and the current managed setting at apply. */
export async function isCurrentCloudOwnerInstanceAdmin(db: Db, userId: string, authority?: CurrentCloudOwnerAuthority | null): Promise<boolean> {
  if (!isCurrentCloudTenantAuthority(userId, authority)) return false;
  const elevated = await resolveOwnerInstanceAdmin(db, authority.role);
  return elevated && isCurrentCloudTenantAuthority(userId, authority);
}
