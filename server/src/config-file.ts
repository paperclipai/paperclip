import fs from "node:fs";
import { aiteamcorpConfigSchema, type AiTeamCorpConfig } from "@aiteamcorp/shared";
import { resolveAiTeamCorpConfigPath } from "./paths.js";

export function readConfigFile(): AiTeamCorpConfig | null {
  const configPath = resolveAiTeamCorpConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return aiteamcorpConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
