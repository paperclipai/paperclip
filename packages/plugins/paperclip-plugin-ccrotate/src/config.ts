import type { CcrotateDriverConfig, CcrotateTarget } from "./types.js";

const DEFAULT_RATE_LIMIT_PATTERNS = [
  "You've hit your session limit",
  "You've hit your weekly limit",
  "You're out of extra usage",
  "You're now using extra usage",
  "rate limit",
  "rate_limit_exceeded",
];

function asString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`config.${field} must be a non-empty string`);
  }
  return value.trim();
}

function asNumber(value: unknown, field: string, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`config.${field} must be a finite number`);
  }
  return value;
}

function asTarget(value: unknown): CcrotateTarget {
  if (value !== "claude" && value !== "codex") {
    throw new Error(`config.target must be "claude" or "codex" (got ${JSON.stringify(value)})`);
  }
  return value;
}

export function parseDriverConfig(raw: Record<string, unknown>): CcrotateDriverConfig {
  const sshRaw = raw.ssh;
  if (!sshRaw || typeof sshRaw !== "object") {
    throw new Error("config.ssh must be an object with host/user/port/identityFile");
  }
  const ssh = sshRaw as Record<string, unknown>;

  const patterns = Array.isArray(raw.rateLimitPatterns)
    ? raw.rateLimitPatterns.filter((entry): entry is string => typeof entry === "string" && entry.length > 0)
    : DEFAULT_RATE_LIMIT_PATTERNS;

  return {
    ssh: {
      host: asString(ssh.host, "ssh.host"),
      user: asString(ssh.user, "ssh.user"),
      port: Math.max(1, Math.floor(asNumber(ssh.port, "ssh.port", 22))),
      identityFile: asString(ssh.identityFile, "ssh.identityFile"),
      strictHostKeyChecking: ssh.strictHostKeyChecking !== false,
    },
    target: asTarget(raw.target),
    remoteWorkspaceRoot: asString(raw.remoteWorkspaceRoot, "remoteWorkspaceRoot"),
    midRunRetries: Math.max(0, Math.floor(asNumber(raw.midRunRetries, "midRunRetries", 1))),
    rateLimitPatterns: patterns,
  };
}

export const CCROTATE_CONFIG_SCHEMA = {
  type: "object",
  required: ["ssh", "target", "remoteWorkspaceRoot"],
  properties: {
    ssh: {
      type: "object",
      required: ["host", "user", "identityFile"],
      properties: {
        host: { type: "string", title: "SSH Host" },
        user: { type: "string", title: "SSH User" },
        port: { type: "number", title: "SSH Port", default: 22 },
        identityFile: {
          type: "string",
          title: "SSH Identity File Path",
          description:
            "Absolute path on the plugin worker filesystem to the private key used to reach the ccrotate host.",
        },
        strictHostKeyChecking: {
          type: "boolean",
          title: "Strict Host Key Checking",
          default: true,
        },
      },
    },
    target: {
      type: "string",
      title: "Account Pool",
      enum: ["claude", "codex"],
      description: "Which ccrotate account pool this environment rotates through.",
    },
    remoteWorkspaceRoot: {
      type: "string",
      title: "Remote Workspace Root",
      description: "Absolute path on the ccrotate host where per-run workspaces will be materialized.",
    },
    midRunRetries: {
      type: "number",
      title: "Mid-Run Rotation Retries",
      description:
        "How many times to rotate and respawn a command if its output matches a rate-limit pattern.",
      default: 1,
      minimum: 0,
      maximum: 5,
    },
    rateLimitPatterns: {
      type: "array",
      title: "Rate-Limit Patterns",
      description:
        "Substrings that trigger mid-run rotation when seen in stdout/stderr. Defaults to the standard ccrotate set.",
      items: { type: "string" },
      default: DEFAULT_RATE_LIMIT_PATTERNS,
    },
  },
};

export { DEFAULT_RATE_LIMIT_PATTERNS };
