import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import {
  defaultPromptTemplateForAdapter,
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

function makeEnvironment(overrides: Partial<Environment>): Environment {
  return {
    id: "env-1",
    name: "Env",
    description: null,
    driver: "local",
    status: "active",
    config: {},
    envVars: {},
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
