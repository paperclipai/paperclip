export const PORTABLE_CATALOG_PROVENANCE_STRING_KEYS = [
  "sourceRef",
  "originHash",
  "catalogId",
  "catalogKey",
  "catalogKind",
  "catalogCategory",
  "catalogPath",
  "packageName",
  "packageVersion",
  "originVersion",
  "installedHash",
  "userModifiedAt",
  "updateHoldReason",
  "auditVerdict",
  "auditScannedAt",
  "auditScanVersion",
] as const;

function asCatalogString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function readCatalogStringList(value: unknown) {
  if (!Array.isArray(value)) return null;
  const entries = value.map((entry) => asCatalogString(entry)).filter((entry): entry is string => Boolean(entry));
  return entries.length === value.length ? entries : null;
}

function isCatalogRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readPortableCatalogProvenance(
  metadata: Record<string, unknown> | null,
  canonicalKey: string | null = null,
) {
  const paperclip = isCatalogRecord(metadata?.paperclip) ? metadata.paperclip : null;
  const catalog = isCatalogRecord(paperclip?.catalog) ? paperclip.catalog : null;
  if (!catalog) return null;

  const sourceRef = asCatalogString(catalog.sourceRef) ?? asCatalogString(catalog.originHash);
  const normalized: Record<string, unknown> = {
    ...(canonicalKey ? { skillKey: canonicalKey } : {}),
    sourceKind: "catalog",
  };
  const catalogSkillKey = asCatalogString(catalog.skillKey);
  if (!canonicalKey && catalogSkillKey) normalized.skillKey = catalogSkillKey;

  for (const key of PORTABLE_CATALOG_PROVENANCE_STRING_KEYS) {
    if (key === "sourceRef") continue;
    const value = asCatalogString(catalog[key]);
    if (value) normalized[key] = value;
  }
  if (sourceRef && !normalized.originHash) normalized.originHash = sourceRef;
  const auditCodes = readCatalogStringList(catalog.auditCodes);
  if (auditCodes) normalized.auditCodes = auditCodes;

  return {
    sourceRef,
    metadata: normalized,
  };
}
