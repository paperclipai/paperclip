import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Detect the user's default Copilot CLI model from ~/.copilot/config.json.
 *
 * The Copilot CLI stores the active model as a top-level `"model"` field
 * (set via the `/model` slash-command during a session).
 *
 * Returns `{ model, provider: "copilot", source }` or `null` if not found.
 */
export async function detectCopilotLocalModel(): Promise<{
  model: string;
  provider: string;
  source: string;
} | null> {
  try {
    const configPath = join(homedir(), ".copilot", "config.json");
    const raw = await readFile(configPath, "utf-8");
    const config = JSON.parse(raw);

    if (typeof config.model === "string" && config.model.trim()) {
      return {
        model: config.model.trim(),
        provider: "copilot",
        source: "~/.copilot/config.json",
      };
    }
    return null;
  } catch {
    return null;
  }
}
