import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Trash2, Variable } from "lucide-react";
import type { CompanySecret, EnvSecretRefBinding } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";
import { SecretPicker } from "./environment-variables-editor/SecretPicker";
import {
  entriesToEnvironmentRows,
  resolveEnvironmentRows,
  nextEnvironmentRowId,
  nextAvailableEnvKey,
  normalizeAccessMapKey,
  rowsToEnvMap,
  type AgentSecretRefEntry,
  type EnvironmentSecretRow,
} from "./agent-secret-access-model";

interface AgentEnvironmentSecretAccessEditorProps {
  bindings: readonly AgentSecretRefEntry[];
  secrets: readonly CompanySecret[];
  onChange: (next: Record<string, EnvSecretRefBinding>) => void;
  /** Env keys bound to plain values or user secrets; a rename must not take one. */
  reservedNames?: readonly string[];
  disabled?: boolean;
}

export function AgentEnvironmentSecretAccessEditor({
  bindings,
  secrets,
  onChange,
  reservedNames,
  disabled,
}: AgentEnvironmentSecretAccessEditorProps) {
  const reserved = useMemo(() => new Set(reservedNames ?? []), [reservedNames]);
  const incomingMap = useMemo(() => rowsToEnvMap(entriesToEnvironmentRows(bindings)), [bindings]);
  const incomingKey = useMemo(() => normalizeAccessMapKey(incomingMap), [incomingMap]);
  const [rows, setRows] = useState<EnvironmentSecretRow[]>(() => entriesToEnvironmentRows(bindings));
  // The last saved version of each row, used while that row has a name problem.
  const savedRowsRef = useRef(new Map(rows.map((row) => [row.id, row])));
  const lastEmittedKeyRef = useRef(incomingKey);
  const lastIncomingKeyRef = useRef(incomingKey);

  useEffect(() => {
    if (incomingKey === lastIncomingKeyRef.current) return;
    lastIncomingKeyRef.current = incomingKey;
    if (incomingKey === lastEmittedKeyRef.current) return;
    const nextRows = entriesToEnvironmentRows(bindings);
    savedRowsRef.current = new Map(nextRows.map((row) => [row.id, row]));
    setRows(nextRows);
  }, [bindings, incomingKey]);

  function emit(nextRows: EnvironmentSecretRow[]) {
    setRows(nextRows);
    // A row whose name is invalid, duplicated or taken keeps its last saved
    // assignment, so it is neither dropped nor written over another binding.
    // Edits and removals in the other rows still reach the form.
    const { effectiveRows } = resolveEnvironmentRows(nextRows, savedRowsRef.current, reserved);
    savedRowsRef.current = new Map(effectiveRows.map((row) => [row.id, row]));
    const map = rowsToEnvMap(effectiveRows);
    lastEmittedKeyRef.current = normalizeAccessMapKey(map);
    onChange(map);
  }

  const nameIssues = resolveEnvironmentRows(rows, savedRowsRef.current, reserved).issues;

  function patchRow(id: string, patch: Partial<EnvironmentSecretRow>) {
    emit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function addRow() {
    setRows((current) => [
      ...current,
      { id: nextEnvironmentRowId(), name: "", secretId: "", version: "latest" },
    ]);
  }

  return (
    <div className="space-y-2">
      <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
        Environment variables
      </div>
      {rows.length > 0 ? (
        <div className="space-y-2">
          {rows.map((row) => {
            const selectedSecret = secrets.find((secret) => secret.id === row.secretId) ?? null;
            const nameIssue = nameIssues.get(row.id) ?? null;
            return (
              <div key={row.id} className="grid grid-cols-(--gtc-65) items-start gap-1.5">
                <div className="min-w-0">
                  <SecretPicker
                    secretId={row.secretId}
                    secrets={secrets}
                    onSelect={(secretId) => {
                      const secret = secrets.find((candidate) => candidate.id === secretId);
                      // The key is the contract with the agent: changing the secret
                      // behind GH_TOKEN must keep GH_TOKEN. Derive a key only for a
                      // new row that has none yet.
                      patchRow(row.id, {
                        secretId,
                        name: secret && !row.name.trim()
                          ? nextAvailableEnvKey(
                              secret.name,
                              rows
                                .filter((candidate) => candidate.id !== row.id)
                                .map((candidate) => candidate.name),
                            )
                          : row.name,
                        version: "latest",
                      });
                    }}
                    disabled={disabled}
                    triggerClassName="h-9 min-h-9"
                  />
                  <div className="mt-1 flex items-center gap-1.5 text-(length:--text-micro) text-muted-foreground">
                    <Badge variant="outline" className="h-5 gap-1 px-1.5 font-normal">
                      <Variable className="size-3" /> Env var
                    </Badge>
                    <input
                      className="h-6 min-w-0 flex-1 rounded border border-border bg-background px-1.5 font-mono text-(length:--text-micro) outline-none disabled:cursor-not-allowed disabled:opacity-60"
                      value={row.name}
                      placeholder="ENV_NAME"
                      onChange={(event) => patchRow(row.id, { name: event.target.value })}
                      disabled={disabled}
                      aria-label="Environment variable name"
                      aria-invalid={nameIssue ? true : undefined}
                      spellCheck={false}
                    />
                    {row.name ? <code>env.{row.name}</code> : null}
                  </div>
                  {nameIssue ? (
                    <p role="alert" className="mt-1 text-(length:--text-micro) text-destructive">
                      {nameIssue}. Not saved yet.
                    </p>
                  ) : null}
                </div>
                <select
                  className="h-9 shrink-0 rounded-md border border-border bg-background px-2 text-xs outline-none disabled:cursor-not-allowed disabled:opacity-60"
                  value={row.version === undefined ? "latest" : String(row.version)}
                  onChange={(event) => {
                    const raw = event.target.value;
                    patchRow(row.id, {
                      version: raw === "latest" ? "latest" : Number.parseInt(raw, 10),
                    });
                  }}
                  disabled={disabled || !selectedSecret}
                  aria-label="Environment secret version"
                >
                  <option value="latest">latest</option>
                  {selectedSecret
                    ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => {
                        const version = selectedSecret.latestVersion - index;
                        return version > 0 ? <option key={version} value={version}>v{version}</option> : null;
                      })
                    : null}
                </select>
                <button
                  type="button"
                  onClick={() => emit(rows.filter((candidate) => candidate.id !== row.id))}
                  disabled={disabled}
                  aria-label="Remove environment secret"
                  className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No environment secrets assigned.</p>
      )}

      <button
        type="button"
        onClick={addRow}
        disabled={disabled}
        className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
      >
        <Plus className="size-3.5" />
        Add environment secret
      </button>
    </div>
  );
}
