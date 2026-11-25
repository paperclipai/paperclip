import { chmod, lstat, mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { output, roots, storeRoot, useNativeStoreFixtures } from "./native-distribution-integrity.test-support.js";

// A tiny stand-in for `agy` pinned for this host; it prints what it was launched with.
const fixture = vi.hoisted(() => {
  const script = '#!/bin/sh\nprintf "%s|%s|%s|%s" "$1" "$2" "$3" "$AGY_CLI_DISABLE_AUTO_UPDATE"\n';
  return { script, target: `${process.platform}-${process.arch}` };
});
vi.mock("./antigravity-cli-pins.js", async () => {
  const { createHash } = await import("node:crypto");
  const entries = [{ path: "agy", sha256: createHash("sha256").update(fixture.script).digest("hex"), size: Buffer.byteLength(fixture.script), executable: true }];
  return { ANTIGRAVITY_CLI_DISTRIBUTION: {
    version: "1.5.15", build: "1.5.15-5514532022517760", args: ["acp"], environment: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" },
    platforms: { [fixture.target]: { executable: "agy", closureSha256: createHash("sha256").update(JSON.stringify(entries)).digest("hex"), entries } },
  } };
});

const { ANTIGRAVITY_CLI_DISTRIBUTION } = await import("./antigravity-cli-pins.js");
const { antigravityCliRuntimeCachePath, resolveAntigravityCliLaunch } = await import("./antigravity-cli-installation.js");

useNativeStoreFixtures();

async function installedHome(script = fixture.script) {
  const home = await realpath(await mkdtemp(join(tmpdir(), "antigravity-cli-home-"))); roots.push(home);
  const pin = (ANTIGRAVITY_CLI_DISTRIBUTION.platforms as Record<string, { closureSha256: string; entries: unknown }>)[fixture.target]!;
  const directory = join(home, ".paperclip/runtimes/antigravity-cli", fixture.target, pin.closureSha256);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(join(directory, "agy"), script, { mode: 0o500 });
  await writeFile(join(directory, ".paperclip-antigravity-cli-closure.json"), JSON.stringify({ schema: "paperclip.antigravity_cli_closure.v1", entries: pin.entries }), { mode: 0o400 });
  return { home, directory, closure: pin.closureSha256 };
}

describe("Antigravity CLI launch resolver", () => {
  it("launches the pinned executable from the sealed store with the pinned arguments and environment", async () => {
    const { home, directory, closure } = await installedHome();
    const launch = await resolveAntigravityCliLaunch({ home, arguments: ["--gemini-dir", "/private/run"] });
    expect(launch).toMatchObject({ version: "1.5.15", build: "1.5.15-5514532022517760", target: fixture.target, commandDigest: `sha256:${closure}`,
      arguments: ["acp", "--gemini-dir", "/private/run"], environment: { AGY_CLI_DISABLE_AUTO_UPDATE: "1" } });
    expect(Object.isFrozen(launch.environment)).toBe(true);
    expect(launch.installation.agentServerPackageJsonPath).toBe(join(directory, ".paperclip-antigravity-cli-closure.json"));
    expect(antigravityCliRuntimeCachePath(closure, process.platform, process.arch, home)).toBe(directory);
    const lease = await launch.installation.openCommand();
    try {
      // The launch runs the runner-owned sealed copy, not the installed file.
      const sealed = join(storeRoot, closure, "distribution", "agy");
      expect((await lstat(sealed)).mode & 0o7777).toBe(0o500);
      expect(() => lease.spawn(["--extra"])).toThrow("fixed profile arguments");
      const result = await output(lease.spawn([], { env: launch.environmentFor({ PATH: "/usr/bin:/bin", AGY_CLI_DISABLE_AUTO_UPDATE: "0" }) }));
      expect(result).toEqual({ text: "acp|--gemini-dir|/private/run|1", error: "", code: 0 });
    } finally { await lease.close(); }
  });

  it("refuses a modified installation before launch", async () => {
    const { home, directory } = await installedHome();
    await chmod(join(directory, "agy"), 0o700);
    await writeFile(join(directory, "agy"), "#!/bin/sh\necho tampered\n");
    await chmod(join(directory, "agy"), 0o500);
    const launch = await resolveAntigravityCliLaunch({ home });
    await expect(launch.installation.openCommand()).rejects.toThrow();
  });

  it("names the setup command when the CLI is not installed", async () => {
    const home = await realpath(await mkdtemp(join(tmpdir(), "antigravity-cli-empty-"))); roots.push(home);
    await expect(resolveAntigravityCliLaunch({ home })).rejects.toMatchObject({
      code: "ANTIGRAVITY_CLI_RUNTIME_MISSING", retryable: false, message: expect.stringContaining("paperclipai runtime setup antigravity-cli"),
    });
  });

  it("refuses a host without a pinned build and arguments the store cannot carry", async () => {
    const { home } = await installedHome();
    await expect(resolveAntigravityCliLaunch({ home, platform: "win32", architecture: "x64" })).rejects.toMatchObject({
      code: "ANTIGRAVITY_CLI_UNSUPPORTED_PLATFORM", retryable: false, message: expect.stringContaining("win32-x64"),
    });
    await expect(resolveAntigravityCliLaunch({ home, arguments: ["bad\0arg"] })).rejects.toThrow("Antigravity CLI launch arguments are invalid");
  });
});

describe("Antigravity CLI runtime cache layout", () => {
  it("refuses a linked ~/.paperclip or a link inside the route directory, like the registry-server route", async () => {
    const { symlink, rm: remove } = await import("node:fs/promises");
    for (const linked of [".paperclip", `.paperclip/runtimes/antigravity-cli/${fixture.target}`]) {
      const { home, closure } = await installedHome();
      const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "antigravity-cli-elsewhere-"))); roots.push(elsewhere);
      await remove(join(home, linked), { recursive: true, force: true });
      await symlink(elsewhere, join(home, linked));
      expect(() => antigravityCliRuntimeCachePath(closure, process.platform, process.arch, home)).toThrow("real directories");
      await expect(resolveAntigravityCliLaunch({ home })).rejects.toThrow("real directories");
    }
  });
});
