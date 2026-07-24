import { describe, expect, it } from "vitest";
import {
  KUBERNETES_PROVIDER_KEY,
  evaluateExecutionAllowlist,
  type ExecutionEnvironmentCandidate,
} from "./execution-allowlist.js";

const localEnv: ExecutionEnvironmentCandidate = {
  driver: "local",
  provider: null,
};

const kubernetesEnv: ExecutionEnvironmentCandidate = {
  driver: "sandbox",
  provider: KUBERNETES_PROVIDER_KEY,
};

const fakeSandboxEnv: ExecutionEnvironmentCandidate = {
  driver: "sandbox",
  provider: "fake",
};

const sshEnv: ExecutionEnvironmentCandidate = {
  driver: "ssh",
  provider: null,
};

describe("evaluateExecutionAllowlist", () => {
  describe('executionMode "any" (unrestricted, default)', () => {
    it("allows the local environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "any" }, localEnv);
      expect(result.allowed).toBe(true);
    });

    it("allows the kubernetes sandbox environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "any" }, kubernetesEnv);
      expect(result.allowed).toBe(true);
    });

    it("allows a non-kubernetes sandbox environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "any" }, fakeSandboxEnv);
      expect(result.allowed).toBe(true);
    });

    it("treats absent executionMode as unrestricted", () => {
      expect(evaluateExecutionAllowlist({}, localEnv).allowed).toBe(true);
      expect(evaluateExecutionAllowlist({ executionMode: undefined }, localEnv).allowed).toBe(true);
    });
  });

  describe('executionMode "kubernetes" (forced sandbox)', () => {
    it("allows ONLY a kubernetes sandbox_provider environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "kubernetes" }, kubernetesEnv);
      expect(result.allowed).toBe(true);
    });

    it("DENIES the local environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "kubernetes" }, localEnv);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.reason).toMatch(/kubernetes/i);
        expect(result.deniedDriver).toBe("local");
      }
    });

    it("DENIES an ssh environment", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "kubernetes" }, sshEnv);
      expect(result.allowed).toBe(false);
    });

    it("DENIES a non-kubernetes sandbox provider (e.g. fake)", () => {
      const result = evaluateExecutionAllowlist({ executionMode: "kubernetes" }, fakeSandboxEnv);
      expect(result.allowed).toBe(false);
      if (!result.allowed) {
        expect(result.deniedProvider).toBe("fake");
      }
    });

    it("DENIES a sandbox driver with no provider", () => {
      const result = evaluateExecutionAllowlist(
        { executionMode: "kubernetes" },
        { driver: "sandbox", provider: null },
      );
      expect(result.allowed).toBe(false);
    });
  });

  describe("isExecutionForcedToKubernetes helper", () => {
    it("reflects the policy", async () => {
      const { isExecutionForcedToKubernetes } = await import("./execution-allowlist.js");
      expect(isExecutionForcedToKubernetes({ executionMode: "kubernetes" })).toBe(true);
      expect(isExecutionForcedToKubernetes({ executionMode: "any" })).toBe(false);
      expect(isExecutionForcedToKubernetes({})).toBe(false);
    });
  });
});
