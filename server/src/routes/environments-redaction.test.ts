import { describe, expect, it } from "vitest";
import { redactEnvironmentForRestrictedView } from "./environments.js";

describe("redactEnvironmentForRestrictedView", () => {
  const base = {
    id: "env-1",
    name: "Kubernetes Sandbox",
    driver: "sandbox",
    status: "active",
  };

  it("keeps the non-secret config.provider discriminator while dropping the rest of config", () => {
    const redacted = redactEnvironmentForRestrictedView({
      ...base,
      config: {
        provider: "kubernetes",
        inCluster: true,
        namespacePrefix: "paperclip-tenant-",
        imageRegistry: "ghcr.io/example",
      },
      envVars: { KUBECONFIG_B64: "c2VjcmV0" },
      metadata: { managedByPaperclip: true, managedKubernetesSandbox: true },
    });

    expect(redacted.config).toEqual({ provider: "kubernetes" });
    expect(redacted.envVars).toEqual({});
    expect(redacted.metadata).toBeNull();
  });

  it("returns an empty config when there is no string provider", () => {
    expect(
      redactEnvironmentForRestrictedView({
        ...base,
        config: { image: "ubuntu:24.04" },
        metadata: null,
      }).config,
    ).toEqual({});
    expect(
      redactEnvironmentForRestrictedView({
        ...base,
        config: null,
        metadata: null,
      }).config,
    ).toEqual({});
    expect(
      redactEnvironmentForRestrictedView({
        ...base,
        config: { provider: 42 },
        metadata: null,
      }).config,
    ).toEqual({});
  });

  it("omits envVars when the input has no envVars key", () => {
    const redacted = redactEnvironmentForRestrictedView({
      ...base,
      config: { provider: "kubernetes" },
      metadata: { managedByPaperclip: true },
    });
    expect(Object.prototype.hasOwnProperty.call(redacted, "envVars")).toBe(false);
  });
});
