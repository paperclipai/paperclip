import fs from "node:fs";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { ZodError } from "zod";
import { resolvePaperclipConfigPath } from "./paths.js";

// ponytail: warn once per path per process. readConfigFile is called repeatedly
// (config load, logger init, model listing) — a persistently-invalid file must
// not spam the log on every call.
const warnedPaths = new Set<string>();

function warnConfigIgnored(configPath: string, reason: string): void {
  if (warnedPaths.has(configPath)) return;
  warnedPaths.add(configPath);
  console.warn(
    `[paperclip] Ignoring config at ${configPath}: ${reason}. Booting with defaults.`,
  );
}

export function readConfigFile(): PaperclipConfig | null {
  const configPath = resolvePaperclipConfigPath();

  if (!fs.existsSync(configPath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    warnConfigIgnored(configPath, `invalid JSON (${(err as Error).message})`);
    return null;
  }

  try {
    return paperclipConfigSchema.parse(raw);
  } catch (err) {
    if (err instanceof ZodError) {
      const detail = err.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      warnConfigIgnored(configPath, `failed schema validation (${detail})`);
    } else {
      warnConfigIgnored(configPath, (err as Error).message);
    }
    return null;
  }
}
