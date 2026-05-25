import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SecretStore } from "./secret-store.js";
import { SECRETS_REF_SCHEME, parseSecretsRef } from "./secret-store.js";

export interface ClaudeLocalGitConfig {
  userName: string;
  userEmail: string;
  tokenSecretRef: string | null;
}

export interface ClaudeLocalGitConfigParseError {
  field: "userName" | "userEmail" | "tokenSecretRef";
  message: string;
}

export interface ClaudeLocalGitConfigParseResult {
  config: ClaudeLocalGitConfig | null;
  errors: ClaudeLocalGitConfigParseError[];
}

const FEATURE_FLAG_ENV = "PAPERCLIP_ADAPTER_GIT_IDENTITY";
const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

export function isClaudeLocalGitIdentityEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = env[FEATURE_FLAG_ENV];
  if (typeof raw !== "string") return false;
  return TRUE_VALUES.has(raw.trim().toLowerCase());
}

export function parseClaudeLocalGitConfig(value: unknown): ClaudeLocalGitConfigParseResult {
  if (value === null || value === undefined) {
    return { config: null, errors: [] };
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    return {
      config: null,
      errors: [{ field: "userName", message: "adapterConfig.git must be an object" }],
    };
  }
  const record = value as Record<string, unknown>;
  const errors: ClaudeLocalGitConfigParseError[] = [];

  const userName = readNonEmptyString(record.userName);
  if (userName === null) {
    errors.push({
      field: "userName",
      message: "adapterConfig.git.userName must be a non-empty string",
    });
  }
  const userEmail = readNonEmptyString(record.userEmail);
  if (userEmail === null) {
    errors.push({
      field: "userEmail",
      message: "adapterConfig.git.userEmail must be a non-empty string",
    });
  } else if (!userEmail.includes("@")) {
    errors.push({
      field: "userEmail",
      message: "adapterConfig.git.userEmail must look like an email address",
    });
  }
  let tokenSecretRef: string | null = null;
  if (record.tokenSecretRef !== undefined && record.tokenSecretRef !== null) {
    const raw = readNonEmptyString(record.tokenSecretRef);
    if (raw === null) {
      errors.push({
        field: "tokenSecretRef",
        message: "adapterConfig.git.tokenSecretRef must be a non-empty string when provided",
      });
    } else if (!isSupportedTokenSecretRef(raw)) {
      errors.push({
        field: "tokenSecretRef",
        message:
          "adapterConfig.git.tokenSecretRef must use a supported scheme (env:NAME, file:/abs/path)",
      });
    } else {
      tokenSecretRef = raw;
    }
  }
  if (errors.length > 0 || userName === null || userEmail === null) {
    return { config: null, errors };
  }
  return {
    config: { userName, userEmail, tokenSecretRef },
    errors,
  };
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isSupportedTokenSecretRef(ref: string): boolean {
  if (ref.startsWith("env:")) return ref.slice(4).trim().length > 0;
  if (ref.startsWith("file:")) return ref.slice(5).trim().length > 0;
  if (ref.startsWith(SECRETS_REF_SCHEME)) return parseSecretsRef(ref) !== null;
  return false;
}

export interface TokenResolver {
  (ref: string): Promise<string | null>;
}

export const defaultTokenResolver: TokenResolver = async (ref) => resolveBuiltInTokenRef(ref);

async function resolveBuiltInTokenRef(ref: string): Promise<string | null> {
  if (ref.startsWith("env:")) {
    const name = ref.slice(4).trim();
    if (!name) return null;
    const value = process.env[name];
    if (typeof value !== "string" || value.length === 0) return null;
    return value;
  }
  if (ref.startsWith("file:")) {
    const filePath = ref.slice(5).trim();
    if (!filePath) return null;
    const absolute = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
    try {
      const raw = await fs.readFile(absolute, "utf8");
      const trimmed = raw.trim();
      return trimmed.length > 0 ? trimmed : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Build a TokenResolver that recognizes `env:`, `file:`, and `secrets://` schemes.
 * Used by `execute()` so the SecretStore can be injected per-run (carries the companyId
 * needed to pick the right per-company encrypted file).
 */
export function createTokenResolverWithSecretStore(secretStore: SecretStore | null): TokenResolver {
  if (secretStore === null) return defaultTokenResolver;
  return async (ref) => {
    if (ref.startsWith(SECRETS_REF_SCHEME)) {
      return secretStore.resolve(ref);
    }
    return resolveBuiltInTokenRef(ref);
  };
}

export interface PrepareGitIdentityRuntimeInput {
  runId: string;
  agentId: string;
  cwd: string;
  config: ClaudeLocalGitConfig;
  resolveToken?: TokenResolver;
  runtimeRoot?: string;
}

export interface PrepareGitIdentityRuntimeResult {
  env: Record<string, string>;
  gitConfigPath: string;
  cleanup: () => Promise<void>;
  resolvedTokenLength: number;
  warnings: string[];
}

export async function prepareGitIdentityRuntime(
  input: PrepareGitIdentityRuntimeInput,
): Promise<PrepareGitIdentityRuntimeResult> {
  const warnings: string[] = [];
  const resolveToken = input.resolveToken ?? defaultTokenResolver;
  const runtimeRoot = input.runtimeRoot
    ? input.runtimeRoot
    : path.join(os.tmpdir(), "paperclip-claude-git-identity");
  const runDir = path.join(runtimeRoot, sanitizePathSegment(input.agentId), sanitizePathSegment(input.runId));
  await fs.mkdir(runDir, { recursive: true, mode: 0o700 });
  try {
    await fs.chmod(runDir, 0o700);
  } catch {
    // Best-effort: chmod may fail on Windows or unusual filesystems.
  }
  const gitConfigPath = path.join(runDir, ".gitconfig");
  let resolvedToken: string | null = null;
  if (input.config.tokenSecretRef) {
    try {
      resolvedToken = await resolveToken(input.config.tokenSecretRef);
    } catch (err) {
      warnings.push(
        `Failed to resolve adapter git tokenSecretRef "${input.config.tokenSecretRef}": ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      resolvedToken = null;
    }
    if (resolvedToken === null) {
      warnings.push(
        `Adapter git tokenSecretRef "${input.config.tokenSecretRef}" did not resolve to a value; ` +
          "skipping GH_TOKEN injection.",
      );
    }
  }
  const gitConfigBody = buildGitConfigBody({
    userName: input.config.userName,
    userEmail: input.config.userEmail,
    includeCredentialHelper: resolvedToken !== null,
  });
  await fs.writeFile(gitConfigPath, gitConfigBody, { encoding: "utf8", mode: 0o600 });
  try {
    await fs.chmod(gitConfigPath, 0o600);
  } catch {
    // Best-effort: chmod may fail on Windows or unusual filesystems.
  }
  const env: Record<string, string> = {
    GIT_AUTHOR_NAME: input.config.userName,
    GIT_AUTHOR_EMAIL: input.config.userEmail,
    GIT_COMMITTER_NAME: input.config.userName,
    GIT_COMMITTER_EMAIL: input.config.userEmail,
    GIT_CONFIG_GLOBAL: gitConfigPath,
  };
  if (resolvedToken !== null) {
    env.GH_TOKEN = resolvedToken;
  }
  return {
    env,
    gitConfigPath,
    resolvedTokenLength: resolvedToken?.length ?? 0,
    warnings,
    cleanup: async () => {
      try {
        await fs.rm(runDir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    },
  };
}

interface BuildGitConfigBodyInput {
  userName: string;
  userEmail: string;
  includeCredentialHelper: boolean;
}

function buildGitConfigBody(input: BuildGitConfigBodyInput): string {
  const lines = [
    `# Generated by Paperclip claude_local adapter. Per-run, do not edit.`,
    `[user]`,
    `\tname = ${quoteIniValue(input.userName)}`,
    `\temail = ${quoteIniValue(input.userEmail)}`,
  ];
  if (input.includeCredentialHelper) {
    lines.push(
      `[credential "https://github.com"]`,
      `\thelper = !f() { echo "username=x-access-token"; echo "password=$GH_TOKEN"; }; f`,
    );
  }
  lines.push("");
  return lines.join("\n");
}

function quoteIniValue(value: string): string {
  const sanitized = value.replace(/[\r\n]+/g, " ").trim();
  const escaped = sanitized.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

function sanitizePathSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "default";
}

export const __testing = {
  FEATURE_FLAG_ENV,
  buildGitConfigBody,
};
