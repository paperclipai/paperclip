import { describe, expect, it } from "vitest";
import {
  parseExecutionPolicyBootstrapEnv,
  type ExecutionPolicyBootstrapEnv,
} from "./execution-policy-bootstrap.js";

function env(overrides: Record<string, string | undefined>): ExecutionPolicyBootstrapEnv {
  return overrides;
}

describe("parseExecutionPolicyBootstrapEnv", () => {
  it("returns null when no execution mode is set (default unrestricted)", () => {
    expect(parseExecutionPolicyBootstrapEnv(env({}))).toBeNull();
  });

  it("returns null when execution mode is explicitly any", () => {
    expect(
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "any" })),
    ).toBeNull();
  });

  it("parses the forced kubernetes policy with a job/gvisor/cilium config", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({
        PAPERCLIP_EXECUTION_MODE: "kubernetes",
        PAPERCLIP_K8S_BACKEND: "job",
        PAPERCLIP_K8S_IN_CLUSTER: "true",
        PAPERCLIP_K8S_RUNTIME_CLASS_NAME: "gvisor",
        PAPERCLIP_K8S_EGRESS_MODE: "cilium",
        PAPERCLIP_K8S_EGRESS_ALLOW_FQDNS: "api.anthropic.com, api.openai.com",
        PAPERCLIP_K8S_EGRESS_ALLOW_CIDRS: "10.0.0.0/8",
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.executionMode).toBe("kubernetes");
    expect(parsed?.kubernetesConfig).toMatchObject({
      backend: "job",
      inCluster: true,
      runtimeClassName: "gvisor",
      egressMode: "cilium",
      egressAllowFqdns: ["api.anthropic.com", "api.openai.com"],
      egressAllowCidrs: ["10.0.0.0/8"],
    });
  });

  it("defaults inCluster false and omits unset optional fields", () => {
    const parsed = parseExecutionPolicyBootstrapEnv(
      env({ PAPERCLIP_EXECUTION_MODE: "kubernetes" }),
    );
    expect(parsed?.kubernetesConfig.inCluster).toBe(false);
    expect(parsed?.kubernetesConfig.runtimeClassName).toBeUndefined();
    expect(parsed?.kubernetesConfig.egressAllowFqdns).toBeUndefined();
  });

  it("throws on an unknown execution mode", () => {
    expect(() =>
      parseExecutionPolicyBootstrapEnv(env({ PAPERCLIP_EXECUTION_MODE: "vm" })),
    ).toThrow(/PAPERCLIP_EXECUTION_MODE/);
  });
});
