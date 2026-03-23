import fs from "node:fs";
import path from "node:path";
import { paperclipConfigSchema, normalizeRawConfig, type PaperclipConfig } from "./schema.js";
import {
  resolveDefaultConfigPath,
  resolvePaperclipInstanceId,
} from "./home.js";

const DEFAULT_CONFIG_BASENAME = "config.json";

function findConfigFileFromAncestors(startDir: string): string | null {
  const absoluteStartDir = path.resolve(startDir);
  let currentDir = absoluteStartDir;

  while (true) {
    const candidate = path.resolve(currentDir, ".paperclip", DEFAULT_CONFIG_BASENAME);
    if (fs.existsSync(candidate)) {
      return candidate;
    }

    const nextDir = path.resolve(currentDir, "..");
    if (nextDir === currentDir) break;
    currentDir = nextDir;
  }

  return null;
}

export function resolveConfigPath(overridePath?: string): string {
  if (overridePath) return path.resolve(overridePath);
  if (process.env.PAPERCLIP_CONFIG) return path.resolve(process.env.PAPERCLIP_CONFIG);
  return findConfigFileFromAncestors(process.cwd()) ?? resolveDefaultConfigPath(resolvePaperclipInstanceId());
}

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

export function readConfig(configPath?: string): PaperclipConfig | null {
  const filePath = resolveConfigPath(configPath);
  if (!fs.existsSync(filePath)) return null;
  const raw = parseJson(filePath);
  const normalized = normalizeRawConfig(raw);
  const parsed = paperclipConfigSchema.safeParse(normalized);
  if (!parsed.success) {
    throw new Error(`Invalid config at ${filePath}: ${formatValidationError(parsed.error)}`);
  }
  return parsed.data;
}

export function writeConfig(
  config: PaperclipConfig,
  configPath?: string,
): void {
  const filePath = resolveConfigPath(configPath);
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

export function configExists(configPath?: string): boolean {
  return fs.existsSync(resolveConfigPath(configPath));
}
