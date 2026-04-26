import { describe, it, expect } from "vitest";
import { getSecretProvider, listSecretProviders } from "./provider-registry.js";

describe("getSecretProvider", () => {
  it("returns local_encrypted provider for 'local_encrypted' id", () => {
    const provider = getSecretProvider("local_encrypted");
    expect(provider.id).toBe("local_encrypted");
  });

  it("returns aws_secrets_manager provider for 'aws_secrets_manager' id", () => {
    const provider = getSecretProvider("aws_secrets_manager");
    expect(provider.id).toBe("aws_secrets_manager");
  });

  it("returns gcp_secret_manager provider for 'gcp_secret_manager' id", () => {
    const provider = getSecretProvider("gcp_secret_manager");
    expect(provider.id).toBe("gcp_secret_manager");
  });

  it("returns vault provider for 'vault' id", () => {
    const provider = getSecretProvider("vault");
    expect(provider.id).toBe("vault");
  });

  it("throws for unknown provider id", () => {
    expect(() => getSecretProvider("unknown_provider" as any)).toThrow(
      "Unsupported secret provider",
    );
  });

  it("returned provider has a descriptor with matching id", () => {
    const provider = getSecretProvider("local_encrypted");
    expect(provider.descriptor.id).toBe("local_encrypted");
    expect(typeof provider.descriptor.label).toBe("string");
    expect(provider.descriptor.label.length).toBeGreaterThan(0);
  });

  it("stub providers have descriptor with requiresExternalRef=true", () => {
    for (const id of ["aws_secrets_manager", "gcp_secret_manager", "vault"] as const) {
      const provider = getSecretProvider(id);
      expect(provider.descriptor.requiresExternalRef).toBe(true);
    }
  });

  it("stub providers throw on createVersion", async () => {
    for (const id of ["aws_secrets_manager", "gcp_secret_manager", "vault"] as const) {
      const provider = getSecretProvider(id);
      await expect(provider.createVersion({ value: "secret", externalRef: null })).rejects.toThrow(
        "not configured",
      );
    }
  });

  it("stub providers throw on resolveVersion", async () => {
    for (const id of ["aws_secrets_manager", "gcp_secret_manager", "vault"] as const) {
      const provider = getSecretProvider(id);
      await expect(provider.resolveVersion({ material: {}, externalRef: null })).rejects.toThrow(
        "not configured",
      );
    }
  });
});

describe("listSecretProviders", () => {
  it("returns a non-empty array of descriptors", () => {
    const list = listSecretProviders();
    expect(list.length).toBeGreaterThan(0);
  });

  it("includes all four expected provider IDs", () => {
    const list = listSecretProviders();
    const ids = list.map((d) => d.id);
    expect(ids).toContain("local_encrypted");
    expect(ids).toContain("aws_secrets_manager");
    expect(ids).toContain("gcp_secret_manager");
    expect(ids).toContain("vault");
  });

  it("each descriptor has a non-empty label string", () => {
    const list = listSecretProviders();
    for (const descriptor of list) {
      expect(typeof descriptor.label).toBe("string");
      expect(descriptor.label.length).toBeGreaterThan(0);
    }
  });

  it("each descriptor has an id matching getSecretProvider", () => {
    const list = listSecretProviders();
    for (const descriptor of list) {
      const provider = getSecretProvider(descriptor.id);
      expect(provider.id).toBe(descriptor.id);
    }
  });
});
