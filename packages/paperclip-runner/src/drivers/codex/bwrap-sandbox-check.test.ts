import { describe, expect, it, afterEach, vi } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { verifyCodexBwrapSandbox } from "./bwrap-sandbox-check.js";

function withLinuxPlatform<T>(fn: () => T | Promise<T>): T {
  const original = process.platform;
  Object.defineProperty(process, "platform", { value: "linux" });
  try {
    return fn();
  } finally {
    Object.defineProperty(process, "platform", { value: original });
  }
}

/**
 * Temp dir whose parent chain contains no node_modules, so the fake tree's
 * packages are found before any resolution fallback outside the tree.
 */
function isolatedTmpDir(prefix: string): string {
  const base = existsSync("/tmp") ? "/tmp" : os.tmpdir();
  return mkdtempSync(path.join(base, prefix));
}

/**
 * Build a minimal fake Codex installation mirroring the pnpm layout the
 * resolver walks: a `codex` executable inside `@openai/codex`, with the
 * platform package (and its bundled bwrap) linked one level up. The
 * executable is also exposed as a bare `codex` in `<root>/bin` so the
 * bare-command anchor path can be exercised.
 */
function buildFakeCodexInstall(root: string): { codexExecutable: string; binDir: string } {
  const nodeModules = path.join(root, "node_modules");
  const codexPkg = path.join(nodeModules, "@openai", "codex");
  const codexBin = path.join(codexPkg, "bin");
  const codexExecutable = path.join(codexBin, "codex");
  const platformPkg = path.join(nodeModules, "@openai", "codex-linux-x64");
  const vendorBwrap = path.join(
    platformPkg,
    "vendor",
    "x86_64-unknown-linux-musl",
    "codex-resources",
    "bwrap",
  );
  const bridgePkg = path.join(nodeModules, "@agentclientprotocol", "codex-acp");
  mkdirSync(codexBin, { recursive: true });
  mkdirSync(platformPkg, { recursive: true });
  mkdirSync(path.dirname(vendorBwrap), { recursive: true });
  mkdirSync(bridgePkg, { recursive: true });
  writeFileSync(
    path.join(bridgePkg, "package.json"),
    JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "0.0.0" }),
  );
  writeFileSync(
    path.join(codexPkg, "package.json"),
    JSON.stringify({
      name: "@openai/codex",
      version: "0.0.0",
      optionalDependencies: { "@openai/codex-linux-x64": "0.0.0" },
    }),
  );
  writeFileSync(codexExecutable, "#!/bin/sh\nexit 0\n");
  chmodSync(codexExecutable, 0o755);
  writeFileSync(
    path.join(platformPkg, "package.json"),
    JSON.stringify({ name: "@openai/codex-linux-x64", version: "0.0.0" }),
  );
  writeFileSync(vendorBwrap, "#!/bin/sh\nexit 0\n");
  chmodSync(vendorBwrap, 0o755);
  const binDir = path.join(root, "bin");
  mkdirSync(binDir);
  const bareCodex = path.join(binDir, "codex");
  writeFileSync(bareCodex, "#!/bin/sh\nexit 0\n");
  chmodSync(bareCodex, 0o755);
  return { codexExecutable, binDir };
}

describe("verifyCodexBwrapSandbox", () => {
  afterEach(() => {
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

  it("returns a well-formed result on Linux", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await verifyCodexBwrapSandbox();
      // The result shape is always well-formed regardless of environment.
      expect(typeof result.ok).toBe("boolean");
      expect(result.bwrapPath === null || typeof result.bwrapPath === "string").toBe(true);
      expect(result.reason === null || typeof result.reason === "string").toBe(true);
      expect(result.probeStderr === null || typeof result.probeStderr === "string").toBe(true);

      if (result.ok) {
        expect(result.reason).toBeNull();
        expect(result.bwrapPath).not.toBeNull();
      } else {
        expect(result.reason).toMatch(/bwrap/i);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("reports a descriptive reason when bwrap is not found", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await verifyCodexBwrapSandbox();
      if (!result.ok && result.bwrapPath === null) {
        expect(result.reason).toMatch(/not found|unavailable/i);
      }
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("reports probe stderr when bwrap is found but fails", async () => {
    const original = process.platform;
    Object.defineProperty(process, "platform", { value: "linux" });
    try {
      const result = await verifyCodexBwrapSandbox();
      if (!result.ok && result.bwrapPath !== null) {
        // bwrap was found but the probe failed (e.g. AppArmor deny mount,
        // or a CI runner without unprivileged user namespaces).
        expect(result.reason).toMatch(/probe failed|timed out|cancelled/i);
        expect(result.probeStderr).toBeTruthy();
      }
    } finally {
      Object.defineProperty(process, "platform", { value: original });
    }
  });

  it("resolves the bundled bwrap from the launched codex executable's package context", async () => {
    // The gate must probe the sandbox of the Codex installation the session
    // actually launches, not this package's own bundled copy: a working
    // PATH Codex must not be refused because the runner's copy is broken.
    const root = isolatedTmpDir("bwrap-check-launch-anchor-");
    const originalPath = process.env.PATH ?? "";
    try {
      const { codexExecutable, binDir } = buildFakeCodexInstall(root);
      // Keep PATH to the fake bin dir only: no real bwrap can leak in.
      process.env.PATH = binDir;
      const result = await withLinuxPlatform(() =>
        verifyCodexBwrapSandbox({ anchorPath: codexExecutable }),
      );
      expect(result.ok).toBe(true);
      expect(result.bwrapPath).toContain(path.join("codex-resources", "bwrap"));
      expect(result.reason).toBeNull();
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves a bare codex command anchor through PATH to the installed package context", async () => {
    const root = isolatedTmpDir("bwrap-check-bare-codex-");
    const originalPath = process.env.PATH ?? "";
    try {
      const { binDir } = buildFakeCodexInstall(root);
      process.env.PATH = binDir;
      const result = await withLinuxPlatform(() =>
        verifyCodexBwrapSandbox({ anchorPath: "codex" }),
      );
      expect(result.ok).toBe(true);
      expect(result.bwrapPath).toContain(path.join("codex-resources", "bwrap"));
      expect(result.reason).toBeNull();
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("falls back to the module context when the anchor is a shell string", async () => {
    // Shell strings cannot be anchored to a single file; the result stays
    // well-formed via the module-context fallback (environment-dependent
    // probe outcome, shape asserted only).
    const result = await withLinuxPlatform(() =>
      verifyCodexBwrapSandbox({ anchorPath: "codex --foo=bar" }),
    );
    expect(typeof result.ok).toBe("boolean");
    expect(result.bwrapPath === null || typeof result.bwrapPath === "string").toBe(true);
    expect(result.reason === null || typeof result.reason === "string").toBe(true);
    expect(result.probeStderr === null || typeof result.probeStderr === "string").toBe(true);
  });
});
