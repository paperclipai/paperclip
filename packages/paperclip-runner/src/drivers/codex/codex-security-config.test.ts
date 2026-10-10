import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { resolvePinnedCodexCommand } from "./codex-command.js";
import { evalProviderTransportOptions } from "../../cli/eval-provider-runtime.js";
import { describe, expect, it } from "vitest";

import {
  codexExecutableReadOnlyRoots,
  codexNetworkReadOnlyRoots,
  createIsolatedCodexAppServerArgs,
  createSecuredCodexThreadParams,
  createSkilllessCodexThreadConfig,
} from "./codex-security-config.js";

describe("Codex security configuration", () => {
  it("uses the same actual pinned executable for native defaults and direct evals without a global Codex PATH", () => {
    const command = resolvePinnedCodexCommand();
    expect(evalProviderTransportOptions("codex").codexCommand).toBe(command);
    expect(execFileSync(command, ["--version"], { env: { PATH: dirname(process.execPath) },
      encoding: "utf8", timeout: 30_000, maxBuffer: 16 * 1024 }).trim()).toBe("codex-cli 0.160.0");
  });

  it("resolves usable installed Codex commands and an absent-package PATH fallback while rejecting malformed or escaped dependencies", () => {
    // Vitest adds its dependency directories to global module lookup paths.
    // Use the existing Node/tsx boundary so an absent fixture dependency cannot
    // be supplied by the test runner's installed bridge instead.
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { createRequire } from "node:module";
      import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { delimiter, dirname, isAbsolute, join } from "node:path";
      import { resolveCodexCommand, resolvePinnedCodexCommand } from ${JSON.stringify(new URL("./codex-command.ts", import.meta.url).href)};
      import { codexExecutableReadOnlyRoots, createIsolatedCodexAppServerArgs } from ${JSON.stringify(new URL("./codex-security-config.ts", import.meta.url).href)};
      const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-pinned-codex-test-")));
      const pathOnlyRoot = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-path-codex-test-")));
      const pathDirectory = join(pathOnlyRoot, "bin");
      const pathCommand = join(pathDirectory, "codex");
      const commandEnvironment = { PATH: pathDirectory };
      const issuer = join(root, "node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/codex/codex-command.js");
      const adapter = join(root, "node_modules/@paperclipai/adapter-codex-local");
      const bridge = join(adapter, "node_modules/@agentclientprotocol/codex-acp");
      const codex = join(bridge, "node_modules/@openai/codex");
      const executable = join(codex, "bin/codex.js");
      const platformName = "@openai/codex-" + process.platform + "-" + process.arch;
      const platform = join(root, "node_modules", platformName), vendor = join(platform, "vendor");
      const metadata = { name: "@openai/codex", version: "0.160.0", bin: { codex: "bin/codex.js" },
        optionalDependencies: { [platformName]: "npm:@openai/codex@0.160.0-" + process.platform + "-" + process.arch } };
      try {
        mkdirSync(pathDirectory);
        writeFileSync(pathCommand, "#!" + process.execPath + "\\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(9); console.log('codex-cli 0.141.0');\\n", { mode: 0o755 });
        const pathOnlyIssuer = join(pathOnlyRoot, "standalone-command.js");
        assert.equal(resolveCodexCommand(pathOnlyIssuer, commandEnvironment), pathCommand, "Only absent dependency graphs use the selected PATH command");
        assert.equal(execFileSync(resolveCodexCommand(pathOnlyIssuer, commandEnvironment), ["--version"], {
          env: commandEnvironment, encoding: "utf8", timeout: 5_000 }).trim(), "codex-cli 0.141.0");
        const relativeCommand = resolveCodexCommand(pathOnlyIssuer, { PATH: "./bin" }, pathOnlyRoot);
        assert.equal(relativeCommand, pathCommand, "Relative PATH entries use the provider working directory");
        assert.ok(isAbsolute(relativeCommand), "Provider launch receives an absolute executable");
        assert.equal(execFileSync(relativeCommand, ["--version"], {
          cwd: root, env: { PATH: "/missing-codex-command" }, encoding: "utf8", timeout: 5_000 }).trim(), "codex-cli 0.141.0");
        const cwdCommand = join(pathOnlyRoot, "codex");
        writeFileSync(cwdCommand, "#!" + process.execPath + "\\n", { mode: 0o755 });
        const secondDirectory = join(pathOnlyRoot, "second-bin");
        mkdirSync(secondDirectory);
        const secondCommand = join(secondDirectory, "codex");
        writeFileSync(secondCommand, "#!" + process.execPath + "\\n", { mode: 0o755 });
        for (const path of [".", "", "./missing" + delimiter, delimiter + "./bin"]) {
          assert.equal(resolveCodexCommand(pathOnlyIssuer, { PATH: path }, pathOnlyRoot), cwdCommand,
            "Dot and empty PATH entries retain their ordered current-directory meaning");
        }
        for (const [path, expected] of [
          ["./bin" + delimiter + ".", pathCommand],
          ["./bin" + delimiter + "./second-bin", pathCommand],
          ["./second-bin" + delimiter + "./bin", secondCommand],
          ["./missing" + delimiter + "./bin", pathCommand],
        ]) assert.equal(resolveCodexCommand(pathOnlyIssuer, { PATH: path }, pathOnlyRoot), expected,
          "Relative PATH resolution preserves search ordering and skips missing entries");
        for (const environment of [{}, { PATH: "/missing-codex-command" }, { PATH: "./missing" }]) {
          assert.throws(() => resolveCodexCommand(pathOnlyIssuer, environment, pathOnlyRoot),
            /runtime unavailable.*No installed Codex dependency or executable on PATH/,
            "An absent PATH must not implicitly authorize the provider working directory");
        }
        assert.throws(() => resolveCodexCommand(pathOnlyIssuer, { PATH: "./bin" }, root), /runtime unavailable/,
          "Relative PATH must not use a different provider working directory");
        const previousCwd = process.cwd();
        try {
          process.chdir(pathOnlyRoot);
          assert.equal(resolveCodexCommand(pathOnlyIssuer, { PATH: "./bin" }), pathCommand,
            "Omitted working directory follows the current process directory");
        } finally { process.chdir(previousCwd); }
        const directCodex = join(pathOnlyRoot, "node_modules/@openai/codex");
        const directCommand = join(directCodex, "bin/codex.js");
        mkdirSync(dirname(directCommand), { recursive: true });
        writeFileSync(join(directCodex, "package.json"), JSON.stringify({ ...metadata, version: "0.155.0" }));
        writeFileSync(directCommand, "#!" + process.execPath + "\\n", { mode: 0o755 });
        assert.equal(resolveCodexCommand(pathOnlyIssuer, commandEnvironment), directCommand, "A directly installed older wrapper takes precedence over PATH");
        writeFileSync(join(directCodex, "package.json"), JSON.stringify({ ...metadata, name: "unowned-wrapper" }));
        assert.throws(() => resolveCodexCommand(pathOnlyIssuer, commandEnvironment), /unexpected package identity/);
        writeFileSync(join(directCodex, "package.json"), "{");
        assert.throws(() => resolveCodexCommand(pathOnlyIssuer, commandEnvironment), /runtime unavailable/);
        mkdirSync(dirname(issuer), { recursive: true });
        mkdirSync(join(codex, "bin"), { recursive: true });
        writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: "@paperclipai/adapter-codex-local", exports: { "./server": "./server.js" } }));
        writeFileSync(join(adapter, "server.js"), "");
        writeFileSync(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.6.2" }));
        writeFileSync(join(codex, "package.json"), JSON.stringify(metadata));
        mkdirSync(vendor, { recursive: true });
        const platformMetadata = { name: "@openai/codex", version: "0.160.0-" + process.platform + "-" + process.arch,
          os: [process.platform], cpu: [process.arch] };
        writeFileSync(join(platform, "package.json"), JSON.stringify(platformMetadata));
        writeFileSync(executable, "#!" + process.execPath + "\\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(9); console.log('codex-cli 0.160.0');\\n", { mode: 0o755 });
        assert.equal(resolveCodexCommand(issuer, commandEnvironment), executable, "The selected installed bridge closure takes precedence over PATH");
        assert.equal(resolvePinnedCodexCommand(issuer, commandEnvironment), executable, "The published compatibility alias keeps ordinary command semantics");
        const roots = codexExecutableReadOnlyRoots({ PATH: "/missing-codex-command" }, executable);
        assert.ok(roots.includes(vendor), "The npm-hoisted native vendor directory remains readable");
        assert.ok(!roots.includes(platform) && !roots.includes(root), "Hoisting must not expose npm ancestry");
        assert.equal(execFileSync(resolveCodexCommand(issuer, commandEnvironment), ["--version"], { env: { PATH: "/missing-codex-command" },
          encoding: "utf8", timeout: 5_000 }).trim(), "codex-cli 0.160.0");

        for (const bin of ["../../escaped-codex", "/usr/bin/codex", {}, ""]) {
          writeFileSync(join(codex, "package.json"), JSON.stringify({ ...metadata, bin }));
          assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /contained executable|escapes its package/);
        }
        for (const version of ["0.159.0", "0.161.0"]) {
          writeFileSync(join(codex, "package.json"), JSON.stringify({ ...metadata, version }));
          assert.equal(resolveCodexCommand(issuer, commandEnvironment), executable, "Independently usable older and newer installed wrappers remain selectable");
        }
        writeFileSync(join(codex, "package.json"), JSON.stringify({ ...metadata, name: "unowned-wrapper" }));
        assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /unexpected package identity/);
        writeFileSync(join(codex, "package.json"), "{");
        assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /runtime unavailable/);
        writeFileSync(join(codex, "package.json"), JSON.stringify(metadata));
        chmodSync(executable, 0o600);
        assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /runtime unavailable/);
        rmSync(executable);
        writeFileSync(join(root, "external-codex"), "external executable", { mode: 0o755 });
        symlinkSync(join(root, "external-codex"), executable);
        assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /escapes its package/);
        rmSync(executable);
        assert.throws(() => resolveCodexCommand(issuer, commandEnvironment), /runtime unavailable/);
        rmSync(codex, { recursive: true });
        // Use the existing fresh-process boundary: Node caches earlier module
        // paths, whereas a genuinely absent installed graph must use PATH.
        const resolverModule = ${JSON.stringify(new URL("./codex-command.ts", import.meta.url).href)};
        const freshAbsence = [
          'import assert from "node:assert/strict";',
          'import { resolveCodexCommand } from ' + JSON.stringify(resolverModule) + ';',
          'assert.equal(resolveCodexCommand(' + JSON.stringify(issuer) + ',' + JSON.stringify(commandEnvironment) + '),' + JSON.stringify(pathCommand) + ');',
          'assert.throws(() => resolveCodexCommand(' + JSON.stringify(issuer) + ', { PATH: "/missing-codex-command" }), /runtime unavailable.*No installed Codex dependency or executable on PATH/);',
        ].join("\\n");
        execFileSync(process.execPath, ['--no-global-search-paths', '--import', createRequire(resolverModule).resolve('tsx'),
          '--input-type=module', '--eval', freshAbsence], { env: commandEnvironment, encoding: 'utf8', timeout: 5_000 });

        // npm installs the host alias declared by the published server while
        // its bundled JS wrapper deliberately omits optionalDependencies.
        const server = join(root, "node_modules/@paperclipai/server");
        const serverManifest = join(server, "package.json");
        const normalized = join(server, "node_modules/@openai/codex");
        const normalizedManifest = join(normalized, "package.json");
        const normalizedCommand = join(normalized, "bin/codex.js");
        const publishedBridgeManifest = join(server, "node_modules/@agentclientprotocol/codex-acp/package.json");
        const publishedBridgeMetadata = { name: "@agentclientprotocol/codex-acp", version: "1.6.2" };
        const serverMetadata = { name: "@paperclipai/server", dependencies: { "@agentclientprotocol/codex-acp": "1.6.2" },
          optionalDependencies: metadata.optionalDependencies };
        const normalizedMetadata = { ...metadata, optionalDependencies: undefined };
        mkdirSync(dirname(normalizedCommand), { recursive: true });
        mkdirSync(dirname(publishedBridgeManifest), { recursive: true });
        writeFileSync(publishedBridgeManifest, JSON.stringify(publishedBridgeMetadata));
        writeFileSync(serverManifest, JSON.stringify(serverMetadata));
        writeFileSync(normalizedManifest, JSON.stringify(normalizedMetadata));
        writeFileSync(normalizedCommand, "#!" + process.execPath + "\\n", { mode: 0o755 });
        const normalizedRoots = () => codexExecutableReadOnlyRoots({ PATH: "/missing-codex-command" }, normalizedCommand);
        assert.ok(normalizedRoots().includes(vendor), "The normalized published wrapper must retain its selected native sandbox resources");
        const sandbox = createIsolatedCodexAppServerArgs({ HOME: "/private-provider-home" }, normalizedRoots()).join("\\n");
        assert.ok(sandbox.includes(JSON.stringify(vendor) + '=\"read\"'), "Native sandbox resources must reach the actual read-only permission configuration");
        assert.ok(sandbox.includes('\"/private-provider-home\"=\"none\"'), "The provider home remains denied");
        for (const ancestor of [platform, dirname(platform), join(root, "node_modules"), server, root]) {
          assert.ok(!normalizedRoots().includes(ancestor), "Platform discovery must not grant enclosing npm or server roots");
        }
        const restoreMetadata = () => {
          writeFileSync(serverManifest, JSON.stringify(serverMetadata));
          writeFileSync(publishedBridgeManifest, JSON.stringify(publishedBridgeMetadata));
          writeFileSync(normalizedManifest, JSON.stringify(normalizedMetadata));
          writeFileSync(join(platform, "package.json"), JSON.stringify(platformMetadata));
        };
        // Resource lookup protects package ownership and paths. Version
        // qualification belongs to ACPX, not ordinary Codex shell access.
        for (const version of ["0.159.0", "0.161.0"]) {
          for (const [path, changed] of [
            [serverManifest, { ...serverMetadata, optionalDependencies: { [platformName]: "npm:@openai/codex@" + version + "-" + process.platform + "-" + process.arch } }],
            [serverManifest, { ...serverMetadata, dependencies: { "@agentclientprotocol/codex-acp": version } }],
            [publishedBridgeManifest, { ...publishedBridgeMetadata, version }],
            [normalizedManifest, { ...normalizedMetadata, version }],
            [join(platform, "package.json"), { ...platformMetadata, version: version + "-" + process.platform + "-" + process.arch }],
          ]) {
            writeFileSync(path, JSON.stringify(changed));
            assert.ok(normalizedRoots().includes(vendor), "Older or newer usable metadata must retain native resources independently of other version numbers");
            for (const ancestor of [platform, dirname(platform), server, root]) assert.ok(!normalizedRoots().includes(ancestor));
            restoreMetadata();
          }
        }
        for (const [path, changed] of [
          [serverManifest, { ...serverMetadata, optionalDependencies: {} }],
          [serverManifest, { ...serverMetadata, name: "unowned-server" }],
          [serverManifest, { ...serverMetadata, optionalDependencies: { [platformName]: "npm:unowned/codex@0.160.0-" + process.platform + "-" + process.arch } }],
          [serverManifest, { ...serverMetadata, optionalDependencies: { [platformName]: "file:/unowned/native" } }],
          [serverManifest, { ...serverMetadata, optionalDependencies: { [platformName]: "npm:@openai/codex@0.160.0-unsupported-os-" + process.arch } }],
          [serverManifest, { ...serverMetadata, dependencies: {} }],
          [serverManifest, { ...serverMetadata, dependencies: { "@agentclientprotocol/codex-acp": "" } }],
          [publishedBridgeManifest, { ...publishedBridgeMetadata, name: "unqualified-bridge" }],
          [normalizedManifest, { ...normalizedMetadata, name: "unowned-wrapper" }],
          [normalizedManifest, { ...normalizedMetadata, optionalDependencies: {} }],
          [join(platform, "package.json"), { ...platformMetadata, name: "unqualified-native" }],
          [join(platform, "package.json"), { ...platformMetadata, os: ["unsupported-os"] }],
          [join(platform, "package.json"), { ...platformMetadata, cpu: ["unsupported-cpu"] }],
        ]) {
          writeFileSync(path, JSON.stringify(changed));
          assert.ok(!normalizedRoots().includes(vendor), "Unqualified metadata must not grant native resources");
          restoreMetadata();
        }
        const outsideVendor = join(root, "outside-vendor");
        mkdirSync(outsideVendor);
        rmSync(vendor, { recursive: true });
        symlinkSync(outsideVendor, vendor);
        assert.ok(!normalizedRoots().includes(outsideVendor), "A vendor symlink must not escape the selected platform package");
        rmSync(vendor); mkdirSync(vendor);
        const outsidePlatform = join(root, "outside-platform");
        mkdirSync(join(outsidePlatform, "vendor"), { recursive: true });
        writeFileSync(join(outsidePlatform, "package.json"), JSON.stringify(platformMetadata));
        rmSync(platform, { recursive: true }); symlinkSync(outsidePlatform, platform);
        assert.ok(!normalizedRoots().includes(join(outsidePlatform, "vendor")), "An alias symlink must not grant a foreign package");
        rmSync(platform); mkdirSync(vendor, { recursive: true });
        writeFileSync(join(platform, "package.json"), JSON.stringify(platformMetadata));

      } finally { rmSync(root, { recursive: true, force: true }); rmSync(pathOnlyRoot, { recursive: true, force: true }); }
      process.stdout.write("PINNED_CODEX_ISOLATION_VERIFIED");
    `;
    expect(execFileSync(process.execPath, [
      "--no-global-search-paths", "--import", createRequire(import.meta.url).resolve("tsx"),
      "--input-type=module", "--eval", source,
    ], { env: { ...process.env, NODE_PATH: "", NODE_OPTIONS: "" }, encoding: "utf8", timeout: 10_000,
      maxBuffer: 32 * 1024 })).toBe("PINNED_CODEX_ISOLATION_VERIFIED");
  });

  it("allows only the registered private instruction directory while keeping shared context read-only", () => {
    const args = createIsolatedCodexAppServerArgs({ HOME: "/host/home" }, ["/runtime/immutable-context"], "/runtime/instruction-edits/run-1").join("\n");
    expect(args).toContain('"/runtime/instruction-edits/run-1"="write"');
    expect(args).toContain('"/runtime/immutable-context"="read"');
    expect(args).not.toContain('"/runtime"="write"');
    expect(args).toContain('"/host/home"="none"');
    expect(createIsolatedCodexAppServerArgs({ PAPERCLIP_INSTRUCTION_ROOT: "/host/home" }).join("\n"))
      .not.toContain('"/host/home"="write"');
  });

  it("exposes AGENT_HOME only when it matches the controller-registered writable directory", () => {
    const root = "/agent-files/run-1";
    const registered = createIsolatedCodexAppServerArgs({ AGENT_HOME: root, HOME: "/provider" }, [], root).join("\n");
    expect(registered).toContain('AGENT_HOME="/agent-files/run-1"');
    expect(registered).toContain('"/provider"="none"');
    expect(createIsolatedCodexAppServerArgs({ AGENT_HOME: "/arbitrary" }, [], root).join("\n")).not.toContain("AGENT_HOME");
    expect(createIsolatedCodexAppServerArgs({ AGENT_HOME: root }).join("\n")).not.toContain("AGENT_HOME");
  });

  it("makes the installed npm Codex native sandbox executable readable without exposing its parent workspace", () => {
    const command = evalProviderTransportOptions("codex").codexCommand!;
    const manifest = createRequire(command).resolve(`@openai/codex-${process.platform}-${process.arch}/package.json`);
    const vendor = resolve(dirname(manifest), "vendor");
    const roots = codexExecutableReadOnlyRoots({ HOME: "/private-provider-home", PATH: "/usr/bin" }, command);
    expect(roots).toContain(vendor);
    expect(roots).toContain(process.execPath);
    expect(roots).not.toContain(dirname(manifest));
    expect(roots).not.toContain("/private-provider-home");
    const args = createIsolatedCodexAppServerArgs({ HOME: "/private-provider-home" }, roots).join("\n");
    expect(args).toContain(`${JSON.stringify(vendor)}="read"`);
    expect(args).toContain('"/private-provider-home"="none"');
  });

  it("preserves target DNS symlink resources without opening all of /run", () => {
    const source = { PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled", PAPERCLIP_RUNNER_NETWORK_ROOTS: '["/run/systemd/resolve/stub-resolv.conf","/etc/ssl/certs"]' };
    const args = createIsolatedCodexAppServerArgs(source).join("\n");
    expect(args).toContain('"/run/systemd/resolve/stub-resolv.conf"="read"');
    expect(args).not.toContain('"/run"="read"');
    expect(codexNetworkReadOnlyRoots({ ...source, PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" })).toEqual([]);
  });

  it("requires the controller's network decision even when GitHub credentials exist", () => {
    for (const GH_TOKEN of [undefined, "managed-token"]) {
      const args = createIsolatedCodexAppServerArgs({ GH_TOKEN }).join("\n");
      expect(args).toContain("network.enabled=false");
      expect(args).not.toContain("network.enabled=true");
    }
  });

  it("honors an explicit network restriction independently of GitHub", () => {
    for (const GH_TOKEN of [undefined, "managed-token"]) {
      const args = createIsolatedCodexAppServerArgs({ GH_TOKEN, PAPERCLIP_RUNNER_NETWORK_ACCESS: "disabled" }).join("\n");
      expect(args).toContain("network.enabled=false");
      expect(args).not.toContain("network.enabled=true");
    }
  });

  it("restores host Git resources without exposing the provider home", () => {
    const args = createIsolatedCodexAppServerArgs({
      HOME: "/provider", CODEX_HOME: "/provider", PATH: "/usr/bin:/bin", PAPERCLIP_GITHUB_AUTH_MODE: "host",
      OPENAI_API_KEY: "must-not-cross", DATABASE_URL: "must-not-cross", PAPERCLIP_API_KEY: "must-not-cross",
      PAPERCLIP_GITHUB_HOST_HOME: "/legacy", GH_CONFIG_DIR: "/legacy/.config/gh",
      SSH_AUTH_SOCK: "/agent/socket", PAPERCLIP_GIT_METADATA_ROOTS: '["/repo/.git","/repo/.git"]',
    }).join("\n");
    const allowlist = JSON.parse(args.split("\n").find((arg) => arg.startsWith("shell_environment_policy.include_only="))!.split("=", 2)[1]!);
    expect(allowlist).toEqual(["GH_CONFIG_DIR", "HOME", "PAPERCLIP_GITHUB_AUTH_MODE", "PAPERCLIP_GITHUB_HOST_HOME", "PAPERCLIP_GIT_METADATA_ROOTS", "PATH", "SSH_AUTH_SOCK"]);
    expect(args).not.toContain("must-not-cross");
    expect(args).not.toContain("OPENAI_API_KEY");
    expect(args).not.toContain("DATABASE_URL");
    expect(args).not.toContain("PAPERCLIP_API_KEY");
    expect(args).toContain('HOME="/legacy"');
    expect(args).toContain('"/legacy/.gitconfig"="read"');
    expect(args).toContain('"/legacy/.ssh"="read"');
    expect(args).toContain('"/agent/socket"="read"');
    expect(args).toContain('"/repo/.git"="write"');
    expect(args).toContain('"/repo/.git"="read"');
    expect(args).toContain('"/provider"="none"');
    expect(args).not.toContain('"/legacy"="read"');
    expect(args.match(/"\/legacy\/.config\/gh"="read"/g)).toHaveLength(2);
  });

  it("disables host extensions and makes collaboration instructions explicit", () => {
    expect(createSkilllessCodexThreadConfig("/workspace", {}, false)).toEqual({
      "skills.include_instructions": false,
      include_apps_instructions: false,
      include_collaboration_mode_instructions: false,
      "features.apps": false,
      "features.plugins": false,
      "features.multi_agent": false,
      "features.memories": false,
      "features.image_generation": false,
    });
  });

  it("keeps automatic execution inside the workspace without host credentials and with normal network access", () => {
    const args = createIsolatedCodexAppServerArgs(
      {
        HOME: "/host/home",
        CODEX_HOME: "/host/codex",
        PATH: "/safe/bin",
        PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled",
        LANG: "C.UTF-8",
        OPENAI_API_KEY: "must-not-cross",
      },
      ["/isolated/codex-home/skills", "/runner/context"],
    );
    const serialized = args.join("\n");

    expect(serialized).toContain('":root"="none"');
    expect(serialized).toContain('":minimal"="read"');
    expect(serialized).toContain('":tmpdir"="none"');
    expect(serialized).toContain('"/host/home"="none"');
    expect(serialized).toContain('"/host/codex"="none"');
    expect(serialized).toContain('"/isolated/codex-home/skills"="read"');
    expect(serialized).not.toContain('"/isolated/codex-home"="read"');
    expect(serialized).toContain('"/runner/context"="read"');
    expect(serialized).toContain('":workspace_roots"={"."="write"}');
    expect(serialized).toContain('":workspace_roots"={"."="read"}');
    expect(serialized).toContain("network.enabled=true");
    expect(serialized).toContain('shell_environment_policy.include_only=["LANG","PAPERCLIP_RUNNER_NETWORK_ACCESS","PATH"]');
    expect(serialized).toContain('PATH="/safe/bin"');
    expect(serialized).toContain('LANG="C.UTF-8"');
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("must-not-cross");
  });

  it("inherits only projected GitHub credentials without serializing their values", () => {
    const args = createIsolatedCodexAppServerArgs({
      PATH: "/safe/bin",
      PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled",
      GH_TOKEN: "must-remain-in-process-environment",
      GITHUB_TOKEN: "must-remain-in-process-environment",
      PAPERCLIP_GIT_TOKEN: "must-remain-in-process-environment",
      GIT_TERMINAL_PROMPT: "0",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
      GIT_CONFIG_VALUE_0: "!trusted-helper",
      OPENAI_API_KEY: "must-not-cross",
    });
    const serialized = args.join("\n");

    expect(serialized).toContain("network.enabled=true");
    expect(serialized).toContain('shell_environment_policy.inherit="all"');
    expect(serialized).toContain(
      "shell_environment_policy.ignore_default_excludes=true",
    );
    expect(serialized).toContain("shell_environment_policy.include_only=");
    expect(serialized).toContain('"GH_TOKEN"');
    expect(serialized).toContain('"GIT_CONFIG_KEY_0"');
    expect(serialized).toContain('"GIT_CONFIG_VALUE_0"');
    expect(serialized).not.toContain("must-remain-in-process-environment");
    expect(serialized).not.toContain("must-not-cross");
    expect(serialized).not.toContain("!trusted-helper");
  });

  it("isolates managed launcher profiles and never serializes broker capabilities or host API credentials", () => {
    const serialized = createIsolatedCodexAppServerArgs({
      HOME: "/isolated/provider", CODEX_HOME: "/isolated/provider",
      PATH: "/runtime/run-B:/safe/bin",
      PAPERCLIP_GITHUB_LAUNCHER_DIR: "/runtime/run-B",
      PAPERCLIP_GITHUB_BROKER_TOKEN: "private-run-capability",
      PAPERCLIP_GITHUB_BRIDGE_TOKEN: "private-bridge-capability",
      PAPERCLIP_API_KEY: "forbidden-agent-token",
      GH_CONFIG_DIR: "/runtime/run-B/gh-config",
    }).join("\n");
    expect(serialized).toContain('"/isolated/provider"="none"');
    expect(serialized).toContain('"/runtime/run-B"="read"');
    expect(serialized).toContain('"/runtime/run-B/gh-config"="write"');
    expect(serialized).toContain('HOME="/runtime/run-B"');
    expect(serialized).toContain('ZDOTDIR="/runtime/run-B"');
    expect(serialized).toContain('BASH_ENV="/runtime/run-B/.bashrc"');
    expect(serialized).toContain('"PAPERCLIP_GITHUB_BRIDGE_TOKEN"');
    expect(serialized).not.toContain("PAPERCLIP_API_KEY");
    expect(serialized).not.toContain("private-run-capability");
    expect(serialized).not.toContain("private-bridge-capability");
    expect(serialized).not.toContain("forbidden-agent-token");
  });

  it("uses a read-only permission profile for plan mode", () => {
    expect(createSecuredCodexThreadParams("/workspace", "plan")).toMatchObject({
      cwd: "/workspace",
      permissions: "paperclip-runner-workspace-read-only",
      runtimeWorkspaceRoots: ["/workspace"],
      config: {
        "skills.include_instructions": false,
        include_collaboration_mode_instructions: true,
      },
    });
  });

  it("uses the outer sandbox for default-mode commands only when the controller authorizes it", () => {
    const source = { PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1", PAPERCLIP_RUNNER_NETWORK_ACCESS: "enabled" };
    const externalArgs = createIsolatedCodexAppServerArgs(source);
    const serializedExternalArgs = externalArgs.join("\n");
    expect(externalArgs).toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
    expect(serializedExternalArgs).toContain(
      'default_permissions="paperclip-runner-external-sandbox"',
    );
    expect(serializedExternalArgs).toContain(
      'permissions.paperclip-runner-external-sandbox.filesystem={":root"="write"}',
    );
    expect(serializedExternalArgs).toContain(
      "permissions.paperclip-runner-external-sandbox.network.enabled=true",
    );
    expect(
      createSecuredCodexThreadParams(
        "/workspace",
        "default",
        true,
        false,
        source,
      ),
    ).toMatchObject({
      permissions: "paperclip-runner-external-sandbox",
    });
    expect(
      createSecuredCodexThreadParams(
        "/workspace",
        "plan",
        true,
        false,
        source,
      ),
    ).toMatchObject({
      permissions: "paperclip-runner-workspace-read-only",
    });
    expect(createIsolatedCodexAppServerArgs({})).not.toContain(
      "--dangerously-bypass-approvals-and-sandbox",
    );
  });
});
