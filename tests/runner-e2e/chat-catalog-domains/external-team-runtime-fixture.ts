import { parseFrontmatterMarkdown } from "../../../packages/shared/src/frontmatter.js";
import YAML from "yaml";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { buildCatalogManifest } from "../../../packages/teams-catalog/src/catalog-builder.js";
import type { CatalogTeam } from "../../../packages/shared/src/types/teams-catalog.js";
import { reviewedChatExecutionIds } from "../chat-runtime-profile.js";

const selectedIds = reviewedChatExecutionIds("teams.install-team");
export const teamRuntimeCatalogRoot = (temporaryRoot: string) => path.join(temporaryRoot, "team-runtime-catalog");

/** Only the disposable installer fixture uses this catalog and native default. */
export async function teamRuntimeCatalogServerEnvironment(input: { executionIds: string[]; temporaryRoot: string; repositoryRoot: string }) {
  if (!input.executionIds.some(id => selectedIds.includes(id))) return {};
  if (input.executionIds.length !== 1) throw new Error("Team runtime catalog requires its isolated execution");
  const source = path.join(input.repositoryRoot, "packages/teams-catalog"), target = teamRuntimeCatalogRoot(input.temporaryRoot);
  await mkdir(target, { recursive: true });
  for (const entry of ["package.json", "catalog", "generated"]) await cp(path.join(source, entry), path.join(target, entry), { recursive: true, force: false, errorOnExist: true });
  return { PAPERCLIP_TEAMS_CATALOG_DIR: target, PAPERCLIP_TEAMS_CATALOG_DEFAULT_ADAPTER_TYPE: "paperclip_runner" };
}

/** Add runtime/account metadata only; all shipped team files remain byte-identical. */
export async function normalizeTeamRuntimeCatalog(input: { temporaryRoot: string; repositoryRoot: string; team: CatalogTeam; adapters: Record<string, { adapterType: string; adapterConfig: Record<string, unknown> }> }) {
  const packageDir = teamRuntimeCatalogRoot(input.temporaryRoot);
  const original = JSON.parse(await readFile(path.join(input.repositoryRoot, "packages/teams-catalog/generated/catalog.json"), "utf8"));
  const source = original.teams.find((team: CatalogTeam) => team.id === input.team.id) as CatalogTeam | undefined;
  if (!source || source.contentHash !== input.team.contentHash || !isDeepStrictEqual(Object.keys(input.adapters).sort(), [...source.agentSlugs].sort())) throw new Error("Team runtime fixture must start from the exact unmodified accepted package");
  for (const file of source.files) {
    const shipped = await readFile(path.join(input.repositoryRoot, "packages/teams-catalog", source.path, file.path));
    const derived = await readFile(path.join(packageDir, source.path, file.path));
    if (!shipped.equals(derived)) throw new Error("Team runtime fixture changed a shipped non-runtime file");
  }
  const sidecarPath = path.join(packageDir, source.path, ".paperclip.yaml");
  const originalSidecar = YAML.parse(await readFile(sidecarPath, "utf8"));
  const sidecar = structuredClone(originalSidecar);
  sidecar.agents ??= {};
  for (const [slug, adapter] of Object.entries(input.adapters)) sidecar.agents[slug] = { ...sidecar.agents[slug], adapter: { type: adapter.adapterType, config: adapter.adapterConfig } };
  const serialized = YAML.stringify(sidecar, { aliasDuplicateObjects: false, lineWidth: 0 });
  if (!isDeepStrictEqual(parseFrontmatterMarkdown(`---\n${serialized}---\n`).frontmatter, sidecar)) throw new Error("Runtime sidecar is not supported by the actual portability parser");
  await writeFile(sidecarPath, serialized, { mode: 0o600 });
  const restored = structuredClone(sidecar);
  for (const slug of Object.keys(input.adapters)) {
    delete restored.agents[slug].adapter;
    if (!Object.keys(restored.agents[slug]).length) delete restored.agents[slug];
  }
  if (!isDeepStrictEqual(restored, originalSidecar)) throw new Error("Team runtime fixture changed non-runtime sidecar fields");
  const skills = JSON.parse(await readFile(path.join(input.repositoryRoot, "packages/skills-catalog/generated/catalog.json"), "utf8"));
  const built = await buildCatalogManifest({ packageDir, generatedAt: original.generatedAt, catalogSkills: skills.skills });
  if (built.errors.length) throw new Error(`Derived runtime catalog is invalid: ${built.errors.join("; ")}`);
  const effective = built.manifest.teams.find(team => team.id === source.id)!;
  const withoutRuntime = (team: CatalogTeam) => ({ ...team, contentHash: "", fileCount: 0, files: team.files.filter(file => file.path !== ".paperclip.yaml") });
  if (!isDeepStrictEqual(withoutRuntime(effective), withoutRuntime(source)) || effective.contentHash === source.contentHash || built.manifest.teams.some(team => team.id !== source.id && !isDeepStrictEqual(team, original.teams.find((row: CatalogTeam) => row.id === team.id)))) throw new Error("Derived catalog changed non-runtime team metadata");
  await writeFile(path.join(packageDir, "generated/catalog.json"), JSON.stringify(built.manifest, null, 2) + "\n");
  return { originalContentHash: source.contentHash, effectiveContentHash: effective.contentHash, originalFilesUnchanged: true, team: effective };
}
