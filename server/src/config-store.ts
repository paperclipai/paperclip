import fs from "node:fs";
import path from "node:path";
import { paperclipConfigSchema, type PaperclipConfig } from "@paperclipai/shared";
import { resolvePaperclipConfigPath } from "./paths.js";

function parseJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err) {
    throw new Error(`Failed to parse JSON at ${filePath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function formatValidationError(err: unknown): string {
  const issues = (err as { issues?: Array<{ path?: unknown; message?: unknown }> })?.issues;
  if (Array.isArray(issues) && issues.length > 0) {
    return issues
      .map((issue) => {
        const pathParts = Array.isArray(issue.path) ? issue.path.map(String) : [];
        const issuePath = pathParts.length > 0 ? pathParts.join(".") : "config";
        const message = typeof issue.message === "string" ? issue.message : "Invalid value";
        return `${issuePath}: ${message}`;
      })
      .join("; ");
  }
  return err instanceof Error ? err.message : String(err);
}

export function readConfigFile(): PaperclipConfig | null {
  const filePath = resolvePaperclipConfigPath();
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const parsed = paperclipConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

export function writeConfigFile(config: PaperclipConfig): void {
  const filePath = resolvePaperclipConfigPath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  // Backup existing config before overwriting
  if (fs.existsSync(filePath)) {
    const backupPath = filePath + ".backup";
    fs.copyFileSync(filePath, backupPath);
    fs.chmodSync(backupPath, 0o600);
  }

  fs.writeFileSync(filePath, JSON.stringify(config, null, 2) + "\n", {
    mode: 0o600,
  });
}

export function updateConfigFile(updater: (config: PaperclipConfig) => PaperclipConfig): PaperclipConfig {
  const current = readConfigFile();
  if (!current) {
    throw new Error("No config file found. Run `paperclipai onboard` first.");
  }
  const updated = updater({
    ...current,
    $meta: {
      ...current.$meta,
      updatedAt: new Date().toISOString(),
      source: "configure",
    },
  });
  writeConfigFile(updated);
  return updated;
}
