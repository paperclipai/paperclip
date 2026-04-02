import type {
  AdapterSkillContext,
  AdapterSkillEntry,
  AdapterSkillSnapshot,
} from "@paperclipai/adapter-utils";
import { asString, parseObject } from "@paperclipai/adapter-utils/server-utils";
import { FleetOSClient } from "../shared/fleetos-client.js";

/**
 * List hermes skills available inside the FleetOS container by executing
 * `hermes skills list --json` via the FleetOS exec API.
 *
 * TODO: Refine once hermes CLI skills output format is finalized.
 */
export async function listSkills(ctx: AdapterSkillContext): Promise<AdapterSkillSnapshot> {
  const config = parseObject(ctx.config);
  const fleetosUrl = asString(config.fleetosUrl, "");
  const apiKey = asString(config.apiKey, "");
  const containerId = asString(config.containerId, "");

  if (!fleetosUrl || !apiKey || !containerId) {
    return {
      adapterType: "hermes_fleetos",
      supported: false,
      mode: "unsupported",
      desiredSkills: [],
      entries: [],
      warnings: ["FleetOS adapter config incomplete — cannot list skills."],
    };
  }

  const client = new FleetOSClient(fleetosUrl, apiKey);
  const hermesCommand = asString(config.hermesCommand, "hermes");

  try {
    const result = await client.exec(
      containerId,
      [hermesCommand, "skills", "list", "--json"],
      15_000,
    );

    if (result.exit_code !== 0) {
      return {
        adapterType: "hermes_fleetos",
        supported: true,
        mode: "persistent",
        desiredSkills: [],
        entries: [],
        warnings: [
          `hermes skills list failed with exit code ${result.exit_code}: ${result.stderr.trim().split(/\r?\n/)[0] ?? "unknown error"}`,
        ],
      };
    }

    // TODO: Parse hermes skills JSON output into AdapterSkillEntry[]
    // For now, attempt best-effort parsing
    const entries: AdapterSkillEntry[] = [];
    try {
      const parsed = JSON.parse(result.stdout) as Array<{
        name: string;
        installed?: boolean;
        path?: string;
      }>;

      if (Array.isArray(parsed)) {
        for (const skill of parsed) {
          if (typeof skill.name !== "string") continue;
          entries.push({
            key: skill.name,
            runtimeName: skill.name,
            desired: true,
            managed: false,
            state: skill.installed ? "installed" : "available",
            origin: "external_unknown",
            originLabel: "Hermes container skill",
            readOnly: true,
            sourcePath: skill.path ?? null,
            targetPath: null,
            detail: `Discovered via hermes skills list in container ${containerId}.`,
          });
        }
      }
    } catch (parseErr: unknown) {
      // JSON parse failed — stdout may not be valid JSON
      console.warn(
        `[skills] Failed to parse hermes skills JSON output:`,
        parseErr instanceof Error ? parseErr.message : parseErr,
        `| raw stdout: ${result.stdout.slice(0, 500)}`,
      );
    }

    return {
      adapterType: "hermes_fleetos",
      supported: true,
      mode: "persistent",
      desiredSkills: entries.filter((e) => e.desired).map((e) => e.key),
      entries,
      warnings: [],
    };
  } catch (err) {
    return {
      adapterType: "hermes_fleetos",
      supported: true,
      mode: "persistent",
      desiredSkills: [],
      entries: [],
      warnings: [
        `Failed to list skills from FleetOS container: ${err instanceof Error ? err.message : String(err)}`,
      ],
    };
  }
}
