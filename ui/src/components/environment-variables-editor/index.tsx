import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { flushSync } from "react-dom";
import { AlertCircle, KeyRound, Plus, RotateCcw, Save, UserRound } from "lucide-react";
import type { CompanySecret, EnvBinding, UserSecretDefinition } from "@paperclipai/shared";
import { cn } from "@/lib/utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { useOptionalToastActions } from "@/context/ToastContext";
import { EnvironmentVariableRow } from "./Row";
import { parseDotenv } from "./parse-dotenv";
import {
  computeDuplicateNames,
  computeRowHealth,
  computeUserSecretRowHealth,
  emptyRow,
  envKeyFromSecretName,
  rowsFromValue,
  validateName,
  valueFromRows,
  type EnvRow,
} from "./model";
import type { EnvironmentVariableDirtyFields } from "./Row";

const DEFAULT_RESERVED_PREFIXES = ["PAPERCLIP_"];

const DEFAULT_HINT =
  "Set the KEY to the env var name the process expects, for example GH_TOKEN. Choose a secret to resolve a stored value at run start. PAPERCLIP_* variables are injected automatically.";

// Canonical entries for dirty comparison. Must mirror the emit semantics of
// valueFromRows (trimmed names, incomplete refs dropped, last-writer-wins on
// trimmed duplicates) — otherwise a saved value that round-trips lossily shows
// a phantom "Unsaved changes" banner the moment the form opens.
function normalizedEnvEntries(
  value: Record<string, EnvBinding> | null | undefined,
): Array<[string, Record<string, unknown>]> {
  if (!value || typeof value !== "object") return [];
  const byName = new Map<string, Record<string, unknown>>();
  for (const [rawName, binding] of Object.entries(value)) {
    const name = rawName.trim();
    if (!name) continue;
    if (typeof binding === "string") {
      byName.set(name, { type: "plain", value: binding });
    } else if (binding?.type === "secret_ref") {
      const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
      if (!secretId) continue; // incomplete ref — never emitted by the editor
      byName.set(name, {
        type: "secret_ref",
        secretId,
        version: typeof binding.version === "number" ? binding.version : "latest",
      });
    } else if (binding?.type === "user_secret_ref") {
      const key = typeof binding.key === "string" ? binding.key.trim() : "";
      if (!key) continue; // incomplete ref — never emitted by the editor
      byName.set(name, {
        type: "user_secret_ref",
        key,
        version: typeof binding.version === "number" ? binding.version : "latest",
        required: binding.required !== false,
      });
    } else if (binding?.type === "plain") {
      byName.set(name, { type: "plain", value: typeof binding.value === "string" ? binding.value : "" });
    } else {
      byName.set(name, { type: "plain", value: "" });
    }
  }
  return [...byName.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function normalizedEnvKey(value: Record<string, EnvBinding> | null | undefined): string {
  return JSON.stringify(normalizedEnvEntries(value));
}

const CHANGE_SUMMARY_MAX_NAMES = 3;

function formatChangedNames(names: readonly string[]): string {
  const shown = names.slice(0, CHANGE_SUMMARY_MAX_NAMES).join(", ");
  return names.length > CHANGE_SUMMARY_MAX_NAMES
    ? `${shown} +${names.length - CHANGE_SUMMARY_MAX_NAMES} more`
    : shown;
}

function cloneRows(rows: readonly EnvRow[]): EnvRow[] {
  return rows.map((row) => ({ ...row }));
}

function rowDirtyFields(row: EnvRow, committedRow: EnvRow | undefined): EnvironmentVariableDirtyFields {
  if (!committedRow) {
    return {
      name: Boolean(row.name.trim()),
      value:
        row.source !== "text" ||
        Boolean(row.textValue) ||
        Boolean(row.secretId) ||
        row.version !== "latest",
    };
  }

  return {
    name: row.name.trim() !== committedRow.name.trim(),
    value:
      row.source !== committedRow.source ||
      row.textValue !== committedRow.textValue ||
      row.secretId !== committedRow.secretId ||
      row.userSecretKey !== committedRow.userSecretKey ||
      row.required !== committedRow.required ||
      row.version !== committedRow.version,
  };
}

export interface EnvironmentVariablesEditorProps {
  value: Record<string, EnvBinding>;
  onChange: (next: Record<string, EnvBinding> | undefined) => void;
  secrets: readonly CompanySecret[];
  /**
   * Optional company user-secret definitions. When present, the "User secret"
   * source becomes a picker; otherwise operators can type the definition key.
   */
  userSecretDefinitions?: readonly UserSecretDefinition[];
  onCreateSecret: (name: string, value: string) => Promise<CompanySecret>;
  /** Optional "Recently used" picker group + quick-bind chips. */
  recentlyUsedSecrets?: readonly CompanySecret[];
  /** Read-only rendering. */
  disabled?: boolean;
  /** Prefixes flagged as reserved/auto-provided. Default `["PAPERCLIP_"]`. */
  reservedPrefixes?: readonly string[];
  /** Context-specific hint line. `null` hides the default copy; omit for default. */
  footerHint?: ReactNode | null;
  /** Reports editor-local draft changes that are not yet promoted to the parent value. */
  onDirtyChange?: (dirty: boolean) => void;
}

export interface EnvironmentVariablesEditorHandle {
  /**
   * Promote the editor-local draft into the controlled value before an outer
   * action reads parent state. Returns the promoted value when a draft existed.
   */
  flushPendingDraft: () => Record<string, EnvBinding> | null;
}

export const EnvironmentVariablesEditor = forwardRef<EnvironmentVariablesEditorHandle, EnvironmentVariablesEditorProps>(function EnvironmentVariablesEditor({
  value,
  onChange,
  secrets,
  userSecretDefinitions,
  onCreateSecret,
  recentlyUsedSecrets,
  disabled,
  reservedPrefixes = DEFAULT_RESERVED_PREFIXES,
  footerHint,
  onDirtyChange,
}: EnvironmentVariablesEditorProps, ref) {
  const toast = useOptionalToastActions();
  const editorRootRef = useRef<HTMLDivElement | null>(null);
  const [rows, setRows] = useState<EnvRow[]>(() => rowsFromValue(value));
  const rowsRef = useRef(rows);
  const [committedRows, setCommittedRows] = useState<EnvRow[]>(() => cloneRows(rows));
  const initialValueKey = useMemo(() => normalizedEnvKey(value), []); // eslint-disable-line react-hooks/exhaustive-deps
  const committedValueKeyRef = useRef(initialValueKey);
  const lastPropValueKeyRef = useRef(initialValueKey);
  const pendingSaveValueKeyRef = useRef<string | null>(null);
  const [committedValueKey, setCommittedValueKey] = useState(initialValueKey);
  // Seeded (already-committed) names are "touched" so a saved reserved/invalid
  // var surfaces its message on load; freshly-typed rows wait for blur (§6.2).
  const [touchedNames, setTouchedNames] = useState<ReadonlySet<string>>(
    () => new Set(rowsFromValue(value).map((row) => row.name.trim()).filter(Boolean)),
  );
  const [pendingFocus, setPendingFocus] = useState<{ rowId: string; field: "name" | "value" } | null>(null);

  useEffect(() => {
    rowsRef.current = rows;
  }, [rows]);

  function markCommitted(nextValueKey: string, nextRows: readonly EnvRow[] = rowsRef.current) {
    committedValueKeyRef.current = nextValueKey;
    setCommittedValueKey(nextValueKey);
    setCommittedRows(cloneRows(nextRows));
  }

  function touchCommittedNames(nextRows: EnvRow[]) {
    setTouchedNames((prev) => {
      const next = new Set(prev);
      for (const row of nextRows) {
        const name = row.name.trim();
        if (name) next.add(name);
      }
      return next;
    });
  }

  function adoptExternalValue(nextValue: Record<string, EnvBinding>): EnvRow[] {
    const nextRows = rowsFromValue(nextValue);
    setRows(nextRows);
    touchCommittedNames(nextRows);
    return nextRows;
  }

  // Controlled sync: clean external changes replace the editor rows, but dirty
  // local drafts are never clobbered by refetches. A save echo only advances the
  // committed baseline so the focused row keeps its local id.
  useEffect(() => {
    const incomingValueKey = normalizedEnvKey(value);
    if (incomingValueKey === lastPropValueKeyRef.current) {
      return;
    }
    lastPropValueKeyRef.current = incomingValueKey;

    const draftValueKey = normalizedEnvKey(valueFromRows(rowsRef.current));
    const draftIsDirty = draftValueKey !== committedValueKeyRef.current;
    const matchesPendingSave = pendingSaveValueKeyRef.current === incomingValueKey;
    if (matchesPendingSave) {
      pendingSaveValueKeyRef.current = null;
    }

    if (!draftIsDirty) {
      const nextRows = adoptExternalValue(value);
      markCommitted(incomingValueKey, nextRows);
      return;
    }

    if (matchesPendingSave || draftValueKey === incomingValueKey) {
      touchCommittedNames(rowsRef.current);
      markCommitted(incomingValueKey);
    }
  }, [value]);

  const draftValue = useMemo(() => valueFromRows(rows), [rows]);
  const draftValueKey = useMemo(() => normalizedEnvKey(draftValue), [draftValue]);
  const hasUnsavedChanges = draftValueKey !== committedValueKey;

  useEffect(() => {
    onDirtyChange?.(!disabled && hasUnsavedChanges);
  }, [disabled, hasUnsavedChanges, onDirtyChange]);

  // Which variables differ from the committed baseline, so the unsaved-changes
  // banner can say *what* is unsaved instead of a bare label. A rename shows
  // as one addition plus one removal.
  const changeSummary = useMemo(() => {
    const committed = new Map(
      normalizedEnvEntries(valueFromRows(committedRows)).map(([name, binding]) => [name, JSON.stringify(binding)]),
    );
    const draft = new Map(
      normalizedEnvEntries(draftValue).map(([name, binding]) => [name, JSON.stringify(binding)]),
    );
    const added: string[] = [];
    const changed: string[] = [];
    for (const [name, bindingKey] of draft) {
      if (!committed.has(name)) added.push(name);
      else if (committed.get(name) !== bindingKey) changed.push(name);
    }
    const removed = [...committed.keys()].filter((name) => !draft.has(name));
    return { added, changed, removed };
  }, [committedRows, draftValue]);

  const changeSummaryText = useMemo(() => {
    const parts: string[] = [];
    if (changeSummary.added.length > 0) parts.push(`New: ${formatChangedNames(changeSummary.added)}`);
    if (changeSummary.changed.length > 0) parts.push(`Edited: ${formatChangedNames(changeSummary.changed)}`);
    if (changeSummary.removed.length > 0) parts.push(`Removed: ${formatChangedNames(changeSummary.removed)}`);
    return parts.join(" · ");
  }, [changeSummary]);

  // Warn before the tab unloads with a dirty draft (same guard as the skill
  // file editor). In-app navigation is not intercepted here.
  useEffect(() => {
    if (disabled || !hasUnsavedChanges) return;
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      event.preventDefault();
      event.returnValue = "";
    }
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [disabled, hasUnsavedChanges]);

  const flushPendingDraft = useCallback(() => {
    if (disabled || !hasUnsavedChanges) return null;
    pendingSaveValueKeyRef.current = draftValueKey;
    flushSync(() => {
      onChange(draftValue);
    });
    return draftValue ?? {};
  }, [disabled, draftValue, draftValueKey, hasUnsavedChanges, onChange]);

  useImperativeHandle(ref, () => ({ flushPendingDraft }), [flushPendingDraft]);

  useEffect(() => {
    const form = editorRootRef.current?.closest("form");
    if (!form) return;

    function handleSubmit() {
      flushPendingDraft();
    }

    form.addEventListener("submit", handleSubmit, true);
    return () => form.removeEventListener("submit", handleSubmit, true);
  }, [flushPendingDraft]);

  useEffect(() => {
    const root = editorRootRef.current;
    if (!root) return;
    const currentRoot = root;

    function handleDocumentClick(event: MouseEvent) {
      const target = event.target;
      if (!(target instanceof Element) || currentRoot.contains(target)) return;
      const button = target.closest("button");
      if (!button || button.disabled) return;
      const label = `${button.getAttribute("aria-label") ?? ""} ${button.textContent ?? ""}`;
      if (button.type === "submit" || /\b(save|create|update|test|import)\b/i.test(label)) {
        flushPendingDraft();
      }
    }

    document.addEventListener("click", handleDocumentClick, true);
    return () => document.removeEventListener("click", handleDocumentClick, true);
  }, [flushPendingDraft]);

  function updateDraft(nextRows: EnvRow[]) {
    setRows(nextRows);
  }

  function patchRow(id: string, patch: Partial<EnvRow>) {
    updateDraft(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    updateDraft(rows.filter((row) => row.id !== id));
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
    const working = rows.filter((row) => row.id !== targetRowId).map((row) => ({ ...row }));
    for (const { key, value: pairValue } of pairs) {
      const existing = working.find((row) => row.name.trim() === key);
      if (existing) {
        existing.name = key;
        existing.source = "text";
        existing.textValue = pairValue;
        existing.secretId = "";
        existing.sensitiveDismissed = false;
        existing.userSecretKey = "";
        existing.required = true;
      } else {
        working.push({ ...emptyRow(), name: key, textValue: pairValue });
      }
    }
    updateDraft(working);
    toast?.pushToast({ title: `Imported ${pairs.length} variable${pairs.length === 1 ? "" : "s"}`, tone: "success" });
    return true;
  }

  function bindRecentSecret(secret: CompanySecret) {
    const next = rows.map((row) => ({ ...row }));
    const trailing = next[next.length - 1];
    let target: EnvRow;
    if (trailing && !trailing.name && !trailing.textValue && !trailing.secretId && !trailing.userSecretKey) {
      target = trailing;
    } else {
      target = emptyRow();
      next.push(target);
    }
    target.source = "secret";
    target.secretId = secret.id;
    target.version = "latest";
    if (!target.name) target.name = envKeyFromSecretName(secret.name);
    updateDraft(next);
  }

  function saveDraft() {
    if (!hasUnsavedChanges) return;
    pendingSaveValueKeyRef.current = draftValueKey;
    onChange(draftValue);
  }

  function revertDraft() {
    pendingSaveValueKeyRef.current = null;
    lastPropValueKeyRef.current = normalizedEnvKey(value);
    const nextRows = adoptExternalValue(value);
    markCommitted(lastPropValueKeyRef.current, nextRows);
  }

  const duplicateNames = useMemo(() => computeDuplicateNames(rows), [rows]);

  const attentionCount = useMemo(
    () =>
      rows.reduce(
        (count, row) =>
          computeRowHealth(row, secrets) || computeUserSecretRowHealth(row, userSecretDefinitions)
            ? count + 1
            : count,
        0,
      ),
    [rows, secrets, userSecretDefinitions],
  );

  const quickBind = useMemo(() => {
    const boundIds = new Set(rows.filter((row) => row.source === "secret" && row.secretId).map((row) => row.secretId));
    return (recentlyUsedSecrets ?? [])
      .filter((secret) => secret.status === "active" && !boundIds.has(secret.id))
      .slice(0, 8);
  }, [recentlyUsedSecrets, rows]);

  const hasRows = rows.length > 0;
  const hint = footerHint === undefined ? DEFAULT_HINT : footerHint;
  const committedRowsById = useMemo(
    () => new Map(committedRows.map((row) => [row.id, row])),
    [committedRows],
  );

  return (
    <TooltipProvider>
      <div ref={editorRootRef} className="@container/env space-y-2">
      {attentionCount > 1 ? (
        <p className="inline-flex items-center gap-1.5 text-(length:--text-micro) font-medium text-amber-700 dark:text-amber-400">
          <AlertCircle className="size-3.5" />
          {attentionCount} bindings need attention
        </p>
      ) : null}

      {hasRows ? (
        <>
          {/* Header (desktop only) */}
          <div className="hidden gap-x-1.5 @[40rem]/env:grid @[40rem]/env:grid-cols-(--gtc-14)">
            <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">Name</span>
            <span className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">Value</span>
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
                userSecretDefinitions={userSecretDefinitions}
                recentlyUsedSecrets={recentlyUsedSecrets}
                disabled={disabled}
                nameIssue={issue}
                showNameIssue={touched}
                dirtyFields={rowDirtyFields(row, committedRowsById.get(row.id))}
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
      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
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
            <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground/70">
              <KeyRound className="size-3" />
              Recently used:
            </span>
            {quickBind.map((secret) => (
              <button
                key={secret.id}
                type="button"
                onClick={() => bindRecentSecret(secret)}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 font-mono text-(length:--text-micro) text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                title={`Bind ${secret.name}`}
              >
                + {secret.name}
              </button>
            ))}
          </div>
        ) : null}

      </div>

      {hasUnsavedChanges && !disabled ? (
        <div
          role="status"
          className="mt-3 flex w-full flex-col gap-3 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-3 text-amber-950 shadow-sm dark:bg-amber-500/15 dark:text-amber-100 @[34rem]/env:flex-row @[34rem]/env:items-center @[34rem]/env:justify-between"
        >
          <div className="flex min-w-0 flex-col gap-0.5">
            <div className="flex items-center gap-2 text-sm font-medium">
              <span className="size-2 rounded-full bg-amber-500 shadow-(--shadow-extract-13)" />
              <span>Unsaved changes</span>
            </div>
            {changeSummaryText ? (
              <p className="min-w-0 truncate pl-4 text-xs text-amber-950/80 dark:text-amber-100/80" title={changeSummaryText}>
                {changeSummaryText}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={revertDraft}
              className="inline-flex h-9 items-center gap-1.5 rounded-md border border-amber-500/30 bg-background px-3 text-sm font-medium text-foreground transition-colors hover:bg-amber-500/10 dark:bg-background/80"
            >
              <RotateCcw className="size-4" />
              Revert
            </button>
            <button
              type="button"
              onClick={saveDraft}
              className="inline-flex h-9 items-center gap-1.5 rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
            >
              <Save className="size-4" />
              Save
            </button>
          </div>
        </div>
      ) : null}

      {hint ? <p className="text-(length:--text-micro) text-muted-foreground/70">{hint}</p> : null}
      {rows.some((row) => row.source === "user_secret" && row.userSecretKey) ? (
        <p className="inline-flex items-start gap-1 text-(length:--text-micro) text-muted-foreground/70">
          <UserRound className="mt-0.5 size-3 shrink-0" />
          <span>
            User secrets resolve from the user responsible for the run. Required bindings fail until that user
            sets their value under Secrets → My secrets.
          </span>
        </p>
      ) : null}
      </div>
    </TooltipProvider>
  );
});

export type { EnvRow } from "./model";
export { EnvironmentVariableRow } from "./Row";
export { SecretPicker } from "./SecretPicker";
export { CreateSecretPopover, ConvertToSecretPopover } from "./CreateSecretPopover";
export { parseDotenv, looksLikeDotenv } from "./parse-dotenv";
export { isSensitiveEnv } from "./sensitive";
