import type { AdapterModel } from "@paperclipai/adapter-utils";

type ClaudeModelFamily = "opus" | "sonnet" | "haiku";

type ClaudeFamilyDefinition = {
  family: ClaudeModelFamily;
  envKey: string;
  fallbackId: string;
  fallbackLabel: string;
  configuredLabel: string;
};

const CLAUDE_FAMILY_DEFINITIONS: readonly ClaudeFamilyDefinition[] = [
  {
    family: "opus",
    envKey: "ANTHROPIC_DEFAULT_OPUS_MODEL",
    fallbackId: "claude-opus-4-6",
    fallbackLabel: "Claude Opus 4.6",
    configuredLabel: "Claude Opus default",
  },
  {
    family: "sonnet",
    envKey: "ANTHROPIC_DEFAULT_SONNET_MODEL",
    fallbackId: "claude-sonnet-4-6",
    fallbackLabel: "Claude Sonnet 4.6",
    configuredLabel: "Claude Sonnet default",
  },
  {
    family: "haiku",
    envKey: "ANTHROPIC_DEFAULT_HAIKU_MODEL",
    fallbackId: "claude-haiku-4-6",
    fallbackLabel: "Claude Haiku 4.6",
    configuredLabel: "Claude Haiku default",
  },
] as const;

const CLAUDE_LEGACY_MODELS: readonly AdapterModel[] = [
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asTrimmedString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function configuredEnv(settings: Record<string, unknown> | null): Record<string, unknown> {
  return asRecord(settings?.env) ?? {};
}

function inferPreferredFamily(settings: Record<string, unknown> | null): ClaudeModelFamily {
  const configured = asTrimmedString(settings?.model)?.toLowerCase();
  if (configured === "opus" || configured === "sonnet" || configured === "haiku") {
    return configured;
  }
  if (configured?.includes("opus")) return "opus";
  if (configured?.includes("haiku")) return "haiku";
  if (configured?.includes("sonnet")) return "sonnet";
  return "sonnet";
}

function orderedFamilies(preferred: ClaudeModelFamily): ClaudeFamilyDefinition[] {
  return [
    ...CLAUDE_FAMILY_DEFINITIONS.filter((entry) => entry.family === preferred),
    ...CLAUDE_FAMILY_DEFINITIONS.filter((entry) => entry.family !== preferred),
  ];
}

function dedupeModels(models: readonly AdapterModel[]): AdapterModel[] {
  const deduped: AdapterModel[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const id = model.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    deduped.push({ id, label: model.label.trim() || id });
  }
  return deduped;
}

function resolveConfiguredFamilyModel(
  definition: ClaudeFamilyDefinition,
  settings: Record<string, unknown> | null,
): AdapterModel {
  const env = configuredEnv(settings);
  const configuredId = asTrimmedString(env[definition.envKey]);
  if (!configuredId || configuredId === definition.fallbackId) {
    return {
      id: definition.fallbackId,
      label: definition.fallbackLabel,
    };
  }

  return {
    id: configuredId,
    label: `${definition.configuredLabel} (${configuredId})`,
  };
}

export function resolveClaudeModelsFromSettings(
  settings: Record<string, unknown> | null,
): AdapterModel[] {
  const preferred = inferPreferredFamily(settings);
  const primaryModels = orderedFamilies(preferred).map((definition) =>
    resolveConfiguredFamilyModel(definition, settings),
  );
  return dedupeModels([...primaryModels, ...CLAUDE_LEGACY_MODELS]);
}

export const DEFAULT_CLAUDE_MODELS = resolveClaudeModelsFromSettings(null);