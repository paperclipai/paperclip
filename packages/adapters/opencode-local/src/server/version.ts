import {
  runChildProcess,
  type RunProcessResult,
} from "@paperclipai/adapter-utils/server-utils";

const DEFAULT_VERSION_DETECT_TIMEOUT_MS = 5_000;
const VERSION_DETECT_GRACE_SEC = 3;
const SEMVER_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/;

export interface OpenCodeVersion {
  raw: string;
  major: number;
  minor: number;
  patch: number;
}

export type OpenCodeVersionLine = "v1" | "v2" | "unknown";

export interface DetectedOpenCodeVersion extends OpenCodeVersion {
  line: OpenCodeVersionLine;
}

function stripKnownPrefixes(line: string): string {
  const withoutCommand = line.replace(/^opencode\s+/i, "");
  return withoutCommand.replace(/^v/i, "");
}

// `opencode --version` prints a bare `1.18.32` on v1 (npm `opencode-ai`) and
// `opencode v2.0.18` on v2 (npm `@opencode/cli`). Scan line by line so a
// noisy banner still yields the version line, and stay anchored after the
// known prefixes so unrelated semver-looking junk is rejected.
export function parseOpenCodeVersion(output: string): OpenCodeVersion | null {
  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const match = SEMVER_PATTERN.exec(stripKnownPrefixes(line));
    if (!match) continue;
    return {
      raw: line,
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
    };
  }
  return null;
}

export function classifyOpenCodeLine(
  version: { major: number } | null,
): OpenCodeVersionLine {
  if (!version) return "unknown";
  if (version.major >= 2) return "v2";
  if (version.major === 1) return "v1";
  return "unknown";
}

export function semverAtLeast(
  version: { major: number; minor: number; patch: number } | null,
  minimum: { major: number; minor: number; patch: number },
): boolean {
  if (!version) return false;
  if (version.major !== minimum.major) return version.major > minimum.major;
  if (version.minor !== minimum.minor) return version.minor > minimum.minor;
  return version.patch >= minimum.patch;
}

function normalizeEnv(input: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    if (typeof value === "string") env[key] = value;
  }
  return env;
}

// Best-effort probe: never throws. A missing command, a timeout, or output
// that does not parse all resolve to `null` so callers can degrade to the
// `unknown` line instead of failing a run.
export async function detectOpenCodeVersion(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    timeoutMs?: number;
  },
): Promise<DetectedOpenCodeVersion | null> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERSION_DETECT_TIMEOUT_MS;
  let result: RunProcessResult;
  try {
    result = await runChildProcess(
      `opencode-version-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      command,
      ["--version"],
      {
        cwd: options.cwd,
        env: normalizeEnv(options.env),
        timeoutSec: Math.max(1, Math.ceil(timeoutMs / 1000)),
        graceSec: VERSION_DETECT_GRACE_SEC,
        onLog: async () => {},
      },
    );
  } catch {
    return null;
  }

  if (result.timedOut) return null;
  const parsed =
    parseOpenCodeVersion(result.stdout) ?? parseOpenCodeVersion(result.stderr);
  if (!parsed) return null;
  return { ...parsed, line: classifyOpenCodeLine(parsed) };
}
