import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  readPaperclipRuntimeSkillEntries,
  resolvePaperclipDesiredSkillNames,
} from "@paperclipai/adapter-utils/server-utils";

const __moduleDir = path.dirname(fileURLToPath(import.meta.url));

type AcpxSkillAgent = "claude" | "codex" | "custom";

function normalizeAcpxSkillAgent(config: Record<string, unknown>): AcpxSkillAgent {
  const configured = typeof config.agent === "string" ? config.agent.trim() : "";
  if (configured === "codex" || configured === "custom") return configured;
  if (configured === "claude" || configured === "") return "claude";
  return "claude";
}

function configuredDetail(agent: AcpxSkillAgent): string {
  if (agent === "codex") {
    return "Will be linked into the effective CODEX_HOME/skills/ directory for the next ACPX Codex session.";
  }
  return "Will be mounted into the next ACPX Claude session.";
}

function unsupportedDetail(): string {
  return "Desired state is stored in Paperclip only; custom ACP commands need an explicit skill integration contract before runtime sync is available.";
}

async function buildAcpxSkillSnapshot(config: Record<string, unknown>): Promise<AdapterSkillSnapshot> {
  const acpxAgent = normalizeAcpxSkillAgent(config);
  const availableEntries = await readPaperclipRuntimeSkillEntries(config, __moduleDir);
  const availableByKey = new Map(availableEntries.map((entry) => [entry.key, entry]));
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const desiredSet = new Set(desiredSkills);
  const supported = acpxAgent !== "custom";
  const warnings: string[] = supported
    ? []
    : [
        "Custom ACP commands do not expose a Paperclip skill integration contract yet; selected skills are tracked only.",
      ];

  const entries: AdapterSkillEntry[] = availableEntries.map((entry) => {
    const desired = desiredSet.has(entry.key);
    return {
      key: entry.key,
      runtimeName: entry.runtimeName,
      desired,
      managed: true,
      state: desired ? "configured" : "available",
      origin: entry.required ? "paperclip_required" : "company_managed",
      originLabel: entry.required ? "Required by Paperclip" : "Managed by Paperclip",
      readOnly: false,
      sourcePath: entry.source,
      targetPath: null,
      detail: desired ? (supported ? configuredDetail(acpxAgent) : unsupportedDetail()) : null,
      required: Boolean(entry.required),
      requiredReason: entry.requiredReason ?? null,
    };
  });

  for (const desiredSkill of desiredSkills) {
    if (availableByKey.has(desiredSkill)) continue;
    warnings.push(`Desired skill "${desiredSkill}" is not available from the Paperclip skills directory.`);
    entries.push({
      key: desiredSkill,
      runtimeName: null,
      desired: true,
      managed: true,
      state: "missing",
      origin: "external_unknown",
      originLabel: "External or unavailable",
      readOnly: false,
      sourcePath: null,
      targetPath: null,
      detail: "Paperclip cannot find this skill in the local runtime skills directory.",
    });
  }

  entries.sort((left, right) => left.key.localeCompare(right.key));

  return {
    adapterType: "acpx_local",
    supported,
    mode: supported ? "ephemeral" : "unsupported",
    desiredSkills,
    entries,
    warnings,
  };
}

export async function listAcpxSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  return buildAcpxSkillSnapshot(ctx.config);
}

export async function syncAcpxSkills(
  ctx: AdapterSkillContext,
  _desiredSkills: string[],
): Promise<AdapterSkillSnapshot> {
  return buildAcpxSkillSnapshot(ctx.config);
}
