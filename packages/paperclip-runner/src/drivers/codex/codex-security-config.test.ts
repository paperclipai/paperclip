import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { evalProviderTransportOptions } from "../../cli/eval-provider-runtime.js";
import { resolvePinnedCodexCommand } from "./codex-command.js";
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

  it("resolves an isolated public server dependency graph and rejects missing, mismatched or escaped commands", () => {
    // Vitest adds its dependency directories to global module lookup paths.
    // Use the existing Node/tsx boundary so an absent fixture dependency cannot
    // be supplied by the test runner's installed bridge instead.
    const source = `
      import assert from "node:assert/strict";
      import { execFileSync } from "node:child_process";
      import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
      import { tmpdir } from "node:os";
      import { dirname, join } from "node:path";
      import { resolvePinnedCodexCommand } from ${JSON.stringify(new URL("./codex-command.ts", import.meta.url).href)};
      const root = realpathSync(mkdtempSync(join(tmpdir(), "paperclip-pinned-codex-test-")));
      const issuer = join(root, "node_modules/@paperclipai/server/dist/vendor/paperclip-runner/drivers/codex/codex-command.js");
      const adapter = join(root, "node_modules/@paperclipai/adapter-codex-local");
      const bridge = join(adapter, "node_modules/@agentclientprotocol/codex-acp");
      const codex = join(bridge, "node_modules/@openai/codex");
      const executable = join(codex, "bin/codex.js");
      const metadata = { name: "@openai/codex", version: "0.160.0", bin: { codex: "bin/codex.js" } };
      try {
        mkdirSync(dirname(issuer), { recursive: true });
        mkdirSync(join(codex, "bin"), { recursive: true });
        writeFileSync(join(adapter, "package.json"), JSON.stringify({ name: "@paperclipai/adapter-codex-local", exports: { "./server": "./server.js" } }));
        writeFileSync(join(adapter, "server.js"), "");
        writeFileSync(join(bridge, "package.json"), JSON.stringify({ name: "@agentclientprotocol/codex-acp", version: "1.6.2" }));
        writeFileSync(join(codex, "package.json"), JSON.stringify(metadata));
        writeFileSync(executable, "#!" + process.execPath + "\\nif (process.argv.slice(2).join(' ') !== '--version') process.exit(9); console.log('codex-cli 0.160.0');\\n", { mode: 0o755 });
        assert.equal(resolvePinnedCodexCommand(issuer), executable);
        assert.equal(execFileSync(resolvePinnedCodexCommand(issuer), ["--version"], { env: { PATH: "/missing-codex-command" },
          encoding: "utf8", timeout: 5_000 }).trim(), "codex-cli 0.160.0");

        for (const bin of ["../../escaped-codex", "/usr/bin/codex", {}, ""]) {
          writeFileSync(join(codex, "package.json"), JSON.stringify({ ...metadata, bin }));
          assert.throws(() => resolvePinnedCodexCommand(issuer), /contained executable|escapes its package/);
        }
        writeFileSync(join(codex, "package.json"), JSON.stringify({ ...metadata, version: "0.159.0" }));
        assert.throws(() => resolvePinnedCodexCommand(issuer), /version mismatch.*0\\.160\\.0/);
        writeFileSync(join(codex, "package.json"), JSON.stringify(metadata));
        chmodSync(executable, 0o600);
        assert.throws(() => resolvePinnedCodexCommand(issuer), /runtime unavailable/);
        rmSync(executable);
        writeFileSync(join(root, "external-codex"), "external executable", { mode: 0o755 });
        symlinkSync(join(root, "external-codex"), executable);
        assert.throws(() => resolvePinnedCodexCommand(issuer), /escapes its package/);
        rmSync(executable);
        assert.throws(() => resolvePinnedCodexCommand(issuer), /runtime unavailable/);
        rmSync(codex, { recursive: true });
        assert.throws(() => resolvePinnedCodexCommand(issuer), /runtime unavailable.*Legacy runner/);
      } finally { rmSync(root, { recursive: true, force: true }); }
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
