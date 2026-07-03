import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { AlertCircle, KeyRound, Plus } from "lucide-react";
import type { CompanySecret, EnvBinding } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useOptionalToastActions } from "@/context/ToastContext";
import { EnvironmentVariableRow } from "./Row";
import { parseDotenv } from "./parse-dotenv";
import {
  computeDuplicateNames,
  computeRowHealth,
  emptyRow,
  envKeyFromSecretName,
  rowsFromValue,
  validateName,
  valueFromRows,
  type EnvRow,
} from "./model";

const DEFAULT_RESERVED_PREFIXES = ["PAPERCLIP_"];

const DEFAULT_HINT =
  "Set the KEY to the env var name the process expects, for example GH_TOKEN. Choose a secret to resolve a stored value at run start. PAPERCLIP_* variables are injected automatically.";

function normalizedEnvKey(value: Record<string, EnvBinding> | null | undefined): string {
  if (!value || typeof value !== "object") return "";
  const entries = Object.entries(value)
    .map(([name, binding]) => {
      if (typeof binding === "string") {
        return [name, { type: "plain", value: binding }] as const;
      }
      if (binding?.type === "secret_ref") {
        return [
          name,
          {
            type: "secret_ref",
            secretId: typeof binding.secretId === "string" ? binding.secretId : "",
            version: typeof binding.version === "number" ? binding.version : "latest",
          },
        ] as const;
      }
      if (binding?.type === "plain") {
        return [
          name,
          { type: "plain", value: typeof binding.value === "string" ? binding.value : "" },
        ] as const;
      }
      return [name, { type: "plain", value: "" }] as const;
    })
    .sort(([left], [right]) => left.localeCompare(right));
  return JSON.stringify(entries);
}

export interface EnvironmentVariablesEditorProps {
  value: Record<string, EnvBinding>;
  onChange: (next: Record<string, EnvBinding> | undefined) => void;
  secrets: readonly CompanySecret[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Optional "Recently used" picker group + quick-bind chips. */
  recentlyUsedSecrets?: readonly CompanySecret[];
  /** Read-only rendering. */
  disabled?: boolean;
  /** Prefixes flagged as reserved/auto-provided. Default `["PAPERCLIP_"]`. */
  reservedPrefixes?: readonly string[];
  /** Context-specific hint line. `null` hides the default copy; omit for default. */
  footerHint?: ReactNode | null;
}

export function EnvironmentVariablesEditor({
  value,
  onChange,
  secrets,
  onCreateSecret,
  recentlyUsedSecrets,
  disabled,
  reservedPrefixes = DEFAULT_RESERVED_PREFIXES,
  footerHint,
}: EnvironmentVariablesEditorProps) {
  const toast = useOptionalToastActions();
  const [rows, setRows] = useState<EnvRow[]>(() => rowsFromValue(value));
  // Seeded (already-committed) names are "touched" so a saved reserved/invalid
  // var surfaces its message on load; freshly-typed rows wait for blur (§6.2).
  const [touchedNames, setTouchedNames] = useState<ReadonlySet<string>>(
    () => new Set(rowsFromValue(value).map((row) => row.name.trim()).filter(Boolean)),
  );
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string; field: "name" | "value" } | null>(null);
  const valueRef = useRef(value);
  const emittingRef = useRef(false);

  function adoptExternalValue(nextValue: Record<string, EnvBinding>) {
    valueRef.current = nextValue;
    const nextRows = rowsFromValue(nextValue);
    setRows(nextRows);
    setTouchedNames((prev) => {
      const next = new Set(prev);
      for (const row of nextRows) {
        const name = row.name.trim();
        if (name) next.add(name);
      }
      return next;
    });
  }

  // Controlled sync: adopt real external value changes, but preserve row ids
  // across semantically-equivalent save/refetch echoes so focused inputs do not
  // remount while the user is typing.
  useEffect(() => {
    const incomingValueKey = normalizedEnvKey(value);
    const currentValueKey = normalizedEnvKey(valueRef.current);
    if (emittingRef.current) {
      emittingRef.current = false;
    }
    if (incomingValueKey === currentValueKey) {
      valueRef.current = value;
      return;
    }
    if (value !== valueRef.current) {
      adoptExternalValue(value);
    }
  }, [value]);

  function commit(nextRows: EnvRow[]) {
    setRows(nextRows);
    const nextValue = valueFromRows(nextRows);
    if (normalizedEnvKey(nextValue) === normalizedEnvKey(valueRef.current)) return;
    emittingRef.current = true;
    valueRef.current = nextValue ?? {};
    onChange(nextValue);
  }

  function patchRow(id: string, patch: Partial<EnvRow>) {
    commit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    commit(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    const row = emptyRow();
    setRows([...rows, row]);
    setPendingFocus({ rowId: row.id, field: "name" });
  }

  function markTouched(id: string) {
    const rowName = rows.find((row) => row.id === id)?.name.trim();
    if (!rowName) return;
    setTouchedNames((prev) => {
      if (prev.has(rowName)) return prev;
      const next = new Set(prev);
      next.add(rowName);
      return next;
    });
  }

  function bulkImport(text: string, targetRowId: string): boolean {
    const pairs = parseDotenv(text);
    if (pairs.length === 0) return false;
    // Drop the empty row that received the paste, then upsert each pair.
    const working = rows.filter((row) => row.id !== targetRowId);
    for (const { key, value: pairValue } of pairs) {
      const existing = working.find((row) => row.name.trim() === key);
      if (existing) {
        existing.name = key;
        existing.source = "text";
        existing.textValue = pairValue;
        existing.secretId = "";
        existing.sensitiveDismissed = false;
      } else {
        working.push({ ...emptyRow(), name: key, textValue: pairValue });
      }
    }
    commit(working);
    toast?.pushToast({ title: `Imported ${pairs.length} variable${pairs.length === 1 ? "" : "s"}`, tone: "success" });
    return true;
  }

  function bindRecentSecret(secret: CompanySecret) {
    const next = rows.map((row) => ({ ...row }));
    const trailing = next[next.length - 1];
    let target: EnvRow;
    if (trailing && !trailing.name && !trailing.textValue && !trailing.secretId) {
      target = trailing;
    } else {
      target = emptyRow();
      next.push(target);
    }
    target.source = "secret";
    target.secretId = secret.id;
    target.version = "latest";
    if (!target.name) target.name = envKeyFromSecretName(secret.name);
    commit(next);
  }

  const duplicateNames = useMemo(() => computeDuplicateNames(rows), [rows]);

  const attentionCount = useMemo(
    () => rows.reduce((count, row) => (computeRowHealth(row, secrets) ? count + 1 : count), 0),
    [rows, secrets],
  );

  const quickBind = useMemo(() => {
    const boundIds = new Set(rows.filter((row) => row.source === "secret" && row.secretId).map((row) => row.secretId));
    return (recentlyUsedSecrets ?? [])
      .filter((secret) => secret.status === "active" && !boundIds.has(secret.id))
      .slice(0, 8);
  }, [recentlyUsedSecrets, rows]);

  const hasRows = rows.length > 0;
  const hint = footerHint === undefined ? DEFAULT_HINT : footerHint;

  return (
    <TooltipProvider>
      <div className="@container/env space-y-1.5">
      {attentionCount > 1 ? (
        <p className="inline-flex items-center gap-1.5 text-[11px] font-medium text-amber-700 dark:text-amber-400">
          <AlertCircle className="size-3.5" />
          {attentionCount} bindings need attention
        </p>
      ) : null}

      {hasRows ? (
        <>
          {/* Header (desktop only) */}
          <div className="hidden gap-x-1.5 @[40rem]/env:grid @[40rem]/env:grid-cols-[minmax(160px,2fr)_minmax(240px,3fr)_32px]">
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Name</span>
            <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Value</span>
            <span />
          </div>

          {rows.map((row, index) => {
            const issue = validateName(row.name, duplicateNames, reservedPrefixes);
            const touched = touchedNames.has(row.name.trim());
            return (
              <EnvironmentVariableRow
                key={row.id}
                row={row}
                isLast={index === rows.length - 1}
                secrets={secrets}
                recentlyUsedSecrets={recentlyUsedSecrets}
                disabled={disabled}
                nameIssue={issue}
                showNameIssue={touched}
                onPatch={(patch) => patchRow(row.id, patch)}
                onRemove={() => removeRow(row.id)}
                onNameBlur={() => markTouched(row.id)}
                onNamePaste={(text) => bulkImport(text, row.id)}
                onEnterInValueLast={addRow}
                onCreateSecret={onCreateSecret}
                onToast={(message) => toast?.pushToast({ title: message, tone: "success" })}
                focusRequest={pendingFocus?.rowId === row.id ? pendingFocus.field : null}
                onFocusConsumed={() => setPendingFocus(null)}
              />
            );
          })}
        </>
      ) : (
        <p className="text-sm text-muted-foreground">No environment variables</p>
      )}

      {/* Footer bar */}
      <div className="flex flex-wrap items-center justify-between gap-2 pt-0.5">
        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add variable
        </button>

        {quickBind.length > 0 && !disabled ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/70">
              <KeyRound className="size-3" />
              Recently used:
            </span>
            {quickBind.map((secret) => (
              <button
                key={secret.id}
                type="button"
                onClick={() => bindRecentSecret(secret)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-[11px] text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                title={`Bind ${secret.name}`}
              >
                + {secret.name}
              </button>
            ))}
          </div>
        ) : null}
      </div>

      {hint ? <p className="text-[11px] text-muted-foreground/70">{hint}</p> : null}
      </div>
    </TooltipProvider>
  );
}

export type { EnvRow } from "./model";
export { EnvironmentVariableRow } from "./Row";
export { SecretPicker } from "./SecretPicker";
export { CreateSecretPopover, ConvertToSecretPopover } from "./CreateSecretPopover";
export { parseDotenv, looksLikeDotenv } from "./parse-dotenv";
export { isSensitiveEnv } from "./sensitive";
