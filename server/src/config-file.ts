import fs from "node:fs";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  let contents: string;
  try {
    contents = fs.readFileSync(configPath, "utf-8");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT"
    ) {
      return null;
    }
    throw new Error(`Failed to read Paperclip config at ${configPath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(contents);
  } catch {
    throw new Error(`Invalid JSON in Paperclip config at ${configPath}`);
  }

  const parsed = paperclipConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid Paperclip config schema at ${configPath}`);
  }

  return parsed.data;
}
