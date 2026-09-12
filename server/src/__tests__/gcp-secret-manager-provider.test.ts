import { inspect } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGcpSecretManagerProvider } from "../secrets/gcp-secret-manager-provider.js";
import { SecretProviderClientError } from "../secrets/types.js";

const { request, authOptions } = vi.hoisted(() => ({ request: vi.fn(), authOptions: vi.fn() }));
vi.mock("google-auth-library", () => ({
  GoogleAuth: class {
    constructor(options: unknown) { authOptions(options); }
    request = request;
  },
}));

const externalRef = "projects/example-project/secrets/example-key";
const config = {
  id: "gcp-vault",
  provider: "gcp_secret_manager" as const,
  status: "ready",
  config: { projectId: "example-project", location: "global" },
};
const payload = () => ({
  name: `${externalRef}/versions/7`,
  payload: { data: Buffer.from("123456789").toString("base64"), dataCrc32c: "3808858755" },
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("Google Secret Manager external references", () => {
  it("verifies and pins latest on link, then resolves that immutable version without storing its value", async () => {
    const accessVersion = vi.fn(async () => payload());
    const provider = createGcpSecretManagerProvider({ accessVersion });

    const prepared = await provider.linkExternalSecret({ externalRef, providerConfig: config });
    expect(prepared.providerVersionRef).toBe("7");
    expect(prepared.externalRef).toBe(externalRef);
    expect(prepared.valueSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(prepared)).not.toContain("123456789");
    expect(JSON.stringify(prepared)).not.toContain(payload().payload.data);
    expect(await provider.resolveVersion({ ...prepared, providerConfig: config })).toBe("123456789");
    expect(accessVersion.mock.calls).toEqual([
      [`${externalRef}/versions/latest`], [`${externalRef}/versions/7`],
    ]);
  });

  it("uses ADC and the fixed, bounded Google REST read endpoint", async () => {
    request.mockResolvedValue({ data: payload() });
    const provider = createGcpSecretManagerProvider();
    await provider.linkExternalSecret({ externalRef: `${externalRef}/versions/7`, providerConfig: config });

    expect(authOptions).toHaveBeenLastCalledWith(expect.objectContaining({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
    }));
    expect(request).toHaveBeenCalledWith({
      url: `https://secretmanager.googleapis.com/v1/${externalRef}/versions/7:access`,
      method: "GET", timeout: 30_000, retry: false, maxRedirects: 0, responseType: "json",
    });
  });

  it("accepts Google's canonical project number while retaining the vault's requested project ID", async () => {
    const provider = createGcpSecretManagerProvider({ accessVersion: async () => ({
      ...payload(), name: "projects/123456789012/secrets/example-key/versions/7",
    }) });
    const prepared = await provider.linkExternalSecret({ externalRef, providerConfig: config });
    expect(prepared.externalRef).toBe(externalRef);
  });

  it("reports rejected ADC refresh as an authentication failure without retaining its description", async () => {
    const provider = createGcpSecretManagerProvider({ accessVersion: async () => {
      throw { response: { status: 400, data: {
        error: "invalid_grant", error_subtype: "invalid_rapt", error_description: "private-token-or-description",
      } } };
    } });
    let failure: unknown;
    try { await provider.linkExternalSecret({ externalRef, providerConfig: config }); } catch (error) { failure = error; }
    expect(failure).toMatchObject({ code: "access_denied", rawMessage: null });
    expect(inspect(failure, { depth: 8, showHidden: true })).not.toContain("private-token-or-description");
  });

  it.each([
    "https://other.example/secret", `${externalRef}?token=secret`, `${externalRef}/../other`,
    "projects/other-project/secrets/example-key", `${externalRef}/versions/0`,
    `${externalRef}/versions/custom-alias`, "projects/example-project/locations/us-east1/secrets/example-key",
  ])("rejects invalid or out-of-vault references before authentication: %s", async (reference) => {
    const accessVersion = vi.fn();
    const provider = createGcpSecretManagerProvider({ accessVersion });
    await expect(provider.linkExternalSecret({ externalRef: reference, providerConfig: config }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(accessVersion).not.toHaveBeenCalled();
  });

  it("enforces an optional secret-name prefix before reading", async () => {
    const accessVersion = vi.fn();
    const provider = createGcpSecretManagerProvider({ accessVersion });
    await expect(provider.linkExternalSecret({ externalRef, providerConfig: {
      ...config, config: { ...config.config, secretNamePrefix: "approved-" },
    } })).rejects.toMatchObject({ code: "invalid_request" });
    expect(accessVersion).not.toHaveBeenCalled();
  });

  it("does not replace an incomplete selected vault with deployment defaults", async () => {
    vi.stubEnv("PAPERCLIP_SECRETS_GCP_PROJECT_ID", "example-project");
    const accessVersion = vi.fn();
    const provider = createGcpSecretManagerProvider({ accessVersion });
    await expect(provider.linkExternalSecret({ externalRef, providerConfig: { ...config, config: {} } }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(accessVersion).not.toHaveBeenCalled();
  });

  it.each(["disabled", "coming_soon"])("rejects a %s vault before reading", async (status) => {
    const accessVersion = vi.fn();
    const provider = createGcpSecretManagerProvider({ accessVersion });
    await expect(provider.linkExternalSecret({ externalRef, providerConfig: { ...config, status } }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(accessVersion).not.toHaveBeenCalled();
  });

  it("rejects conflicting selectors and tampered stored reference material", async () => {
    const accessVersion = vi.fn(async () => payload());
    const provider = createGcpSecretManagerProvider({ accessVersion });
    await expect(provider.linkExternalSecret({
      externalRef: `${externalRef}/versions/7`, providerVersionRef: "8", providerConfig: config,
    })).rejects.toMatchObject({ code: "invalid_request" });
    const prepared = await provider.linkExternalSecret({ externalRef, providerConfig: config });
    accessVersion.mockClear();
    await expect(provider.resolveVersion({ ...prepared, providerVersionRef: "8", providerConfig: config }))
      .rejects.toMatchObject({ code: "invalid_request" });
    await expect(provider.resolveVersion({ ...prepared, externalRef: `${externalRef}-other`, providerConfig: config }))
      .rejects.toMatchObject({ code: "invalid_request" });
    expect(accessVersion).not.toHaveBeenCalled();
  });

  it("can resolve a legacy metadata-only link through the configured project", async () => {
    const accessVersion = vi.fn(async () => payload());
    const provider = createGcpSecretManagerProvider({ accessVersion });
    expect(await provider.resolveVersion({
      material: { scheme: "external_reference_v1", provider: "gcp_secret_manager", externalRef, providerVersionRef: null },
      externalRef, providerConfig: config,
    })).toBe("123456789");
    expect(accessVersion).toHaveBeenCalledWith(`${externalRef}/versions/latest`);
  });

  it.each([
    [401, "access_denied"], [403, "access_denied"], [404, "not_found"],
    [429, "throttled"], [400, "invalid_request"], [409, "conflict"], [503, "provider_unavailable"],
    [undefined, "provider_unavailable"],
  ])("sanitises HTTP/auth failures including status %s without retaining tokens or payloads", async (status, code) => {
    const marker = "private-value-that-must-never-escape";
    const provider = createGcpSecretManagerProvider({ accessVersion: async () => {
      throw Object.assign(new Error(marker), { response: { status, data: marker }, config: { headers: { Authorization: marker } } });
    } });
    let failure: unknown;
    try { await provider.linkExternalSecret({ externalRef, providerConfig: config }); } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(SecretProviderClientError);
    expect(failure).toMatchObject({ code, rawMessage: null });
    expect(inspect(failure, { depth: 8, showHidden: true })).not.toContain(marker);
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect(failure).not.toHaveProperty("cause");
  });

  it.each([
    null,
    { ...payload(), name: `${externalRef}/versions/latest` },
    { ...payload(), name: "projects/example-project/secrets/other/versions/7" },
    { ...payload(), payload: { data: "private-malformed-payload", dataCrc32c: "0" } },
    { ...payload(), payload: { ...payload().payload, dataCrc32c: "0" } },
    { ...payload(), payload: { data: payload().payload.data } },
  ])("rejects malformed responses and integrity failures without payload disclosure", async (response) => {
    const provider = createGcpSecretManagerProvider({ accessVersion: async () => response });
    await expect(provider.linkExternalSecret({ externalRef, providerConfig: config }))
      .rejects.toMatchObject({ code: "provider_error", rawMessage: null });
  });

  it("does not claim remote access in health checks or make remote writes on archive/delete", async () => {
    const accessVersion = vi.fn();
    const provider = createGcpSecretManagerProvider({ accessVersion });
    expect(await provider.healthCheck({ providerConfig: config })).toMatchObject({
      status: "warn", details: { accessVerified: false, credentialSource: "Application Default Credentials" },
    });
    expect(provider.descriptor()).toMatchObject({ supportsManagedValues: false, supportsExternalValueWrites: false });
    await expect(provider.createSecret({ value: "private-value" })).rejects.toThrow(/linking existing secrets only/);
    await expect(provider.createVersion({ value: "private-value" })).rejects.toThrow(/linking existing secrets only/);
    await provider.deleteOrArchive({ externalRef, mode: "archive" });
    await provider.deleteOrArchive({ externalRef, mode: "delete" });
    expect(accessVersion).not.toHaveBeenCalled();
  });
});
