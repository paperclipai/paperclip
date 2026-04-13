import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

/**
 * Detect the currently configured model for GitHub Copilot CLI.
 *
 * Reads `~/.copilot/config.json` which contains the model preference
 * set via `copilot --model <id>` or the Copilot settings UI.
 */
export async function detectModel(): Promise<{
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
} | null> {
  try {
    const configPath = path.join(os.homedir(), ".copilot", "config.json");
    const raw = await fs.readFile(configPath, "utf-8");
    const config = JSON.parse(raw) as Record<string, unknown>;
    const model = typeof config.model === "string" ? config.model.trim() : "";
    if (!model) return null;

    const provider = inferProvider(model);
    return {
      model,
      provider,
      source: "copilot_config",
    };
  } catch {
    return null;
  }
}

function inferProvider(model: string): string {
  if (model.startsWith("claude-") || model.startsWith("claude_")) return "anthropic";
  if (model.startsWith("gpt-") || model.startsWith("o1") || model.startsWith("o3") || model.startsWith("o4"))
    return "openai";
  return "unknown";
}
