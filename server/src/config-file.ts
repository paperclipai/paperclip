import fs from "node:fs";
import { odysseusConfigSchema, type OdysseusConfig } from "@odysseus/shared";
import { resolveOdysseusConfigPath } from "./paths.js";

export function readConfigFile(): OdysseusConfig | null {
  const configPath = resolveOdysseusConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return odysseusConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
