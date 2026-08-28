import catalogManifestJson from "../generated/catalog.json" with { type: "json" };
import type { CatalogManifest, CatalogTeam } from "./types.js";

export type {
  CatalogManifest,
  CatalogTeam,
  CatalogTeamCompatibility,
  CatalogTeamEnvInputSummary,
  CatalogTeamFile,
  CatalogTeamFileKind,
  CatalogTeamKind,
  CatalogTeamSkillRequirement,
  CatalogTeamSkillRequirementType,
  CatalogTeamSourceRef,
  CatalogTeamTrustLevel,
  CatalogValidationResult,
} from "./types.js";

export const catalogManifest = catalogManifestJson as CatalogManifest;

export const catalogTeams: CatalogTeam[] = catalogManifest.teams;

const teamsById = new Map(catalogTeams.map((team) => [team.id, team]));
const teamsByKey = new Map(catalogTeams.map((team) => [team.key, team]));

export function getCatalogTeam(id: string): CatalogTeam | null {
  return teamsById.get(id) ?? null;
}

export function resolveCatalogTeamRef(ref: string): CatalogTeam | null {
  const normalized = ref.trim();
  if (normalized.length === 0) return null;

  const exactMatch = teamsById.get(normalized) ?? teamsByKey.get(normalized);
  if (exactMatch) return exactMatch;

  const slugMatches = catalogTeams.filter((team) => team.slug === normalized);
  if (slugMatches.length === 1) return slugMatches[0]!;

  return null;
}
