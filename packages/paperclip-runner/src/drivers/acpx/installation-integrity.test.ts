import { createHash } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  symlink,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveQualifiedAcpxProfile } from "./qualified-profiles.js";
import {
  guardSnapshotModuleLookup,
  guardSnapshotModuleResolution,
  sanitizedNodeEnvironment,
  snapshotDescriptorAncestorIndex,
  snapshotDescriptorResolution,
  verifiedExecutableOpenFlags,
  verifyQualifiedAcpxInstallation,
} from "./installation-integrity.js";

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
    resolve(packageName: string): string {
      const resolved = paths.get(packageName);
      if (!resolved) throw new Error(`unexpected package ${packageName}`);
      return resolved;
    },
  };
}
