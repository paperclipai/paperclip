import { describe, expect, it } from "vitest";
import {
  canonicalizeEffectiveRunConfigCategory,
  createEffectiveRunConfigFingerprints,
  diffEffectiveRunConfigFingerprints,
} from "../services/effective-run-config-fingerprints.ts";

describe("effective run config fingerprints", () => {
  it("emits versioned deterministic fingerprints with stable object ordering", () => {
    const first = createEffectiveRunConfigFingerprints({
      session: {
        adapterType: "codex_local",
        adapterConfig: {
          env: {
            ZETA: "raw-zeta",
            ALPHA: "raw-alpha",
            PAPERCLIP_RUN_ID: "run-one",
          },
          model: "gpt-5.2",
        },
      },
      workspace: {
        repoRef: "main",
        repoUrl: "https://github.com/example/repo.git",
        workspaceRuntime: {
          services: [
            {
              env: { PORT: "3100", FEATURE_FLAG: "enabled" },
              command: "pnpm dev",
            },
          ],
        },
      },
      lease: {
        environmentId: "environment-1",
        config: { beta: true, alpha: 1 },
      },
    });

    const second = createEffectiveRunConfigFingerprints({
      lease: {
        config: { alpha: 1, beta: true },
        environmentId: "environment-1",
      },
      workspace: {
        workspaceRuntime: {
          services: [
            {
              command: "pnpm dev",
              env: { FEATURE_FLAG: "enabled", PORT: "3100" },
            },
          ],
        },
        repoUrl: "https://github.com/example/repo.git",
        repoRef: "main",
      },
      session: {
        adapterConfig: {
          model: "gpt-5.2",
          env: {
            PAPERCLIP_RUN_ID: "run-two",
            ALPHA: "raw-alpha",
            ZETA: "raw-zeta",
          },
        },
        adapterType: "codex_local",
      },
    });

    expect(first.version).toBe(1);
    expect(first.categories).toEqual(["session", "workspace", "lease"]);
    expect(first.sessionFingerprint).toMatchObject({
      version: 1,
      category: "session",
      algorithm: "sha256",
    });
    expect(first.sessionFingerprint.fingerprint).toMatch(/^v1:sha256:[a-f0-9]{64}$/);
    expect(second).toEqual(first);
  });

  it("reports changed categories independently", () => {
    const base = createEffectiveRunConfigFingerprints({
      session: { adapterType: "codex_local", model: "gpt-5.2" },
      workspace: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" } },
      lease: { environmentId: "environment-1", reuseLease: true },
    });

    expect(diffEffectiveRunConfigFingerprints(
      base,
      createEffectiveRunConfigFingerprints({
        session: { adapterType: "codex_local", model: "gpt-5.3" },
        workspace: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" } },
        lease: { environmentId: "environment-1", reuseLease: true },
      }),
    )).toMatchObject({
      hasChanges: true,
      changedCategories: ["session"],
      changed: { session: true, workspace: false, lease: false },
    });

    expect(diffEffectiveRunConfigFingerprints(
      base,
      createEffectiveRunConfigFingerprints({
        session: { adapterType: "codex_local", model: "gpt-5.2" },
        workspace: { workspaceStrategy: { type: "git_worktree", branchTemplate: "custom-{{issue.identifier}}" } },
        lease: { environmentId: "environment-1", reuseLease: true },
      }),
    ).changedCategories).toEqual(["workspace"]);

    expect(diffEffectiveRunConfigFingerprints(
      base,
      createEffectiveRunConfigFingerprints({
        session: { adapterType: "codex_local", model: "gpt-5.2" },
        workspace: { workspaceStrategy: { type: "git_worktree", branchTemplate: "{{issue.identifier}}" } },
        lease: { environmentId: "environment-2", reuseLease: true },
      }),
    ).changedCategories).toEqual(["lease"]);
  });

  it("uses resolved secret version metadata without raw secret values", () => {
    const v7 = createEffectiveRunConfigFingerprints({
      session: {
        adapterConfig: {
          env: {
            OPENAI_API_KEY: "resolved-secret-value",
            PLAIN_TEXT: "plain env value",
          },
        },
      },
      secretManifest: [
        {
          configPath: "env.OPENAI_API_KEY",
          envKey: "OPENAI_API_KEY",
          secretId: "secret-1",
          bindingId: "binding-1",
          version: 7,
          provider: "local_encrypted",
          providerVersionRef: "provider-version-7",
          outcome: "success",
        },
      ],
    });
    const canonical = v7.sessionFingerprint.canonicalJson;

    expect(canonical).toContain("secret-1");
    expect(canonical).toContain("binding-1");
    expect(canonical).toContain("provider-version-7");
    expect(canonical).toContain("\"version\":7");
    expect(canonical).not.toContain("resolved-secret-value");
    expect(canonical).not.toContain("plain env value");
    expect(canonical).not.toContain("fingerprintSha256");

    const rawValueChanged = createEffectiveRunConfigFingerprints({
      session: {
        adapterConfig: {
          env: {
            OPENAI_API_KEY: "different-resolved-secret-value",
            PLAIN_TEXT: "plain env value",
          },
        },
      },
      secretManifest: [
        {
          configPath: "env.OPENAI_API_KEY",
          envKey: "OPENAI_API_KEY",
          secretId: "secret-1",
          bindingId: "binding-1",
          version: 7,
          provider: "local_encrypted",
          providerVersionRef: "provider-version-7",
          outcome: "success",
        },
      ],
    });
    expect(rawValueChanged.sessionFingerprint.fingerprint).toBe(v7.sessionFingerprint.fingerprint);

    const versionChanged = createEffectiveRunConfigFingerprints({
      session: {
        adapterConfig: {
          env: {
            OPENAI_API_KEY: "different-resolved-secret-value",
            PLAIN_TEXT: "plain env value",
          },
        },
      },
      secretManifest: [
        {
          configPath: "env.OPENAI_API_KEY",
          envKey: "OPENAI_API_KEY",
          secretId: "secret-1",
          bindingId: "binding-1",
          version: 8,
          provider: "local_encrypted",
          providerVersionRef: "provider-version-8",
          outcome: "success",
        },
      ],
    });
    expect(versionChanged.sessionFingerprint.fingerprint).not.toBe(v7.sessionFingerprint.fingerprint);
  });

  it("detects plain env value drift without storing raw values", () => {
    const base = createEffectiveRunConfigFingerprints({
      session: {
        adapterConfig: {
          env: {
            FEATURE_FLAG: "enabled",
          },
        },
      },
    });
    const changed = createEffectiveRunConfigFingerprints({
      session: {
        adapterConfig: {
          env: {
            FEATURE_FLAG: "disabled",
          },
        },
      },
    });

    expect(changed.sessionFingerprint.fingerprint).not.toBe(base.sessionFingerprint.fingerprint);
    expect(base.sessionFingerprint.canonicalJson).toContain('"valueHash":"sha256:');
    expect(base.sessionFingerprint.canonicalJson).not.toContain("enabled");
    expect(changed.sessionFingerprint.canonicalJson).not.toContain("disabled");
  });

  it("excludes generated run values, sensitive tokens, timestamps, and session path noise", () => {
    const first = createEffectiveRunConfigFingerprints({
      session: {
        sessionId: "generated-session-one",
        runId: "run-one",
        cwd: "/runtime/noise/project-a",
        updatedAt: "2026-06-01T00:00:00.000Z",
        adapterConfig: {
          token: "token-one",
          nested: {
            authorization: "Bearer first",
          },
          env: {
            PAPERCLIP_API_KEY: "runtime-api-key-one",
            NORMAL_VALUE: "first",
          },
        },
      },
      lease: {
        leaseId: "lease-one",
        providerLeaseId: "provider-lease-one",
        remoteCwd: "/runtime/noise/remote-a",
        createdAt: "2026-06-01T00:00:00.000Z",
        driver: "daytona",
      },
    });
    const second = createEffectiveRunConfigFingerprints({
      session: {
        sessionId: "generated-session-two",
        runId: "run-two",
        cwd: "/runtime/noise/project-b",
        updatedAt: "2026-06-02T00:00:00.000Z",
        adapterConfig: {
          token: "token-two",
          nested: {
            authorization: "Bearer second",
          },
          env: {
            PAPERCLIP_API_KEY: "runtime-api-key-two",
            NORMAL_VALUE: "first",
          },
        },
      },
      lease: {
        leaseId: "lease-two",
        providerLeaseId: "provider-lease-two",
        remoteCwd: "/runtime/noise/remote-b",
        createdAt: "2026-06-02T00:00:00.000Z",
        driver: "daytona",
      },
    });

    expect(second.sessionFingerprint.fingerprint).toBe(first.sessionFingerprint.fingerprint);
    expect(second.leaseFingerprint.fingerprint).toBe(first.leaseFingerprint.fingerprint);
    const canonical = [
      first.sessionFingerprint.canonicalJson,
      first.leaseFingerprint.canonicalJson,
    ].join("\n");
    expect(canonical).not.toContain("generated-session-one");
    expect(canonical).not.toContain("run-one");
    expect(canonical).not.toContain("/runtime/noise/project-a");
    expect(canonical).not.toContain("runtime-api-key-one");
    expect(canonical).not.toContain("token-one");
    expect(canonical).not.toContain("Bearer first");
    expect(canonical).not.toContain("lease-one");
    expect(canonical).not.toContain("/runtime/noise/remote-a");

    expect(canonicalizeEffectiveRunConfigCategory({
      category: "workspace",
      value: { cwd: "/explicit/runtime/workspace", workspaceStrategy: { type: "git_worktree" } },
    })).toEqual({
      cwd: "/explicit/runtime/workspace",
      workspaceStrategy: { type: "git_worktree" },
    });
  });
});
