import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  AdapterSkillContext,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import {
  buildRuntimeMountedSkillSnapshot,
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
  const desiredSkills = resolvePaperclipDesiredSkillNames(config, availableEntries);
  const supported = acpxAgent !== "custom";
  const warnings: string[] = supported
    ? []
    : [
        "Custom ACP commands do not expose a Paperclip skill integration contract yet; selected skills are tracked only.",
      ];

  return buildRuntimeMountedSkillSnapshot({
    adapterType: "acpx_local",
    availableEntries,
    desiredSkills,
    supported,
    mode: supported ? "ephemeral" : "unsupported",
    configuredDetail: configuredDetail(acpxAgent),
    unsupportedDetail: unsupportedDetail(),
    warnings,
  });
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
