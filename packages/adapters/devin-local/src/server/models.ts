import { execFile } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AdapterModel } from '@paperclipai/adapter-utils';
import { ensurePathInEnv } from '@paperclipai/adapter-utils/server-utils';
import { devinCliEnv } from './env.js';

const execFileAsync = promisify(execFile);

export interface DevinModelVariant {
  model_uid: string;
  label: string;
  max_context_tokens: number;
  max_output_tokens: number;
  cost_tier: string;
  cost_summary: string | null;
  is_new: boolean;
  is_beta: boolean;
}

export interface DevinModelFamily {
  family_label: string;
  family_uid: string;
  slug: string;
  aliases: string[];
  variants: DevinModelVariant[];
}

interface DevinModelsJson {
  families: DevinModelFamily[];
}

export interface ParsedModelCost {
  inputCostPerMTok: number;
  outputCostPerMTok: number;
  /** Published cached-read rate, when the catalog offers one (current format
   * does; the <=3000.6.2 format did not). */
  cachedInputCostPerMTok?: number;
  isFree: boolean;
  isUnknown?: boolean;
}

export interface DetailedModel extends AdapterModel {
  familyUid: string;
  familyLabel: string;
  /** Canonical slug from `devin models list`; used for variant decoding. */
  slug: string;
  /** Raw `cost_tier` from the Devin catalog (e.g. "Free", "High cost"). */
  costTier: string;
  maxContextTokens: number;
  maxOutputTokens: number;
  cost: ParsedModelCost;
  isNew: boolean;
  isBeta: boolean;
}

// ── Consolidated model config axes ───────────────────────────────────────────
// The Devin CLI exposes ~150 "models" that are really the cross-product of a
// base model family and several axes (reasoning effort, fast mode, 1M context,
// priority). We decode each variant id into those axes so the UI can present a
// single base-model dropdown plus separate controls, and so the adapter can
// reconstruct the exact concrete model_uid to pass to `devin --model`.

/** Reasoning-effort levels, ordered weakest → strongest. "auto" = no suffix. */
const DEVIN_EFFORT_ORDER = [
  'auto',
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'thinking',
] as const;
export type DevinEffort = (typeof DEVIN_EFFORT_ORDER)[number];

const EFFORT_TOKENS = new Set<string>(
  DEVIN_EFFORT_ORDER.filter((e) => e !== 'auto'),
);
const FLAG_TOKENS = new Set<string>(['fast', '1m', 'priority']);

export interface DevinModelAxes {
  effort: DevinEffort;
  fast: boolean;
  context1m: boolean;
  priority: boolean;
}

/** A base model (family) with the axes actually available across its variants. */
export interface DevinBaseModel {
  /** Stable id used as the `model` config value (the family uid, or a one-off id). */
  id: string;
  familyLabel: string;
  /** Representative cost (the auto/base, non-fast, non-1m variant when present). */
  cost: ParsedModelCost;
  costLabel: string;
  /** Broad cost tier of the representative variant (e.g. "Free", "High cost"). */
  costTier: string;
  maxContextTokens: number;
  availableEfforts: DevinEffort[];
  hasFast: boolean;
  has1m: boolean;
  hasPriority: boolean;
  isBeta: boolean;
  isNew: boolean;
  /** Fallback concrete uid when a requested axis combo does not exist. */
  defaultVariantId: string;
}

export interface DiscoveredModels {
  models: AdapterModel[];
  details: Map<string, DetailedModel>;
  defaultModelId: string;
  freeModelIds: string[];
  baseModels: DevinBaseModel[];
  baseById: Map<string, DevinBaseModel>;
  /** `${familyId}|${effort}|${fast}|${1m}|${priority}` → concrete model_uid */
  variantIndex: Map<string, string>;
  /** familyId → decoded variants (for nearest-match resolution). */
  variantsByFamily: Map<string, { axes: DevinModelAxes | null; id: string }[]>;
}

// Catalog cost_summary segments, as observed from the CLI: "$5 / 1M Input",
// optionally "$0.5 / 1M Cached input", then "$25 / 1M Output". Older unit
// spellings ("MTok In") stay tolerated; nothing observed emits them today.
const COST_IN_RE = /\$(\d+(?:\.\d+)?)\s*\/\s*(?:1M|MTok)\s*In(?:put)?/i;
const COST_CACHED_RE = /\$(\d+(?:\.\d+)?)\s*\/\s*(?:1M|MTok)\s*Cached input/i;
const COST_OUT_RE = /\$(\d+(?:\.\d+)?)\s*\/\s*(?:1M|MTok)\s*Out(?:put)?/i;

// Keyed by the resolved `command`: two agents pointing at different devin
// binaries (installs, accounts, entitlements) must never share a catalog or
// price runs against each other's rate card.
const modelCacheByCommand = new Map<string, { at: number; value: DiscoveredModels }>();
const refreshPromiseByCommand = new Map<string, Promise<DiscoveredModels>>();
const CACHE_TTL_MS = 60_000;

/**
 * Decode a concrete variant id into its axes relative to the family's `slug`.
 * Returns null when the id does not match the family slug at all (one-off /
 * legacy private model ids). Partial matches (known flags plus no effort) are
 * treated as `auto` effort.
 */
export function decodeVariant(id: string, slug: string): DevinModelAxes | null {
  const normalized = slug.toLowerCase().replace(/\./g, '-');
  if (id === normalized)
    return { effort: 'auto', fast: false, context1m: false, priority: false };
  if (!normalized || !id.startsWith(normalized + '-')) return null;
  const tokens = id.slice(normalized.length + 1).split('-');
  const axes: DevinModelAxes = {
    effort: 'auto',
    fast: false,
    context1m: false,
    priority: false,
  };
  let sawEffort = false;
  for (const tok of tokens) {
    if (!sawEffort && EFFORT_TOKENS.has(tok)) {
      axes.effort = tok as DevinEffort;
      sawEffort = true;
      continue;
    }
    if (tok === 'fast') {
      axes.fast = true;
      continue;
    }
    if (tok === '1m') {
      axes.context1m = true;
      continue;
    }
    if (tok === 'priority') {
      axes.priority = true;
      continue;
    }
    // Unrecognized token is ignored; the variant still belongs to this family.
    // It just will not appear in the decomposed effort/flag index.
  }
  return axes;
}

function variantKey(familyId: string, axes: DevinModelAxes): string {
  return `${familyId}|${axes.effort}|${axes.fast ? 1 : 0}|${axes.context1m ? 1 : 0}|${axes.priority ? 1 : 0}`;
}

export function parseCostSummary(
  costTier: string | undefined,
  costSummary: string | null | undefined,
): ParsedModelCost {
  const tier = (costTier ?? '').trim();
  const summary = String(costSummary ?? '').trim();
  // Adaptive has no cost fields; treat as unknown rather than free.
  if (!tier && !summary) {
    return {
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      isFree: false,
      isUnknown: true,
    };
  }
  if (
    tier.toLowerCase().includes('free') ||
    summary.toLowerCase() === 'none' ||
    summary.toLowerCase() === 'free'
  ) {
    return { inputCostPerMTok: 0, outputCostPerMTok: 0, isFree: true };
  }
  const inMatch = summary.match(COST_IN_RE);
  const outMatch = summary.match(COST_OUT_RE);
  if (!inMatch || !outMatch) {
    return {
      inputCostPerMTok: 0,
      outputCostPerMTok: 0,
      isFree: false,
      isUnknown: true,
    };
  }
  const cachedMatch = summary.match(COST_CACHED_RE);
  return {
    inputCostPerMTok: Number.parseFloat(inMatch[1]),
    outputCostPerMTok: Number.parseFloat(outMatch[1]),
    ...(cachedMatch
      ? { cachedInputCostPerMTok: Number.parseFloat(cachedMatch[1]) }
      : {}),
    isFree: false,
  };
}

export function costLabel(cost: ParsedModelCost): string {
  if (cost.isUnknown) return 'cost varies';
  if (cost.isFree) return 'Free';
  return `$${cost.inputCostPerMTok} / MTok In · $${cost.outputCostPerMTok} / MTok Out`;
}

function formatModelLabel(variant: DevinModelVariant): string {
  const cost = parseCostSummary(variant.cost_tier, variant.cost_summary);
  let suffix: string;
  if (cost.isUnknown) {
    suffix = 'cost varies';
  } else if (cost.isFree) {
    suffix = 'Free';
  } else if (variant.cost_summary && variant.cost_summary !== 'None') {
    suffix = variant.cost_summary;
  } else {
    suffix = variant.cost_tier;
  }
  const badges: string[] = [];
  if (variant.is_new) badges.push('NEW');
  if (variant.is_beta) badges.push('BETA');
  const badge = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
  return `${variant.label} - ${suffix}${badge}`;
}

// ── Base-model consolidation ─────────────────────────────────────────────────
function buildBaseModels(details: Map<string, DetailedModel>): {
  baseModels: DevinBaseModel[];
  baseById: Map<string, DevinBaseModel>;
  variantIndex: Map<string, string>;
  variantsByFamily: Map<string, { axes: DevinModelAxes | null; id: string }[]>;
} {
  const variantIndex = new Map<string, string>();
  const variantsByFamily = new Map<
    string,
    { axes: DevinModelAxes | null; id: string }[]
  >();
  // family accumulator
  interface Acc {
    familyUid: string;
    familyLabel: string;
    efforts: Set<DevinEffort>;
    hasFast: boolean;
    has1m: boolean;
    hasPriority: boolean;
    baseCost: ParsedModelCost | null;
    baseCostTier: string;
    minCost: ParsedModelCost | null;
    minCostTier: string;
    baseCtx: number;
    isBeta: boolean;
    isNew: boolean;
    defaultVariantId: string;
  }
  const acc = new Map<string, Acc>();
  const cheaper = (a: ParsedModelCost | null, b: ParsedModelCost) => {
    if (!a) return b;
    const av = a.isFree
      ? 0
      : a.isUnknown
        ? Number.MAX_SAFE_INTEGER
        : a.inputCostPerMTok + a.outputCostPerMTok;
    const bv = b.isFree
      ? 0
      : b.isUnknown
        ? Number.MAX_SAFE_INTEGER
        : b.inputCostPerMTok + b.outputCostPerMTok;
    return bv < av ? b : a;
  };

  for (const d of details.values()) {
    const axes = decodeVariant(d.id, d.slug);
    const fam = d.familyUid;
    let a = acc.get(fam);
    if (!a) {
      a = {
        familyUid: fam,
        familyLabel: d.familyLabel || fam,
        efforts: new Set(),
        hasFast: false,
        has1m: false,
        hasPriority: false,
        baseCost: null,
        baseCostTier: '',
        minCost: null,
        minCostTier: '',
        baseCtx: 0,
        isBeta: false,
        isNew: false,
        defaultVariantId: d.id,
      };
      acc.set(fam, a);
    }
    if (axes) {
      a.efforts.add(axes.effort);
      a.hasFast ||= axes.fast;
      a.has1m ||= axes.context1m;
      a.hasPriority ||= axes.priority;
      // representative: the plainest variant (auto effort, no flags) drives cost + ctx.
      const isPlain = !axes.fast && !axes.context1m && !axes.priority;
      if (isPlain && (axes.effort === 'auto' || a.baseCost === null)) {
        a.baseCost = d.cost;
        a.baseCostTier = d.costTier;
        a.baseCtx = d.maxContextTokens;
        a.defaultVariantId = d.id;
      }
      variantIndex.set(variantKey(fam, axes), d.id);
    }
    const prevMin = a.minCost;
    a.minCost = cheaper(a.minCost, d.cost);
    if (a.minCost !== prevMin) a.minCostTier = d.costTier;
    if (d.isBeta) a.isBeta = true;
    if (d.isNew) a.isNew = true;
    const list = variantsByFamily.get(fam) ?? [];
    list.push({ axes, id: d.id });
    variantsByFamily.set(fam, list);
  }

  const baseById = new Map<string, DevinBaseModel>();
  const baseModels: DevinBaseModel[] = [];
  for (const a of acc.values()) {
    const cost = a.baseCost ??
      a.minCost ?? {
        inputCostPerMTok: 0,
        outputCostPerMTok: 0,
        isFree: false,
        isUnknown: true,
      };
    const efforts = DEVIN_EFFORT_ORDER.filter((e) => a.efforts.has(e));
    const costTier = a.baseCostTier || a.minCostTier || '';
    const bm: DevinBaseModel = {
      id: a.familyUid,
      familyLabel: a.familyLabel,
      cost,
      costLabel: costLabel(cost),
      costTier,
      maxContextTokens: a.baseCtx,
      availableEfforts: efforts.length > 0 ? efforts : ['auto'],
      hasFast: a.hasFast,
      has1m: a.has1m,
      hasPriority: a.hasPriority,
      isBeta: a.isBeta,
      isNew: a.isNew,
      defaultVariantId: a.defaultVariantId,
    };
    baseModels.push(bm);
    baseById.set(bm.id, bm);
  }
  // Sort: free first, then by family label. The API does not expose a provider,
  // so we avoid inventing one.
  baseModels.sort((x, y) => {
    const fx = x.cost.isFree ? 0 : 1;
    const fy = y.cost.isFree ? 0 : 1;
    if (fx !== fy) return fx - fy;
    return x.familyLabel.localeCompare(y.familyLabel);
  });
  return { baseModels, baseById, variantIndex, variantsByFamily };
}

export async function discoverDevinModels(
  command = 'devin',
  cacheTtlMs = CACHE_TTL_MS,
): Promise<DiscoveredModels> {
  const now = Date.now();
  const cached = modelCacheByCommand.get(command);
  if (cached && now - cached.at < cacheTtlMs) {
    return cached.value;
  }
  const inFlight = refreshPromiseByCommand.get(command);
  if (inFlight) {
    return inFlight;
  }

  const refreshPromise = (async () => {
    let families: DevinModelFamily[] = [];
    try {
      const { stdout } = await execFileAsync(
        command,
        ['models', 'list', '--format', 'json'],
        {
          timeout: 30_000,
          env: ensurePathInEnv({
            ...devinCliEnv(),
            NO_COLOR: '1',
            FORCE_COLOR: '0',
          }),
        },
      );
      const parsed = JSON.parse(stdout) as DevinModelsJson;
      if (
        parsed &&
        typeof parsed === 'object' &&
        !Array.isArray(parsed) &&
        Array.isArray(parsed.families)
      ) {
        families = parsed.families;
      } else {
        throw new Error('invalid devin models list output');
      }
    } catch (err) {
      // If `devin models list` fails the CLI cannot run a session either, so surface
      // the real error instead of pretending with a stale hardcoded list.
      throw new Error(
        `devin models list failed: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const discovered = buildDiscoveredModels(families);
    modelCacheByCommand.set(command, { at: now, value: discovered });
    return discovered;
  })().finally(() => {
    refreshPromiseByCommand.delete(command);
  });
  refreshPromiseByCommand.set(command, refreshPromise);
  return refreshPromise;
}

/**
 * Pure catalog builder: turn the raw `devin models list` families into the
 * consolidated {@link DiscoveredModels} shape (base models + variant index +
 * cost details). Split out from {@link discoverDevinModels} so it can be unit
 * tested against a fixture catalog without shelling out to the Devin CLI.
 */
export function buildDiscoveredModels(
  families: DevinModelFamily[],
): DiscoveredModels {
  const details = new Map<string, DetailedModel>();
  const freeModelIds: string[] = [];

  for (const family of families) {
    if (!Array.isArray(family.variants)) continue;
    for (const variant of family.variants) {
      const cost = parseCostSummary(variant.cost_tier, variant.cost_summary);
      const label = formatModelLabel(variant);
      const model: DetailedModel = {
        id: variant.model_uid,
        label,
        familyUid: family.family_uid,
        familyLabel: family.family_label,
        slug: family.slug,
        costTier: variant.cost_tier,
        maxContextTokens: variant.max_context_tokens,
        maxOutputTokens: variant.max_output_tokens,
        cost,
        isNew: variant.is_new,
        isBeta: variant.is_beta,
      };
      if (!details.has(model.id)) {
        details.set(model.id, model);
        if (cost.isFree && !cost.isUnknown) {
          freeModelIds.push(model.id);
        }
      }
    }
  }

  const built = buildBaseModels(details);
  // Default = cheapest free BASE model (family), else adaptive, else first base.
  // Prefer the SWE-1.7 free lane. NB: live family uids use dots ("swe-1.7") while
  // model uids use dashes ("swe-1-7"), so match both separators. A dash-only test
  // silently never matches the discovered (dotted) base ids.
  const freeBase = built.baseModels
    .filter((b) => b.cost.isFree)
    .map((b) => b.id);
  const isSwe17 = (id: string) => /swe-1[.-]7\b/i.test(id);
  const defaultModelId =
    freeBase.find((id) => id === 'swe-1.7' || id === 'swe-1-7') ??
    freeBase.find(isSwe17) ??
    freeBase[0] ??
    (built.baseById.has('adaptive')
      ? 'adaptive'
      : (built.baseModels[0]?.id ?? ''));

  return {
    models: built.baseModels.map((b) => ({
      id: b.id,
      label: baseModelLabel(b),
      efforts: b.availableEfforts,
    })),
    details,
    defaultModelId,
    freeModelIds,
    ...built,
  };
}

/** Dropdown label for a base model: "Claude Opus 4.8 - High cost [BETA]". */
function baseModelLabel(b: DevinBaseModel): string {
  const badges: string[] = [];
  if (b.isNew) badges.push('NEW');
  if (b.isBeta) badges.push('BETA');
  const badge = badges.length > 0 ? ` [${badges.join(', ')}]` : '';
  const modifier = b.costTier || b.costLabel;
  return `${b.familyLabel} - ${modifier}${badge}`;
}

/** Base (consolidated) model list - one entry per family; drives the model dropdown. */
export async function listDevinModels(
  command = 'devin',
  bypassCache = false,
): Promise<AdapterModel[]> {
  const discovered = await discoverDevinModels(
    command,
    bypassCache ? 0 : CACHE_TTL_MS,
  );
  return discovered.models;
}

/** Rich base-model list (with axes) for schema-driven / custom config UIs. */
export async function listDevinBaseModels(
  command = 'devin',
): Promise<DevinBaseModel[]> {
  const { baseModels } = await discoverDevinModels(command);
  return baseModels;
}

export async function refreshDevinModels(
  command = 'devin',
): Promise<AdapterModel[]> {
  return listDevinModels(command, true);
}

export interface DevinModelSelection {
  model: string; // family id or a concrete/legacy uid
  effort?: string;
  contextSize?: string; // "1m" | "default"
  fast?: boolean;
  priority?: boolean;
}

/**
 * Resolve a consolidated selection to a concrete devin `--model` uid, always
 * returning a real id. An explicit effort the family does not offer is a hard
 * error (never silently remapped); unavailable flag combos degrade gracefully:
 * drop priority → drop fast → drop 1m → family default.
 * A legacy/concrete uid (or a one-off model) passes through unchanged.
 */
export async function resolveDevinModelUid(
  selection: DevinModelSelection,
  command = 'devin',
): Promise<string> {
  const model = (selection.model ?? '').trim();
  if (!model) return '';
  const discovered = await discoverDevinModels(command);
  return resolveModelUidFrom(discovered, selection);
}

/**
 * Pure resolver: reconstruct a concrete devin `--model` uid from a consolidated
 * selection against an already-discovered catalog. Split out from
 * {@link resolveDevinModelUid} so the graceful-degradation logic can be unit
 * tested deterministically. Effort is validated, never remapped: an explicit
 * effort outside the family's availableEfforts throws. Degradation order for
 * flags: drop priority → drop fast → drop 1m → any family variant → family
 * default → the id.
 */
export function resolveModelUidFrom(
  discovered: DiscoveredModels,
  selection: DevinModelSelection,
): string {
  const model = (selection.model ?? '').trim();
  if (!model) return '';
  const { baseById, details, variantIndex, variantsByFamily } = discovered;

  const requestedEffort = (selection.effort ?? '').trim().toLowerCase();
  // Validate effort against the family behind the selection, whether the
  // selection names the family itself or a concrete variant of it.
  const family =
    baseById.get(model) ??
    (details.has(model)
      ? baseById.get(details.get(model)!.familyUid)
      : undefined);
  if (requestedEffort && requestedEffort !== 'auto' && family) {
    const legal = family.availableEfforts.filter((e) => e !== 'auto');
    if (!family.availableEfforts.includes(requestedEffort as DevinEffort)) {
      throw new Error(
        `thinkingEffort "${selection.effort}" is not available for ${family.id} (available: ${legal.length > 0 ? legal.join(', ') : 'auto only'})`,
      );
    }
  }

  const base = baseById.get(model);
  // Not a known base family: treat as a concrete/legacy uid passthrough.
  if (!base) return model;

  const want: DevinModelAxes = {
    effort: requestedEffort ? (requestedEffort as DevinEffort) : 'auto',
    fast: Boolean(selection.fast) && base.hasFast,
    context1m: selection.contextSize === '1m' && base.has1m,
    priority: Boolean(selection.priority) && base.hasPriority,
  };

  const tryKey = (a: DevinModelAxes): string | undefined =>
    variantIndex.get(variantKey(model, a));

  // Exact, then relax flags one at a time, then all off.
  const relaxations: DevinModelAxes[] = [
    want,
    { ...want, priority: false },
    { ...want, fast: false },
    { ...want, context1m: false },
    { ...want, priority: false, fast: false },
    { ...want, priority: false, context1m: false },
    { ...want, fast: false, context1m: false },
    { ...want, priority: false, fast: false, context1m: false },
  ];
  for (const a of relaxations) {
    const hit = tryKey(a);
    if (hit) return hit;
  }
  // Nearest effort among available at the base (no flags). For "Auto" on a family
  // with no base/auto variant, target a balanced default (medium) rather than the
  // lowest tier, so Auto means "sensible default", not "cheapest".
  const targetEffort =
    want.effort === 'auto' && !base.availableEfforts.includes('auto')
      ? 'medium'
      : want.effort;
  const nearest = nearestEffort(targetEffort, base.availableEfforts);
  const nearestHit = tryKey({
    effort: nearest,
    fast: false,
    context1m: false,
    priority: false,
  });
  if (nearestHit) return nearestHit;
  // Exact concrete uid if known, then any variant, then the family default.
  const any = variantsByFamily.get(model)?.[0]?.id;
  return (details.has(model) ? model : null) ?? any ?? base.defaultVariantId;
}

function nearestEffort(
  want: DevinEffort,
  available: DevinEffort[],
): DevinEffort {
  if (available.includes(want)) return want;
  if (available.length === 0) return 'auto';
  const wi = DEVIN_EFFORT_ORDER.indexOf(want);
  let best = available[0];
  let bestDist = Infinity;
  for (const a of available) {
    const dist = Math.abs(DEVIN_EFFORT_ORDER.indexOf(a) - wi);
    if (dist < bestDist) {
      bestDist = dist;
      best = a;
    }
  }
  return best;
}

export async function getModelCost(
  modelId: string,
  command = 'devin',
): Promise<ParsedModelCost | null> {
  const { details, baseById } = await discoverDevinModels(command);
  return details.get(modelId)?.cost ?? baseById.get(modelId)?.cost ?? null;
}

export function clearModelCache(): void {
  modelCacheByCommand.clear();
  refreshPromiseByCommand.clear();
}

interface DetectedDevinModel {
  model: string;
  provider: string;
  source: string;
  candidates?: string[];
}

/**
 * Map a raw config value (family id, variant uid, either separator style) to
 * the base-model id the board's model list uses, so the detected model matches
 * a real list entry instead of rendering as a duplicate raw key. Falls back to
 * the raw value when the catalog doesn't know it.
 */
export function resolveDetectedBaseModelId(
  raw: string,
  discovered: DiscoveredModels,
): string {
  const value = raw.trim();
  if (!value) return value;
  if (discovered.baseById.has(value)) return value;
  const asVariant = discovered.details.get(value);
  if (asVariant && discovered.baseById.has(asVariant.familyUid)) {
    return asVariant.familyUid;
  }
  // Live family uids use dots ("swe-1.7") while model uids use dashes
  // ("swe-1-7"); match both separator styles case-insensitively.
  const norm = (s: string) => s.toLowerCase().replace(/[._]/g, '-');
  for (const id of discovered.baseById.keys()) {
    if (norm(id) === norm(value)) return id;
  }
  for (const [uid, detail] of discovered.details) {
    if (
      norm(uid) === norm(value) &&
      discovered.baseById.has(detail.familyUid)
    ) {
      return detail.familyUid;
    }
  }
  return value;
}

/**
 * Detect the model Devin is configured to use locally, without exposing the rest
 * of the user's config. Reads `~/.config/devin/config.json` (or
 * `$XDG_CONFIG_HOME/devin/config.json`) and returns the `agent.model` field,
 * resolved to the catalog's base-model id when discovery is available (the raw
 * value is preserved in `candidates` when it was rewritten).
 */
export async function detectModel(): Promise<DetectedDevinModel | null> {
  const configHome = process.env.XDG_CONFIG_HOME
    ? path.resolve(process.env.XDG_CONFIG_HOME)
    : path.join(homedir(), '.config');
  const configPath = path.join(configHome, 'devin', 'config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const agent =
      parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed.agent as Record<string, unknown> | undefined)
        : undefined;
    const model =
      typeof agent?.model === 'string' && agent.model.trim().length > 0
        ? agent.model.trim()
        : typeof parsed.model === 'string' && parsed.model.trim().length > 0
          ? parsed.model.trim()
          : '';
    if (!model) return null;
    try {
      const discovered = await discoverDevinModels();
      const mapped = resolveDetectedBaseModelId(model, discovered);
      if (mapped !== model) {
        return {
          model: mapped,
          provider: 'devin',
          source: configPath,
          candidates: [model],
        };
      }
    } catch {
      // Discovery unavailable (CLI missing/unauthenticated): return raw value.
    }
    return { model, provider: 'devin', source: configPath };
  } catch {
    return null;
  }
}
