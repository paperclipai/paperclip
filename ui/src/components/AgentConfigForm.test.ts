import { describe, expect, it } from "vitest";
import type { Environment } from "@paperclipai/shared";
import { supportsAdapterModelRefresh } from "./AgentConfigForm";
import {
  resolveExecutionPickerState,
  resolveForcedKubernetesEnvironment,
} from "../lib/forced-kubernetes-environment";

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

describe("resolveExecutionPickerState", () => {
  it("renders the forced read-only section when execution is forced", () => {
    expect(
      resolveExecutionPickerState({
        forced: true,
        environmentsEnabled: false,
        executionModeLoading: false,
        executionModeFailed: false,
      }),
    ).toEqual({ state: "forced", showPolicyUnknownNotice: false });
  });

  it("hides the section when the environments picker is disabled", () => {
    expect(
      resolveExecutionPickerState({
        forced: false,
        environmentsEnabled: false,
        executionModeLoading: true,
        executionModeFailed: false,
      }),
    ).toEqual({ state: "hidden", showPolicyUnknownNotice: false });
  });

  it("shows a loading placeholder instead of the picker while the policy loads", () => {
    expect(
      resolveExecutionPickerState({
        forced: false,
        environmentsEnabled: true,
        executionModeLoading: true,
        executionModeFailed: false,
      }),
    ).toEqual({ state: "loading", showPolicyUnknownNotice: false });
  });

  it("shows the full picker without a notice once the policy resolves as not forced", () => {
    expect(
      resolveExecutionPickerState({
        forced: false,
        environmentsEnabled: true,
        executionModeLoading: false,
        executionModeFailed: false,
      }),
    ).toEqual({ state: "picker", showPolicyUnknownNotice: false });
  });

  it("keeps the picker usable but warns when the policy load failed (never forces K8s)", () => {
    expect(
      resolveExecutionPickerState({
        forced: false,
        environmentsEnabled: true,
        executionModeLoading: false,
        executionModeFailed: true,
      }),
    ).toEqual({ state: "picker", showPolicyUnknownNotice: true });
  });
});
