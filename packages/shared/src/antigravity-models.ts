import { ANTIGRAVITY_GENERATED_MODEL_CATALOG as CATALOG } from "./antigravity-models.generated.js";

/**
 * Google Antigravity model identity. A model id is `<family>-<level>`: the
 * family is the base model and the level is its thinking level. The ACP
 * server spells levels `minimal, low, medium, high, extra_high`. A Google
 * account's catalog uses the Antigravity CLI's spellings instead: `xhigh` for
 * extra high, plus `max`, and a few legacy ids that do not encode their level.
 * Ids round-trip exactly: formatting a parsed id restores its own spelling.
 */
export const ANTIGRAVITY_THINKING_LEVELS = ["minimal", "low", "medium", "high", "extra_high"] as const;
export type AntigravityThinkingLevel = (typeof ANTIGRAVITY_THINKING_LEVELS)[number];
/** `max` exists only in Google account catalogs; the server has no equivalent. */
export type AntigravityModelLevel = AntigravityThinkingLevel | "max";
export type AntigravityLevelSpelling = "server" | "account" | "legacy";

export interface AntigravityModelVariant {
  familyId: string;
  level: AntigravityModelLevel;
  spelling: AntigravityLevelSpelling;
  /** Present when the account id ends in `-effort`, which formatting keeps. */
  effortSuffix?: true;
}

const LEVEL_LABELS: Record<AntigravityModelLevel, string> = {
  minimal: "Minimal", low: "Low", medium: "Medium", high: "High", extra_high: "Extra high", max: "Max",
};
/** Account-only spellings, per the server's own `_CCPA_LEVEL_NAMES`. */
const ACCOUNT_LEVELS: Record<string, AntigravityModelLevel> = { xhigh: "extra_high", max: "max" };
/** Account ids that do not spell their level (the server's `_CCPA_LEGACY_VARIANTS`). */
const LEGACY_VARIANTS: Record<string, readonly [string, AntigravityThinkingLevel]> = {
  "gemini-3.5-flash-extra-low": ["gemini-3.5-flash", "low"],
  "gemini-3.5-flash-low": ["gemini-3.5-flash", "medium"],
  "gemini-3-flash-agent": ["gemini-3.5-flash", "high"],
  "gemini-3.1-pro-low": ["gemini-3.1-pro", "low"],
  "gemini-pro-agent": ["gemini-3.1-pro", "high"],
};
const SERVER_LEVELS = new Set<string>(ANTIGRAVITY_THINKING_LEVELS);

/** Parses a model id from any Antigravity catalog, or null when it has no level. */
export function parseAntigravityModelId(id: string, options: { catalog?: "server" | "account" } = {}): AntigravityModelVariant | null {
  if (typeof id !== "string" || !id) return null;
  // `gemini-3.1-pro-low` is both a server id and a legacy account id with the
  // same meaning; `gemini-3.5-flash-low` is not, so account ids check legacy first.
  if (options.catalog === "account" && Object.hasOwn(LEGACY_VARIANTS, id)) {
    const [familyId, level] = LEGACY_VARIANTS[id]!;
    return { familyId, level, spelling: "legacy" };
  }
  const effortSuffix = options.catalog === "account" && id.endsWith("-effort");
  const stem = effortSuffix ? id.slice(0, -"-effort".length) : id;
  const cut = stem.lastIndexOf("-");
  if (cut < 1) return null;
  const familyId = stem.slice(0, cut), suffix = stem.slice(cut + 1);
  const effort = effortSuffix ? { effortSuffix: true as const } : {};
  if (SERVER_LEVELS.has(suffix)) {
    // `extra_high` is only ever the server's spelling, so it formats back as itself.
    const spelling = options.catalog === "account" && suffix !== "extra_high" ? "account" : "server";
    return { familyId, level: suffix as AntigravityThinkingLevel, spelling, ...effort };
  }
  if (Object.hasOwn(ACCOUNT_LEVELS, suffix)) return { familyId, level: ACCOUNT_LEVELS[suffix]!, spelling: "account", ...effort };
  return null;
}

/** The exact inverse of `parseAntigravityModelId` for the same spelling. */
export function formatAntigravityModelId(variant: AntigravityModelVariant): string {
  if (variant.spelling === "legacy") {
    const id = Object.entries(LEGACY_VARIANTS).find(([, [family, level]]) => family === variant.familyId && level === variant.level)?.[0];
    if (!id) throw new Error("No legacy Antigravity id has this family and level");
    return id;
  }
  if (variant.spelling === "server" && variant.level === "max") throw new Error("The Antigravity server has no max thinking level");
  const level = variant.spelling === "account" && variant.level === "extra_high" ? "xhigh" : variant.level;
  return `${variant.familyId}-${level}${variant.effortSuffix ? "-effort" : ""}`;
}

/** Converts an account-catalog level to the server's enum; `max` has none. */
export function antigravityServerThinkingLevel(level: string): AntigravityThinkingLevel | null {
  if (SERVER_LEVELS.has(level)) return level as AntigravityThinkingLevel;
  const mapped = ACCOUNT_LEVELS[level];
  return mapped && mapped !== "max" ? mapped : null;
}

export function antigravityThinkingLevelLabel(level: AntigravityModelLevel): string {
  return LEVEL_LABELS[level];
}

type CatalogFamily = (typeof CATALOG.families)[number];
const FAMILIES: ReadonlyMap<string, CatalogFamily> = new Map(CATALOG.families.map(family => [family.id, family]));

export interface AntigravityModelChoice {
  familyId: string;
  familyLabel: string;
  level: AntigravityModelLevel;
  levelLabel: string;
}

/** Family and level for a picker. The family label comes from the catalog, or
 * from the provider's own label with its level parenthetical removed. */
export function antigravityModelChoice(model: { id: string; label?: string }, options: { catalog?: "server" | "account" } = {}): AntigravityModelChoice | null {
  const variant = parseAntigravityModelId(model.id, options);
  if (!variant) return null;
  const levelLabel = LEVEL_LABELS[variant.level];
  const known = FAMILIES.get(variant.familyId)?.label;
  const fromLabel = model.label?.replace(/\s*\((?:[^()]*)\)\s*$/u, "").trim();
  return { familyId: variant.familyId, familyLabel: known ?? (fromLabel && fromLabel !== model.id ? fromLabel : variant.familyId), level: variant.level, levelLabel };
}

/** Gemini 4 families the server lists only for Agent Platform. With an API key
 * they run through the exact-model admission path, which needs a Gemini API
 * plan with Gemini 4 quota (the free tier has none). */
export function antigravityModelNeedsPaidGeminiApiPlan(id: string): boolean {
  const variant = parseAntigravityModelId(id, { catalog: "server" });
  return Boolean(variant && FAMILIES.get(variant.familyId)?.agentPlatformOnly
    && (FAMILIES.get(variant.familyId)!.levels as readonly string[]).includes(variant.level));
}

export const ANTIGRAVITY_PAID_PLAN_NOTE = "needs a paid Gemini API plan";

/** Model suggestions for a Google API-key connection, generated from the pinned
 * runtime. These are suggestions, not an allowlist: an explicit id stays
 * accepted and native admission decides. */
export function antigravityApiKeyModels(): Array<{ id: string; label: string }> {
  const listed = CATALOG.apiKey.models.map(model => ({ id: model.id, label: model.label }));
  const gemini4 = CATALOG.families.filter(family => family.agentPlatformOnly).flatMap(family => family.levels.map(level => ({
    id: `${family.id}-${level}`,
    label: `${family.label} (${LEVEL_LABELS[level as AntigravityThinkingLevel]}) · ${ANTIGRAVITY_PAID_PLAN_NOTE}`,
  })));
  return [...listed, ...gemini4];
}

export const ANTIGRAVITY_API_KEY_DEFAULT_MODEL = CATALOG.apiKey.defaultModelId;
export const ANTIGRAVITY_RUNTIME_CATALOG_VERSION = CATALOG.source.runtimeVersion;

/** Every server-catalog id of one family, in the server's priority order. */
export function antigravityFamilyModelIds(familyId: string): string[] {
  const family = FAMILIES.get(familyId);
  return family ? family.levels.map(level => `${family.id}-${level}`) : [];
}

export type AntigravityAuthRoute = "api_key" | "subscription";

/** Plain-language reason and fix when Google refuses a model for a connection.
 * Names only the model; never a provider code. */
export function antigravityModelRefusalMessage(modelId: string, route: AntigravityAuthRoute): string {
  const choice = antigravityModelChoice({ id: modelId }, { catalog: route === "api_key" ? "server" : "account" });
  const name = choice ? `${choice.familyLabel} (${choice.levelLabel})` : modelId;
  if (route === "subscription") {
    return `${name} is not available to this Google account. Choose a model from the account's list, or sign in with an account that includes it.`;
  }
  if (antigravityModelNeedsPaidGeminiApiPlan(modelId)) {
    return `${name} is not available with this Gemini API key. Use a key on a paid Gemini API plan that includes Gemini 4, or choose a Gemini 3 model.`;
  }
  return `${name} is not available with this Gemini API key. Choose a model from the list, or check that the model name is correct.`;
}
