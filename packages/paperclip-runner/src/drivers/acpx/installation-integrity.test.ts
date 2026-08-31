import { createHash } from "node:crypto";
import { fork, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  awaitVerifiedAcpxProviderExit,
  awaitVerifiedAcpxProviderOwnership,
  guardSnapshotModuleLookup,
  guardSnapshotModuleResolution,
  reapCurrentProviderProcessGroup,
  sanitizedNodeEnvironment,
  snapshotDescriptorAncestorIndex,
  snapshotDescriptorResolution,
  verifiedExecutableOpenFlags,
  verifyQualifiedAcpxInstallation,
  type VerifiedAcpxProviderLifetime,
} from "./installation-integrity.js";
import { stageManagedCodexCredential } from "./codex-credentials.js";

const temporaryDirectories: string[] = [];
const descriptorCommandPath = "/proc/self/fd/4/server.js";

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { force: true, recursive: true })),
  );
});

describe("ACPX installation integrity", () => {
  it("rejects an unregistered provider exit proof", async () => {
    await expect(
      awaitVerifiedAcpxProviderExit({} as ChildProcess),
    ).rejects.toThrow("provider exit proof is unavailable");
  });

  it("never signals a dead guardian's saved process-group identity", () => {
    const signalCurrentGroup = vi.fn(
      (_pid: number, _signal: NodeJS.Signals) => true,
    );
    reapCurrentProviderProcessGroup(
      signalCurrentGroup,
      4_321,
      vi.fn((_code: number) => undefined),
    );
    expect(signalCurrentGroup).toHaveBeenCalledOnce();
    expect(signalCurrentGroup).toHaveBeenCalledWith(0, "SIGKILL");

    const signalSelfAfterGroupFailure = vi.fn(
      (pid: number, _signal: NodeJS.Signals) => {
        if (pid === 0) throw new Error("group signal unavailable");
      },
    );
    const exit = vi.fn((_code: number) => undefined);
    reapCurrentProviderProcessGroup(signalSelfAfterGroupFailure, 4_321, exit);
    expect(signalSelfAfterGroupFailure.mock.calls).toEqual([
      [0, "SIGKILL"],
      [4_321, "SIGKILL"],
    ]);
    expect(exit).not.toHaveBeenCalled();

    const failedSignals = vi.fn((_pid: number, _signal: NodeJS.Signals) => {
      throw new Error("signal unavailable");
    });
    reapCurrentProviderProcessGroup(failedSignals, 4_321, exit);
    expect(failedSignals.mock.calls).toEqual([
      [0, "SIGKILL"],
      [4_321, "SIGKILL"],
    ]);
    expect(exit).toHaveBeenCalledWith(1);
    expect(
      [
        ...signalCurrentGroup.mock.calls,
        ...signalSelfAfterGroupFailure.mock.calls,
        ...failedSignals.mock.calls,
      ]
        .map(([pid]) => pid)
        .filter((pid) => pid < 0),
    ).toEqual([]);
  });

  it("does not delegate non-Linux snapshot filesystem lookups", () => {
    for (const platform of ["darwin", "freebsd", "win32"] as const) {
      const nextResolve = vi.fn(() => ({ url: "file:///attacker.js" }));
      const nextLoad = vi.fn(() => ({ source: "attacker" }));
      expect(() =>
        guardSnapshotModuleLookup(platform, true, nextResolve),
      ).toThrow("requires Linux descriptor-pinned paths");
      expect(() => guardSnapshotModuleLookup(platform, true, nextLoad)).toThrow(
        "requires Linux descriptor-pinned paths",
      );
      expect(nextResolve).not.toHaveBeenCalled();
      expect(nextLoad).not.toHaveBeenCalled();
    }

    const pinnedLookup = vi.fn(() => "verified");
    expect(guardSnapshotModuleLookup("linux", true, pinnedLookup)).toBe(
      "verified",
    );
    expect(pinnedLookup).toHaveBeenCalledOnce();

    const builtinLookup = vi.fn(() => "builtin");
    expect(guardSnapshotModuleLookup("darwin", false, builtinLookup)).toBe(
      "builtin",
    );
    expect(builtinLookup).toHaveBeenCalledOnce();
  });

  it("rejects host-ancestry file resolutions outside retained descriptors", () => {
    const commandDirectoryUrl = "file:///proc/self/fd/4/";
    const dependencyDirectoryUrls = [
      "file:///proc/self/fd/5/",
      "file:///proc/self/fd/6/",
    ];
    const hostShadowUrl =
      "file:///proc/self/fd/node_modules/host-shadow/index.js";
    const hostShadowIndex = snapshotDescriptorAncestorIndex(
      hostShadowUrl,
      commandDirectoryUrl,
      dependencyDirectoryUrls,
    );
    expect(hostShadowIndex).toBe(-1);
    expect(() =>
      guardSnapshotModuleResolution(false, hostShadowUrl, hostShadowIndex >= 0),
    ).toThrow("escaped descriptor-pinned ancestry");
    expect(
      snapshotDescriptorResolution(
        hostShadowUrl,
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        "file:///snapshot/package/bin/",
        ["file:///snapshot/package/", "file:///"],
      ),
    ).toBeNull();

    const verifiedUrl = "file:///proc/self/fd/5/node_modules/verified/index.js";
    const verifiedIndex = snapshotDescriptorAncestorIndex(
      verifiedUrl,
      commandDirectoryUrl,
      dependencyDirectoryUrls,
    );
    expect(verifiedIndex).toBe(0);
    expect(() =>
      guardSnapshotModuleResolution(false, verifiedUrl, verifiedIndex >= 0),
    ).not.toThrow();
    expect(() =>
      guardSnapshotModuleResolution(false, "data:text/javascript,0", false),
    ).not.toThrow();

    const canonicalCommandDirectoryUrl = "file:///snapshot/package/bin/";
    const canonicalDependencyDirectoryUrls = [
      "file:///snapshot/package/",
      "file:///snapshot/",
    ];
    expect(
      snapshotDescriptorResolution(
        "file:///snapshot/package/bin/value.js",
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        canonicalCommandDirectoryUrl,
        canonicalDependencyDirectoryUrls,
      ),
    ).toEqual({ url: "file:///proc/self/fd/4/value.js", ancestorIndex: 0 });
    expect(
      snapshotDescriptorResolution(
        "file:///snapshot/package/node_modules/near/index.js",
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        canonicalCommandDirectoryUrl,
        canonicalDependencyDirectoryUrls,
      ),
    ).toEqual({
      url: "file:///proc/self/fd/5/node_modules/near/index.js",
      ancestorIndex: 0,
    });
    expect(
      snapshotDescriptorResolution(
        "file:///snapshot/node_modules/higher/index.js",
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        canonicalCommandDirectoryUrl,
        canonicalDependencyDirectoryUrls,
      ),
    ).toEqual({
      url: "file:///proc/self/fd/6/node_modules/higher/index.js",
      ancestorIndex: 1,
    });
    expect(
      snapshotDescriptorResolution(
        "file:///proc/self/fd/6/node_modules/higher/index.js",
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        canonicalCommandDirectoryUrl,
        canonicalDependencyDirectoryUrls,
      ),
    ).toEqual({
      url: "file:///proc/self/fd/6/node_modules/higher/index.js",
      ancestorIndex: 1,
    });
    expect(
      snapshotDescriptorResolution(
        "file:///unrelated/node_modules/host/index.js",
        commandDirectoryUrl,
        dependencyDirectoryUrls,
        canonicalCommandDirectoryUrl,
        canonicalDependencyDirectoryUrls,
      ),
    ).toBeNull();
  });

  it("removes every case variant of Node module-loader overrides", () => {
    expect(
      sanitizedNodeEnvironment({
        PATH: "/verified/bin",
        NODE_PATH: "/unverified/one",
        node_path: "/unverified/two",
        NoDe_OpTiOnS: "--require=/unverified/preload.cjs",
        LD_PRELOAD: "/unverified/preload.so",
        ld_library_path: "/unverified/lib",
        LD_AUDIT: "/unverified/audit.so",
        DyLd_InSeRt_LiBrArIeS: "/unverified/inject.dylib",
        GCONV_PATH: "/unverified/gconv",
        glibc_tunables: "glibc.malloc.check=3",
        OPENSSL_CONF: "/unverified/openssl.cnf",
        OPENSSL_ENGINES: "/unverified/engines",
        openssl_modules: "/unverified/providers",
      }),
    ).toEqual({ PATH: "/verified/bin" });
  });

  it("fails closed when the platform cannot atomically open without following symlinks", () => {
    expect(() => verifiedExecutableOpenFlags("win32", 0x20000)).toThrow(
      "requires atomic no-follow",
    );
    expect(() => verifiedExecutableOpenFlags("linux", undefined)).toThrow(
      "requires atomic no-follow",
    );
    expect(verifiedExecutableOpenFlags("linux", 0x20000)).not.toBe(0);
  });

  it("accepts the exact package, version, executable, and runtime", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    expect(installation).toMatchObject({
      commandDigest: fixture.profile.commandDigest,
      openCommand: expect.any(Function),
      agentServerPackageJsonPath: await realpath(fixture.serverPackageJsonPath),
      agentRuntimePackageJsonPath: await realpath(
        fixture.runtimePackageJsonPath,
      ),
    });
  });

  it("rejects package version and executable digest drift", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.34", bin: "bin/server.js" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/package version mismatch/);

    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }),
    );
    await writeFile(fixture.commandPath, "changed executable");
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/digest mismatch/);
  });

  it("rejects ambiguous and escaping executable metadata", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({
        version: "0.0.33",
        bin: { first: "bin/server.js", second: "bin/other.js" },
      }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/one relative executable/);

    await writeFile(
      fixture.serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "../outside.js" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/escapes its package/);
  });

  it("rejects runtime version drift", async () => {
    const fixture = await installationFixture();
    await writeFile(
      fixture.runtimePackageJsonPath,
      JSON.stringify({ version: "0.84.3" }),
    );
    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/runtime version mismatch/);
  });

  it("rejects an executable symlink even when its target has the expected digest", async () => {
    const fixture = await installationFixture();
    const target = join(fixture.root, "outside.js");
    await writeFile(target, fixture.command);
    await rm(fixture.commandPath);
    await symlink(target, fixture.commandPath);

    await expect(
      verifyQualifiedAcpxInstallation(fixture.profile, fixture.resolve),
    ).rejects.toThrow(/real regular file|no-follow regular file/);
  });

  it("detects pathname replacement before opening a launch lease", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    await writeFile(fixture.commandPath, "replacement");

    await expect(installation.openCommand()).rejects.toThrow(
      /digest mismatch|identity changed/,
    );
  });

  it("rejects a hard-linked executable through a replacement directory", async () => {
    const fixture = await installationFixture();
    const attackerDirectory = join(fixture.root, "attacker-bin");
    await mkdir(attackerDirectory);
    await link(fixture.commandPath, join(attackerDirectory, "server.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    await rename(
      fixture.commandDirectory,
      `${fixture.commandDirectory}.verified`,
    );
    await symlink(attackerDirectory, fixture.commandDirectory);

    await expect(installation.openCommand()).rejects.toThrow(
      /executable directory (must be a real directory|identity changed)/,
    );
  });

  it("launches the verified bytes after its pathname is replaced", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const replacement = `${fixture.commandPath}.replacement`;
    await writeFile(
      replacement,
      '#!/usr/bin/env node\nprocess.stdout.write("replacement");\n',
    );
    await chmod(replacement, 0o755);
    await rename(replacement, fixture.commandPath);

    await expectPinnedOutput(lease.spawn(), "verified");
  });

  it("launches the lexical verified snapshot after symlink replacement", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const outside = join(fixture.root, "outside.js");
    await writeFile(
      outside,
      '#!/usr/bin/env node\nprocess.stdout.write("symlink-target");\n',
    );
    await rm(fixture.commandPath);
    await symlink(outside, fixture.commandPath);

    await expectPinnedOutput(lease.spawn(), "verified");
  });

  it("launches the verified bytes after the open inode is modified", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const before = await stat(fixture.commandPath, { bigint: true });
    await writeFile(
      fixture.commandPath,
      '#!/usr/bin/env node\nprocess.stdout.write("modified");\n',
    );
    const after = await stat(fixture.commandPath, { bigint: true });
    expect(after.ino).toBe(before.ino);

    await expectPinnedOutput(lease.spawn(), "verified");
  });

  it("drops inherited and caller-supplied Node preload options", async () => {
    const fixture = await installationFixture();
    const installation = await verifyQualifiedAcpxInstallation(
      fixture.profile,
      fixture.resolve,
    );
    const preload = join(fixture.root, "unverified-preload.cjs");
    await writeFile(preload, 'process.stdout.write("unverified-preload");\n');
    const previousNodeOptions = process.env.NODE_OPTIONS;
    let inheritedChild: ChildProcess;
    try {
      process.env.NODE_OPTIONS = `--require=${preload}`;
      inheritedChild = (await installation.openCommand()).spawn();
    } finally {
      if (previousNodeOptions === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = previousNodeOptions;
    }
    await expectPinnedOutput(inheritedChild, "verified");

    await expectPinnedOutput(
      (await installation.openCommand()).spawn([], {
        env: { ...process.env, node_options: `--require=${preload}` },
      }),
      "verified",
    );
  });

  it("drops native loader injection variables before spawning", async () => {
    const fixture = await installationFixture();
    const variables = [
      "LD_PRELOAD",
      "ld_library_path",
      "DyLd_InSeRt_LiBrArIeS",
      "GCONV_PATH",
      "OPENSSL_CONF",
      "OPENSSL_ENGINES",
      "openssl_modules",
    ];
    const command = `process.stdout.write(JSON.stringify(${JSON.stringify(
      variables,
    )}.filter((key) => Object.hasOwn(process.env, key))));`;
    await writeFile(fixture.commandPath, command);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    await expectPinnedOutput(
      (await installation.openCommand()).spawn([], {
        env: Object.fromEntries(
          variables.map((variable) => [variable, "/unverified/injection"]),
        ),
      }),
      "[]",
    );
  });

  it("drops inherited and caller-supplied Node package search paths", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("unverified-node-path-package");',
      "process.stdout.write(value);",
    ].join("\n");
    const unverifiedPackage = join(
      fixture.root,
      "unverified-node-path",
      "unverified-node-path-package",
    );
    await mkdir(unverifiedPackage, { recursive: true });
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(unverifiedPackage, "package.json"),
        JSON.stringify({
          name: "unverified-node-path-package",
          main: "index.js",
        }),
      ),
      writeFile(
        join(unverifiedPackage, "index.js"),
        'module.exports = "unverified-node-path";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const previousNodePath = process.env.NODE_PATH;
    let inheritedChild: ChildProcess;
    try {
      process.env.NODE_PATH = dirname(unverifiedPackage);
      inheritedChild = (await installation.openCommand()).spawn();
    } finally {
      if (previousNodePath === undefined) delete process.env.NODE_PATH;
      else process.env.NODE_PATH = previousNodePath;
    }
    const expectedFailure =
      process.platform === "linux"
        ? "unverified-node-path-package"
        : "requires Linux descriptor-pinned paths";
    await expectFailure(inheritedChild, expectedFailure);

    await expectFailure(
      (await installation.openCommand()).spawn([], {
        env: {
          ...process.env,
          NODE_PATH: dirname(unverifiedPackage),
          node_path: dirname(unverifiedPackage),
        },
      }),
      expectedFailure,
    );
  });

  it("loads a verified ESM snapshot with relative imports and arguments", async () => {
    const fixture = await installationFixture();
    const command = [
      'import { fileURLToPath } from "node:url";',
      'import value from "./value.js";',
      "process.stdout.write(JSON.stringify({ value, argument: process.argv[2], argv: process.argv[1], filename: fileURLToPath(import.meta.url) }));",
    ].join("\n");
    await Promise.all([
      writeFile(
        fixture.serverPackageJsonPath,
        JSON.stringify({
          version: "0.0.33",
          type: "module",
          bin: "bin/server.js",
        }),
      ),
      writeFile(fixture.commandPath, command),
      writeFile(
        join(fixture.commandDirectory, "value.js"),
        'export default "relative";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const child = (await installation.openCommand()).spawn(["argument"]);
    if (process.platform === "linux") {
      await expectOutput(
        child,
        JSON.stringify({
          value: "relative",
          argument: "argument",
          argv: descriptorCommandPath,
          filename: descriptorCommandPath,
        }),
      );
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("pins relative imports when the command directory is replaced", async () => {
    const fixture = await installationFixture();
    const command = [
      'import { fileURLToPath } from "node:url";',
      'import value from "./value.js";',
      "process.stdout.write(JSON.stringify({ value, argv: process.argv[1], filename: fileURLToPath(import.meta.url) }));",
    ].join("\n");
    const attackerDirectory = join(fixture.root, "attacker-bin");
    await mkdir(attackerDirectory);
    await Promise.all([
      writeFile(
        fixture.serverPackageJsonPath,
        JSON.stringify({
          version: "0.0.33",
          type: "module",
          bin: "bin/server.js",
        }),
      ),
      writeFile(fixture.commandPath, command),
      writeFile(
        join(fixture.commandDirectory, "value.js"),
        'export default "verified-relative";',
      ),
      writeFile(
        join(attackerDirectory, "value.js"),
        'export default "attacker-relative";',
      ),
    ]);
    await link(fixture.commandPath, join(attackerDirectory, "server.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    const verifiedDirectory = `${fixture.commandDirectory}.verified`;
    await rename(fixture.commandDirectory, verifiedDirectory);
    await symlink(attackerDirectory, fixture.commandDirectory);
    const verifiedCommand = await stat(join(verifiedDirectory, "server.js"), {
      bigint: true,
    });
    const redirectedCommand = await stat(fixture.commandPath, { bigint: true });
    expect(redirectedCommand.dev).toBe(verifiedCommand.dev);
    expect(redirectedCommand.ino).toBe(verifiedCommand.ino);

    if (process.platform === "linux") {
      await expectOutput(
        lease.spawn(),
        JSON.stringify({
          value: "verified-relative",
          argv: descriptorCommandPath,
          filename: descriptorCommandPath,
        }),
      );
    } else {
      await expectFailure(
        lease.spawn(),
        "requires Linux descriptor-pinned paths",
      );
    }
  });

  it("keeps descriptor-pinned CommonJS identity across replacement", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("./value");',
      "process.stdout.write(JSON.stringify({ value, argument: process.argv[2], argv: process.argv[1], filename: __filename, directory: __dirname }));",
    ].join("\n");
    const attackerDirectory = join(fixture.root, "attacker-bin");
    await mkdir(attackerDirectory);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(fixture.commandDirectory, "value.js"),
        'module.exports = "verified-relative";',
      ),
      writeFile(
        join(attackerDirectory, "value.js"),
        'module.exports = "attacker-relative";',
      ),
    ]);
    await link(fixture.commandPath, join(attackerDirectory, "server.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    await rename(
      fixture.commandDirectory,
      `${fixture.commandDirectory}.verified`,
    );
    await symlink(attackerDirectory, fixture.commandDirectory);

    const child = lease.spawn(["argument"]);
    if (process.platform === "linux") {
      await expectOutput(
        child,
        JSON.stringify({
          value: "verified-relative",
          argument: "argument",
          argv: descriptorCommandPath,
          filename: descriptorCommandPath,
          directory: dirname(descriptorCommandPath),
        }),
      );
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("pins direct sibling resource reads across directory replacement", async () => {
    const fixture = await installationFixture();
    const command = [
      'const { readFileSync } = require("node:fs");',
      'const { join } = require("node:path");',
      'process.stdout.write(readFileSync(join(__dirname, "resource.txt"), "utf8"));',
    ].join("\n");
    const attackerDirectory = join(fixture.root, "attacker-bin");
    await mkdir(attackerDirectory);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(fixture.commandDirectory, "resource.txt"),
        "verified-resource",
      ),
      writeFile(join(attackerDirectory, "resource.txt"), "attacker-resource"),
    ]);
    await link(fixture.commandPath, join(attackerDirectory, "server.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    await rename(
      fixture.commandDirectory,
      `${fixture.commandDirectory}.verified`,
    );
    await symlink(attackerDirectory, fixture.commandDirectory);

    const child = lease.spawn();
    if (process.platform === "linux") {
      await expectOutput(child, "verified-resource");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("pins a bare entry require when the command directory is replaced", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("verified-dependency");',
      "process.stdout.write(value);",
    ].join("\n");
    const attackerDirectory = join(fixture.root, "attacker-bin");
    const verifiedDependency = join(
      fixture.commandDirectory,
      "node_modules",
      "verified-dependency",
    );
    const attackerDependency = join(
      attackerDirectory,
      "node_modules",
      "verified-dependency",
    );
    await Promise.all([
      mkdir(verifiedDependency, { recursive: true }),
      mkdir(attackerDependency, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(verifiedDependency, "package.json"),
        JSON.stringify({ name: "verified-dependency", main: "index.js" }),
      ),
      writeFile(
        join(verifiedDependency, "index.js"),
        'module.exports = "verified-bare";',
      ),
      writeFile(
        join(attackerDependency, "package.json"),
        JSON.stringify({ name: "verified-dependency", main: "index.js" }),
      ),
      writeFile(
        join(attackerDependency, "index.js"),
        'module.exports = "attacker-bare";',
      ),
    ]);
    await link(fixture.commandPath, join(attackerDirectory, "server.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    await rename(
      fixture.commandDirectory,
      `${fixture.commandDirectory}.verified`,
    );
    await symlink(attackerDirectory, fixture.commandDirectory);

    const child = lease.spawn();
    if (process.platform === "linux") {
      await expectOutput(child, "verified-bare");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("rejects dependencies that escape through a descendant symlink", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("linked-dependency");',
      "process.stdout.write(value);",
    ].join("\n");
    const packageNodeModules = join(fixture.serverDirectory, "node_modules");
    const outsideDependency = join(fixture.root, "outside-dependency");
    await Promise.all([
      mkdir(packageNodeModules, { recursive: true }),
      mkdir(outsideDependency, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(outsideDependency, "package.json"),
        JSON.stringify({ name: "linked-dependency", main: "index.js" }),
      ),
      writeFile(
        join(outsideDependency, "index.js"),
        'module.exports = "attacker-symlink";',
      ),
    ]);
    await symlink(
      outsideDependency,
      join(packageNodeModules, "linked-dependency"),
    );
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const child = (await installation.openCommand()).spawn();
    if (process.platform === "linux") {
      await expectFailure(child, "escaped descriptor-pinned ancestry");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("rejects a final-component module symlink", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("./linked.js");',
      "process.stdout.write(value);",
    ].join("\n");
    const outsideModule = join(fixture.root, "outside-module.js");
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(outsideModule, 'module.exports = "attacker-symlink";'),
    ]);
    await symlink(outsideModule, join(fixture.commandDirectory, "linked.js"));
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const child = (await installation.openCommand()).spawn();
    if (process.platform === "linux") {
      await expectFailure(child, "descriptor-pinned ancestry");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("rejects bare entry dependencies outside the verified package", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("ancestor-dependency");',
      "process.stdout.write(value);",
    ].join("\n");
    const dependency = join(
      fixture.root,
      "node_modules",
      "ancestor-dependency",
    );
    await mkdir(dependency, { recursive: true });
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(dependency, "package.json"),
        JSON.stringify({ name: "ancestor-dependency", main: "index.js" }),
      ),
      writeFile(
        join(dependency, "index.js"),
        'module.exports = "verified-ancestor";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const child = (await installation.openCommand()).spawn();
    if (process.platform === "linux") {
      await expectFailure(child, "ancestor-dependency");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("loads a separately qualified runtime through a package symlink", async () => {
    const fixture = await installationFixture();
    const packageName = "@earendil-works/pi-coding-agent";
    const command = [
      `const value = require(${JSON.stringify(packageName)});`,
      "process.stdout.write(value);",
    ].join("\n");
    const packageScope = join(
      fixture.serverDirectory,
      "node_modules",
      "@earendil-works",
    );
    await mkdir(packageScope, { recursive: true });
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        fixture.runtimePackageJsonPath,
        JSON.stringify({
          name: packageName,
          version: "0.84.2",
          main: "index.js",
        }),
      ),
      writeFile(
        join(fixture.runtimeDirectory, "index.js"),
        'const { readFileSync } = require("node:fs"); const { join } = require("node:path"); module.exports = readFileSync(join(__dirname, "resource.txt"), "utf8");',
      ),
      writeFile(
        join(fixture.runtimeDirectory, "resource.txt"),
        "verified-runtime",
      ),
    ]);
    const runtimeLink = join(packageScope, "pi-coding-agent");
    await symlink(fixture.runtimeDirectory, runtimeLink);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    await expectPinnedOutput(
      (await installation.openCommand()).spawn(),
      "verified-runtime",
    );

    const replacementLease = await installation.openCommand();
    const attackerRuntime = join(fixture.root, "attacker-runtime");
    await mkdir(attackerRuntime);
    await Promise.all([
      writeFile(
        join(attackerRuntime, "package.json"),
        JSON.stringify({ name: packageName, main: "index.js" }),
      ),
      writeFile(
        join(attackerRuntime, "index.js"),
        'module.exports = "attacker-runtime";',
      ),
    ]);
    await rm(runtimeLink);
    await symlink(attackerRuntime, runtimeLink);
    if (process.platform === "linux") {
      await expectFailure(replacementLease.spawn(), "descriptor-pinned");
    } else {
      await expectFailure(
        replacementLease.spawn(),
        "requires Linux descriptor-pinned paths",
      );
    }
  });

  it("loads parent-relative modules inside the verified package", async () => {
    const fixture = await installationFixture();
    const nestedDirectory = join(fixture.commandDirectory, "nested");
    const nestedCommandPath = join(nestedDirectory, "server.js");
    const packageLibrary = join(fixture.commandDirectory, "lib");
    const command = [
      'const value = require("./child.js");',
      "process.stdout.write(value);",
    ].join("\n");
    await Promise.all([
      mkdir(nestedDirectory, { recursive: true }),
      mkdir(packageLibrary, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(
        fixture.serverPackageJsonPath,
        JSON.stringify({ version: "0.0.33", bin: "bin/nested/server.js" }),
      ),
      writeFile(nestedCommandPath, command),
      writeFile(
        join(nestedDirectory, "child.js"),
        'module.exports = require("../lib/value.js");',
      ),
      writeFile(
        join(packageLibrary, "value.js"),
        'module.exports = "verified-parent-relative";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    await expectPinnedOutput(
      (await installation.openCommand()).spawn(),
      "verified-parent-relative",
    );
  });

  it("supports an executable at the verified package root", async () => {
    const fixture = await installationFixture();
    const rootCommandPath = join(fixture.serverDirectory, "server.js");
    const command = 'process.stdout.write("verified-package-root");';
    await Promise.all([
      writeFile(
        fixture.serverPackageJsonPath,
        JSON.stringify({ version: "0.0.33", bin: "server.js" }),
      ),
      writeFile(rootCommandPath, command),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    await expectPinnedOutput(
      (await installation.openCommand()).spawn(),
      "verified-package-root",
    );
  });

  it("pins package-ancestor dependencies across directory replacement", async () => {
    const fixture = await installationFixture();
    const command = [
      'const value = require("package-dependency");',
      "process.stdout.write(value);",
    ].join("\n");
    const packageDependency = join(
      fixture.serverDirectory,
      "node_modules",
      "package-dependency",
    );
    const attackerServerDirectory = join(fixture.root, "attacker-server");
    const attackerDependency = join(
      attackerServerDirectory,
      "node_modules",
      "package-dependency",
    );
    await Promise.all([
      mkdir(packageDependency, { recursive: true }),
      mkdir(attackerDependency, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(packageDependency, "package.json"),
        JSON.stringify({ name: "package-dependency", main: "index.js" }),
      ),
      writeFile(
        join(packageDependency, "index.js"),
        'module.exports = "verified-package";',
      ),
      writeFile(
        join(attackerDependency, "package.json"),
        JSON.stringify({ name: "package-dependency", main: "index.js" }),
      ),
      writeFile(
        join(attackerDependency, "index.js"),
        'module.exports = "attacker-package";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );
    const lease = await installation.openCommand();
    await rename(
      fixture.serverDirectory,
      `${fixture.serverDirectory}.verified`,
    );
    await symlink(attackerServerDirectory, fixture.serverDirectory);

    const child = lease.spawn();
    if (process.platform === "linux") {
      await expectOutput(child, "verified-package");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });

  it("does not admit a transitive package from host ancestry", async () => {
    const fixture = await installationFixture();
    const command = 'require("higher-ancestor-package");';
    const higherPackage = join(
      fixture.root,
      "node_modules",
      "higher-ancestor-package",
    );
    const lowerDependency = join(
      fixture.serverDirectory,
      "node_modules",
      "lower-only-dependency",
    );
    await Promise.all([
      mkdir(higherPackage, { recursive: true }),
      mkdir(lowerDependency, { recursive: true }),
    ]);
    await Promise.all([
      writeFile(fixture.commandPath, command),
      writeFile(
        join(higherPackage, "package.json"),
        JSON.stringify({ name: "higher-ancestor-package", main: "index.js" }),
      ),
      writeFile(
        join(higherPackage, "index.js"),
        'module.exports = require("lower-only-dependency");',
      ),
      writeFile(
        join(lowerDependency, "package.json"),
        JSON.stringify({ name: "lower-only-dependency", main: "index.js" }),
      ),
      writeFile(
        join(lowerDependency, "index.js"),
        'module.exports = "must-not-resolve";',
      ),
    ]);
    const installation = await verifyQualifiedAcpxInstallation(
      {
        ...fixture.profile,
        commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
      },
      fixture.resolve,
    );

    const child = (await installation.openCommand()).spawn();
    if (process.platform === "linux") {
      await expectFailure(child, "higher-ancestor-package");
    } else {
      await expectFailure(child, "requires Linux descriptor-pinned paths");
    }
  });
  it.runIf(process.platform !== "win32")(
    "rejects incomplete or duplicate provider credential quorum descriptors",
    async () => {
      const fixture = await persistentInstallationFixture();
      const installation = await verifyQualifiedAcpxInstallation(
        fixture.profile,
        fixture.resolve,
      );
      const invalidLifetimes = [
        {
          credentialFenceFds: [42],
          activateCredentialFenceOwner: async () => undefined,
        },
        {
          credentialFenceFds: [42, 42],
          activateCredentialFenceOwner: async () => undefined,
        },
        {
          credentialFenceFds: [42, -1],
          activateCredentialFenceOwner: async () => undefined,
        },
        {
          credentialFenceFds: [42, 43],
        },
      ] as unknown as readonly VerifiedAcpxProviderLifetime[];

      for (const lifetime of invalidLifetimes) {
        const command = await installation.openCommand();
        expect(() => command.spawn([], {}, lifetime)).toThrow(
          "ACPX provider credential fence is invalid",
        );
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "keeps the staged credential fenced through owner SIGKILL and reaps the provider group",
    async () => {
      const fixture = await persistentInstallationFixture();
      const ownerScript = join(fixture.root, "provider-owner.mjs");
      const pidFile = join(fixture.root, "provider.pid");
      const credentialHome = join(fixture.root, "codex-home");
      await mkdir(credentialHome, { mode: 0o700 });
      const moduleUrl = new URL("./installation-integrity.ts", import.meta.url)
        .href;
      const credentialModuleUrl = new URL(
        "./codex-credentials.ts",
        import.meta.url,
      ).href;
      await writeFile(
        ownerScript,
        [
          `const module = await import(${JSON.stringify(moduleUrl)});`,
          `const credentials = await import(${JSON.stringify(credentialModuleUrl)});`,
          `const profile = ${JSON.stringify(fixture.profile)};`,
          `const credential = await credentials.stageManagedCodexCredential({ agentHomeDirectory: ${JSON.stringify(credentialHome)}, environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"original"}' } });`,
          `const paths = new Map(${JSON.stringify([...fixture.paths])});`,
          "const installation = await module.verifyQualifiedAcpxInstallation(profile, (name) => paths.get(name));",
          "const lease = await installation.openCommand();",
          `const provider = lease.spawn([], { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: ${JSON.stringify(pidFile)} } }, { credentialFenceFds: credential.lifetimeFenceFds, activateCredentialFenceOwner: (pid) => credential.activateLifetimeOwner(pid) });`,
          "await module.awaitVerifiedAcpxProviderOwnership(provider);",
          'process.send?.({ type: "ready", guardianPid: provider.pid });',
          "process.stdin.resume();",
        ].join("\n"),
      );

      const owner = fork(ownerScript, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "ignore", "pipe", "ipc"],
      });
      let guardianPid = 0;
      let providerPid = 0;
      try {
        const ready = (await childMessage(owner, "ready")) as {
          guardianPid: number;
        };
        guardianPid = ready.guardianPid;
        providerPid = Number.parseInt(await waitForFile(pidFile), 10);
        expect(processAlive(providerPid)).toBe(true);

        process.kill(guardianPid, "SIGSTOP");
        try {
          owner.kill("SIGKILL");
          await once(owner, "exit");
          // The stopped sentinel cannot answer any application protocol. Its
          // two inherited quorum listeners nevertheless prevent a second owner.
          await expect(
            stageManagedCodexCredential({
              agentHomeDirectory: credentialHome,
              environment: {
                PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
              },
            }),
          ).rejects.toThrow("already has an active lease");
          expect(processAlive(providerPid)).toBe(true);
        } finally {
          if (owner.exitCode === null && owner.signalCode === null) {
            owner.kill("SIGKILL");
            await once(owner, "exit").catch(() => undefined);
          }
          // SIGSTOP pins this exact live guardian PID against reuse until the
          // matching resume. Owner-pipe EOF then makes it self-reap its group.
          process.kill(guardianPid, "SIGCONT");
          await waitUntil(() => !processAlive(providerPid));
        }
        let contender: Awaited<
          ReturnType<typeof stageManagedCodexCredential>
        > | null = null;
        await waitUntilAsync(async () => {
          try {
            contender = await stageManagedCodexCredential({
              agentHomeDirectory: credentialHome,
              environment: {
                PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
              },
            });
            return true;
          } catch {
            return false;
          }
        });
        await contender!.close();
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          // This direct child handle owns the guardian pipe. Closing it lets
          // the live guardian reap only its own still-pinned group; never
          // signal a saved guardian PGID from cleanup.
          owner.kill("SIGKILL");
          await once(owner, "exit").catch(() => undefined);
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "reaps a fenced provider when its lifetime guardian is SIGKILLed",
    async () => {
      const fixture = await persistentInstallationFixture();
      const ownerScript = join(fixture.root, "guardian-owner.mjs");
      const pidFile = join(fixture.root, "guardian-provider.pid");
      const credentialHome = join(fixture.root, "guardian-codex-home");
      await mkdir(credentialHome, { mode: 0o700 });
      const moduleUrl = new URL("./installation-integrity.ts", import.meta.url)
        .href;
      const credentialModuleUrl = new URL(
        "./codex-credentials.ts",
        import.meta.url,
      ).href;
      await writeFile(
        ownerScript,
        [
          `const module = await import(${JSON.stringify(moduleUrl)});`,
          `const credentials = await import(${JSON.stringify(credentialModuleUrl)});`,
          `const profile = ${JSON.stringify(fixture.profile)};`,
          `const credential = await credentials.stageManagedCodexCredential({ agentHomeDirectory: ${JSON.stringify(credentialHome)}, environment: { PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"original"}' } });`,
          `const paths = new Map(${JSON.stringify([...fixture.paths])});`,
          "const installation = await module.verifyQualifiedAcpxInstallation(profile, (name) => paths.get(name));",
          "const lease = await installation.openCommand();",
          `const provider = lease.spawn([], { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: ${JSON.stringify(pidFile)} } }, { credentialFenceFds: credential.lifetimeFenceFds, activateCredentialFenceOwner: (pid) => credential.activateLifetimeOwner(pid) });`,
          "await module.awaitVerifiedAcpxProviderOwnership(provider);",
          'process.send?.({ type: "ready", guardianPid: provider.pid });',
          "process.stdin.resume();",
        ].join("\n"),
      );

      const owner = fork(ownerScript, [], {
        execArgv: ["--import", "tsx"],
        stdio: ["pipe", "ignore", "pipe", "ipc"],
      });
      let guardianPid = 0;
      let providerPid = 0;
      try {
        const ready = (await childMessage(owner, "ready")) as {
          guardianPid: number;
        };
        guardianPid = ready.guardianPid;
        providerPid = Number.parseInt(await waitForFile(pidFile), 10);
        expect(processAlive(providerPid)).toBe(true);

        // Freeze the provider so it cannot process guardian-pipe EOF itself.
        // The armed credential-free peer must still reap the current group.
        process.kill(providerPid, "SIGSTOP");
        await waitUntilAsync(() => processStopped(providerPid));
        process.kill(guardianPid, "SIGKILL");
        owner.kill("SIGKILL");
        await once(owner, "exit");
        await waitUntil(() => !processAlive(providerPid));

        const contender = await stageManagedCodexCredential({
          agentHomeDirectory: credentialHome,
          environment: {
            PAPERCLIP_ACPX_CODEX_AUTH_JSON_SECRET: '{"owner":"contender"}',
          },
        });
        await contender.close();
      } finally {
        if (owner.exitCode === null && owner.signalCode === null) {
          owner.kill("SIGKILL");
          await once(owner, "exit").catch(() => undefined);
        }
        if (providerPid > 0 && processAlive(providerPid)) {
          // Failure cleanup only: allow the provider's own guardian-loss
          // callback to reap its still-pinned group if the watchdog regressed.
          process.kill(providerPid, "SIGCONT");
          await waitUntil(() => !processAlive(providerPid));
        }
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "reaps a stopped provider after an external guardian kill",
    async () => {
      const fixture = await persistentInstallationFixture();
      const pidFile = join(fixture.root, "provider-exit-proof.pid");
      const fences = await Promise.all([
        listenOnLoopback(),
        listenOnLoopback(),
      ]);
      const fenceFds = fences.map(
        (fence) =>
          (fence as Server & { _handle?: { fd?: number } })._handle?.fd,
      );
      expect(fenceFds.every(Number.isSafeInteger)).toBe(true);
      const installation = await verifyQualifiedAcpxInstallation(
        fixture.profile,
        fixture.resolve,
      );
      const guardian = (await installation.openCommand()).spawn(
        [],
        { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: pidFile } },
        {
          credentialFenceFds: [fenceFds[0]!, fenceFds[1]!],
          activateCredentialFenceOwner: async () => undefined,
        },
      );
      await awaitVerifiedAcpxProviderOwnership(guardian);
      const providerExit = awaitVerifiedAcpxProviderExit(guardian);
      const providerPid = Number.parseInt(await waitForFile(pidFile), 10);
      const guardianExit = once(guardian, "exit");
      process.kill(providerPid, "SIGSTOP");
      await waitUntilAsync(() => processStopped(providerPid));

      try {
        // Bypass the protected cleanup method to model SIGKILL/OOM of the
        // guardian itself. Its credential-free peer must reap the stopped
        // provider without waiting for provider JavaScript to run.
        process.kill(guardian.pid!, "SIGKILL");
        await guardianExit;
        await providerExit;
        await waitUntil(() => !processAlive(providerPid));
      } finally {
        if (guardian.exitCode === null && guardian.signalCode === null) {
          guardian.kill("SIGKILL");
          await guardianExit.catch(() => undefined);
        }
        if (processAlive(providerPid)) {
          process.kill(providerPid, "SIGCONT");
          await waitUntil(() => !processAlive(providerPid));
        }
        await Promise.all(fences.map(closeServer));
      }
    },
  );

  it.runIf(process.platform === "linux")(
    "dismisses the lifetime sentinel only after normal provider-group cleanup",
    async () => {
      const fixture = await persistentInstallationFixture();
      const pidFile = join(fixture.root, "normal-provider.pid");
      const fences = await Promise.all([
        listenOnLoopback(),
        listenOnLoopback(),
      ]);
      const fenceFds = fences.map(
        (fence) =>
          (fence as Server & { _handle?: { fd?: number } })._handle?.fd,
      );
      expect(fenceFds.every(Number.isSafeInteger)).toBe(true);
      expect(fenceFds[0]).not.toBe(fenceFds[1]);
      const installation = await verifyQualifiedAcpxInstallation(
        fixture.profile,
        fixture.resolve,
      );
      const provider = (await installation.openCommand()).spawn(
        [],
        { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: pidFile } },
        {
          credentialFenceFds: [fenceFds[0]!, fenceFds[1]!],
          activateCredentialFenceOwner: async () => undefined,
        },
      );
      await awaitVerifiedAcpxProviderOwnership(provider);
      const providerPid = Number.parseInt(await waitForFile(pidFile), 10);
      const ports = fences.map(
        (fence) => (fence.address() as { port: number }).port,
      );
      provider.kill("SIGTERM");
      await Promise.all(fences.map(closeServer));
      await once(provider, "exit");
      await waitUntil(() => !processAlive(providerPid));
      await Promise.all(
        ports.map((port) =>
          expect(canBindLoopbackPort(port)).resolves.toBe(true),
        ),
      );
    },
  );

  it.runIf(process.platform === "linux")(
    "reaps a stopped provider across repeated guardian cleanup requests",
    async () => {
      const fixture = await persistentInstallationFixture();
      const pidFile = join(fixture.root, "emergency-provider.pid");
      const fences = await Promise.all([
        listenOnLoopback(),
        listenOnLoopback(),
      ]);
      const fenceFds = fences.map(
        (fence) =>
          (fence as Server & { _handle?: { fd?: number } })._handle?.fd,
      );
      expect(fenceFds.every(Number.isSafeInteger)).toBe(true);
      expect(fenceFds[0]).not.toBe(fenceFds[1]);
      const installation = await verifyQualifiedAcpxInstallation(
        fixture.profile,
        fixture.resolve,
      );
      const guardian = (await installation.openCommand()).spawn(
        [],
        { env: { ...process.env, PAPERCLIP_PROVIDER_PID_FILE: pidFile } },
        {
          credentialFenceFds: [fenceFds[0]!, fenceFds[1]!],
          activateCredentialFenceOwner: async () => undefined,
        },
      );
      await awaitVerifiedAcpxProviderOwnership(guardian);
      const providerPid = Number.parseInt(await waitForFile(pidFile), 10);
      const guardianExit = once(guardian, "exit");
      process.kill(providerPid, "SIGSTOP");
      process.kill(guardian.pid!, "SIGSTOP");
      try {
        expect(guardian.kill("SIGKILL")).toBe(true);
        // Retry synchronously while the resumed guardian has not yet processed
        // owner-pipe EOF. Each retry wakes the exact guardian; the guardian
        // remains alive to reap the whole provider group itself.
        expect(guardian.kill("SIGKILL")).toBe(true);
        await guardianExit;
        await waitUntil(() => !processAlive(providerPid));
      } finally {
        if (processAlive(providerPid)) {
          // The stopped provider still pins this exact PID. Resume it only for
          // failure cleanup so guardian-pipe EOF can make it self-reap.
          process.kill(providerPid, "SIGCONT");
        }
        if (guardian.exitCode === null && guardian.signalCode === null) {
          process.kill(guardian.pid!, "SIGCONT");
          guardian.kill("SIGKILL");
          await guardianExit.catch(() => undefined);
        }
        await Promise.all(fences.map(closeServer));
      }
    },
  );
});

async function expectOutput(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  let stdout = "";
  let stderr = "";
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => {
    stdout += String(chunk);
  });
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [exitCode] = await once(child, "exit");
  expect(exitCode, stderr).toBe(0);
  expect(stdout).toBe(expected);
}

async function expectPinnedOutput(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  if (process.platform === "linux") {
    await expectOutput(child, expected);
  } else {
    await expectFailure(child, "requires Linux descriptor-pinned paths");
  }
}

async function expectFailure(
  child: ChildProcess,
  expected: string,
): Promise<void> {
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const [exitCode] = await once(child, "exit");
  expect(exitCode).not.toBe(0);
  expect(stderr).toContain(expected);
}

async function persistentInstallationFixture() {
  const fixture = await installationFixture();
  const command = [
    "#!/usr/bin/env node",
    'const fs = require("node:fs");',
    "fs.writeFileSync(process.env.PAPERCLIP_PROVIDER_PID_FILE, String(process.pid));",
    "setInterval(() => undefined, 1_000);",
  ].join("\n");
  await writeFile(fixture.commandPath, command);
  return {
    ...fixture,
    command,
    profile: {
      ...fixture.profile,
      commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
    },
  };
}

async function childMessage(
  child: ChildProcess,
  type: string,
): Promise<Record<string, unknown>> {
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`Timed out waiting for child message ${type}`)),
      5_000,
    );
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      clearTimeout(timer);
      reject(new Error(`Child exited before ${type}: ${code ?? signal}`));
    };
    child.once("exit", onExit);
    child.on("message", (message) => {
      if (
        typeof message !== "object" ||
        message === null ||
        (message as { type?: unknown }).type !== type
      )
        return;
      clearTimeout(timer);
      child.off("exit", onExit);
      resolve(message as Record<string, unknown>);
    });
  });
}

async function waitForFile(path: string): Promise<string> {
  let value = "";
  await waitUntilAsync(async () => {
    try {
      value = await readFile(path, "utf8");
      return value.length > 0;
    } catch {
      return false;
    }
  });
  return value;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function processStopped(pid: number): Promise<boolean> {
  try {
    const status = await readFile(`/proc/${pid}/status`, "utf8");
    return /^State:\s+T/m.test(status);
  } catch {
    return false;
  }
}

async function listenOnLoopback(port = 0): Promise<Server> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(
      { host: "127.0.0.1", port, exclusive: true, reusePort: false },
      resolve,
    );
  });
  return server;
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}

async function canBindLoopbackPort(port: number): Promise<boolean> {
  try {
    const server = await listenOnLoopback(port);
    await closeServer(server);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") return false;
    throw error;
  }
}

async function waitUntil(predicate: () => boolean): Promise<void> {
  await waitUntilAsync(async () => predicate());
}

async function waitUntilAsync(
  predicate: () => Promise<boolean>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("Timed out waiting for subprocess state");
}

async function installationFixture() {
  const root = await mkdtemp(join(tmpdir(), "paperclip-acpx-installation-"));
  temporaryDirectories.push(root);
  const serverDirectory = join(root, "pi-acp");
  const runtimeDirectory = join(root, "pi-runtime");
  const commandDirectory = join(serverDirectory, "bin");
  await Promise.all([
    mkdir(commandDirectory, { recursive: true }),
    mkdir(runtimeDirectory, { recursive: true }),
  ]);
  const serverPackageJsonPath = join(serverDirectory, "package.json");
  const runtimePackageJsonPath = join(runtimeDirectory, "package.json");
  const commandPath = join(commandDirectory, "server.js");
  const command = '#!/usr/bin/env node\nprocess.stdout.write("verified");\n';
  await Promise.all([
    writeFile(
      serverPackageJsonPath,
      JSON.stringify({ version: "0.0.33", bin: "bin/server.js" }),
    ),
    writeFile(runtimePackageJsonPath, JSON.stringify({ version: "0.84.2" })),
    writeFile(commandPath, command),
  ]);
  await chmod(commandPath, 0o755);
  const base = resolveQualifiedAcpxProfile(
    "pi",
    "openrouter/deepseek/deepseek-v4-flash-0731",
  );
  const profile = {
    ...base,
    commandDigest: `sha256:${createHash("sha256").update(command).digest("hex")}`,
  };
  const paths = new Map([
    ["pi-acp", serverPackageJsonPath],
    ["@earendil-works/pi-coding-agent", runtimePackageJsonPath],
  ]);
  return {
    root,
    serverDirectory,
    command,
    profile,
    commandPath,
    commandDirectory,
    runtimeDirectory,
    serverPackageJsonPath,
    runtimePackageJsonPath,
    paths,
    resolve(packageName: string): string {
      const resolved = paths.get(packageName);
      if (!resolved) throw new Error(`unexpected package ${packageName}`);
      return resolved;
    },
  };
}
