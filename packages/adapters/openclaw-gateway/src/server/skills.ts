import { fileURLToPath } from "node:url";
import path from "node:path";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";
import { gatewayRpc } from "./gateway-rpc.js";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

interface GatewaySkillInfo {
  key?: string;
  name?: string;
  description?: string;
  enabled?: boolean;
  location?: string;
  eligible?: boolean;
  missingRequirements?: string[];
}

interface GatewaySkillsPayload {
  skills?: GatewaySkillInfo[];
}

/**
 * Query OpenClaw gateway for native skills via skills.status RPC.
 * Returns empty array on failure (non-blocking — gateway may be offline).
 */
async function queryGatewaySkills(config: Record<string, unknown>): Promise<GatewaySkillInfo[]> {
  const result = await gatewayRpc<GatewaySkillsPayload>(config, "skills.status", {}, 8_000);
  if (!result.ok || !result.payload?.skills) return [];
  return result.payload.skills;
}

/**
 * Build a skill snapshot for the OpenClaw Gateway adapter.
 *
 * Two skill sources:
 * 1. Paperclip-bundled skills — listed from the adapter's local skills directory,
 *    injected into the wake message at execution time (hash-based dedup).
 * 2. OpenClaw native skills — queried via skills.status RPC from the gateway.
 *    Displayed in the UI for visibility. Toggles saved in Paperclip config,
 *    enforced via prompt instruction at execution time (soft control).
 */
async function buildOpenClawSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => ({
    key: entry.key,
    runtimeName: entry.runtimeName,
    desired: desiredSet.has(entry.key),
    managed: true,
    state: desiredSet.has(entry.key) ? "configured" : "available",
    origin: entry.required ? "paperclip_required" : "company_managed",
    originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
    readOnly: false,
    sourcePath: entry.source,
    targetPath: null,
    detail: desiredSet.has(entry.key)
      ? "Will be injected into the agent session on the next run (message-based, hash-deduped)."
      : null,
    required: Boolean(entry.required),
    requiredReason: entry.requiredReason ?? null,
  }));

  // Query OpenClaw gateway for native skills
  const gatewaySkills = await queryGatewaySkills(config);
  for (const gs of gatewaySkills) {
    const key = `openclaw/${gs.key || gs.name || "unknown"}`;
    // If explicitly in desiredSet, use that. Otherwise default to gateway's enabled state.
    const isDesired = desiredSet.has(key) ? true : (gs.enabled !== false);
    if (isDesired && !desiredSet.has(key)) {
      // Add enabled gateway skills to desiredSkills so the UI draft shows them checked
      desiredSkills.push(key);
      desiredSet.add(key);
    }
    entries.push({
      key,
      runtimeName: gs.name ?? gs.key ?? null,
      desired: isDesired,
      managed: false,
      state: isDesired ? "installed" : "available",
      origin: "user_installed",
      originLabel: "OpenClaw Gateway",
      readOnly: false,
      sourcePath: gs.location ?? undefined,
      targetPath: undefined,
      detail: gs.description ?? null,
    });
  }

  const warnings: string[] = [];

  for (const desiredSkill of desiredSkills) {
    if (entries.some((e) => e.key === desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: undefined,
      targetPath: undefined,
      detail: "Paperclip cannot find this skill.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "openclaw_gateway",
    supported: true,
    mode: "ephemeral",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listOpenClawSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildOpenClawSkillSnapshot(ctx.config);
}

export async function syncOpenClawSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildOpenClawSkillSnapshot(ctx.config);
}
