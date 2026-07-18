import { afterEach, describe, expect, it } from "vitest";
import {
  classifyOciProviderError,
  createOciVaultProvider,
} from "../secrets/oci-vault-provider.js";
import { isSecretProviderClientError } from "../secrets/types.js";

const OCI_ENV_KEYS = [
  "PAPERCLIP_SECRETS_OCI_REGION",
  "PAPERCLIP_SECRETS_OCI_VAULT_ID",
  "PAPERCLIP_SECRETS_OCI_VAULT_OCID",
  "PAPERCLIP_SECRETS_OCI_COMPARTMENT_ID",
  "PAPERCLIP_SECRETS_OCI_SECRET_NAME_PREFIX",
  "PAPERCLIP_SECRETS_OCI_AUTH",
  "PAPERCLIP_SECRETS_OCI_CONFIG_FILE",
  "PAPERCLIP_SECRETS_OCI_CONFIG_PROFILE",
] as const;

const VAULT_ID = "ocid1.vault.oc1.il-jerusalem-1.abcvault";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    region: "il-jerusalem-1",
    vaultId: VAULT_ID,
    compartmentId: null,
    secretNamePrefix: "agent-",
    authMode: "instance_principal" as const,
    configFilePath: null,
    configProfile: null,
    ...overrides,
  };
}

function base64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}

describe("ociVaultProvider", () => {
  const savedEnv = new Map<string, string | undefined>();
  for (const key of OCI_ENV_KEYS) savedEnv.set(key, process.env[key]);

  afterEach(() => {
    for (const key of OCI_ENV_KEYS) {
      const previous = savedEnv.get(key);
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("describes read/external-reference provider capabilities", () => {
    const descriptor = createOciVaultProvider().descriptor();
    expect(descriptor).toMatchObject({
      id: "oci_vault",
      label: "OCI Vault",
      requiresExternalRef: true,
      supportsManagedValues: false,
      supportsExternalReferences: true,
    });
  });

  it("links external references as metadata-only provider material without plaintext", async () => {
    const provider = createOciVaultProvider({ config: makeConfig() });
    const prepared = await provider.linkExternalSecret({
      externalRef: "agent-claude-oauth-token",
      providerVersionRef: null,
    });

    expect(prepared.externalRef).toBe("agent-claude-oauth-token");
    expect(prepared.material).toEqual({
      scheme: "oci_vault_v1",
      secretRef: "agent-claude-oauth-token",
      versionRef: null,
      source: "external_reference",
    });
    // The exact material shape above proves the value is never present — material carries only a
    // name reference, a version selector, and a scheme tag (plus a fingerprint below).
    expect(prepared.valueSha256).toBeTruthy();
    expect(prepared.fingerprintSha256).toBe(prepared.valueSha256);
  });

  it("rejects linked external references outside the configured secretNamePrefix", async () => {
    const provider = createOciVaultProvider({ config: makeConfig({ secretNamePrefix: "agent-" }) });
    await expect(
      provider.linkExternalSecret({ externalRef: "broker-etoro-key", providerVersionRef: null }),
    ).rejects.toThrow(/outside the configured secretNamePrefix/i);
  });

  it("resolves an external reference by secret name and base64-decodes the value", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const provider = createOciVaultProvider({
      config: makeConfig(),
      gateway: {
        async getSecretBundleByName(input) {
          calls.push({ op: "getSecretBundleByName", input });
          return {
            secretId: "ocid1.vaultsecret.oc1.il-jerusalem-1.secretx",
            versionNumber: 1,
            versionName: null,
            content: base64("resolved-oci-secret-value"),
            contentType: "BASE64",
          };
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "oci_vault_v1",
        secretRef: "agent-claude-oauth-token",
        versionRef: null,
        source: "external_reference",
      },
      externalRef: "agent-claude-oauth-token",
      providerVersionRef: null,
      context: { companyId: "company-1", secretId: "secret-1", secretKey: "agent_claude_oauth_token", version: 1 },
    });

    expect(resolved).toBe("resolved-oci-secret-value");
    expect(calls).toEqual([
      {
        op: "getSecretBundleByName",
        input: {
          secretName: "agent-claude-oauth-token",
          vaultId: VAULT_ID,
          stage: "CURRENT",
        },
      },
    ]);
  });

  it("resolves an external reference by OCID via the by-id gateway path", async () => {
    const calls: Array<{ op: string; input: Record<string, unknown> }> = [];
    const secretOcid = "ocid1.vaultsecret.oc1.il-jerusalem-1.secretx";
    const provider = createOciVaultProvider({
      // No prefix: OCID refs are vault-scoped already.
      config: makeConfig({ secretNamePrefix: "" }),
      gateway: {
        async getSecretBundleByName() {
          throw new Error("should not be called for OCID refs");
        },
        async getSecretBundleById(input) {
          calls.push({ op: "getSecretBundleById", input });
          return {
            secretId: secretOcid,
            versionNumber: 3,
            versionName: null,
            content: base64("by-ocid-value"),
            contentType: "BASE64",
          };
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "oci_vault_v1",
        secretRef: secretOcid,
        versionRef: "3",
        source: "external_reference",
      },
      externalRef: secretOcid,
      providerVersionRef: "3",
    });

    expect(resolved).toBe("by-ocid-value");
    expect(calls).toEqual([
      { op: "getSecretBundleById", input: { secretId: secretOcid, versionNumber: 3 } },
    ]);
  });

  it("passes a numeric providerVersionRef as an OCI versionNumber", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const provider = createOciVaultProvider({
      config: makeConfig(),
      gateway: {
        async getSecretBundleByName(input) {
          calls.push(input);
          return { secretId: null, versionNumber: 5, versionName: null, content: base64("v5"), contentType: "BASE64" };
        },
      },
    });

    const resolved = await provider.resolveVersion({
      material: {
        scheme: "oci_vault_v1",
        secretRef: "agent-grafana-token",
        versionRef: null,
        source: "external_reference",
      },
      externalRef: "agent-grafana-token",
      providerVersionRef: "5",
    });

    expect(resolved).toBe("v5");
    expect(calls[0]).toEqual({ secretName: "agent-grafana-token", vaultId: VAULT_ID, versionNumber: 5 });
  });

  it("does not support Paperclip-managed values", async () => {
    const provider = createOciVaultProvider({ config: makeConfig() });
    await expect(
      provider.createSecret({ value: "x", context: { companyId: "c", secretKey: "k", secretName: "n", version: 1 } }),
    ).rejects.toThrow(/managed values are not supported/i);
    await expect(
      provider.createVersion({ value: "x", context: { companyId: "c", secretKey: "k", secretName: "n", version: 2 } }),
    ).rejects.toThrow(/does not create managed secret versions/i);
  });

  it("treats deleteOrArchive as a metadata-only no-op", async () => {
    const provider = createOciVaultProvider({
      config: makeConfig(),
      gateway: {
        async getSecretBundleByName() {
          throw new Error("should not be called");
        },
      },
    });
    await expect(
      provider.deleteOrArchive({
        material: { scheme: "oci_vault_v1", secretRef: "agent-linear-key", versionRef: null, source: "external_reference" },
        externalRef: "agent-linear-key",
        mode: "delete",
      }),
    ).resolves.toBeUndefined();
  });

  it("redacts OCI exception text and maps a 404 to not_found on resolve", async () => {
    const provider = createOciVaultProvider({
      config: makeConfig(),
      gateway: {
        async getSecretBundleByName() {
          throw Object.assign(new Error("NotAuthorizedOrNotFound: secret agent-missing not found in tenancy T"), {
            statusCode: 404,
            serviceCode: "NotAuthorizedOrNotFound",
          });
        },
      },
    });

    const failure = await provider
      .resolveVersion({
        material: { scheme: "oci_vault_v1", secretRef: "agent-missing", versionRef: null, source: "external_reference" },
        externalRef: "agent-missing",
        providerVersionRef: null,
      })
      .then(() => null)
      .catch((error) => error);

    expect(isSecretProviderClientError(failure)).toBe(true);
    expect(failure.code).toBe("not_found");
    expect(failure.status).toBe(404);
    // Operator-safe message must not leak tenancy/secret internals.
    expect(failure.message).not.toContain("tenancy T");
    expect(failure.rawMessage).toContain("NotAuthorizedOrNotFound");
  });

  it("classifies OCI provider errors by status code and message", () => {
    expect(classifyOciProviderError("boom", 401)).toBe("access_denied");
    expect(classifyOciProviderError("boom", 429)).toBe("throttled");
    expect(classifyOciProviderError("boom", 409)).toBe("conflict");
    expect(classifyOciProviderError("boom", 503)).toBe("provider_unavailable");
    expect(classifyOciProviderError("NotAuthorizedOrNotFound")).toBe("access_denied");
    expect(classifyOciProviderError("ETIMEDOUT while calling vault")).toBe("provider_unavailable");
    expect(classifyOciProviderError("totally unknown")).toBe("provider_error");
  });

  it("warns when OCI provider configuration is incomplete and never throws from healthCheck", async () => {
    for (const key of OCI_ENV_KEYS) delete process.env[key];

    const provider = createOciVaultProvider();
    const health = await provider.healthCheck();

    expect(health.provider).toBe("oci_vault");
    expect(health.status).toBe("warn");
    expect(health.message).toContain("missing PAPERCLIP_SECRETS_OCI_REGION");
    expect(health.warnings).toEqual(
      expect.arrayContaining([
        expect.stringContaining("Missing required non-secret OCI provider config"),
        expect.stringContaining("OCI credentials must be available"),
        expect.stringContaining("Do not store OCI private keys"),
      ]),
    );
  });

  it("reports ok health with credential source when configured via provider vault", async () => {
    const provider = createOciVaultProvider();
    const health = await provider.healthCheck({
      deploymentMode: "authenticated",
      strictMode: true,
      providerConfig: {
        id: "vault-1",
        provider: "oci_vault",
        status: "ready",
        config: { region: "il-jerusalem-1", vaultId: VAULT_ID, secretNamePrefix: "agent-" },
      },
    });

    expect(health.status).toBe("ok");
    expect(health.details).toMatchObject({
      region: "il-jerusalem-1",
      vaultId: VAULT_ID,
      authMode: "instance_principal",
      credentialSource: "OCI instance principals",
    });
  });
});
