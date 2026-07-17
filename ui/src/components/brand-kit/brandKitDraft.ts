import { parseDesignMd, type BrandKitTokens } from "@paperclipai/shared";
import type { BrandKit } from "../../api/brandKits";

// Pure draft model + transforms for the Brand Kit structured editor (NEO-271).
// Kept free of React so the round-trip (kit -> draft -> tokens -> DESIGN.md ->
// parse) is unit-testable and can run on every keystroke without cost.

export type Pair = [string, string];

export interface ColorField {
  mode: "solid" | "scale";
  solid: string;
  scale: Pair[];
}

export interface TypeStyleDraft {
  name: string;
  family: string;
  size: string;
  weight: string;
  lineHeight: string;
  letterSpacing: string;
}

export interface Draft {
  name: string;
  colors: {
    primary: ColorField;
    secondary: ColorField;
    accent: ColorField;
    neutral: ColorField;
    semantic: Pair[];
  };
  families: Pair[];
  typeScale: TypeStyleDraft[];
  rounded: Pair[];
  spacing: Pair[];
  elevation: Pair[];
  durations: Pair[];
  easings: Pair[];
  breakpoints: Pair[];
  zIndex: Pair[];
  imagery: { style: string; treatments: string[]; samples: string[] };
  narrative: { audience: string; positioning: string; oneLiner: string };
  narrativeRef: string;
  voice: {
    audience: string;
    toneAttributes: string[];
    dosAndDonts: Array<{ do: string; dont: string }>;
    preferred: string[];
    blacklist: string[];
    boilerplate: string;
    proofPoints: string[];
  };
  body: string;
}

export const emptyColor = (): ColorField => ({ mode: "solid", solid: "", scale: [] });

function colorFieldFrom(value: unknown): ColorField {
  if (typeof value === "string") return { mode: "solid", solid: value, scale: [] };
  if (value && typeof value === "object") {
    return {
      mode: "scale",
      solid: "",
      scale: Object.entries(value as Record<string, string>).map(
        ([k, v]) => [k, String(v)] as Pair,
      ),
    };
  }
  return emptyColor();
}

function recordToPairs(rec: unknown): Pair[] {
  if (!rec || typeof rec !== "object") return [];
  return Object.entries(rec as Record<string, unknown>).map(
    ([k, v]) => [k, String(v)] as Pair,
  );
}

// Build an editable draft from a persisted kit. A brand-new empty kit (no tokens)
// seeds a sensible default primary so the preview and contrast checks have input.
export function seedDraft(kit: BrandKit): Draft {
  const tokens = (kit.tokens ?? {}) as Partial<BrandKitTokens>;
  const hasTokens = tokens && Object.keys(tokens).length > 0;
  const parsedBody = kit.designMd ? parseDesignMd(kit.designMd) : null;
  const body = parsedBody && parsedBody.ok ? parsedBody.document.body : "";

  const colors = (tokens.colors ?? {}) as Record<string, unknown>;
  const typography = (tokens.typography ?? {}) as {
    families?: Record<string, string>;
    scale?: Record<string, Record<string, unknown>>;
  };
  const motion = (tokens.motion ?? {}) as {
    durations?: Record<string, string>;
    easings?: Record<string, string>;
  };
  const imagery = (tokens.imagery ?? {}) as {
    style?: string;
    treatments?: string[];
    samples?: string[];
  };
  const narrative = (tokens.narrative ?? {}) as {
    audience?: string;
    positioning?: string;
    oneLiner?: string;
  };
  const voice = (tokens.voice ?? {}) as Record<string, unknown>;
  const lexicon = (voice.lexicon ?? {}) as { preferred?: string[]; blacklist?: string[] };

  const typeScale: TypeStyleDraft[] = Object.entries(typography.scale ?? {}).map(
    ([name, style]) => ({
      name,
      family: String(style?.family ?? ""),
      size: String(style?.size ?? ""),
      weight: style?.weight === undefined ? "" : String(style.weight),
      lineHeight: String(style?.lineHeight ?? ""),
      letterSpacing: String(style?.letterSpacing ?? ""),
    }),
  );

  return {
    name: tokens.name ?? kit.name ?? "",
    colors: {
      primary: hasTokens
        ? colorFieldFrom(colors.primary)
        : { mode: "solid", solid: "#6366f1", scale: [] },
      secondary: colorFieldFrom(colors.secondary),
      accent: colorFieldFrom(colors.accent),
      neutral: colorFieldFrom(colors.neutral),
      semantic: recordToPairs(colors.semantic),
    },
    families: recordToPairs(typography.families),
    typeScale,
    rounded: recordToPairs(tokens.rounded),
    spacing: recordToPairs(tokens.spacing),
    elevation: recordToPairs(tokens.elevation),
    durations: recordToPairs(motion.durations),
    easings: recordToPairs(motion.easings),
    breakpoints: recordToPairs(tokens.breakpoints),
    zIndex: recordToPairs(tokens.zIndex),
    imagery: {
      style: imagery.style ?? "",
      treatments: imagery.treatments ?? [],
      samples: imagery.samples ?? [],
    },
    narrative: {
      audience: narrative.audience ?? "",
      positioning: narrative.positioning ?? "",
      oneLiner: narrative.oneLiner ?? "",
    },
    narrativeRef: tokens.narrativeRef ?? "",
    voice: {
      audience: String(voice.audience ?? ""),
      toneAttributes: (voice.toneAttributes as string[]) ?? [],
      dosAndDonts: (voice.dosAndDonts as Array<{ do: string; dont: string }>) ?? [],
      preferred: lexicon.preferred ?? [],
      blacklist: lexicon.blacklist ?? [],
      boilerplate: String(voice.boilerplate ?? ""),
      proofPoints: (voice.proofPoints as string[]) ?? [],
    },
    body,
  };
}

// --- draft -> tokens ---------------------------------------------------------

export function cleanRecord(pairs: Pair[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const [k, v] of pairs) {
    const key = k.trim();
    if (key && v.trim()) out[key] = v.trim();
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanNumberRecord(pairs: Pair[]): Record<string, number> | undefined {
  const out: Record<string, number> = {};
  for (const [k, v] of pairs) {
    const key = k.trim();
    const n = Number(v.trim());
    if (key && v.trim() && Number.isFinite(n)) out[key] = n;
  }
  return Object.keys(out).length ? out : undefined;
}

function cleanList(list: string[]): string[] | undefined {
  const out = list.map((s) => s.trim()).filter(Boolean);
  return out.length ? out : undefined;
}

function colorFieldToValue(f: ColorField): string | Record<string, string> | undefined {
  if (f.mode === "solid") {
    const v = f.solid.trim();
    return v ? v : undefined;
  }
  return cleanRecord(f.scale);
}

export function draftToTokens(d: Draft): BrandKitTokens {
  const t: Record<string, unknown> = { name: d.name.trim() || "Untitled" };

  const colors: Record<string, unknown> = {};
  const primary = colorFieldToValue(d.colors.primary);
  if (primary !== undefined) colors.primary = primary;
  const secondary = colorFieldToValue(d.colors.secondary);
  if (secondary !== undefined) colors.secondary = secondary;
  const accent = colorFieldToValue(d.colors.accent);
  if (accent !== undefined) colors.accent = accent;
  const neutral = colorFieldToValue(d.colors.neutral);
  if (neutral !== undefined) colors.neutral = neutral;
  const semantic = cleanRecord(d.colors.semantic);
  if (semantic) colors.semantic = semantic;
  if (Object.keys(colors).length) t.colors = colors;

  const families = cleanRecord(d.families);
  const scale: Record<string, Record<string, unknown>> = {};
  for (const s of d.typeScale) {
    const name = s.name.trim();
    if (!name) continue;
    const style: Record<string, unknown> = {};
    if (s.family.trim()) style.family = s.family.trim();
    if (s.size.trim()) style.size = s.size.trim();
    if (s.weight.trim()) {
      const n = Number(s.weight.trim());
      style.weight = Number.isFinite(n) && String(n) === s.weight.trim() ? n : s.weight.trim();
    }
    if (s.lineHeight.trim()) style.lineHeight = s.lineHeight.trim();
    if (s.letterSpacing.trim()) style.letterSpacing = s.letterSpacing.trim();
    scale[name] = style;
  }
  if (families || Object.keys(scale).length) {
    const typography: Record<string, unknown> = { scale };
    if (families) typography.families = families;
    t.typography = typography;
  }

  const rounded = cleanRecord(d.rounded);
  if (rounded) t.rounded = rounded;
  const spacing = cleanRecord(d.spacing);
  if (spacing) t.spacing = spacing;
  const elevation = cleanRecord(d.elevation);
  if (elevation) t.elevation = elevation;

  const durations = cleanRecord(d.durations);
  const easings = cleanRecord(d.easings);
  if (durations || easings) {
    const motion: Record<string, unknown> = {};
    if (durations) motion.durations = durations;
    if (easings) motion.easings = easings;
    t.motion = motion;
  }

  const breakpoints = cleanRecord(d.breakpoints);
  if (breakpoints) t.breakpoints = breakpoints;
  const zIndex = cleanNumberRecord(d.zIndex);
  if (zIndex) t.zIndex = zIndex;

  const treatments = cleanList(d.imagery.treatments);
  const samples = cleanList(d.imagery.samples);
  if (d.imagery.style.trim() || treatments || samples) {
    const imagery: Record<string, unknown> = {};
    if (d.imagery.style.trim()) imagery.style = d.imagery.style.trim();
    if (treatments) imagery.treatments = treatments;
    if (samples) imagery.samples = samples;
    t.imagery = imagery;
  }

  const nar: Record<string, unknown> = {};
  if (d.narrative.audience.trim()) nar.audience = d.narrative.audience.trim();
  if (d.narrative.positioning.trim()) nar.positioning = d.narrative.positioning.trim();
  if (d.narrative.oneLiner.trim()) nar.oneLiner = d.narrative.oneLiner.trim();
  if (Object.keys(nar).length) t.narrative = nar;
  if (d.narrativeRef.trim()) t.narrativeRef = d.narrativeRef.trim();

  const voice: Record<string, unknown> = {};
  if (d.voice.audience.trim()) voice.audience = d.voice.audience.trim();
  const tone = cleanList(d.voice.toneAttributes);
  if (tone) voice.toneAttributes = tone;
  const dnd = d.voice.dosAndDonts
    .map((r) => ({ do: r.do.trim(), dont: r.dont.trim() }))
    .filter((r) => r.do || r.dont);
  if (dnd.length) voice.dosAndDonts = dnd;
  const preferred = cleanList(d.voice.preferred);
  const blacklist = cleanList(d.voice.blacklist);
  if (preferred || blacklist) {
    const lex: Record<string, unknown> = {};
    if (preferred) lex.preferred = preferred;
    if (blacklist) lex.blacklist = blacklist;
    voice.lexicon = lex;
  }
  if (d.voice.boilerplate.trim()) voice.boilerplate = d.voice.boilerplate.trim();
  const proof = cleanList(d.voice.proofPoints);
  if (proof) voice.proofPoints = proof;
  if (Object.keys(voice).length) t.voice = voice;

  return t as BrandKitTokens;
}

// Representative solid color for a role, used by preview + contrast checks.
export function roleSolid(field: ColorField): string | null {
  if (field.mode === "solid") {
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(field.solid.trim())
      ? field.solid.trim()
      : null;
  }
  const map = cleanRecord(field.scale) ?? {};
  const preferred = map["500"] ?? map["600"] ?? map["400"];
  const value = preferred ?? Object.values(map)[0];
  return value && /^#/.test(value) ? value : null;
}
