import type { CompanySecret, EnvBinding, SecretVersionSelector, UserSecretDefinition } from "@paperclipai/shared";

export type RowSource = "text" | "secret" | "user_secret";

/** Local, per-row UI state. Only a subset is emitted upward (see {@link valueFromRows}). */
export interface EnvRow {
  /** Stable local id — used as React key and to target popovers/undo. */
  id: string;
  name: string;
  source: RowSource;
  textValue: string;
  secretId: string;
  userSecretKey: string;
  required: boolean;
  version: SecretVersionSelector;
  /** Session-local dismissal of the sensitive-value suggestion (§6.6). */
  sensitiveDismissed?: boolean;
}

let rowCounter = 0;
export function nextRowId(): string {
  rowCounter += 1;
  return `env-row-${rowCounter}`;
}

export function emptyRow(source: RowSource = "text"): EnvRow {
  return {
    id: nextRowId(),
    name: "",
    source,
    textValue: "",
    secretId: "",
    userSecretKey: "",
    required: true,
    version: "latest",
  };
}

function isSecretRef(binding: unknown): binding is { type: "secret_ref"; secretId?: unknown; version?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "secret_ref"
  );
}

function isPlainObj(binding: unknown): binding is { type: "plain"; value?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "plain"
  );
}

function isUserSecretRef(
  binding: unknown,
): binding is { type: "user_secret_ref"; key?: unknown; version?: unknown; required?: unknown } {
  return (
    typeof binding === "object" &&
    binding !== null &&
    "type" in binding &&
    (binding as { type?: unknown }).type === "user_secret_ref"
  );
}

/** Build editor rows from the controlled value. No implicit trailing ghost row. */
export function rowsFromValue(value: Record<string, EnvBinding> | null | undefined): EnvRow[] {
  if (!value || typeof value !== "object") return [];
  return Object.entries(value).map(([name, binding]) => {
    if (typeof binding === "string") {
      return { ...emptyRow(), name, textValue: binding };
    }
    if (isSecretRef(binding)) {
      const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
      return {
        ...emptyRow(),
        name,
        source: "secret" as const,
        secretId: typeof binding.secretId === "string" ? binding.secretId : "",
        version,
      };
    }
    if (isUserSecretRef(binding)) {
      const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
      return {
        ...emptyRow(),
        name,
        source: "user_secret" as const,
        userSecretKey: typeof binding.key === "string" ? binding.key : "",
        required: binding.required !== false,
        version,
      };
    }
    if (isPlainObj(binding)) {
      return {
        ...emptyRow(),
        name,
        source: "text" as const,
        textValue: typeof binding.value === "string" ? binding.value : "",
      };
    }
    return { ...emptyRow(), name };
  });
}

/**
 * Emit semantics (plan §4/§6.1): rows with empty (trimmed) names are dropped;
 * secret rows without a chosen secret are incomplete and dropped; an empty
 * result emits `undefined`. Duplicate names are last-writer-wins (unchanged).
 */
export function valueFromRows(rows: EnvRow[]): Record<string, EnvBinding> | undefined {
  const record: Record<string, EnvBinding> = {};
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    if (row.source === "secret") {
      if (!row.secretId) continue; // incomplete ref — not emitted
      record[name] = { type: "secret_ref", secretId: row.secretId, version: row.version };
    } else if (row.source === "user_secret") {
      const key = row.userSecretKey.trim();
      if (!key) continue;
      record[name] = {
        type: "user_secret_ref",
        key,
        version: row.version,
        required: row.required,
      };
    } else {
      record[name] = { type: "plain", value: row.textValue };
    }
  }
  return Object.keys(record).length > 0 ? record : undefined;
}

export const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type NameIssueLevel = "error" | "warn";
export interface NameIssue {
  level: NameIssueLevel;
  message: string;
}

/**
 * Validate a single row's name given the full set of names (for duplicate
 * detection). Returns null when the name is empty (not yet an error) or valid.
 */
export function validateName(
  name: string,
  duplicateNames: ReadonlySet<string>,
  reservedPrefixes: readonly string[],
): NameIssue | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (!ENV_NAME_RE.test(trimmed)) {
    return { level: "error", message: "Invalid name — use letters, digits and _" };
  }
  if (duplicateNames.has(trimmed)) {
    return { level: "error", message: "Duplicate name" };
  }
  for (const prefix of reservedPrefixes) {
    if (prefix && trimmed.startsWith(prefix)) {
      return { level: "warn", message: "Reserved prefix — provided automatically and may be overridden" };
    }
  }
  return null;
}

/** Names that appear on more than one row (trimmed, non-empty). */
export function computeDuplicateNames(rows: EnvRow[]): Set<string> {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const name = row.name.trim();
    if (!name) continue;
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  const dupes = new Set<string>();
  for (const [name, count] of counts) {
    if (count > 1) dupes.add(name);
  }
  return dupes;
}

/**
 * Pure decision for a source switch (§6.3), extracted so the value-preserving
 * behaviour is unit-testable without driving the Radix menu.
 */
export type SourceSwitchPlan =
  | { kind: "noop" }
  /** Text → Secret with a non-empty value: never discard it — open Store-as-secret. */
  | { kind: "open-store"; name: string; value: string }
  /** Text → Secret with an empty value: switch and open the picker. */
  | { kind: "to-secret" }
  /** Secret → Text: clear the ref; offer undo when a secret was bound. */
  | { kind: "to-text"; undoFrom: EnvRow | null };

export function planSourceSwitch(row: EnvRow, next: RowSource): SourceSwitchPlan {
  if (next === row.source) return { kind: "noop" };
  if (next === "secret") {
    if (row.textValue.trim()) {
      return { kind: "open-store", name: secretNameFromKey(row.name) || "secret", value: row.textValue };
    }
    return { kind: "to-secret" };
  }
  return { kind: "to-text", undoFrom: row.secretId ? { ...row } : null };
}

export interface SecretHealth {
  level: "error" | "warn";
  message: string;
  /** Short label for the summary line at the top of the editor. */
  kind: "missing" | "disabled";
}

/** Per-row secret-binding health (plan §6.8). Null when healthy or not a bound ref. */
export function computeRowHealth(row: EnvRow, secrets: readonly CompanySecret[]): SecretHealth | null {
  if (row.source !== "secret" || !row.secretId) return null;
  const secret = secrets.find((candidate) => candidate.id === row.secretId);
  if (!secret) {
    return {
      level: "error",
      kind: "missing",
      message: "This secret no longer exists — runs will fail until you rebind.",
    };
  }
  if (secret.status !== "active") {
    return {
      level: "warn",
      kind: "disabled",
      message: "Runs will fail until re-enabled or rebound.",
    };
  }
  return null;
}

/** Per-row user-secret health. Null when healthy or not a bound user-secret ref. */
export function computeUserSecretRowHealth(
  row: EnvRow,
  definitions: readonly UserSecretDefinition[] | undefined,
): SecretHealth | null {
  if (row.source !== "user_secret" || !row.userSecretKey || !definitions?.length) return null;
  const definition = definitions.find((candidate) => candidate.key === row.userSecretKey);
  if (!definition) {
    return {
      level: "error",
      kind: "missing",
      message: "This user secret definition no longer exists — runs will fail until you rebind.",
    };
  }
  if (definition.status !== "active") {
    return {
      level: "warn",
      kind: "disabled",
      message: "Runs will fail until this user secret definition is re-enabled or rebound.",
    };
  }
  return null;
}

/** Suggest a `lower_snake` secret name from an env KEY (plan §6.5). */
export function secretNameFromKey(key: string): string {
  return key
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}

/** Suggest an env KEY (UPPER_SNAKE) from a secret name (for quick-bind). */
export function envKeyFromSecretName(name: string): string {
  return name
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
}
