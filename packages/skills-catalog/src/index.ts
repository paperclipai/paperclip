import catalogManifestJson from "../generated/catalog.json" with { type: "json" };
import type { CatalogManifest, CatalogSkill } from "./types.js";

export type {
  CatalogCompatibility,
  CatalogManifest,
  CatalogSkill,
  CatalogSkillFile,
  CatalogSkillFileKind,
  CatalogSkillKind,
  CatalogTrustLevel,
  CatalogValidationResult,
} from "./types.js";

export const catalogManifest = catalogManifestJson as CatalogManifest;

export const catalogSkills: CatalogSkill[] = catalogManifest.skills;

const skillsById = new Map(catalogSkills.map((skill) => [skill.id, skill]));
const skillsByKey = new Map(catalogSkills.map((skill) => [skill.key, skill]));

export function getCatalogSkill(id: string): CatalogSkill | null {
  return skillsById.get(id) ?? null;
}

export function resolveCatalogSkillRef(ref: string): CatalogSkill | null {
  const normalized = ref.trim();
  if (normalized.length === 0) return null;

  const exactMatch = skillsById.get(normalized) ?? skillsByKey.get(normalized);
  if (exactMatch) return exactMatch;

  const slugMatches = catalogSkills.filter((skill) => skill.slug === normalized);
  if (slugMatches.length === 1) return slugMatches[0]!;

  return null;
}
