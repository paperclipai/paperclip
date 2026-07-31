/**
 * Typed work references for pipeline cases.
 *
 * Cases carry references to the actual work — a workspace folder, an external
 * URL, a linked issue — inside `fields` (and the dedicated `workspaceRef`
 * column). This module formalises those loosely-shaped values into a small
 * typed union so the case detail panel can render real links/chips instead of
 * dumping "[object Object]" or "Added details" into the plain field list.
 *
 * Detection is intentionally tolerant: references can arrive as explicit
 * `{ kind: "url", url }` records, as bare URL strings, or as records that simply
 * carry a tell-tale field (`url`, `issueId`, `path`). Anything we don't
 * recognise is left in the plain Details list untouched.
 */

export type WorkReference =
  | { id: string; kind: "workspace"; label: string; path: string | null; branch: string | null }
  | { id: string; kind: "url"; label: string; url: string }
  | { id: string; kind: "issue"; label: string; issueId: string | null; identifier: string | null };

interface ReferenceCaseInput {
  fields?: Record<string, unknown> | null;
  workspaceRef?: Record<string, unknown> | null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim());
}

function humanizeKey(key: string): string {
  return key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .replace(/\s+/g, " ")
    .replace(/^./, (char) => char.toUpperCase());
}

function normalizeKind(raw: unknown): WorkReference["kind"] | null {
  const kind = readString(raw)?.toLowerCase();
  if (!kind) return null;
  if (kind === "workspace" || kind === "folder" || kind === "workspace_folder" || kind === "file") return "workspace";
  if (kind === "url" || kind === "link" || kind === "external") return "url";
  if (kind === "issue" || kind === "task" || kind === "ticket") return "issue";
  return null;
}

function workspaceFromRecord(id: string, label: string, record: Record<string, unknown>): WorkReference {
  return {
    id,
    kind: "workspace",
    label,
    path:
      readString(record.path) ??
      readString(record.folder) ??
      readString(record.workspacePath) ??
      readString(record.name) ??
      readString(record.label),
    branch: readString(record.branch) ?? readString(record.ref),
  };
}

/** Parse a single `fields` entry into a typed reference, or null if it isn't one. */
function referenceFromField(key: string, value: unknown): WorkReference | null {
  const label = humanizeKey(key);

  const url = readString(value);
  if (url && isHttpUrl(url)) {
    return { id: key, kind: "url", label, url };
  }

  const record = readRecord(value);
  if (!record) return null;

  const explicitKind = normalizeKind(record.kind ?? record.type);

  // URL-shaped.
  const recordUrl = readString(record.url) ?? readString(record.href);
  if (explicitKind === "url" || (recordUrl && isHttpUrl(recordUrl))) {
    if (!recordUrl) return null;
    return { id: key, kind: "url", label: readString(record.label) ?? label, url: recordUrl };
  }

  // Issue-shaped.
  const issueId = readString(record.issueId) ?? readString(record.id);
  const identifier = readString(record.identifier) ?? readString(record.issueIdentifier);
  if (explicitKind === "issue" || ((issueId || identifier) && (record.issueId || record.issueIdentifier))) {
    return {
      id: key,
      kind: "issue",
      label: readString(record.title) ?? readString(record.label) ?? label,
      issueId,
      identifier,
    };
  }

  // Workspace-shaped.
  if (explicitKind === "workspace" || record.path || record.folder || record.workspacePath) {
    return workspaceFromRecord(key, readString(record.label) ?? label, record);
  }

  return null;
}

/**
 * Extract every typed work reference for a case, starting with the dedicated
 * `workspaceRef` column and then any reference-shaped `fields` entries.
 */
export function extractWorkReferences(caseItem: ReferenceCaseInput): WorkReference[] {
  const references: WorkReference[] = [];

  const workspaceRef = readRecord(caseItem.workspaceRef);
  if (workspaceRef && (workspaceRef.path || workspaceRef.folder || workspaceRef.workspacePath || workspaceRef.name)) {
    references.push(workspaceFromRecord("workspaceRef", "Workspace folder", workspaceRef));
  }

  for (const [key, value] of Object.entries(caseItem.fields ?? {})) {
    const reference = referenceFromField(key, value);
    if (reference) references.push(reference);
  }

  return references;
}

/**
 * The set of `fields` keys that render as typed references, so the plain
 * Details list can exclude them and avoid showing the same value twice.
 */
export function referenceFieldKeys(fields: Record<string, unknown> | null | undefined): Set<string> {
  const keys = new Set<string>();
  for (const [key, value] of Object.entries(fields ?? {})) {
    if (referenceFromField(key, value)) keys.add(key);
  }
  return keys;
}
