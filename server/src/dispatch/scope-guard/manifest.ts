import { z } from "zod";
import { ScopeGuardRuleSchema, type ScopeGuardRule } from "./taxonomy.js";

export const MANIFEST_VERSION = 1;

export const ScopeGuardManifestSchema = z.object({
  version: z.literal(1),
  issueId: z.string(),
  generatedAt: z.string().datetime(),
  rules: z.array(ScopeGuardRuleSchema),
});

export type ScopeGuardManifest = z.infer<typeof ScopeGuardManifestSchema>;

export type DispatchInput = {
  issueId: string;
  scopeGuard?: {
    rules?: unknown[];
  } | null;
  generatedAt?: string;
};

function parseRulesFromInput(rawRules: unknown[] | undefined): ScopeGuardRule[] {
  if (!rawRules || !Array.isArray(rawRules) || rawRules.length === 0) {
    return [];
  }

  const parsed: ScopeGuardRule[] = [];
  for (const raw of rawRules) {
    const result = ScopeGuardRuleSchema.safeParse(raw);
    if (result.success) {
      parsed.push(result.data);
    }
    // Unknown/invalid rules are silently dropped — old dispatch bodies without
    // structured scope_guard yield rules:[] rather than a hard error.
  }
  return parsed;
}

function sortRules(rules: ScopeGuardRule[]): ScopeGuardRule[] {
  // Sort by class name for deterministic ordering
  return [...rules].sort((a, b) => a.class.localeCompare(b.class));
}

export function buildManifest(input: DispatchInput): ScopeGuardManifest {
  const rawRules = input.scopeGuard?.rules;
  const rules = sortRules(parseRulesFromInput(rawRules));

  const manifest: ScopeGuardManifest = {
    version: MANIFEST_VERSION,
    issueId: input.issueId,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    rules,
  };

  return manifest;
}

export function serializeManifest(manifest: ScopeGuardManifest): string {
  // Deterministic JSON: stable field order from the ScopeGuardManifest type
  const ordered: ScopeGuardManifest = {
    version: manifest.version,
    issueId: manifest.issueId,
    generatedAt: manifest.generatedAt,
    rules: manifest.rules,
  };
  return JSON.stringify(ordered, null, 2) + "\n";
}

export function parseManifest(raw: unknown): ScopeGuardManifest {
  return ScopeGuardManifestSchema.parse(raw);
}
