import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { unprocessable } from "../errors.js";

type SecretLookup = {
  getById(secretId: string): Promise<{ id: string; companyId: string } | null>;
  resolveSecretValue(companyId: string, secretId: string, version: number | "latest"): Promise<string>;
};

export type ProjectWorkspaceRepoAuth = {
  type: "github_token";
  secretId: string;
  version: number | "latest";
};

const GITHUB_HOSTS = new Set(["github.com", "www.github.com"]);
const ASKPASS_SCRIPT_PATH = path.join(os.tmpdir(), "paperclip-github-askpass.sh");

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function isGitHubRepoUrl(repoUrl: string | null | undefined): boolean {
  const trimmed = repoUrl?.trim() ?? "";
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    return GITHUB_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

export function readProjectWorkspaceRepoAuth(
  metadata: Record<string, unknown> | null | undefined,
): ProjectWorkspaceRepoAuth | null {
  const record = asRecord(metadata);
  const raw = asRecord(record?.repoAuth);
  if (!raw) return null;
  if (raw.type !== "github_token" || typeof raw.secretId !== "string" || raw.secretId.trim().length === 0) {
    return null;
  }
  const versionRaw = raw.version;
  const version =
    typeof versionRaw === "number" && Number.isInteger(versionRaw) && versionRaw > 0
      ? versionRaw
      : "latest";
  return {
    type: "github_token",
    secretId: raw.secretId.trim(),
    version,
  };
}

export async function normalizeProjectWorkspaceRepoAuthMetadata(input: {
  companyId: string;
  repoUrl: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  secrets: SecretLookup;
}): Promise<Record<string, unknown> | null> {
  const record = asRecord(input.metadata);
  if (!record) return input.metadata ?? null;
  if (!Object.prototype.hasOwnProperty.call(record, "repoAuth")) return record;

  const next = { ...record };
  if (next.repoAuth == null) {
    delete next.repoAuth;
    return Object.keys(next).length > 0 ? next : null;
  }

  if (!isGitHubRepoUrl(input.repoUrl)) {
    throw unprocessable("GitHub repo auth is only supported for GitHub repo URLs.");
  }

  const auth = readProjectWorkspaceRepoAuth(record);
  if (!auth) {
    throw unprocessable("Invalid project workspace repoAuth metadata.");
  }

  const secret = await input.secrets.getById(auth.secretId);
  if (!secret || secret.companyId !== input.companyId) {
    throw unprocessable("Repo auth secret must belong to the same company.");
  }

  next.repoAuth = {
    type: "github_token",
    secretId: auth.secretId,
    version: auth.version,
  };
  return next;
}

async function ensureGitHubAskPassScript() {
  const script = `#!/bin/sh
case "$1" in
  *sername*)
    printf '%s\\n' "\${PC_GIT_HTTP_USERNAME:-x-access-token}"
    ;;
  *assword*)
    printf '%s\\n' "\${PC_GIT_HTTP_TOKEN:-}"
    ;;
  *)
    printf '\\n'
    ;;
esac
`;
  await fs.writeFile(ASKPASS_SCRIPT_PATH, script, { mode: 0o700 });
  await fs.chmod(ASKPASS_SCRIPT_PATH, 0o700);
  return ASKPASS_SCRIPT_PATH;
}

export async function resolveProjectWorkspaceRepoAuthEnv(input: {
  companyId: string;
  repoUrl: string | null | undefined;
  metadata: Record<string, unknown> | null | undefined;
  secrets: SecretLookup;
}): Promise<NodeJS.ProcessEnv> {
  if (!isGitHubRepoUrl(input.repoUrl)) return {};
  const auth = readProjectWorkspaceRepoAuth(input.metadata);
  if (!auth) return {};

  const token = await input.secrets.resolveSecretValue(input.companyId, auth.secretId, auth.version);
  const askPassPath = await ensureGitHubAskPassScript();
  return {
    GIT_ASKPASS: askPassPath,
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    PC_GIT_HTTP_USERNAME: "x-access-token",
    PC_GIT_HTTP_TOKEN: token,
  };
}
