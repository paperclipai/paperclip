import { ChangeEvent, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  parseDesignMd,
  serializeDesignMd,
  type BrandKitTokens,
  type BrandKitValidationError,
} from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { AlertTriangle, Check, Code2, Eye } from "lucide-react";
import { Field } from "../agent-config-primitives";
import { brandKitsApi, type BrandKit, type BrandKitAssetRef } from "../../api/brandKits";
import { queryKeys } from "../../lib/queryKeys";
import { contrastRatio, gradeContrast, readableTextColor } from "../../lib/wcagContrast";
import { RecordEditor, StringListEditor, brandKitInputCls } from "./recordEditors";

// ---------------------------------------------------------------------------
// Draft model — mirrors BrandKitTokens but represents record/map tokens as
// ordered arrays so keys can be edited (including transiently-empty ones)
// without losing focus or order. Serialized back to canonical tokens on save.
// ---------------------------------------------------------------------------

type Pair = [string, string];

interface ColorField {
  mode: "solid" | "scale";
  solid: string;
  scale: Pair[];
}

interface TypeStyleDraft {
  name: string;
  family: string;
  size: string;
  weight: string;
  lineHeight: string;
  letterSpacing: string;
}

interface Draft {
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

const emptyColor = (): ColorField => ({ mode: "solid", solid: "", scale: [] });

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

function seedDraft(kit: BrandKit): Draft {
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
      // A brand-new empty kit seeds a sensible starting primary.
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
      dosAndDonts:
        (voice.dosAndDonts as Array<{ do: string; dont: string }>) ?? [],
      preferred: lexicon.preferred ?? [],
      blacklist: lexicon.blacklist ?? [],
      boilerplate: String(voice.boilerplate ?? ""),
      proofPoints: (voice.proofPoints as string[]) ?? [],
    },
    body,
  };
}

// --- draft -> tokens ---------------------------------------------------------

function cleanRecord(pairs: Pair[]): Record<string, string> | undefined {
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

function draftToTokens(d: Draft): BrandKitTokens {
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

// ---------------------------------------------------------------------------
// Presentational helpers
// ---------------------------------------------------------------------------

function SectionCard({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-3 rounded-md border border-border px-4 py-4">
      <div>
        <div className="text-sm font-medium">{title}</div>
        {description && (
          <div className="text-xs text-muted-foreground">{description}</div>
        )}
      </div>
      {children}
    </div>
  );
}

function ColorRoleEditor({
  label,
  required,
  field,
  onChange,
}: {
  label: string;
  required?: boolean;
  field: ColorField;
  onChange: (next: ColorField) => void;
}) {
  return (
    <Field label={required ? `${label} *` : label}>
      <div className="space-y-2">
        <div className="flex items-center gap-2">
          <select
            className={`${brandKitInputCls} w-24`}
            value={field.mode}
            onChange={(e) =>
              onChange({ ...field, mode: e.target.value as "solid" | "scale" })
            }
          >
            <option value="solid">Solid</option>
            <option value="scale">Scale</option>
          </select>
          {field.mode === "solid" ? (
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label={`${label} color`}
                value={/^#[0-9a-fA-F]{6}$/.test(field.solid) ? field.solid : "#000000"}
                onChange={(e) => onChange({ ...field, solid: e.target.value })}
                className="h-8 w-8 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <input
                type="text"
                value={field.solid}
                placeholder="#RRGGBB"
                onChange={(e) => onChange({ ...field, solid: e.target.value })}
                className={`${brandKitInputCls} w-32 font-mono`}
              />
            </div>
          ) : (
            <span className="text-xs text-muted-foreground">
              Named shades (e.g. 50 → 900)
            </span>
          )}
        </div>
        {field.mode === "scale" && (
          <RecordEditor
            value={field.scale}
            onChange={(scale) => onChange({ ...field, scale })}
            keyPlaceholder="shade"
            valuePlaceholder="#RRGGBB"
            addLabel="Add shade"
          />
        )}
      </div>
    </Field>
  );
}

// Representative solid color for a role, used by preview + contrast checks.
function roleSolid(field: ColorField): string | null {
  if (field.mode === "solid") {
    return /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(field.solid.trim())
      ? field.solid.trim()
      : null;
  }
  // For a scale, prefer a mid shade (e.g. 500), else the first valid hex.
  const map = cleanRecord(field.scale) ?? {};
  const preferred = map["500"] ?? map["600"] ?? map["400"];
  const value = preferred ?? Object.values(map)[0];
  return value && /^#/.test(value) ? value : null;
}

// ---------------------------------------------------------------------------
// Main editor
// ---------------------------------------------------------------------------

export function BrandKitEditor({ companyId }: { companyId: string }) {
  const queryClient = useQueryClient();
  const [selectedKitId, setSelectedKitId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [savedMd, setSavedMd] = useState<string>("");
  const [view, setView] = useState<"structured" | "raw">("structured");
  const [rawText, setRawText] = useState<string>("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [newKitName, setNewKitName] = useState("");

  const kitsQuery = useQuery({
    queryKey: queryKeys.brandKits.list(companyId),
    queryFn: () => brandKitsApi.list(companyId),
  });

  const kits = kitsQuery.data?.brandKits ?? [];
  const activeKit = useMemo(
    () =>
      kits.find((k) => k.id === selectedKitId) ??
      kits.find((k) => k.isDefault) ??
      kits[0] ??
      null,
    [kits, selectedKitId],
  );

  const assetsQuery = useQuery({
    queryKey: queryKeys.brandKits.assets(companyId, activeKit?.id ?? ""),
    queryFn: () => brandKitsApi.export(companyId, activeKit!.id),
    enabled: !!activeKit,
  });
  const assets: BrandKitAssetRef[] = assetsQuery.data?.assets ?? [];

  // Load a kit into the draft whenever the active kit changes.
  useEffect(() => {
    if (!activeKit) {
      setDraft(null);
      setSavedMd("");
      return;
    }
    setSelectedKitId(activeKit.id);
    setDraft(seedDraft(activeKit));
    setSavedMd(activeKit.designMd ?? "");
  }, [activeKit?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const designMd = useMemo(
    () => (draft ? serializeDesignMd({ tokens: draftToTokens(draft), body: draft.body }) : ""),
    [draft],
  );

  const validation = useMemo(() => parseDesignMd(designMd), [designMd]);
  const validationErrors: BrandKitValidationError[] = validation.ok ? [] : validation.errors;
  const dirty = designMd !== savedMd;

  const saveMutation = useMutation({
    mutationFn: () =>
      brandKitsApi.updateDesign(companyId, activeKit!.id, {
        designMd,
        name: draft?.name.trim() || undefined,
      }),
    onSuccess: (kit) => {
      setSavedMd(kit.designMd ?? designMd);
      void queryClient.invalidateQueries({ queryKey: queryKeys.brandKits.list(companyId) });
    },
  });

  const createMutation = useMutation({
    mutationFn: () =>
      brandKitsApi.create(companyId, {
        name: newKitName.trim(),
        setDefault: kits.length === 0,
      }),
    onSuccess: (kit) => {
      setNewKitName("");
      setSelectedKitId(kit.id);
      void queryClient.invalidateQueries({ queryKey: queryKeys.brandKits.list(companyId) });
    },
  });

  function openRaw() {
    setRawText(designMd);
    setRawError(null);
    setView("raw");
  }

  function applyRaw() {
    const parsed = parseDesignMd(rawText);
    if (!parsed.ok) {
      setRawError(
        parsed.errors.map((e) => `${e.path || "(root)"}: ${e.message}`).join("\n"),
      );
      return;
    }
    // Round-trip the raw source back into the structured draft.
    setDraft(
      seedDraft({
        ...(activeKit as BrandKit),
        designMd: rawText,
        tokens: parsed.document.tokens,
      }),
    );
    setRawError(null);
    setView("structured");
  }

  if (kitsQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">Loading brand kit…</div>;
  }

  if (!activeKit) {
    return (
      <SectionCard
        title="Brand Kit"
        description="No brand kit yet. Create one to define your company's DESIGN.md tokens."
      >
        <div className="flex items-center gap-2">
          <input
            className={`${brandKitInputCls} flex-1`}
            value={newKitName}
            placeholder="Brand kit name (e.g. Primary)"
            onChange={(e) => setNewKitName(e.target.value)}
          />
          <Button
            size="sm"
            disabled={!newKitName.trim() || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? "Creating…" : "Create brand kit"}
          </Button>
        </div>
        {createMutation.isError && (
          <span className="text-xs text-destructive">
            {createMutation.error instanceof Error
              ? createMutation.error.message
              : "Failed to create brand kit"}
          </span>
        )}
      </SectionCard>
    );
  }

  if (!draft) return null;

  const setColors = (patch: Partial<Draft["colors"]>) =>
    setDraft({ ...draft, colors: { ...draft.colors, ...patch } });

  // --- contrast checks ---
  const bg = roleSolid(draft.colors.neutral) ?? "#ffffff";
  const contrastRows = (
    [
      ["primary", roleSolid(draft.colors.primary)],
      ["secondary", roleSolid(draft.colors.secondary)],
      ["accent", roleSolid(draft.colors.accent)],
    ] as Array<[string, string | null]>
  )
    .filter((r): r is [string, string] => r[1] !== null)
    .map(([role, hex]) => {
      const ratio = contrastRatio(hex, bg) ?? 0;
      return { role, hex, ratio, grade: gradeContrast(ratio) };
    });

  const primaryHex = roleSolid(draft.colors.primary);

  return (
    <div className="space-y-4">
      {/* Kit selector + view toggle */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <select
            className={`${brandKitInputCls}`}
            value={activeKit.id}
            onChange={(e) => setSelectedKitId(e.target.value)}
          >
            {kits.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
                {k.isDefault ? " (default)" : ""}
              </option>
            ))}
          </select>
          {!activeKit.isDefault && (
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                brandKitsApi.setDefault(companyId, activeKit.id).then(() =>
                  queryClient.invalidateQueries({
                    queryKey: queryKeys.brandKits.list(companyId),
                  }),
                )
              }
            >
              Set default
            </Button>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button
            size="sm"
            variant={view === "structured" ? "default" : "outline"}
            onClick={() => setView("structured")}
          >
            <Eye className="mr-1 h-3.5 w-3.5" />
            Structured
          </Button>
          <Button
            size="sm"
            variant={view === "raw" ? "default" : "outline"}
            onClick={openRaw}
          >
            <Code2 className="mr-1 h-3.5 w-3.5" />
            Raw
          </Button>
        </div>
      </div>

      {/* Validation banner */}
      {validationErrors.length > 0 && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <div className="mb-1 flex items-center gap-1 font-medium">
            <AlertTriangle className="h-3.5 w-3.5" />
            DESIGN.md validation ({validationErrors.length})
          </div>
          <ul className="ml-4 list-disc space-y-0.5">
            {validationErrors.slice(0, 8).map((e, i) => (
              <li key={i}>
                <span className="font-mono">{e.path || "(root)"}</span>: {e.message}
              </li>
            ))}
          </ul>
        </div>
      )}

      {view === "raw" ? (
        <SectionCard
          title="Raw DESIGN.md"
          description="Edit the artifact source directly. Applying re-parses it into the structured editor."
        >
          <textarea
            className={`${brandKitInputCls} h-96 w-full font-mono text-xs`}
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            spellCheck={false}
          />
          {rawError && (
            <pre className="whitespace-pre-wrap rounded bg-destructive/5 p-2 text-xs text-destructive">
              {rawError}
            </pre>
          )}
          <div className="flex items-center gap-2">
            <Button size="sm" onClick={applyRaw}>
              Apply to structured
            </Button>
            <Button size="sm" variant="outline" onClick={() => setView("structured")}>
              Cancel
            </Button>
          </div>
        </SectionCard>
      ) : (
        <>
          {/* Live preview */}
          <SectionCard title="Live preview" description="Rendered from the current tokens.">
            <BrandPreview draft={draft} bg={bg} logo={assets.find((a) => a.role === "logo_primary")} />
          </SectionCard>

          {/* Identity */}
          <SectionCard title="Identity">
            <Field label="Kit name">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.name}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })}
              />
            </Field>
          </SectionCard>

          {/* Colors + contrast */}
          <SectionCard
            title="Color roles"
            description="Each role is a solid hex or a named shade scale."
          >
            <ColorRoleEditor
              label="Primary"
              required
              field={draft.colors.primary}
              onChange={(primary) => setColors({ primary })}
            />
            <ColorRoleEditor
              label="Secondary"
              field={draft.colors.secondary}
              onChange={(secondary) => setColors({ secondary })}
            />
            <ColorRoleEditor
              label="Accent"
              field={draft.colors.accent}
              onChange={(accent) => setColors({ accent })}
            />
            <ColorRoleEditor
              label="Neutral"
              field={draft.colors.neutral}
              onChange={(neutral) => setColors({ neutral })}
            />
            <Field label="Semantic colors" hint="e.g. success, warning, danger, info">
              <RecordEditor
                value={draft.colors.semantic}
                onChange={(semantic) => setColors({ semantic })}
                keyPlaceholder="name"
                valuePlaceholder="#RRGGBB"
                addLabel="Add semantic color"
              />
            </Field>

            {contrastRows.length > 0 && (
              <div className="rounded-md border border-border/60 bg-muted/30 p-2">
                <div className="mb-1 text-xs font-medium text-muted-foreground">
                  WCAG contrast vs {draft.colors.neutral.mode === "solid" && roleSolid(draft.colors.neutral) ? "neutral" : "white"} background ({bg})
                </div>
                <div className="space-y-1">
                  {contrastRows.map((r) => {
                    const bad = r.grade === "Fail" || r.grade === "AA Large";
                    return (
                      <div key={r.role} className="flex items-center gap-2 text-xs">
                        <span
                          className="inline-block h-3.5 w-3.5 rounded border border-border"
                          style={{ background: r.hex }}
                        />
                        <span className="w-20 capitalize">{r.role}</span>
                        <span className="font-mono">{r.ratio.toFixed(2)}:1</span>
                        <span
                          className={
                            bad
                              ? "flex items-center gap-1 font-medium text-destructive"
                              : "flex items-center gap-1 text-emerald-600"
                          }
                        >
                          {bad ? (
                            <AlertTriangle className="h-3 w-3" />
                          ) : (
                            <Check className="h-3 w-3" />
                          )}
                          {r.grade}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
          </SectionCard>

          {/* Typography */}
          <SectionCard title="Typography">
            <Field label="Font families" hint="Named family tokens, e.g. sans → 'Inter, sans-serif'">
              <RecordEditor
                value={draft.families}
                onChange={(families) => setDraft({ ...draft, families })}
                keyPlaceholder="token"
                valuePlaceholder="Inter, sans-serif"
                addLabel="Add family"
              />
            </Field>
            <Field label="Type scale">
              <TypeScaleEditor
                value={draft.typeScale}
                onChange={(typeScale) => setDraft({ ...draft, typeScale })}
              />
            </Field>
          </SectionCard>

          {/* Layout tokens */}
          <SectionCard title="Radius, spacing & elevation">
            <Field label="Radius (rounded)">
              <RecordEditor
                value={draft.rounded}
                onChange={(rounded) => setDraft({ ...draft, rounded })}
                keyPlaceholder="sm"
                valuePlaceholder="4px"
              />
            </Field>
            <Field label="Spacing">
              <RecordEditor
                value={draft.spacing}
                onChange={(spacing) => setDraft({ ...draft, spacing })}
                keyPlaceholder="md"
                valuePlaceholder="16px"
              />
            </Field>
            <Field label="Elevation / shadow">
              <RecordEditor
                value={draft.elevation}
                onChange={(elevation) => setDraft({ ...draft, elevation })}
                keyPlaceholder="card"
                valuePlaceholder="0 1px 2px rgba(0,0,0,.1)"
              />
            </Field>
          </SectionCard>

          {/* Motion / breakpoints / z-index */}
          <SectionCard title="Motion, breakpoints & z-index">
            <Field label="Motion — durations">
              <RecordEditor
                value={draft.durations}
                onChange={(durations) => setDraft({ ...draft, durations })}
                keyPlaceholder="fast"
                valuePlaceholder="150ms"
              />
            </Field>
            <Field label="Motion — easings">
              <RecordEditor
                value={draft.easings}
                onChange={(easings) => setDraft({ ...draft, easings })}
                keyPlaceholder="standard"
                valuePlaceholder="cubic-bezier(.4,0,.2,1)"
              />
            </Field>
            <Field label="Breakpoints">
              <RecordEditor
                value={draft.breakpoints}
                onChange={(breakpoints) => setDraft({ ...draft, breakpoints })}
                keyPlaceholder="md"
                valuePlaceholder="768px"
              />
            </Field>
            <Field label="z-index" hint="Integer values only.">
              <RecordEditor
                value={draft.zIndex}
                onChange={(zIndex) => setDraft({ ...draft, zIndex })}
                keyPlaceholder="modal"
                valuePlaceholder="1000"
                numericValue
              />
            </Field>
          </SectionCard>

          {/* Imagery */}
          <SectionCard title="Imagery">
            <Field label="Style">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.imagery.style}
                placeholder="e.g. duotone, editorial photography"
                onChange={(e) =>
                  setDraft({ ...draft, imagery: { ...draft.imagery, style: e.target.value } })
                }
              />
            </Field>
            <Field label="Treatments">
              <StringListEditor
                value={draft.imagery.treatments}
                onChange={(treatments) =>
                  setDraft({ ...draft, imagery: { ...draft.imagery, treatments } })
                }
                placeholder="e.g. rounded corners"
              />
            </Field>
            <Field label="Sample references">
              <StringListEditor
                value={draft.imagery.samples}
                onChange={(samples) =>
                  setDraft({ ...draft, imagery: { ...draft.imagery, samples } })
                }
                placeholder="URL or note"
              />
            </Field>
          </SectionCard>

          {/* Narrative */}
          <SectionCard title="Narrative">
            <Field label="Audience">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.narrative.audience}
                onChange={(e) =>
                  setDraft({ ...draft, narrative: { ...draft.narrative, audience: e.target.value } })
                }
              />
            </Field>
            <Field label="Positioning">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.narrative.positioning}
                onChange={(e) =>
                  setDraft({ ...draft, narrative: { ...draft.narrative, positioning: e.target.value } })
                }
              />
            </Field>
            <Field label="One-liner">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.narrative.oneLiner}
                onChange={(e) =>
                  setDraft({ ...draft, narrative: { ...draft.narrative, oneLiner: e.target.value } })
                }
              />
            </Field>
            <Field label="Long-form narrative ref" hint="Pointer to external long-form brand narrative.">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.narrativeRef}
                onChange={(e) => setDraft({ ...draft, narrativeRef: e.target.value })}
              />
            </Field>
          </SectionCard>

          {/* Voice & tone */}
          <SectionCard title="Voice & tone">
            <Field label="Audience">
              <input
                className={`${brandKitInputCls} w-full`}
                value={draft.voice.audience}
                onChange={(e) =>
                  setDraft({ ...draft, voice: { ...draft.voice, audience: e.target.value } })
                }
              />
            </Field>
            <Field label="Tone attributes">
              <StringListEditor
                value={draft.voice.toneAttributes}
                onChange={(toneAttributes) =>
                  setDraft({ ...draft, voice: { ...draft.voice, toneAttributes } })
                }
                placeholder="e.g. confident"
              />
            </Field>
            <Field label="Do / Don't">
              <DosAndDontsEditor
                value={draft.voice.dosAndDonts}
                onChange={(dosAndDonts) =>
                  setDraft({ ...draft, voice: { ...draft.voice, dosAndDonts } })
                }
              />
            </Field>
            <Field label="Preferred lexicon">
              <StringListEditor
                value={draft.voice.preferred}
                onChange={(preferred) =>
                  setDraft({ ...draft, voice: { ...draft.voice, preferred } })
                }
              />
            </Field>
            <Field label="Blacklist lexicon">
              <StringListEditor
                value={draft.voice.blacklist}
                onChange={(blacklist) =>
                  setDraft({ ...draft, voice: { ...draft.voice, blacklist } })
                }
              />
            </Field>
            <Field label="Boilerplate">
              <textarea
                className={`${brandKitInputCls} w-full`}
                rows={2}
                value={draft.voice.boilerplate}
                onChange={(e) =>
                  setDraft({ ...draft, voice: { ...draft.voice, boilerplate: e.target.value } })
                }
              />
            </Field>
            <Field label="Proof points">
              <StringListEditor
                value={draft.voice.proofPoints}
                onChange={(proofPoints) =>
                  setDraft({ ...draft, voice: { ...draft.voice, proofPoints } })
                }
              />
            </Field>
          </SectionCard>

          {/* Prose body */}
          <SectionCard title="Prose body" description="Markdown appended after the token frontmatter.">
            <textarea
              className={`${brandKitInputCls} h-40 w-full font-mono text-xs`}
              value={draft.body}
              onChange={(e) => setDraft({ ...draft, body: e.target.value })}
              spellCheck={false}
            />
          </SectionCard>

          {/* Assets */}
          <SectionCard
            title="Logos & fonts"
            description="Uploads require a licensing acknowledgement."
          >
            <AssetUploader
              companyId={companyId}
              kitId={activeKit.id}
              assets={assets}
              primaryHex={primaryHex}
              onChanged={() =>
                queryClient.invalidateQueries({
                  queryKey: queryKeys.brandKits.assets(companyId, activeKit.id),
                })
              }
            />
          </SectionCard>
        </>
      )}

      {/* Save bar */}
      <div className="sticky bottom-0 flex items-center gap-2 border-t border-border bg-background/95 py-3 backdrop-blur">
        <Button
          size="sm"
          disabled={
            !dirty || saveMutation.isPending || validationErrors.length > 0 || view === "raw"
          }
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving…" : "Save brand kit"}
        </Button>
        {view === "raw" && (
          <span className="text-xs text-muted-foreground">Apply raw source to save.</span>
        )}
        {!dirty && view !== "raw" && !saveMutation.isPending && (
          <span className="text-xs text-muted-foreground">No unsaved changes</span>
        )}
        {dirty && validationErrors.length === 0 && (
          <span className="text-xs text-amber-600">Unsaved changes</span>
        )}
        {saveMutation.isSuccess && !dirty && (
          <span className="flex items-center gap-1 text-xs text-emerald-600">
            <Check className="h-3.5 w-3.5" /> Saved
          </span>
        )}
        {saveMutation.isError && (
          <span className="text-xs text-destructive">
            {saveMutation.error instanceof Error ? saveMutation.error.message : "Save failed"}
          </span>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-editors
// ---------------------------------------------------------------------------

function TypeScaleEditor({
  value,
  onChange,
}: {
  value: TypeStyleDraft[];
  onChange: (next: TypeStyleDraft[]) => void;
}) {
  const set = (i: number, patch: Partial<TypeStyleDraft>) => {
    const next = value.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  return (
    <div className="space-y-2">
      {value.map((s, i) => (
        <div key={i} className="space-y-1.5 rounded border border-border/60 p-2">
          <div className="flex items-center gap-1.5">
            <input
              className={`${brandKitInputCls} w-40 font-mono`}
              value={s.name}
              placeholder="style name (h1)"
              onChange={(e) => set(i, { name: e.target.value })}
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="ml-auto text-xs text-muted-foreground"
              onClick={() => onChange(value.filter((_, j) => j !== i))}
            >
              Remove
            </Button>
          </div>
          <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-5">
            <input className={brandKitInputCls} value={s.family} placeholder="family" onChange={(e) => set(i, { family: e.target.value })} />
            <input className={brandKitInputCls} value={s.size} placeholder="size" onChange={(e) => set(i, { size: e.target.value })} />
            <input className={brandKitInputCls} value={s.weight} placeholder="weight" onChange={(e) => set(i, { weight: e.target.value })} />
            <input className={brandKitInputCls} value={s.lineHeight} placeholder="line-height" onChange={(e) => set(i, { lineHeight: e.target.value })} />
            <input className={brandKitInputCls} value={s.letterSpacing} placeholder="letter-spacing" onChange={(e) => set(i, { letterSpacing: e.target.value })} />
          </div>
        </div>
      ))}
      <Button
        type="button"
        size="sm"
        variant="outline"
        onClick={() =>
          onChange([
            ...value,
            { name: "", family: "", size: "", weight: "", lineHeight: "", letterSpacing: "" },
          ])
        }
      >
        Add type style
      </Button>
    </div>
  );
}

function DosAndDontsEditor({
  value,
  onChange,
}: {
  value: Array<{ do: string; dont: string }>;
  onChange: (next: Array<{ do: string; dont: string }>) => void;
}) {
  const set = (i: number, patch: Partial<{ do: string; dont: string }>) => {
    const next = value.slice();
    next[i] = { ...next[i], ...patch };
    onChange(next);
  };
  return (
    <div className="space-y-1.5">
      {value.map((r, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <input className={`${brandKitInputCls} flex-1`} value={r.do} placeholder="Do…" onChange={(e) => set(i, { do: e.target.value })} />
          <input className={`${brandKitInputCls} flex-1`} value={r.dont} placeholder="Don't…" onChange={(e) => set(i, { dont: e.target.value })} />
          <Button type="button" size="sm" variant="ghost" className="text-xs text-muted-foreground" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </Button>
        </div>
      ))}
      <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, { do: "", dont: "" }])}>
        Add pair
      </Button>
    </div>
  );
}

function BrandPreview({
  draft,
  bg,
  logo,
}: {
  draft: Draft;
  bg: string;
  logo?: BrandKitAssetRef;
}) {
  const primary = roleSolid(draft.colors.primary) ?? "#6366f1";
  const accent = roleSolid(draft.colors.accent) ?? primary;
  const text = readableTextColor(bg);
  const onPrimary = readableTextColor(primary);
  const family = draft.families.find(([, v]) => v.trim())?.[1] || undefined;
  const radiusPairs = cleanRecord(draft.rounded) ?? {};
  const radius = radiusPairs["md"] ?? radiusPairs["default"] ?? Object.values(radiusPairs)[0] ?? "8px";
  const roles: Array<[string, string | null]> = [
    ["primary", roleSolid(draft.colors.primary)],
    ["secondary", roleSolid(draft.colors.secondary)],
    ["accent", roleSolid(draft.colors.accent)],
    ["neutral", roleSolid(draft.colors.neutral)],
  ];
  return (
    <div
      className="space-y-3 rounded-md border border-border p-4"
      style={{ background: bg, color: text, fontFamily: family }}
    >
      <div className="flex items-center gap-3">
        {logo && (
          <img src={logo.contentPath} alt="Logo" className="h-8 w-8 object-contain" />
        )}
        <div className="text-lg font-semibold">{draft.name || "Brand name"}</div>
      </div>
      {draft.narrative.oneLiner && <div className="text-sm opacity-80">{draft.narrative.oneLiner}</div>}
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          style={{ background: primary, color: onPrimary, borderRadius: radius }}
          className="px-3 py-1.5 text-sm font-medium"
        >
          Primary action
        </button>
        <button
          type="button"
          style={{ borderColor: accent, color: accent, borderRadius: radius, borderWidth: 1 }}
          className="px-3 py-1.5 text-sm font-medium"
        >
          Secondary
        </button>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {roles
          .filter((r): r is [string, string] => r[1] !== null)
          .map(([role, hex]) => (
            <div key={role} className="flex flex-col items-center gap-1">
              <span
                className="inline-block h-8 w-8 rounded border border-black/10"
                style={{ background: hex }}
                title={`${role} ${hex}`}
              />
              <span className="text-[10px] capitalize opacity-70">{role}</span>
            </div>
          ))}
      </div>
    </div>
  );
}

const LICENSE_ACK =
  "I confirm I own or have the rights/license to use this asset for this company's brand.";

function AssetUploader({
  companyId,
  kitId,
  assets,
  primaryHex,
  onChanged,
}: {
  companyId: string;
  kitId: string;
  assets: BrandKitAssetRef[];
  primaryHex: string | null;
  onChanged: () => void;
}) {
  const [logoRole, setLogoRole] = useState("logo_primary");
  const [fontFamily, setFontFamily] = useState("");
  const [fontWeight, setFontWeight] = useState("400");
  const [licensed, setLicensed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const uploadMutation = useMutation({
    mutationFn: ({ file, role }: { file: File; role: string }) =>
      brandKitsApi.uploadAsset(companyId, kitId, file, role),
    onSuccess: () => {
      setError(null);
      onChanged();
    },
    onError: (e) => setError(e instanceof Error ? e.message : "Upload failed"),
  });

  const detachMutation = useMutation({
    mutationFn: (assetId: string) => brandKitsApi.detachAsset(companyId, kitId, assetId),
    onSuccess: onChanged,
  });

  function handleLogo(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.currentTarget.value = "";
    if (!file) return;
    if (!licensed) return setError("Acknowledge licensing before uploading.");
    uploadMutation.mutate({ file, role: logoRole });
  }

  function handleFont(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0] ?? null;
    e.currentTarget.value = "";
    if (!file) return;
    if (!licensed) return setError("Acknowledge licensing before uploading.");
    if (!fontFamily.trim()) return setError("Enter a font family before uploading.");
    if (!fontWeight.trim()) return setError("Enter a font weight before uploading.");
    uploadMutation.mutate({
      file,
      role: `font:${fontFamily.trim()}:${fontWeight.trim()}`,
    });
  }

  const isImage = (ct: string) => ct.startsWith("image/");

  return (
    <div className="space-y-3">
      {/* Licensing acknowledgement gates every upload. */}
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={licensed}
          onChange={(e) => setLicensed(e.target.checked)}
          className="mt-0.5"
        />
        {LICENSE_ACK}
      </label>

      <Field label="Logo upload" hint="PNG, JPEG, WEBP, GIF, or SVG.">
        <div className="flex flex-wrap items-center gap-2">
          <select
            className={`${brandKitInputCls} w-36`}
            value={logoRole}
            onChange={(e) => setLogoRole(e.target.value)}
          >
            <option value="logo_primary">logo_primary</option>
            <option value="logo_mark">logo_mark</option>
            <option value="logo_mono">logo_mono</option>
          </select>
          <input
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/svg+xml"
            disabled={!licensed || uploadMutation.isPending}
            onChange={handleLogo}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs disabled:opacity-50"
          />
        </div>
      </Field>

      <Field label="Font upload" hint="WOFF, WOFF2, TTF, or OTF.">
        <div className="flex flex-wrap items-center gap-2">
          <input
            className={`${brandKitInputCls} w-40`}
            value={fontFamily}
            placeholder="family (Inter)"
            onChange={(e) => setFontFamily(e.target.value)}
          />
          <input
            className={`${brandKitInputCls} w-24`}
            value={fontWeight}
            placeholder="weight"
            onChange={(e) => setFontWeight(e.target.value)}
          />
          <input
            type="file"
            accept=".woff,.woff2,.ttf,.otf,font/woff,font/woff2,font/ttf,font/otf"
            disabled={!licensed || uploadMutation.isPending}
            onChange={handleFont}
            className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-muted file:px-2.5 file:py-1 file:text-xs disabled:opacity-50"
          />
        </div>
      </Field>

      {error && <span className="block text-xs text-destructive">{error}</span>}
      {uploadMutation.isPending && (
        <span className="block text-xs text-muted-foreground">Uploading…</span>
      )}

      {assets.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium text-muted-foreground">Bound assets</div>
          {assets.map((a) => (
            <div
              key={a.assetId}
              className="flex items-center gap-2 rounded border border-border/60 px-2 py-1.5 text-xs"
            >
              {isImage(a.contentType) ? (
                <img
                  src={a.contentPath}
                  alt={a.role}
                  className="h-8 w-8 rounded border border-border object-contain"
                  style={{ background: a.role.startsWith("logo") && primaryHex ? "#fff" : undefined }}
                />
              ) : (
                <span className="inline-flex h-8 w-8 items-center justify-center rounded border border-border font-mono">
                  Aa
                </span>
              )}
              <span className="font-mono">{a.role}</span>
              <span className="truncate text-muted-foreground">{a.originalFilename}</span>
              <Button
                size="sm"
                variant="ghost"
                className="ml-auto text-xs text-muted-foreground"
                disabled={detachMutation.isPending}
                onClick={() => detachMutation.mutate(a.assetId)}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
