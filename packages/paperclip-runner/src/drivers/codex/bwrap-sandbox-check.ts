import { spawn } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface BwrapSandboxCheckResult {
  /** Whether bwrap was found and the probe succeeded. */
  ok: boolean;
  /** The resolved bwrap executable path, or null when not found. */
  bwrapPath: string | null;
  /** Human-readable reason when the check failed. */
  reason: string | null;
  /** The raw stderr from the probe, when available. */
  probeStderr: string | null;
}

/**
 * Resolve the bwrap executable bundled with the installed @openai/codex
 * platform package. Returns null when the platform package or bwrap is
 * not found.
 */
function resolveBwrapFromCodexPackage(
  issuer: string | URL = import.meta.url,
): string | null {
  try {
    const anchorRequire = createRequire(issuer);
    let codexManifestPath: string;
    try {
      const bridgeManifest = anchorRequire.resolve(
        "@agentclientprotocol/codex-acp/package.json",
      );
      codexManifestPath = createRequire(bridgeManifest).resolve(
        "@openai/codex/package.json",
      );
    } catch {
      try {
        codexManifestPath = anchorRequire.resolve("@openai/codex/package.json");
      } catch {
        return null;
      }
    }
    codexManifestPath = realpathSync(codexManifestPath);
    const codexRoot = dirname(codexManifestPath);

    // The bwrap binary lives in the platform-specific package's vendor dir:
    //   node_modules/@openai/codex-<platform>-<arch>/vendor/<arch>-unknown-linux-musl/codex-resources/bwrap
    // or in the @openai/codex package's own optionalDependencies.
    const manifest = JSON.parse(
      readFileSync(codexManifestPath, "utf8"),
    ) as { optionalDependencies?: Record<string, string> };

    const platformPkg = `@openai/codex-${process.platform}-${process.arch}`;
    if (manifest.optionalDependencies?.[platformPkg]) {
      // The platform package is an optional dependency of the codex package,
      // so resolve it from the codex package's own context first (pnpm
      // layouts only link it there); the anchor context is the fallback.
      const platformRequires = [createRequire(codexManifestPath), anchorRequire];
      for (const platformRequire of platformRequires) {
        try {
          const platformManifest = platformRequire.resolve(
            `${platformPkg}/package.json`,
          );
          const platformRoot = dirname(realpathSync(platformManifest));
          const vendor = resolve(platformRoot, "vendor");
          if (!existsSync(vendor)) continue;
          const vendorReal = realpathSync(vendor);
          // Look for bwrap in the vendor directory structure.
          const archDir = `${process.arch === "x64" ? "x86_64" : process.arch}-unknown-linux-musl`;
          const bwrap = resolve(vendorReal, archDir, "codex-resources", "bwrap");
          if (existsSync(bwrap)) return realpathSync(bwrap);
          // Fallback: search for bwrap under vendor/
          const found = findBwrapUnder(vendorReal);
          if (found) return found;
        } catch {
          // Try the next require context.
        }
      }
    }

    // Search the main codex package root for vendor/bwrap.
    const vendor = resolve(codexRoot, "vendor");
    if (existsSync(vendor)) return findBwrapUnder(vendor);

    return null;
  } catch {
    return null;
  }
}

/** Recursively search a directory tree for a file named "bwrap". */
function findBwrapUnder(root: string): string | null {
  const queue: string[] = [root];
  const maxDepth = 6;
  for (let depth = 0; depth < maxDepth; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      let entries;
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isFile() && entry.name === "bwrap") {
          try {
            accessSync(full, constants.X_OK);
            return realpathSync(full);
          } catch {
            // Not executable; keep searching.
          }
        } else if (entry.isDirectory()) {
          next.push(full);
        }
      }
    }
    queue.push(...next);
  }
  return null;
}

/**
 * Verify that the bwrap sandbox bundled with Codex is available and
 * functional on this host.
 *
 * Runs a minimal bwrap probe: mount the host root read-only into an empty
 * sandbox and run a no-op command (`BWRAP_PROBE_ARGS`). The mount is required
 * so `/bin/true` exists inside the sandbox on a healthy host, and it
 * exercises the exact capability that breaks in the field (AppArmor denying
 * `mount()`). A successful exit (code 0) means bwrap can create its
 * namespace and perform its setup mounts; any non-zero exit, timeout, or
 * missing binary means the sandbox is not usable.
 *
 * The probe is asynchronous: a stalled probe must not block the runner's
 * event loop while it runs (see rules/runtime-dependency-boundaries.mdc).
 */
export interface VerifyCodexBwrapSandboxOptions {
  /**
   * The Codex command the session launches (for example the resolved
   * `codex` executable). When it can be anchored to a file, the Codex
   * platform package is resolved from that command's package context —
   * the installation that actually runs — instead of this package's own
   * dependencies. Without an anchor, resolution falls back to this
   * module's context.
   */
  anchorPath?: string | null;
  /** Probe deadline in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Abort the probe early (for example when the run is cancelled). */
  signal?: AbortSignal | null;
}

export const BWRAP_PROBE_ARGS = ["--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"] as const;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

export async function verifyCodexBwrapSandbox(
  options: VerifyCodexBwrapSandboxOptions = {},
): Promise<BwrapSandboxCheckResult> {
  // Only meaningful on Linux; other platforms do not use bwrap.
  if (process.platform !== "linux") {
    return {
      ok: true,
      bwrapPath: null,
      reason: null,
      probeStderr: null,
    };
  }

  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const anchorPath = normalizeAnchorCommand(options.anchorPath);
  const bwrapPath = resolveBwrapFromCodexPackage(anchorPath ?? import.meta.url);
  if (!bwrapPath) {
    // Also check system PATH as a fallback.
    const fromPath = resolveOnPath("bwrap");
    if (!fromPath) {
      return {
        ok: false,
        bwrapPath: null,
        reason:
          "bwrap executable not found: the Codex platform package does not bundle bwrap and it is not on PATH. " +
          "The Codex sandbox cannot be initialized; shell commands will run unsandboxed.",
        probeStderr: null,
      };
    }
    return probeBwrap(fromPath, timeoutMs, options.signal);
  }

  return probeBwrap(bwrapPath, timeoutMs, options.signal);
}

function resolveOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    try {
      const candidate = resolve(directory, name);
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue searching.
    }
  }
  return null;
}

/**
 * Normalize the launched Codex command into a usable require anchor.
 *
 * Supported command values include absolute paths, relative paths, and bare
 * command names or shell strings. Bare names are resolved through PATH so
 * the anchor's package context is the context that actually owns the
 * launched executable; shell strings cannot be anchored to a single file
 * and fall back to this module's own context.
 */
function normalizeAnchorCommand(command: string | null | undefined): string | null {
  const trimmed = command?.trim();
  if (!trimmed) return null;
  if (/[\s;&|<>`$]/.test(trimmed)) return null;
  if (trimmed.includes("/")) return trimmed;
  return resolveOnPath(basename(trimmed));
}

function probeBwrap(
  bwrapPath: string,
  timeoutMs: number,
  signal?: AbortSignal | null,
): Promise<BwrapSandboxCheckResult> {
  return new Promise((resolveProbe) => {
    let settled = false;
    let stderr = "";
    let child: ReturnType<typeof spawn> | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child?.kill("SIGKILL");
      settle({
        ok: false,
        bwrapPath,
        reason: `bwrap probe cancelled before completion at ${bwrapPath}`,
        probeStderr: stderr || null,
      });
    };
    const settle = (result: BwrapSandboxCheckResult) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolveProbe(result);
    };
    try {
      child = spawn(bwrapPath, [...BWRAP_PROBE_ARGS], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      settle({
        ok: false,
        bwrapPath,
        reason: `bwrap probe failed to start at ${bwrapPath}: ${(error as Error).message}`,
        probeStderr: null,
      });
      return;
    }
    timer = setTimeout(
      () => {
        child?.kill("SIGKILL");
        settle({
          ok: false,
          bwrapPath,
          reason: `bwrap probe timed out after ${timeoutMs}ms at ${bwrapPath}`,
          probeStderr: stderr || null,
        });
      },
      timeoutMs,
    );
    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 8192) stderr = stderr.slice(0, 8192);
    });
    child.on("error", (error) => {
      settle({
        ok: false,
        bwrapPath,
        reason: `bwrap probe failed to start at ${bwrapPath}: ${error.message}`,
        probeStderr: stderr || null,
      });
    });
    child.on("close", (code) => {
      if (code === 0) {
        settle({ ok: true, bwrapPath, reason: null, probeStderr: null });
      } else {
        settle({
          ok: false,
          bwrapPath,
          reason: `bwrap probe failed (exit ${code ?? "unknown"}) at ${bwrapPath}: ${(stderr || "no stderr").trim()}`,
          probeStderr: stderr || null,
        });
      }
    });
  });
}
