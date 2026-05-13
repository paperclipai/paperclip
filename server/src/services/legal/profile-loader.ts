import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { load as parseYaml } from "js-yaml";
import type { ProfileDefinition } from "./types.js";

/**
 * Load and validate a single profile YAML file.
 *
 * Profiles configure the active install (small-firm, in-house-dept) — they
 * select which specialists are enabled and bind each risk-gate to an approver.
 */
export async function loadProfile(filePath: string): Promise<ProfileDefinition> {
  const text = await readFile(filePath, "utf8");
  const parsed = parseYaml(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Profile file is not a YAML object: ${filePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (typeof obj["profile"] !== "string" || obj["profile"].length === 0) {
    throw new Error(`Profile file missing 'profile' string key: ${filePath}`);
  }
  if (!obj["risk_gates"] || typeof obj["risk_gates"] !== "object") {
    throw new Error(`Profile '${obj["profile"]}' missing 'risk_gates' object: ${filePath}`);
  }
  return parsed as ProfileDefinition;
}

/**
 * Load every profile YAML in `dir`. Returns map keyed by profile key.
 */
export async function loadProfiles(dir: string): Promise<Record<string, ProfileDefinition>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const yamlFiles = entries
    .filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
    .map((e) => path.join(dir, e.name))
    .sort();

  const profiles: Record<string, ProfileDefinition> = {};
  for (const file of yamlFiles) {
    const profile = await loadProfile(file);
    if (profiles[profile.profile]) {
      throw new Error(
        `Duplicate profile key '${profile.profile}' loading ${file}; already defined`,
      );
    }
    profiles[profile.profile] = profile;
  }
  return profiles;
}

/**
 * Resolve the active profile by key. Throws if not found in the loaded set.
 */
export function selectProfile(
  profiles: Record<string, ProfileDefinition>,
  profileKey: string,
): ProfileDefinition {
  const profile = profiles[profileKey];
  if (!profile) {
    const known = Object.keys(profiles).sort().join(", ") || "<none>";
    throw new Error(
      `Profile '${profileKey}' not found in loaded set. Known profiles: ${known}`,
    );
  }
  return profile;
}
