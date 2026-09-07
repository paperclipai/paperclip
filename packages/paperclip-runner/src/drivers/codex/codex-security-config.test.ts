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

  it("keeps automatic execution inside the workspace without credential or network access", () => {
    const args = createIsolatedCodexAppServerArgs(
      {
        HOME: "/host/home",
        CODEX_HOME: "/host/codex",
        PATH: "/safe/bin",
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
    expect(serialized).toContain("network.enabled=false");
    expect(serialized).toContain('shell_environment_policy.inherit="none"');
    expect(serialized).toContain('PATH="/safe/bin"');
    expect(serialized).toContain('LANG="C.UTF-8"');
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("must-not-cross");
  });

  it("inherits only projected GitHub credentials without serializing their values", () => {
    const args = createIsolatedCodexAppServerArgs({
      PATH: "/safe/bin",
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
    const source = { PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1" };
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
