import { describe, expect, it } from "vitest";

import {
  createIsolatedCodexAppServerArgs,
  createSecuredCodexThreadParams,
  createSkilllessCodexThreadConfig,
} from "./codex-security-config.js";

describe("Codex security configuration", () => {
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

  it("denies host roots, network access, and unlisted environment variables", () => {
    const args = createIsolatedCodexAppServerArgs({
      HOME: "/host/home",
      CODEX_HOME: "/host/codex",
      PATH: "/safe/bin",
      LANG: "C.UTF-8",
      OPENAI_API_KEY: "must-not-cross",
    }, ["/runner/context"]);
    const serialized = args.join("\n");

    expect(serialized).toContain('"/host/home"="none"');
    expect(serialized).toContain('"/host/codex"="none"');
    expect(serialized).toContain('"/runner/context"="read"');
    expect(serialized).toContain('":workspace_roots"={"."="write"}');
    expect(serialized).toContain('":workspace_roots"={"."="read"}');
    expect(serialized).toContain("network.enabled=false");
    expect(serialized).toContain('PATH="/safe/bin"');
    expect(serialized).toContain('LANG="C.UTF-8"');
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("must-not-cross");
  });

  it("keeps the default runner credential projection readable below HOME", () => {
    const runnerCodexHome = "/home/test/.paperclip/instances/default/runtime/paperclip-runner/run-1/codex-home";
    const args = createIsolatedCodexAppServerArgs({
      HOME: "/home/test",
      CODEX_HOME: "/home/test/.codex",
      PATH: "/usr/bin:/bin",
    }, [runnerCodexHome]);
    const serialized = args.join("\n");

    expect(serialized).toContain('"/home/test"="none"');
    expect(serialized).toContain('"/home/test/.codex"="none"');
    expect(serialized).toContain(`${JSON.stringify(runnerCodexHome)}="read"`);
  });

  it("rejects a filesystem-wide read-only projection", () => {
    expect(() => createIsolatedCodexAppServerArgs({}, ["/"]))
      .toThrow("Codex read-only root cannot be the filesystem root");
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
});
