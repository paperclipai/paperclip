import fs from "node:fs";
import { valadrienOsConfigSchema, type ValadrienOsConfig } from "@valadrien-os/shared";
import { resolveValadrienOsConfigPath } from "./paths.js";

export function readConfigFile(): ValadrienOsConfig | null {
  const configPath = resolveValadrienOsConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return valadrienOsConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
