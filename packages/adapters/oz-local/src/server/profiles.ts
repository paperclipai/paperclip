import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";

export interface OzProfile {
  id: string;
  name: string;
}

/**
 * Run `oz agent profile list --output-format json` and parse the result.
 */
export async function listProfiles(
  command: string,
  env: Record<string, string>,
): Promise<OzProfile[]> {
  const proc = await runChildProcess(
    `oz-profile-list-${Date.now()}`,
    command,
    ["agent", "profile", "list", "--output-format", "json"],
    {
      cwd: process.cwd(),
      env,
      timeoutSec: 15,
      graceSec: 5,
      onLog: async () => {},
    },
  );
  if ((proc.exitCode ?? 1) !== 0) return [];
  try {
    const parsed = JSON.parse(proc.stdout.trim());
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is OzProfile =>
        typeof item === "object" &&
        item !== null &&
        typeof item.id === "string" &&
        item.id.length > 0 &&
        typeof item.name === "string",
    );
  } catch {
    return [];
  }
}

/**
 * Resolve a profile ID by name. Returns the ID if found, `null` otherwise.
 * Matching is case-insensitive. Profiles with id "Unsynced" are skipped.
 */
export async function resolveProfileByName(
  profileName: string,
  command: string,
  env: Record<string, string>,
): Promise<{ id: string; name: string } | null> {
  const profiles = await listProfiles(command, env);
  const needle = profileName.toLowerCase();
  const match = profiles.find(
    (p) => p.name.toLowerCase() === needle && p.id !== "Unsynced",
  );
  return match ?? null;
}
