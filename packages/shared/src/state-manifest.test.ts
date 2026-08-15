import path from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_MANIFEST } from "./state-manifest.js";

describe("STATE_MANIFEST", () => {
  it("covers every approved inventory class with absolute live-layout paths", () => {
    const homeDir = path.resolve("/tmp/paperclip-manifest-home");
    const expected = [
      "cli_auth_context", "plugin_install_set", "adapter_state", "host_secrets", "host_maintenance",
      "host_ephemeral", "instance_config", "database", "attachment_storage", "run_logs",
      "local_backup_staging", "agent_instructions_bundle", "secrets_master_key", "codex_agent_home",
      "runtime_materializations", "skill_bundles", "project_repositories", "execution_workspaces",
      "instance_logs", "claude_memory", "claude_transcripts", "claude_runtime_state", "claude_cache",
      "external_cli_homes",
    ];

    expect(STATE_MANIFEST.map((entry) => entry.id)).toEqual(expected);
    for (const entry of STATE_MANIFEST) {
      const paths = entry.resolve({ homeDir, instanceId: "live" });
      expect(paths.length).toBeGreaterThan(0);
      for (const resolved of paths) expect(path.isAbsolute(resolved)).toBe(true);
    }
    expect(STATE_MANIFEST.find((entry) => entry.id === "secrets_master_key")?.resolve({ homeDir, instanceId: "live" })[0])
      .toBe(path.join(homeDir, "instances", "live", "secrets", "master.key"));
    expect(STATE_MANIFEST.find((entry) => entry.id === "codex_agent_home")?.resolve({ homeDir, instanceId: "live" }))
      .toContain(path.join(homeDir, "instances", "live", "companies", "*", "agents", "*", "codex-home"));
  });
});
