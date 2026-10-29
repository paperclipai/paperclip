import { spawn } from "node:child_process";
import {
  accessSync,
  constants,
  existsSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
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

export interface VerifyCodexBwrapSandboxOptions {
  /**
   * The codex-acp ACP command the engine launches (for example
   * `<adapter>/node_modules/.bin/codex-acp`). When provided, the Codex
   * platform package is resolved from this command's package context, which is
   * the context that actually owns the process about to run. Without it, the
   * resolution falls back to this module's own context.
   */
  anchorPath?: string | null;
  /** Probe deadline in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
  /** Abort the probe early (for example when the run is cancelled). */
  signal?: AbortSignal | null;
}

/**
 * Probe workload: mount the host root read-only into an empty bwrap sandbox
 * and run a no-op command. The mount is required so `/bin/true` exists inside
 * the sandbox on a healthy host; a bare `bwrap /bin/true` would fail on every
 * host because its root is empty. The mount also exercises exactly the
 * capability that breaks in the field (AppArmor denying `mount()`), so a
 * denial here means real sandbox commands would fail too.
 */
export const BWRAP_PROBE_ARGS = ["--die-with-parent", "--ro-bind", "/", "/", "--", "/bin/true"] as const;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;

/**
 * Resolve the bwrap executable bundled with the installed @openai/codex
 * platform package. Returns null when the platform package or bwrap is not
 * found.
 */
function resolveBwrapFromCodexPackage(issuer: string | URL): string | null {
  try {
    const baseRequire = createRequire(issuer);
    let codexManifestPath: string;
    try {
      const bridgeManifest = baseRequire.resolve(
        "@agentclientprotocol/codex-acp/package.json",
      );
      codexManifestPath = createRequire(bridgeManifest).resolve(
        "@openai/codex/package.json",
      );
    } catch {
      try {
        codexManifestPath = baseRequire.resolve("@openai/codex/package.json");
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
      const platformRequires = [createRequire(codexManifestPath), baseRequire];
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

function resolveOnPath(name: string): string | null {
  for (const directory of (process.env.PATH ?? "").split(delimiter).filter(isAbsolute)) {
    try {
      const candidate = resolve(directory, name);
      if (statSync(candidate).isFile()) {
        accessSync(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Not present in this directory; keep searching.
    }
  }
  return null;
}

/**
 * Normalize the launched Codex command into a usable require anchor.
 *
 * Supported command values include absolute paths, relative paths, and bare
 * command names (for example `codex-acp`) or shell strings. Bare names are
 * resolved through PATH so the anchor's package context is the context that
 * actually owns the launched executable; shell strings cannot be anchored
 * to a single file and fall back to this module's own context.
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
/**
 * Verify that the Codex bwrap sandbox is operational on this host.
 *
 * Codex ACP shell commands run through the bwrap sandbox bundled with the
 * installed Codex platform package. When the host cannot satisfy bwrap's
 * setup mounts (for example AppArmor denying `mount()`), commands fail
 * sandbox initialization and degrade to unsandboxed execution. This check
 * runs the same bundled bwrap with a no-op workload so callers can refuse to
 * start Codex (or emit an explicit opt-out warning) instead of degrading
 * silently. See PER-8.
 */
export async function verifyCodexBwrapSandbox(
  options: VerifyCodexBwrapSandboxOptions = {},
): Promise<BwrapSandboxCheckResult> {
  if (process.platform !== "linux") {
    return { ok: true, bwrapPath: null, reason: null, probeStderr: null };
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const anchorPath = normalizeAnchorCommand(options.anchorPath);
  const bwrapPath = resolveBwrapFromCodexPackage(
    anchorPath && anchorPath.length > 0 ? anchorPath : import.meta.url,
  );
  if (!bwrapPath) {
    const fromPath = resolveOnPath("bwrap");
    if (!fromPath) {
      return {
        ok: false,
        bwrapPath: null,
        reason:
          "bwrap executable not found: the Codex platform package does not bundle bwrap and it is not on PATH. The Codex sandbox cannot be initialized; shell commands will run unsandboxed.",
        probeStderr: null,
      };
    }
    return probeBwrap(fromPath, timeoutMs, options.signal);
  }
  return probeBwrap(bwrapPath, timeoutMs, options.signal);
}
