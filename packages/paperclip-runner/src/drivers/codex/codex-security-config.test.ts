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
