import { describe, expect, it, vi } from "vitest";
import { HttpError } from "../../../errors.js";
import { descriptorHash, stableHash } from "../../tool-catalog-hash.js";
import { restConnectorFor } from "../rest-registry.js";
import { connectorToolPolicy } from "../tool-policy.js";
import { getConnectableAppDefinition } from "@paperclipai/shared";
import { normalizeConnectionMethodConfig } from "../../tool-access/connection-methods.js";
import { azureDevOpsAuthorization } from "./repositories.js";
import { AZURE_DEVOPS_API_URL, AZURE_DEVOPS_ENTRA_METHOD, AZURE_DEVOPS_PAT_METHOD, AZURE_DEVOPS_TOOLS, azureDevOpsClient,
  azureDevOpsRisk, isAzureDevOpsConnection, isCurrentAzureDevOpsCatalogEntry } from "./index.js";

const pat = "azure-secret-pat";
const entra = "azure-secret-entra";
const organization = "Example-Org";
const connection = (kind: "pat" | "entra" | "entra-write" = "pat") => ({ transport: "rest_api", authKind: kind === "pat" ? "api_key" : "oauth", config: {
  sourceTemplateKey: "azure-devops", connectionMethodKey: kind === "pat" ? AZURE_DEVOPS_PAT_METHOD
    : kind === "entra-write" ? "entra-write" : AZURE_DEVOPS_ENTRA_METHOD,
  url: AZURE_DEVOPS_API_URL, methodConfig: { organization },
} });
const payload = { value: [{ id: "12345678-1234-1234-1234-1234567890ab", name: "repo", project: { name: "project" } }] };

describe("Azure DevOps REST connector", () => {
  it.each([[401, 403, "azure_devops_access_denied"], [403, 403, "azure_devops_access_denied"], [429, 429, "azure_devops_rate_limited"]])(
    "returns safe actionable errors for provider status %i", async (status, expectedStatus, code) => {
      const request = vi.fn(async () => new Response("private provider details", { status }));
      await expect(azureDevOpsClient(connection(), { Authorization: `Bearer ${pat}` }, request).probe())
        .rejects.toMatchObject({ status: expectedStatus, details: { code }, message: expect.not.stringContaining("private provider details") });
    },
  );
  it("recognizes the URL produced by the real connection setup for every supported method", () => {
    const app = getConnectableAppDefinition("azure-devops")!;
    for (const method of app.methods) {
      const normalized = normalizeConnectionMethodConfig(method, { organization });
      expect(isAzureDevOpsConnection({ transport: method.transport, authKind: method.auth, config: {
        sourceTemplateKey: app.slug, connectionMethodKey: method.key, url: normalized.url, methodConfig: normalized.values,
      } })).toBe(true);
    }
  });
  it("pins the reviewed connection shape and exposes only a read action", () => {
    expect(isAzureDevOpsConnection(connection())).toBe(true);
    expect(isAzureDevOpsConnection({ ...connection(), config: { ...connection().config, url: "https://attacker.invalid" } })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection(), config: { ...connection().config, url: `${AZURE_DEVOPS_API_URL}/attacker` } })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection(), config: { ...connection().config, url: `${AZURE_DEVOPS_API_URL}/?redirect=evil` } })).toBe(false);
    expect(isAzureDevOpsConnection(connection("entra"))).toBe(true);
    expect(isAzureDevOpsConnection(connection("entra-write"))).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection("entra-write"), authKind: "api_key" })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection("entra-write"), config: { ...connection("entra-write").config,
      connectionMethodKey: "entra-unreviewed" } })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection("pat"), authKind: "oauth" })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection("entra"), authKind: "api_key" })).toBe(false);
    expect(isAzureDevOpsConnection({ ...connection("pat"), config: { ...connection("pat").config,
      methodConfig: { organization, authKind: "entra" } } })).toBe(true);
    expect(AZURE_DEVOPS_TOOLS.map(tool => tool.name)).toEqual(["azure_devops_list_repositories"]);
    for (const tool of AZURE_DEVOPS_TOOLS) {
      const risk = azureDevOpsRisk(tool.name);
      const contract = { toolName: tool.name, schemaHash: stableHash(tool.inputSchema), versionHash: descriptorHash(tool, risk), riskLevel: risk };
      expect(risk).toBe("read");
      expect(isCurrentAzureDevOpsCatalogEntry(contract)).toBe(true);
      expect(isCurrentAzureDevOpsCatalogEntry({ ...contract, schemaHash: "stale" })).toBe(false);
      expect(isCurrentAzureDevOpsCatalogEntry({ ...contract, riskLevel: "write" })).toBe(false);
    }
    expect(azureDevOpsRisk("unknown")).toBe("destructive");
  });
  it("registers only valid Azure connection methods with the governed REST gateway", () => {
    expect(restConnectorFor(connection("pat"))?.sourceTemplateKey).toBe("azure-devops");
    expect(restConnectorFor(connection("entra"))?.sourceTemplateKey).toBe("azure-devops");
    expect(restConnectorFor(connection("entra-write"))).toBeUndefined();
    expect(restConnectorFor({ ...connection("pat"), authKind: "none" })).toBeUndefined();
    expect(connectorToolPolicy("azure-devops", connection("pat")).quarantineNewEntries).toBe(true);
  });

  it.each([
    ["pat", `Bearer ${pat}`],
    ["entra", `Bearer ${entra}`],
  ] as const)("uses %s credentials through the fixed repository endpoint", async (kind, authorization) => {
    const outgoingAuthorization = kind === "pat" ? azureDevOpsAuthorization({ kind, token: pat }) : authorization;
    const request = vi.fn(async (url: string, init: RequestInit) => {
      expect(url).toBe(`${AZURE_DEVOPS_API_URL}/${organization}/_apis/git/repositories?api-version=7.1`);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(new Headers(init.headers).get("Authorization")).toBe(outgoingAuthorization);
      expect(new Headers(init.headers).get("X-Unrelated-Secret")).toBeNull();
      return Response.json(payload);
    });
    const client = azureDevOpsClient(connection(kind), { Authorization: authorization }, request);
    const repos = await client.invoke(AZURE_DEVOPS_TOOLS[0].name, {});
    expect(repos).toEqual([{ provider: "azure-devops", id: `${organization.toLowerCase()}:12345678-1234-1234-1234-1234567890ab`, fullName: `${organization}/project/repo`,
      url: `${AZURE_DEVOPS_API_URL}/${organization}/project/_git/repo`, private: true }]);
    expect(await client.probe()).toEqual(repos);
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("rejects mismatched auth, malformed configuration, extra headers, unknown actions and arguments", async () => {
    const request = vi.fn();
    expect(() => azureDevOpsClient(connection("entra"), { Authorization: "Basic malformed" }, request)).toThrow(HttpError);
    expect(() => azureDevOpsClient({ ...connection("pat"), authKind: "oauth" }, { Authorization: `Bearer ${pat}` }, request)).toThrow(HttpError);
    expect(() => azureDevOpsClient({ ...connection("entra"), authKind: "api_key" }, { Authorization: `Bearer ${entra}` }, request)).toThrow(HttpError);
    expect(() => azureDevOpsClient({ ...connection(), config: { ...connection().config, methodConfig: { organization: "../evil" } } },
      { Authorization: `Bearer ${pat}` }, request)).toThrow(HttpError);
    expect(() => azureDevOpsClient(connection(), { Authorization: `Bearer ${pat}`, "X-Other": "secret" }, request))
      .toThrow(HttpError);
    const valid = azureDevOpsClient(connection(), { Authorization: `Bearer ${pat}` }, request);
    await expect(valid.invoke("azure_devops_delete_repository", {})).rejects.toMatchObject({ status: 404 });
    await expect(valid.invoke(AZURE_DEVOPS_TOOLS[0].name, { organization: "other" })).rejects.toMatchObject({ status: 422 });
    expect(request).not.toHaveBeenCalled();
  });

  it("does not expose provider failure details or credentials", async () => {
    const request = vi.fn(async () => { throw new Error(`failure ${pat}`); });
    const client = azureDevOpsClient(connection(), { Authorization: `Bearer ${pat}` }, request);
    await expect(client.probe()).rejects.toMatchObject({ message: expect.not.stringContaining(pat) });
  });
  it("cancels in-flight provider work when the gateway aborts", async () => {
    const controller = new AbortController();
    const request = vi.fn(async (_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = azureDevOpsClient(connection("entra"), { Authorization: `Bearer ${entra}` }, request, controller.signal);
    const operation = client.probe();
    controller.abort();
    await expect(Promise.race([operation, new Promise((resolve) => setTimeout(() => resolve("not cancelled"), 100))])).rejects.toThrow(/Azure DevOps/);
    expect(request).toHaveBeenCalledOnce();
  });

  it("sanitizes even provider HttpError details before returning probe failures", async () => {
    const request = vi.fn(async () => { throw new HttpError(422, `provider included ${pat}`, { code: "provider_error" }); });
    const client = azureDevOpsClient(connection(), { Authorization: `Bearer ${pat}` }, request);
    await expect(client.probe()).rejects.toMatchObject({ status: 502, message: expect.not.stringContaining(pat) });
  });
});
