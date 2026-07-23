import fs from "node:fs";
import { paperclipConfigSchema } from "../config/schema.js";
import { readConfig, configExists, resolveConfigPath, writeConfig } from "../config/store.js";
import type { CheckResult } from "./index.js";

const AUTO_HEAL_SOURCE = "doctor" as const;

export function configCheck(configPath?: string): CheckResult {
  const filePath = resolveConfigPath(configPath);

  if (!configExists(configPath)) {
    return {
      name: "Config file",
      status: "fail",
      message: `Config file not found at ${filePath}`,
      canRepair: false,
      repairHint: "Run `paperclipai onboard` to create one",
    };
  }

  try {
    readConfig(configPath);
    return {
      name: "Config file",
      status: "pass",
      message: `Valid config at ${filePath}`,
    };
  } catch (err) {
    const heal = detectSourceOnlyHeal(filePath);
    if (heal) {
      return {
        name: "Config file",
        status: "fail",
        message: `Invalid config: ${err instanceof Error ? err.message : String(err)}`,
        canRepair: true,
        repairHint: `Reset $meta.source to "${AUTO_HEAL_SOURCE}" (was ${JSON.stringify(heal.invalidValue)})`,
        repair: () => {
          writeConfig(heal.repaired, configPath);
        },
      };
    }
    return {
      name: "Config file",
      status: "fail",
      message: `Invalid config: ${err instanceof Error ? err.message : String(err)}`,
      canRepair: false,
      repairHint: "Run `paperclipai configure --section database` (or `paperclipai onboard` to recreate)",
    };
  }
}

function detectSourceOnlyHeal(
  filePath: string,
): { repaired: ReturnType<typeof paperclipConfigSchema.parse>; invalidValue: unknown } | null {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;

  const meta = (raw as { $meta?: unknown }).$meta;
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return null;
  const invalidValue = (meta as { source?: unknown }).source;

  const patched = {
    ...(raw as Record<string, unknown>),
    $meta: { ...(meta as Record<string, unknown>), source: AUTO_HEAL_SOURCE },
  };
  const reparsed = paperclipConfigSchema.safeParse(patched);
  if (!reparsed.success) return null;

  // Only auto-heal if the original failure was driven solely by the source enum.
  const original = paperclipConfigSchema.safeParse(raw);
  if (original.success) return null;
  const issues = original.error.issues;
  const onlySourceIssue =
    issues.length === 1 &&
    issues[0]?.code === "invalid_enum_value" &&
    Array.isArray(issues[0]?.path) &&
    issues[0].path.length === 2 &&
    issues[0].path[0] === "$meta" &&
    issues[0].path[1] === "source";
  if (!onlySourceIssue) return null;

  return { repaired: reparsed.data, invalidValue };
}
