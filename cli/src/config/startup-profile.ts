import fs from "node:fs";
import path from "node:path";

export type RepoStartupProfile = {
  paperclipHome: string;
  instanceId: string;
  configPath: string;
  lastUsedAt: string | null;
  profilePath: string;
};

function findProfilePath(startDir: string): string | null {
  let currentDir = path.resolve(startDir);
  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", "local-start.json");
    if (fs.existsSync(candidate)) return candidate;
    const parentDir = path.resolve(currentDir, "..");
    if (parentDir === currentDir) return null;
    currentDir = parentDir;
  }
}

export function readRepoStartupProfile(startDir = process.cwd()): RepoStartupProfile | null {
  const profilePath = findProfilePath(startDir);
  if (!profilePath) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(profilePath, "utf8"));
    if (
      typeof parsed.paperclipHome !== "string" ||
      typeof parsed.instanceId !== "string" ||
      typeof parsed.configPath !== "string"
    ) {
      return null;
    }
    return {
      paperclipHome: path.resolve(parsed.paperclipHome),
      instanceId: parsed.instanceId,
      configPath: path.resolve(parsed.configPath),
      lastUsedAt: typeof parsed.lastUsedAt === "string" ? parsed.lastUsedAt : null,
      profilePath,
    };
  } catch {
    return null;
  }
}

export function readRecentLaunchHistory(
  profile: RepoStartupProfile,
  limit = 10,
): Array<Record<string, unknown>> {
  // Launch history lives with the resolved instance, not the checkout, so the
  // CLI can explain exactly which runtime a repo-local profile points at.
  const historyPath = path.resolve(
    profile.paperclipHome,
    "instances",
    profile.instanceId,
    "logs",
    "launch-history.jsonl",
  );
  if (!fs.existsSync(historyPath)) return [];

  const lines = fs.readFileSync(historyPath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-limit);

  const rows: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        rows.push(parsed as Record<string, unknown>);
      }
    } catch {
      // Ignore malformed rows so doctor can still show the rest of history.
    }
  }
  return rows;
}
