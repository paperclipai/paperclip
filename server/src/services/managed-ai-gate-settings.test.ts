import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertManagedAiGateReachesRemoteTarget,
  collectHookCommands,
  hookCommandLocalPath,
  hostOnlyHookCommandPaths,
  isManagedAiGateUnreachableError,
  resolveHostClaudeSettingsDir,
  runReadsClaudeUserSettings,
  seedManagedAiGateSettings,
  selectManagedAiGateSettings,
} from "./managed-ai-gate-settings.js";

const GATE_HOOKS = {
  PreToolUse: [
    {
      matcher: "Bash",
      hooks: [
        { type: "command", command: "/opt/flow/hooks/merge-gate.sh", timeout: 15 },
        { type: "command", command: "rtk hook claude", timeout: 10 },
      ],
    },
  ],
};

describe("managed AI gate settings", () => {
  let root: string;
  let hostDir: string;
  let providerHome: string;

  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "paperclip-gate-settings-test-"));
    hostDir = path.join(root, "host-claude");
    providerHome = path.join(root, "managed-home", "provider");
    await mkdir(hostDir, { recursive: true });
    await mkdir(providerHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function writeHostSettings(settings: unknown) {
    await writeFile(path.join(hostDir, "settings.json"), JSON.stringify(settings), "utf8");
  }

  async function writeReachableHook(relative = "merge-gate.sh") {
    const hookPath = path.join(root, relative);
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    return hookPath;
  }

  it("carries the host hooks block and the deny list into the managed config dir", async () => {
    const hookPath = await writeReachableHook();
    await writeHostSettings({
      env: { PATH: "/only/on/the/host", CLAUDE_CODE_FORCE_SESSION_PERSISTENCE: "1" },
      apiKeyHelper: "/usr/local/bin/leak-a-key",
      permissions: { deny: ["Bash(gh pr merge:*)"], defaultMode: "bypassPermissions" },
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookPath }] }],
      },
      outputStyle: "Concise",
    });

    const result = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir });

    expect(result.settingsPath).toBe(path.join(providerHome, "settings.json"));
    expect(result.hookCommands).toEqual([hookPath]);
    expect(result.denyRules).toEqual(["Bash(gh pr merge:*)"]);

    const written = JSON.parse(await readFile(result.settingsPath!, "utf8")) as Record<string, unknown>;
    // The gate is carried.
    expect(written.hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookPath }] }],
    });
    expect(written.permissions).toEqual({ deny: ["Bash(gh pr merge:*)"] });
    // Nothing that could re-inject a provider credential, repoint the runner's
    // PATH, or widen the run's permission posture comes along with it.
    expect(Object.keys(written).sort()).toEqual(["hooks", "permissions"]);
  });

  it("drops a host deny list that is not a list of rule strings", async () => {
    await writeHostSettings({ permissions: { deny: ["Bash(op:*)", 42, null] }, hooks: {} });

    const result = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir });

    expect(result.denyRules).toEqual(["Bash(op:*)"]);
  });

  it("writes nothing when the host declares no gate", async () => {
    await writeHostSettings({ outputStyle: "Concise", permissions: { defaultMode: "default" } });

    const result = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir });

    expect(result).toEqual({ settingsPath: null, hookCommands: [], denyRules: [] });
    await expect(readFile(path.join(providerHome, "settings.json"), "utf8")).rejects.toThrow();
  });

  it("writes nothing when the host has no user settings file at all", async () => {
    const result = await seedManagedAiGateSettings({
      providerHome,
      hostSettingsDir: path.join(root, "absent"),
    });

    expect(result).toEqual({ settingsPath: null, hookCommands: [], denyRules: [] });
  });

  it("fails loudly when the host settings file exists but cannot be parsed", async () => {
    await writeFile(path.join(hostDir, "settings.json"), "{ not json", "utf8");

    const error = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir }).catch(
      (thrown: unknown) => thrown,
    );

    expect(isManagedAiGateUnreachableError(error)).toBe(true);
    expect(isManagedAiGateUnreachableError(error) && error.reason).toBe("host_settings_unreadable");
  });

  it("fails loudly when a carried hook command is not an executable file", async () => {
    const missing = path.join(root, "gone.sh");
    await writeHostSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: missing }] }] },
    });

    const error = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir }).catch(
      (thrown: unknown) => thrown,
    );

    expect(isManagedAiGateUnreachableError(error)).toBe(true);
    if (!isManagedAiGateUnreachableError(error)) throw error;
    expect(error.reason).toBe("hook_command_unreachable");
    expect(error.detail).toEqual([missing]);
    expect(error.message).toContain(missing);
  });

  // Root ignores the executable bit, so the unreadable-mode case cannot be
  // observed from a root test runner.
  it.skipIf(process.getuid?.() === 0)("fails loudly when a carried hook command exists but is not executable", async () => {
    const hookPath = path.join(root, "not-executable.sh");
    await writeFile(hookPath, "#!/bin/sh\nexit 0\n");
    await chmod(hookPath, 0o644);
    await writeHostSettings({
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: hookPath }] }] },
    });

    const error = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir }).catch(
      (thrown: unknown) => thrown,
    );

    expect(isManagedAiGateUnreachableError(error)).toBe(true);
    expect(isManagedAiGateUnreachableError(error) && error.detail).toEqual([hookPath]);
  });

  it("leaves a PATH-resolved or shell-snippet hook command to the runner", async () => {
    await writeHostSettings({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "rtk hook claude" }] }],
        PostToolUse: [
          {
            matcher: "Write",
            hooks: [{ type: "command", command: 'FILE=$(jq -r .x); cd "$DIR" && cargo fmt' }],
          },
        ],
      },
    });

    const result = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir });

    expect(result.settingsPath).not.toBeNull();
    expect(result.hookCommands).toHaveLength(2);
  });

  it("carries a hooks block whose handlers have no command to check", async () => {
    // Whether the gate is carried must not depend on it naming a path this
    // module knows how to verify. A prompt-type PreToolUse handler is still a
    // declared gate, and dropping it would start the run ungated.
    await writeHostSettings({
      hooks: {
        PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "Refuse main writes" }] }],
      },
    });

    const result = await seedManagedAiGateSettings({ providerHome, hostSettingsDir: hostDir });

    expect(result.settingsPath).toBe(path.join(providerHome, "settings.json"));
    expect(result.hookCommands).toEqual([]);
    const written = JSON.parse(await readFile(result.settingsPath!, "utf8")) as Record<string, unknown>;
    expect(written.hooks).toEqual({
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "prompt", prompt: "Refuse main writes" }] }],
    });
  });

  describe("selectManagedAiGateSettings", () => {
    it("ignores a hooks block that is not an object", () => {
      expect(selectManagedAiGateSettings({ hooks: "all of them" }).settings).toEqual({});
    });

    it("ignores host settings that are not an object", () => {
      expect(selectManagedAiGateSettings(null).settings).toEqual({});
      expect(selectManagedAiGateSettings([GATE_HOOKS]).settings).toEqual({});
    });
  });

  describe("collectHookCommands", () => {
    it("collects every command hook across events and matchers", () => {
      expect(collectHookCommands(GATE_HOOKS)).toEqual([
        "/opt/flow/hooks/merge-gate.sh",
        "rtk hook claude",
      ]);
    });

    it("skips entries that are not command hooks", () => {
      expect(
        collectHookCommands({
          PreToolUse: [
            { hooks: [{ type: "prompt", prompt: "no command here" }, { command: 7 }] },
            "not a matcher group",
          ],
          SessionStart: "not a list",
        }),
      ).toEqual([]);
    });
  });

  describe("hookCommandLocalPath", () => {
    it("reads an absolute first token, quoted or bare", () => {
      expect(hookCommandLocalPath("/opt/flow/hooks/merge-gate.sh")).toBe(
        "/opt/flow/hooks/merge-gate.sh",
      );
      expect(hookCommandLocalPath("  /opt/a.sh --flag ")).toBe("/opt/a.sh");
      expect(hookCommandLocalPath("'/opt/with space/a.sh' --flag")).toBe("/opt/with space/a.sh");
      expect(hookCommandLocalPath('"/opt/with space/a.sh"')).toBe("/opt/with space/a.sh");
    });

    it("returns null for anything it cannot resolve to one local file", () => {
      expect(hookCommandLocalPath("rtk hook claude")).toBeNull();
      expect(hookCommandLocalPath("$CLAUDE_PROJECT_DIR/hooks/a.sh")).toBeNull();
      expect(hookCommandLocalPath("FILE=$(jq -r .x); cargo fmt")).toBeNull();
      expect(hookCommandLocalPath("")).toBeNull();
    });
  });

  describe("resolveHostClaudeSettingsDir", () => {
    it("reads the server process environment, then the home default", () => {
      expect(resolveHostClaudeSettingsDir({ CLAUDE_CONFIG_DIR: "/inherited" })).toBe("/inherited");
      expect(resolveHostClaudeSettingsDir({ CLAUDE_CONFIG_DIR: "   " })).toBe(
        path.join(os.homedir(), ".claude"),
      );
      expect(resolveHostClaudeSettingsDir({})).toBe(path.join(os.homedir(), ".claude"));
    });

    it("takes only one argument, so agent config cannot name the gate source", () => {
      // A configured CLAUDE_CONFIG_DIR is overridden by the managed home when
      // the run's env is built, so letting it choose the gate source would be a
      // one-way bypass: point it at a dir with no settings.json, carry no gate.
      expect(resolveHostClaudeSettingsDir.length).toBe(1);
    });
  });

  describe("runReadsClaudeUserSettings", () => {
    it("is true for the Claude adapter, whose provider reads the managed config dir", () => {
      expect(runReadsClaudeUserSettings("claude_local")).toBe(true);
    });

    it("is false for a paperclip runner, which builds its own agent home", () => {
      // drivers/acpx/runtime-sandbox.ts repoints CLAUDE_CONFIG_DIR at a per-run
      // agent home unconditionally, and Claude Managed is an API lane with no
      // settings source at all. Seeding for either would report a dead gate as
      // a live one.
      expect(runReadsClaudeUserSettings("paperclip_runner")).toBe(false);
      expect(runReadsClaudeUserSettings("codex_local")).toBe(false);
    });
  });

  describe("assertManagedAiGateReachesRemoteTarget", () => {
    it("fails a remote run whose carried hook names a server-only path", () => {
      const error = (() => {
        try {
          assertManagedAiGateReachesRemoteTarget({
            hookCommands: ["/opt/flow/hooks/merge-gate.sh --strict", "rtk hook claude"],
            environmentName: "prod-sandbox",
          });
          return null;
        } catch (thrown: unknown) {
          return thrown;
        }
      })();

      expect(isManagedAiGateUnreachableError(error)).toBe(true);
      if (!isManagedAiGateUnreachableError(error)) throw error ?? new Error("no throw");
      expect(error.reason).toBe("hook_command_not_portable");
      expect(error.detail).toEqual(["/opt/flow/hooks/merge-gate.sh"]);
      expect(error.message).toContain("prod-sandbox");
    });

    it("leaves a PATH-resolved hook to the remote environment, and passes with no hooks", () => {
      expect(() =>
        assertManagedAiGateReachesRemoteTarget({ hookCommands: ["rtk hook claude"] }),
      ).not.toThrow();
      expect(() => assertManagedAiGateReachesRemoteTarget({ hookCommands: [] })).not.toThrow();
    });
  });

  describe("hostOnlyHookCommandPaths", () => {
    it("names every carried hook command that is one absolute server path", () => {
      expect(hostOnlyHookCommandPaths(collectHookCommands(GATE_HOOKS))).toEqual([
        "/opt/flow/hooks/merge-gate.sh",
      ]);
    });
  });
});
