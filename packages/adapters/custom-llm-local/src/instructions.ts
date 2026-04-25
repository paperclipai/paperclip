import fs from "node:fs/promises";
import { CustomLlmError } from "./errors.js";

/**
 * Read the instructions file per-request (no caching).
 * Throws a CONFIG_INVALID error if the path is provided but the file cannot be read.
 */
export async function loadInstructions(instructionsFilePath: string): Promise<string> {
  try {
    const content = await fs.readFile(instructionsFilePath, "utf-8");
    return content;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    const error: CustomLlmError = {
      code: "CONFIG_INVALID",
      message: `Cannot read instructions file "${instructionsFilePath}": ${reason}`,
      meta: { path: instructionsFilePath, reason },
    };
    throw error;
  }
}
