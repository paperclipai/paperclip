import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import YAML from "yaml";
import { normalizeTeamRuntimeCatalog, teamRuntimeCatalogRoot, teamRuntimeCatalogServerEnvironment } from "./external-team-runtime-fixture.js";
const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
it("serves a derived runtime-only catalog while preserving shipped roles, permissions, skills and other teams", async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), "team-runtime-fixture-"));
  try {
    expect(await teamRuntimeCatalogServerEnvironment({ executionIds: ["unrelated"], temporaryRoot, repositoryRoot })).toEqual({});
    const env = await teamRuntimeCatalogServerEnvironment({ executionIds: ["chat-features.runner-opencode.local.teams.install-team"], temporaryRoot, repositoryRoot });
    expect(env.PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE).toBe("paperclip_runner");
    const original = JSON.parse(await readFile(path.join(repositoryRoot, "packages/teams-catalog/generated/catalog.json"), "utf8"));
    const team = original.teams.find((row: { slug: string }) => row.slug === "product-engineering");
    const adapterConfig = { provider: "opencode", model: "openrouter/deepseek/deepseek-v4.1-flash-1017", timeoutSec: 0, lifecycleMode: "per_turn", opencodePermissionMode: "allow", env: { OPENROUTER_API_KEY: { type: "secret_ref", secretId: "test-account", version: "latest" } } };
    const adapters = Object.fromEntries(team.agentSlugs.map((slug: string) => [slug, { adapterType: "paperclip_runner", adapterConfig }]));
    const result = await normalizeTeamRuntimeCatalog({ repositoryRoot, temporaryRoot, team, adapters });
    expect(result.originalContentHash).toBe(team.contentHash);
    expect(result.effectiveContentHash).not.toBe(team.contentHash);
    expect(result.originalPackage).toEqual({ id: team.id, key: team.key, packageName: original.packageName, version: original.packageVersion, contentHash: team.contentHash });
    expect(result.effectivePackage).toEqual({ ...result.originalPackage, contentHash: result.effectiveContentHash });
    expect(result.nonRuntimeFilesUnchanged).toBe(true);
    expect(result.nonRuntimeSidecarFieldsUnchanged).toBe(true);
    const sidecar = YAML.parse(await readFile(path.join(teamRuntimeCatalogRoot(temporaryRoot), team.path, ".paperclip.yaml"), "utf8"));
    expect(sidecar.agents.cto.permissions).toEqual({ canCreateAgents: true });
    for (const slug of team.agentSlugs) expect(sidecar.agents[slug].adapter).toEqual({ type: "paperclip_runner", config: adapterConfig });
    expect(result.team.requiredSkills).toEqual(team.requiredSkills);
    const sidecarPath = path.join(teamRuntimeCatalogRoot(temporaryRoot), team.path, ".paperclip.yaml");
    const beforeBootstrap = await readFile(sidecarPath);
    await expect(teamRuntimeCatalogServerEnvironment({ executionIds: ["chat-features.runner-opencode.local.teams.install-team"], temporaryRoot, repositoryRoot })).rejects.toThrow();
    expect((await readFile(sidecarPath)).equals(beforeBootstrap)).toBe(true);
    await expect(normalizeTeamRuntimeCatalog({ repositoryRoot, temporaryRoot, team: { ...team, contentHash: "foreign" }, adapters })).rejects.toThrow("exact unmodified");
  } finally { await rm(temporaryRoot, { recursive: true, force: true }); }
});
