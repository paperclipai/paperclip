import { describe, expect, it, vi } from "vitest";
import type { AdapterEnvironmentTestResult, Environment } from "@paperclipai/shared";
import {
  defaultPromptTemplateForAdapter,
  getAgentConfigTestActionLabel,
  runAgentConfigEnvironmentTest,
  supportsAdapterModelRefresh,
} from "./AgentConfigForm";
import { resolveForcedKubernetesEnvironment } from "../lib/forced-kubernetes-environment";

describe("supportsAdapterModelRefresh", () => {
  it("enables the model refresh action for Claude, Codex, and ACPX adapters", () => {
    expect(supportsAdapterModelRefresh("claude_local")).toBe(true);
    expect(supportsAdapterModelRefresh("codex_local")).toBe(true);
    expect(supportsAdapterModelRefresh("acpx_local")).toBe(true);
  });

  it("keeps the refresh action hidden for adapters without a live refresh hook", () => {
    expect(supportsAdapterModelRefresh("opencode_local")).toBe(false);
    expect(supportsAdapterModelRefresh("process")).toBe(false);
  });
});

describe("defaultPromptTemplateForAdapter", () => {
  it("returns the Paperclip default prompt template for built-in Paperclip adapters", () => {
    expect(defaultPromptTemplateForAdapter("codex_local")).toContain("Execution contract:");
    expect(defaultPromptTemplateForAdapter("cursor_cloud")).toContain("You are agent {{agent.id}}");
  });

  it("returns the Hermes default prompt template for the Hermes local adapter", () => {
    expect(defaultPromptTemplateForAdapter("hermes_local")).toContain('You are "{{agentName}}"');
    expect(defaultPromptTemplateForAdapter("hermes_local")).toContain("{{paperclipApiUrl}}");
  });

  it("does not invent a default for adapters without a known runtime default", () => {
    expect(defaultPromptTemplateForAdapter("http")).toBeNull();
    expect(defaultPromptTemplateForAdapter("process")).toBeNull();
  });
});

describe("agent config test action", () => {
  it("labels dirty edit-mode tests as save-and-test", () => {
    expect(getAgentConfigTestActionLabel({ isCreate: false, isDirty: true })).toBe("Save + Test");
    expect(getAgentConfigTestActionLabel({ isCreate: false, isDirty: false })).toBe("Test");
    expect(getAgentConfigTestActionLabel({ isCreate: true, isDirty: true })).toBe("Test");
  });

  it("saves a dirty edit draft before running the environment test", async () => {
    const callOrder: string[] = [];
    const saveDraft = vi.fn(async () => {
      callOrder.push("save");
    });
    const runTest = vi.fn(async (): Promise<AdapterEnvironmentTestResult> => {
      callOrder.push("test");
      return {
        adapterType: "claude_local",
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      };
    });

    await runAgentConfigEnvironmentTest({
      isCreate: false,
      isDirty: true,
      saveDraft,
      runTest,
    });

    expect(saveDraft).toHaveBeenCalledTimes(1);
    expect(runTest).toHaveBeenCalledTimes(1);
    expect(callOrder).toEqual(["save", "test"]);
  });

  it("runs create-mode tests without saving first", async () => {
    const saveDraft = vi.fn(async () => {});
    const runTest = vi.fn(async (): Promise<AdapterEnvironmentTestResult> => ({
      adapterType: "claude_local",
      status: "pass",
      checks: [],
      testedAt: new Date(0).toISOString(),
    }));

    await runAgentConfigEnvironmentTest({
      isCreate: true,
      isDirty: true,
      saveDraft,
      runTest,
    });

    expect(saveDraft).not.toHaveBeenCalled();
    expect(runTest).toHaveBeenCalledTimes(1);
  });
});

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    companyId: "co-1",
    name: "Env",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    metadata: null,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    ...overrides,
  };
}

const localEnv = makeEnvironment({ id: "local-1", name: "Local", driver: "local" });
const k8sEnv = makeEnvironment({
  id: "k8s-1",
  name: "Managed K8s",
  driver: "sandbox",
  config: { provider: "kubernetes" },
});

describe("resolveForcedKubernetesEnvironment", () => {
  it("does not force when executionMode is 'any' (full picker / unchanged)", () => {
    const result = resolveForcedKubernetesEnvironment("any", [localEnv, k8sEnv]);
    expect(result.forced).toBe(false);
    expect(result.kubernetesEnvironment).toBeNull();
  });

  it("does not force when executionMode is absent (self-hoster default)", () => {
    const result = resolveForcedKubernetesEnvironment(undefined, [localEnv, k8sEnv]);
    expect(result.forced).toBe(false);
    expect(result.kubernetesEnvironment).toBeNull();
  });

  it("forces and selects the Kubernetes sandbox when executionMode is 'kubernetes'", () => {
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv, k8sEnv]);
    expect(result.forced).toBe(true);
    expect(result.kubernetesEnvironment?.id).toBe("k8s-1");
  });

  it("forces but reports no environment when none is the Kubernetes sandbox", () => {
    const fakeSandbox = makeEnvironment({
      id: "fake-1",
      driver: "sandbox",
      config: { provider: "fake" },
    });
    const result = resolveForcedKubernetesEnvironment("kubernetes", [localEnv, fakeSandbox]);
    expect(result.forced).toBe(true);
    expect(result.kubernetesEnvironment).toBeNull();
  });
});
