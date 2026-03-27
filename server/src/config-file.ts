import fs from "node:fs";
import { ironworksConfigSchema, type IronworksConfig } from "@ironworksai/shared";
import { resolveIronworksConfigPath } from "./paths.js";

export function readConfigFile(): IronworksConfig | null {
  const configPath = resolveIronworksConfigPath();

  if (!fs.existsSync(configPath)) return null;

  try {
    const raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return ironworksConfigSchema.parse(raw);
  } catch {
    return null;
  }
}
