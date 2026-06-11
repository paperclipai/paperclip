import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  CLOSURE_GATE_FIX_SHA_LINE_REGEX,
  CLOSURE_GATE_VERIFY_CACHE_TTL_MS,
  type ClosureGateFixShaMode,
} from "@paperclipai/shared";
import { unprocessable } from "../errors.js";

const execFileAsync = promisify(execFile);

export const CLOSURE_GATE_DEFAULT_TARGET = "main";
export const CLOSURE_GATE_LS_REMOTE_TIMEOUT_MS = 10_000;

export type ClosureGateFixSha = {
  sha: string;
  target: string;
};

export type ClosureGateActorLike = {
  actorType: "agent" | "user";
  agentId?: string | null;
};

export type ClosureGateRejectReason =
  | "actor_not_agent"
  | "missing_fix_sha"
  | "unreachable_sha"
  | "git_error";

export type ClosureGateLogger = {
  warn: (payload: Record<string, unknown>, message: string) => void;
};

export type ClosureGateAssertInput = {
  companyMode: ClosureGateFixShaMode;
  actor: ClosureGateActorLike;
  commentBody: string | null | undefined;
  fallbackCommentBody?: string | null;
  resolveRepoUrl: () => Promise<string | null> | string | null;
  defaultTarget?: string;
  clock?: () => number;
  fetchImpl?: (repoUrl: string, target: string) => Promise<Set<string>>;
  logger?: ClosureGateLogger;
};

export type ClosureGateOutcome =
  | { allowed: true; mode: ClosureGateFixShaMode; fixSha: ClosureGateFixSha; verified: "fresh" | "cache"; verificationFailed?: false }
  | { allowed: true; mode: ClosureGateFixShaMode; fixSha: ClosureGateFixSha; verified: null; verificationFailed: true }
  | { allowed: true; mode: ClosureGateFixShaMode; fixSha: null; verified: null; verificationFailed?: boolean }
  | { allowed: false; mode: ClosureGateFixShaMode; reason: ClosureGateRejectReason; message: string };

export function extractFixSha(body: string | null | undefined): ClosureGateFixSha | null {
  if (!body) return null;
  const match = CLOSURE_GATE_FIX_SHA_LINE_REGEX.exec(body);
  if (!match) return null;
  const sha = match[1]?.toLowerCase();
  if (!sha) return null;
  const rawTarget = match[2]?.trim();
  const target = rawTarget && rawTarget.length > 0 ? rawTarget : CLOSURE_GATE_DEFAULT_TARGET;
  return { sha, target };
}

export function createClosureGateCache(ttlMs: number = CLOSURE_GATE_VERIFY_CACHE_TTL_MS) {
  const entries = new Map<string, { value: Set<string>; expiresAt: number }>();

  function key(repoUrl: string, target: string) {
    return `${repoUrl}::${target}`;
  }

  function get(repoUrl: string, target: string, now: number): Set<string> | undefined {
    const entry = entries.get(key(repoUrl, target));
    if (!entry) return undefined;
    if (entry.expiresAt <= now) {
      entries.delete(key(repoUrl, target));
      return undefined;
    }
    return entry.value;
  }

  function set(repoUrl: string, target: string, value: Set<string>, now: number) {
    entries.set(key(repoUrl, target), { value, expiresAt: now + ttlMs });
  }

  function clear() {
    entries.clear();
  }

  return { get, set, clear, _size: () => entries.size };
}

export class ClosureGateGitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClosureGateGitError";
  }
}

export async function fetchReachableShasFromRemote(
  repoUrl: string,
  target: string,
  timeoutMs: number = CLOSURE_GATE_LS_REMOTE_TIMEOUT_MS,
): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "git",
      ["ls-remote", "--quiet", repoUrl, target],
      { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 },
    );
    return parseLsRemoteOutput(stdout);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ClosureGateGitError(message);
  }
}

export function parseLsRemoteOutput(stdout: string): Set<string> {
  const shas = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    const sha = parts[0];
    if (sha && /^[0-9a-f]{40}$/.test(sha)) {
      shas.add(sha.toLowerCase());
    }
  }
  return shas;
}

export async function verifyFixShaOnRemote(args: {
  repoUrl: string;
  target: string;
  sha: string;
  cache?: ReturnType<typeof createClosureGateCache>;
  clock?: () => number;
  fetchImpl?: (repoUrl: string, target: string) => Promise<Set<string>>;
}): Promise<
  | { ok: true; source: "fresh" | "cache" }
  | { ok: false; reason: "unreachable_sha" | "git_error"; message: string }
> {
  const { repoUrl, target, sha } = args;
  const clock = args.clock ?? Date.now;
  const fetchImpl = args.fetchImpl ?? ((u, t) => fetchReachableShasFromRemote(u, t));
  const cache = args.cache;

  if (cache) {
    const cached = cache.get(repoUrl, target, clock());
    if (cached) {
      return cached.has(sha.toLowerCase())
        ? { ok: true, source: "cache" }
        : {
            ok: false,
            reason: "unreachable_sha",
            message: `Fix-SHA ${sha} is not reachable on ${repoUrl}@${target}`,
          };
    }
  }

  let reachable: Set<string>;
  try {
    reachable = await fetchImpl(repoUrl, target);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      reason: "git_error",
      message: `git ls-remote failed for ${repoUrl}@${target}: ${message}`,
    };
  }
  if (cache) cache.set(repoUrl, target, reachable, clock());
  return reachable.has(sha.toLowerCase())
    ? { ok: true, source: "fresh" }
    : {
        ok: false,
        reason: "unreachable_sha",
        message: `Fix-SHA ${sha} is not reachable on ${repoUrl}@${target}`,
      };
}

export function createClosureGate(
  options: {
    cache?: ReturnType<typeof createClosureGateCache>;
    clock?: () => number;
    fetchImpl?: (repoUrl: string, target: string) => Promise<Set<string>>;
    logger?: ClosureGateLogger;
    defaultTarget?: string;
  } = {},
) {
  const cache = options.cache ?? createClosureGateCache();
  const clock = options.clock ?? Date.now;
  const fetchImpl = options.fetchImpl;
  const logger = options.logger;
  const defaultTarget = options.defaultTarget ?? CLOSURE_GATE_DEFAULT_TARGET;

  async function assertAllowed(input: ClosureGateAssertInput): Promise<ClosureGateOutcome> {
    const mode = input.companyMode;

    if (mode === "off") {
      return { allowed: true, mode, fixSha: null, verified: null, verificationFailed: false };
    }

    if (input.actor.actorType !== "agent") {
      return { allowed: true, mode, fixSha: null, verified: null, verificationFailed: false };
    }

    const combinedBody = [input.commentBody, input.fallbackCommentBody]
      .filter((b): b is string => typeof b === "string" && b.length > 0)
      .join("\n");
    const fixSha = extractFixSha(combinedBody);

    if (!fixSha) {
      if (mode === "advisory") {
        logger?.warn(
          { mode, reason: "missing_fix_sha" },
          "closure-gate advisory: no Fix-SHA line found in closure comment",
        );
        return { allowed: true, mode, fixSha: null, verified: null, verificationFailed: true };
      }
      return {
        allowed: false,
        mode,
        reason: "missing_fix_sha",
        message:
          "Closure-gate enforce: PATCH setting status=done by an agent requires a 'Fix-SHA: <40-hex-sha>' line in the closure comment (optionally followed by 'Fix-Target: <branch>').",
      };
    }

    const target = fixSha.target || defaultTarget;
    const repoUrl = await input.resolveRepoUrl();
    if (!repoUrl) {
      if (mode === "advisory") {
        logger?.warn(
          { mode, reason: "git_error", fixSha: fixSha.sha, target },
          "closure-gate advisory: no repo URL configured for company",
        );
        return { allowed: true, mode, fixSha: null, verified: null, verificationFailed: true };
      }
      return {
        allowed: false,
        mode,
        reason: "git_error",
        message: `Closure-gate enforce: company has no configured remote repository URL to verify Fix-SHA ${fixSha.sha}.`,
      };
    }

    const verify = await verifyFixShaOnRemote({
      repoUrl,
      target,
      sha: fixSha.sha,
      cache,
      clock,
      fetchImpl,
    });

    if (verify.ok) {
      return {
        allowed: true,
        mode,
        fixSha: { sha: fixSha.sha, target },
        verified: verify.source,
        verificationFailed: false,
      };
    }

    if (mode === "advisory") {
      logger?.warn(
        { mode, reason: verify.reason, fixSha: fixSha.sha, target, repoUrl, message: verify.message },
        "closure-gate advisory: Fix-SHA verification failed",
      );
      return {
        allowed: true,
        mode,
        fixSha: { sha: fixSha.sha, target },
        verified: null,
        verificationFailed: true,
      };
    }

    return { allowed: false, mode, reason: verify.reason, message: verify.message };
  }

  return { assertAllowed, extractFixSha, verifyFixShaOnRemote, cache };
}

export function throwIfClosureGateRejected(outcome: ClosureGateOutcome): void {
  if (outcome.allowed) return;
  throw unprocessable(outcome.message, { reason: outcome.reason, mode: outcome.mode });
}
