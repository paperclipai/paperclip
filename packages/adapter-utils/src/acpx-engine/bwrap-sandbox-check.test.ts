import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { BWRAP_PROBE_ARGS, verifyCodexBwrapSandbox } from "./bwrap-sandbox-check.js";

function resolveSleepBinary(): string {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, "sleep");
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory; keep searching.
    }
  }
  return "/bin/sleep";
}

function withLinuxPlatform<T>(fn: () => T): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

/**
 * Temp dir whose parent chain contains no node_modules (so the fake tree's
 * own packages are found before any global resolution fallback).
 */
function isolatedTmpDir(prefix: string): string {
  const base = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return mkdtempSync(path.join(base, prefix));
}

type ProbeBehavior = "ok" | "fail" | "slow";

/**
 * Build a minimal fake package tree mirroring the pnpm layout the resolver
 * walks: <root>/node_modules/@fake/codex-acp (the launch anchor), with
 * @openai/codex and the platform package linked one level up so
 * createRequire resolution from the anchor finds them.
 *
 * The fake bwrap records its argv in the file named by
 * BWRAP_PROBE_ARGV_FILE so tests can assert on the real probe arguments
 * instead of trusting a script that ignores them.
 */
function buildFakeCodexTree(root: string, probeBehavior: ProbeBehavior, sleepBin: string): { anchor: string; argvFile: string } {
  const nodeModules = path.join(root, "node_modules");
  const acpDist = path.join(nodeModules, "@fake", "codex-acp", "dist");
  const acpAnchor = path.join(acpDist, "index.js");
  const codexPkg = path.join(nodeModules, "@openai", "codex");
  // The resolver builds the platform package name from the host's own
  // process.arch (the tests only stub process.platform), so the fake tree
  // must match the host architecture — x64 and ARM64 alike.
  const platformPkgName = `@openai/codex-linux-${process.arch}`;
  const platformPkg = path.join(nodeModules, platformPkgName);
  const vendorArch = process.arch === "x64" ? "x86_64" : process.arch;
  const vendorBwrap = path.join(
    platformPkg,
    "vendor",
    `${vendorArch}-unknown-linux-musl`,
    "codex-resources",
    "bwrap",
  );
  const argvFile = path.join(root, "probe-args.txt");
  mkdirSync(acpDist, { recursive: true });
  mkdirSync(codexPkg, { recursive: true });
  mkdirSync(path.dirname(vendorBwrap), { recursive: true });
  const realAcpPkg = path.join(nodeModules, "@agentclientprotocol", "codex-acp");
  mkdirSync(realAcpPkg, { recursive: true });
  writeFileSync(
    path.join(realAcpPkg, "package.json"),
    JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "0.0.0" }),
  );
  writeFileSync(
    path.join(nodeModules, "@fake", "codex-acp", "package.json"),
    JSON.stringify({ name: "@fake/codex-acp", version: "0.0.0" }),
  );
  writeFileSync(acpAnchor, "// fake codex-acp entry\n");
  writeFileSync(
    path.join(codexPkg, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.0.0",
      optionalDependencies: { [platformPkgName]: "0.0.0" },
    }),
  );
  writeFileSync(
    path.join(platformPkg, "package.json"),
    JSON.stringify({ name: platformPkgName, version: "0.0.0" }),
  );
  // The probe child inherits the test's stripped PATH, so pin the stall to
  // an absolute sleep binary; a bare "sleep" would fail to resolve and the
  // script would exit 0 immediately.
  const script =
    probeBehavior === "ok"
      ? '#!/bin/sh\n[ -n "$BWRAP_PROBE_ARGV_FILE" ] && printf "%s\\n" "$@" > "$BWRAP_PROBE_ARGV_FILE"\nexit 0\n'
      : probeBehavior === "slow"
        ? `#!/bin/sh\n[ -n "$BWRAP_PROBE_ARGV_FILE" ] && printf "%s\\n" "$@" > "$BWRAP_PROBE_ARGV_FILE"\n${sleepBin} 2\nexit 0\n`
        : "#!/bin/sh\necho 'bwrap: Failed to make / slave: Permission denied' >&2\nexit 1\n";
  writeFileSync(vendorBwrap, script);
  chmodSync(vendorBwrap, 0o755);
  return { anchor: acpAnchor, argvFile };
}

describe("verifyCodexBwrapSandbox", () => {
  let emptyDir: string;
  let originalPath: string;
  let originalArgvFile: string | undefined;
  let sleepBin: string;

  beforeEach(() => {
    sleepBin = resolveSleepBinary();
    emptyDir = isolatedTmpDir("bwrap-check-empty-");
    originalPath = process.env.PATH ?? "";
    // Keep PATH from leaking a real bwrap into the resolution fallback.
    process.env.PATH = emptyDir;
    originalArgvFile = process.env.BWRAP_PROBE_ARGV_FILE;
  });

  afterEach(() => {
    rmSync(emptyDir, { recursive: true, force: true });
    process.env.PATH = originalPath;
    if (originalArgvFile === undefined) {
      delete process.env.BWRAP_PROBE_ARGV_FILE;
    } else {
      process.env.BWRAP_PROBE_ARGV_FILE = originalArgvFile;
    }
    vi.restoreAllMocks();
  });

  it("returns ok immediately on non-Linux platforms", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const result = await verifyCodexBwrapSandbox();
      expect(result.ok).toBe(true);
      expect(result.bwrapPath).toBeNull();
      expect(result.reason).toBeNull();
      expect(result.probeStderr).toBeNull();
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("resolves the bundled bwrap from the anchor package context and passes on a healthy probe", async () => {
    const root = isolatedTmpDir("bwrap-check-ok-");
    try {
      const { anchor, argvFile } = buildFakeCodexTree(root, "ok", sleepBin);
      process.env.BWRAP_PROBE_ARGV_FILE = argvFile;
      const result = await withLinuxPlatform(() => verifyCodexBwrapSandbox({ anchorPath: anchor }));
      expect(result.ok).toBe(true);
      expect(result.bwrapPath).toContain(path.join("codex-resources", "bwrap"));
      expect(result.reason).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a bare command anchor through PATH to the installed package context", async () => {
    // The engine's default Codex command is often the bare `codex-acp`
    // (resolved through PATH at launch). The anchor must be resolved the
    // same way so the platform package is found in the installed
    // executable's own package context instead of falling through to a
    // standalone bwrap on PATH.
    const root = isolatedTmpDir("bwrap-check-bare-");
    try {
      buildFakeCodexTree(root, "ok", sleepBin);
      const binDir = path.join(root, "bin");
      mkdirSync(binDir);
      const bareCommand = path.join(binDir, "codex-acp");
      writeFileSync(bareCommand, "#!/bin/sh\nexit 0\n");
      chmodSync(bareCommand, 0o755);
      // Keep PATH to the fake bin dir only: no real bwrap can leak in.
      process.env.PATH = binDir;
      const result = await withLinuxPlatform(() =>
        verifyCodexBwrapSandbox({ anchorPath: "codex-acp" }),
      );
      expect(result.ok).toBe(true);
      expect(result.bwrapPath).toContain(path.join("codex-resources", "bwrap"));
      expect(result.reason).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("probes with a root mount so a healthy host has /bin/true inside the sandbox", async () => {
    const root = isolatedTmpDir("bwrap-check-args-");
    try {
      const { anchor, argvFile } = buildFakeCodexTree(root, "ok", sleepBin);
      process.env.BWRAP_PROBE_ARGV_FILE = argvFile;
      const result = await withLinuxPlatform(() => verifyCodexBwrapSandbox({ anchorPath: anchor }));
      expect(result.ok).toBe(true);
      // The probe must mount the host root into the sandbox (bwrap's root
      // starts empty, so without a mount /bin/true would be missing and the
      // probe would fail on every healthy host).
      expect(BWRAP_PROBE_ARGS).toContain("--ro-bind");
      const recorded = readFileSync(argvFile, "utf8").split("\n").filter(Boolean);
      expect(recorded).toEqual([...BWRAP_PROBE_ARGS]);
      const mountIndex = recorded.indexOf("--ro-bind");
      expect(recorded[mountIndex + 1]).toBe("/");
      expect(recorded[mountIndex + 2]).toBe("/");
      expect(recorded[recorded.length - 1]).toBe("/bin/true");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reports probe stderr when the bundled bwrap fails (AppArmor-style denial)", async () => {
    const root = isolatedTmpDir("bwrap-check-fail-");
    try {
      const { anchor } = buildFakeCodexTree(root, "fail", sleepBin);
      const result = await withLinuxPlatform(() => verifyCodexBwrapSandbox({ anchorPath: anchor }));
      expect(result.ok).toBe(false);
      expect(result.bwrapPath).toContain(path.join("codex-resources", "bwrap"));
      expect(result.reason).toMatch(/probe failed/);
      expect(result.reason).toMatch(/Failed to make \/ slave/);
      expect(result.probeStderr).toBeTruthy();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the event loop responsive while a stalled probe runs", async () => {
    const root = isolatedTmpDir("bwrap-check-slow-");
    try {
      const { anchor } = buildFakeCodexTree(root, "slow", sleepBin);
      const probe = withLinuxPlatform(() => verifyCodexBwrapSandbox({ anchorPath: anchor, timeoutMs: 5000 }));
      // If the probe blocked the JS thread (execFileSync), this timer could
      // not fire until the probe settled. With an async spawn it ticks while
      // the probe is still running.
      let probeSettled = false;
      probe.then(
        () => {
          probeSettled = true;
        },
        () => {
          probeSettled = true;
        },
      );
      let tickFiredWhilePending = false;
      await new Promise<void>((resolveTick) => {
        setTimeout(() => {
          tickFiredWhilePending = !probeSettled;
          resolveTick();
        }, 100);
      });
      expect(tickFiredWhilePending).toBe(true);
      const result = await probe;
      expect(result.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("times out a stalled probe with a descriptive reason", async () => {
    const root = isolatedTmpDir("bwrap-check-timeout-");
    try {
      const { anchor } = buildFakeCodexTree(root, "slow", sleepBin);
      const result = await withLinuxPlatform(() =>
        verifyCodexBwrapSandbox({ anchorPath: anchor, timeoutMs: 300 }),
      );
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/timed out after 300ms/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("settles with a cancellation reason when the signal aborts the probe", async () => {
    const root = isolatedTmpDir("bwrap-check-abort-");
    try {
      const { anchor } = buildFakeCodexTree(root, "slow", sleepBin);
      const controller = new AbortController();
      const probe = withLinuxPlatform(() =>
        verifyCodexBwrapSandbox({ anchorPath: anchor, signal: controller.signal }),
      );
      setTimeout(() => controller.abort(), 100);
      const result = await probe;
      expect(result.ok).toBe(false);
      expect(result.reason).toMatch(/cancelled/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("always returns a well-formed result without an anchor", async () => {
    // Environment-dependent: a checkout with the real Codex platform package
    // installed resolves it (probe may pass or fail on the host); a bare
    // environment falls through to the not-found reason. Both shapes are
    // asserted, mirroring the paperclip-runner suite.
    const result = await withLinuxPlatform(() => verifyCodexBwrapSandbox());
    expect(typeof result.ok).toBe("boolean");
    expect(result.bwrapPath === null || typeof result.bwrapPath === "string").toBe(true);
    if (result.ok) {
      expect(result.reason).toBeNull();
      expect(result.bwrapPath).not.toBeNull();
    } else {
      expect(result.reason).toMatch(/bwrap/i);
      if (result.bwrapPath === null) {
        expect(result.reason).toMatch(/not found/i);
      } else {
        expect(result.reason).toMatch(/probe failed|timed out|cancelled/);
      }
    }
  });
});
