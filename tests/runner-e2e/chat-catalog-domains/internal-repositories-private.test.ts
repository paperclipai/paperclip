import { describe, expect, it, vi } from "vitest";
import type { ChatCatalogContext } from "../chat-catalog-contract.js";
import { connectRepositoryFixture, repositoryProjectCases } from "./internal-repositories.js";
import { externalRequirements } from "./external-fixtures.js";
describe("repository selected-input integration", () => {
  it.each(["workspaces.prepare-repository", "workspaces.private-repository-no-access"])("%s requires selected GitHub inputs before any provider/discovery operation", async scenarioId => {
    const repositoryInputs = externalRequirements["projects.add-repository"];
    expect(externalRequirements[scenarioId]).toEqual({ ...repositoryInputs,
      fields: scenarioId === "workspaces.private-repository-no-access" ? [...repositoryInputs.fields, "humanAuthEnv"] : repositoryInputs.fields });
    const postSensitive = vi.fn();
    await expect(connectRepositoryFixture({ scenario: { id: scenarioId }, input: { api: { postSensitive } } } as unknown as ChatCatalogContext)).rejects.toThrow("selected-case private inputs are unavailable");
    expect(postSensitive).not.toHaveBeenCalled();
  });
  for (const definition of repositoryProjectCases) it(`${definition.scenarioId} declares its selected GitHub inputs and never falls back to ambient configuration`, async () => {
    expect(definition.externalInput).toEqual(externalRequirements[definition.scenarioId]);
    const postSensitive = vi.fn();
    const context = { scenario: { id: definition.scenarioId }, input: { api: { postSensitive }, privateSecrets: [], evidence: async () => {} } } as unknown as ChatCatalogContext;
    await expect(definition.setup(context)).rejects.toThrow("selected-case private inputs are unavailable");
    expect(postSensitive).not.toHaveBeenCalled();
  });
  it("uses only the selected reference while retaining actual repository discovery and cleanup guards", async () => {
    const declaration = repositoryProjectCases.find(row => row.scenarioId === "projects.add-repository")!;
    const binding = { disposable: true, resourceIds: ["42"], credentialEnv: ["PAPERCLIP_CHAT_EVAL_GITHUB_TOKEN"], prerequisites: { siteRepositoryId: "42", siteRepositoryFullName: "owned/site", tokenEnv: "PAPERCLIP_CHAT_EVAL_GITHUB_TOKEN" } };
    const postSensitive = vi.fn(async (path: string, _body?: unknown) => ({ id: path.endsWith("/secrets") ? "secret" : "connection" }));
    const remove = vi.fn(async (_path: string, _options?: unknown) => {}); const read = vi.fn((name: string) => name === "PAPERCLIP_CHAT_EVAL_GITHUB_TOKEN" ? "selected-synthetic-token" : undefined);
    const secrets: string[] = [];
    const context = { scenario: { id: declaration.scenarioId }, input: { nonce: "synthetic", fixtures: { company: { id: "company" } }, privateSecrets: secrets,
      privateInputs: { credentials: {}, read, configuration: () => ({ schemaVersion: 1, providers: { github: binding } }) }, evidence: async () => {},
      api: { postSensitive, get: async () => ({ repositories: [{ id: "999", fullName: "owned/site", url: "https://github.com/owned/site", connectionIds: ["connection"] }], failedConnectionCount: 0 }), delete: remove } } } as unknown as ChatCatalogContext;
    await expect(declaration.setup(context)).rejects.toThrow("independently expose each explicit disposable repository name and ID");
    expect(postSensitive.mock.calls[0]?.[1]).toMatchObject({ value: "selected-synthetic-token" });
    expect(secrets).toContain("selected-synthetic-token");
    expect(read.mock.calls.every(([name]) => name === "PAPERCLIP_CHAT_EVAL_GITHUB_TOKEN")).toBe(true);
    expect(remove.mock.calls.map(call => call[0])).toEqual(["/api/tool-connections/connection", "/api/secrets/secret"]);
  });
});
