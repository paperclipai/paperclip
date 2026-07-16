import { describe, expect, it } from "vitest";
import {
  mergeAgentAdapterConfigForUpdate,
  mergeAgentRuntimeConfigForUpdate,
} from "../serializers/agent-config-merge.js";

describe("agent projected config update merge", () => {
  it("preserves hidden adapter credentials and unknown settings during a visible replacement edit", () => {
    expect(mergeAgentAdapterConfigForUpdate(
      {
        model: "gpt-4",
        fastMode: false,
        env: { OPENAI_API_KEY: { secretRef: "secret-1" } },
        headers: { authorization: "hidden" },
        pluginRuntime: { credentialBindingId: "binding-1" },
        workspaceStrategy: {
          type: "git_worktree",
          baseRef: "main",
          branchTemplate: "old/{{issue.key}}",
          hiddenLease: "keep-workspace",
        },
        paperclipSkillSync: {
          desiredSkills: [{ key: "old", versionId: "v1" }],
          hiddenRevision: "keep-skills",
        },
        payloadTemplate: { agentId: "remote-agent", hiddenBinding: "keep-payload" },
        workspaceRuntime: { services: [{ name: "preview", hiddenToken: "keep-runtime" }] },
      },
      {
        model: "gpt-5",
        fastMode: true,
        workspaceStrategy: { type: "git_worktree", baseRef: "develop", branchTemplate: "new/{{issue.key}}" },
        paperclipSkillSync: { desiredSkills: [{ key: "new", versionId: "v2" }] },
      },
      true,
    )).toEqual({
      model: "gpt-5",
      fastMode: true,
      env: { OPENAI_API_KEY: { secretRef: "secret-1" } },
      headers: { authorization: "hidden" },
      pluginRuntime: { credentialBindingId: "binding-1" },
      workspaceStrategy: {
        type: "git_worktree",
        baseRef: "develop",
        branchTemplate: "new/{{issue.key}}",
        hiddenLease: "keep-workspace",
      },
      paperclipSkillSync: {
        desiredSkills: [{ key: "new", versionId: "v2" }],
        hiddenRevision: "keep-skills",
      },
      payloadTemplate: { agentId: "remote-agent", hiddenBinding: "keep-payload" },
      workspaceRuntime: { services: [{ name: "preview", hiddenToken: "keep-runtime" }] },
    });
  });

  it("preserves unrelated hidden runtime settings while applying visible heartbeat/profile edits", () => {
    expect(mergeAgentRuntimeConfigForUpdate(
      {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          leaseToken: "hidden",
          maxTurnContinuation: { enabled: true, maxAttempts: 3, delayMs: 1000, hiddenCursor: "keep" },
        },
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Cheap",
            adapterConfig: { model: "gpt-4-mini", env: { OPENAI_API_KEY: { secretRef: "secret-2" } } },
            runtimeLease: "hidden-profile",
          },
          pluginProfile: { privateSetting: "keep" },
        },
        pluginRuntime: { privateSetting: "keep" },
      },
      {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          maxTurnContinuation: { enabled: true, maxAttempts: 4, delayMs: 2000 },
        },
        modelProfiles: {
          cheap: { enabled: true, label: "Cheap", adapterConfig: { model: "gpt-5-mini" } },
        },
      },
    )).toEqual({
      heartbeat: {
        enabled: true,
        intervalSec: 60,
        leaseToken: "hidden",
        maxTurnContinuation: { enabled: true, maxAttempts: 4, delayMs: 2000, hiddenCursor: "keep" },
      },
      modelProfiles: {
        cheap: {
          enabled: true,
          label: "Cheap",
          adapterConfig: { model: "gpt-5-mini", env: { OPENAI_API_KEY: { secretRef: "secret-2" } } },
          runtimeLease: "hidden-profile",
        },
        pluginProfile: { privateSetting: "keep" },
      },
      pluginRuntime: { privateSetting: "keep" },
    });
  });
});
