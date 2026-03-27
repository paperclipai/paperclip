/**
 * Detect the current model from the user's Hermes config.
 *
 * Reads ~/.hermes/config.yaml and extracts the default model
 * and provider settings.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

export interface DetectedModel {
  model: string;
  provider: string;
  source: "config";
}

/**
 * Read the Hermes config file and extract the default model.
 */
export async function detectModel(
  configPath?: string,
): Promise<DetectedModel | null> {
  const filePath = configPath ?? join(homedir(), ".hermes", "config.yaml");

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch {
    return null;
  }

  return parseModelFromConfig(content);
}

/**
 * Parse model.default and model.provider from raw YAML content.
 * Uses simple regex parsing to avoid a YAML dependency.
 */
export function parseModelFromConfig(content: string): DetectedModel | null {
  const lines = content.split("\n");
  let model = "";
  let provider = "";
  let inModelSection = false;
  let modelSectionIndent = 0;

  for (const line of lines) {
    const trimmed = line.trimEnd();
    const indent = line.length - line.trimStart().length;

    // Track model: section (indent 0)
    if (/^model:\s*$/.test(trimmed) && indent === 0) {
      inModelSection = true;
      modelSectionIndent = 0;
      continue;
    }

    // We left the model section if indent drops back to the section level or below
    if (inModelSection && indent <= modelSectionIndent && trimmed && !trimmed.startsWith("#")) {
      inModelSection = false;
    }

    if (inModelSection) {
      const match = trimmed.match(/^\s*(\w+)\s*:\s*(.+)$/);
      if (match) {
        const key = match[1];
        const val = match[2].trim().replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
        if (key === "default") model = val;
        if (key === "provider") provider = val;
      }
    }
  }

  if (!model) return null;

  return { model, provider, source: "config" };
}
