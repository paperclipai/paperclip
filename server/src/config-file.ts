import fs from "node:fs";
import { aiteamcorpConfigSchema, type PaperclipConfig } from "@aiteamcorp/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return aiteamcorpConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
