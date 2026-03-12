import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { parseJson } from "@paperclipai/adapter-utils/server-utils";
import {
  DEFAULT_CLAUDE_MODELS,
  resolveClaudeModelsFromSettings,
} from "../models.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function mergeSettings(
  base: Record<string, unknown> | null,
  override: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!base) return override;
  if (!override) return base;

  const merged: Record<string, unknown> = { ...base, ...override };
  const baseEnv = asRecord(base.env) ?? {};
  const overrideEnv = asRecord(override.env) ?? {};
  if (Object.keys(baseEnv).length > 0 || Object.keys(overrideEnv).length > 0) {
    merged.env = { ...baseEnv, ...overrideEnv };
  }
  return merged;
}

async function readClaudeSettingsFile(filePath: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(filePath, "utf-8").catch(() => null);
  if (!raw) return null;
  return parseJson(raw);
}

async function readClaudeSettings(): Promise<Record<string, unknown> | null> {
  const claudeDir = path.join(os.homedir(), ".claude");
  const globalSettings = await readClaudeSettingsFile(path.join(claudeDir, "settings.json"));
  const localSettings = await readClaudeSettingsFile(path.join(claudeDir, "settings.local.json"));
  return mergeSettings(globalSettings, localSettings);
}

export { DEFAULT_CLAUDE_MODELS, resolveClaudeModelsFromSettings } from "../models.js";

export async function listClaudeModels(): Promise<AdapterModel[]> {
  try {
    const settings = await readClaudeSettings();
    return resolveClaudeModelsFromSettings(settings);
  } catch {
    return DEFAULT_CLAUDE_MODELS;
  }
}