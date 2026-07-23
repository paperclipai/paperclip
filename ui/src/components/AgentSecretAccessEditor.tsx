import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Plus, ServerCog, Trash2, Variable } from "lucide-react";
import type { CompanySecret, EnvSecretRefBinding, SecretVersionSelector } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SecretBindingPicker, type SecretBindingValue } from "./SecretBindingPicker";
import {
  AGENT_ACCESS_CONFIG_PATH_PREFIX,
  ENV_CONFIG_PATH_PREFIX,
  SECRET_ALIAS_RE,
  deliveryModeDescription,
} from "../lib/secret-delivery";
import { envKeyFromSecretName } from "./environment-variables-editor/model";

/* -------------------------------------------------------------------------- */
/* Pure model (exported for tests)                                            */
/* -------------------------------------------------------------------------- */

export interface AgentSecretRefEntry {
  /** env KEY (env delivery) or access ALIAS (API-access delivery). */
  name: string;
  secretId: string;
  version: SecretVersionSelector;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readSecretRef(raw: unknown): { secretId: string; version: SecretVersionSelector } | null {
  const binding = asRecord(raw);
  if (!binding || binding.type !== "secret_ref") return null;
  const secretId = typeof binding.secretId === "string" ? binding.secretId : "";
  if (!secretId) return null;
  const version: SecretVersionSelector = typeof binding.version === "number" ? binding.version : "latest";
  return { secretId, version };
}

/** Secret-ref bindings delivered as environment variables (`config.env.<KEY>`). */
export function parseEnvSecretRefs(config: Record<string, unknown> | null | undefined): AgentSecretRefEntry[] {
  const env = asRecord(config?.env);
  if (!env) return [];
  const entries: AgentSecretRefEntry[] = [];
  for (const [key, raw] of Object.entries(env)) {
    const ref = readSecretRef(raw);
    if (ref) entries.push({ name: key, ...ref });
  }
  return entries;
}

/** Secret-ref bindings delivered via the agent API (top-level `access.<ALIAS>`). */
export function parseAccessGrants(config: Record<string, unknown> | null | undefined): AgentSecretRefEntry[] {
  if (!config) return [];
  const entries: AgentSecretRefEntry[] = [];
  for (const [key, raw] of Object.entries(config)) {
    if (!key.startsWith(AGENT_ACCESS_CONFIG_PATH_PREFIX)) continue;
    const ref = readSecretRef(raw);
    if (ref) entries.push({ name: key.slice(AGENT_ACCESS_CONFIG_PATH_PREFIX.length), ...ref });
  }
  return entries;
}

export interface AgentSecretBindingSummary {
  secretId: string;
  envKeys: string[];
  apiAliases: string[];
}

/** Group env + API bindings by secret so the overview can show delivery mode per secret. */
export function summarizeAgentBindings(
  envBindings: readonly AgentSecretRefEntry[],
  apiBindings: readonly AgentSecretRefEntry[],
): AgentSecretBindingSummary[] {
  const bySecret = new Map<string, AgentSecretBindingSummary>();
  const ensure = (secretId: string) => {
    let summary = bySecret.get(secretId);
    if (!summary) {
      summary = { secretId, envKeys: [], apiAliases: [] };
      bySecret.set(secretId, summary);
    }
    return summary;
  };
  for (const entry of envBindings) ensure(entry.secretId).envKeys.push(entry.name);
  for (const entry of apiBindings) ensure(entry.secretId).apiAliases.push(entry.name);
  return [...bySecret.values()];
}

let accessRowCounter = 0;
function nextAccessRowId(): string {
  accessRowCounter += 1;
  return `access-row-${accessRowCounter}`;
}

interface AccessRow {
  id: string;
  alias: string;
  secretId: string;
  version: SecretVersionSelector;
}

function entriesToRows(entries: readonly AgentSecretRefEntry[]): AccessRow[] {
  return entries.map((entry) => ({
    id: nextAccessRowId(),
    alias: entry.name,
    secretId: entry.secretId,
    version: entry.version,
  }));
}

/** Complete, valid API-access grants keyed by alias. Incomplete/invalid/duplicate rows are dropped. */
export function rowsToAccessMap(rows: readonly AccessRow[]): Record<string, EnvSecretRefBinding> {
  const map: Record<string, EnvSecretRefBinding> = {};
  for (const row of rows) {
    const alias = row.alias.trim();
    if (!alias || !SECRET_ALIAS_RE.test(alias) || !row.secretId) continue;
    map[alias] = { type: "secret_ref", secretId: row.secretId, version: row.version };
  }
  return map;
}

/** Stable key for change-detection between the controlled value and the local draft. */
export function normalizeAccessMapKey(map: Record<string, EnvSecretRefBinding>): string {
  return JSON.stringify(
    Object.keys(map)
      .sort()
      .map((alias) => {
        const binding = map[alias]!;
        return [alias, binding.secretId, binding.version ?? "latest"];
      }),
  );
}

/* -------------------------------------------------------------------------- */
/* Component                                                                  */
/* -------------------------------------------------------------------------- */

export interface AgentSecretAccessEditorProps {
  /** Effective adapter config (env + top-level `access.*`), reflecting unsaved edits. */
  config: Record<string, unknown>;
  secrets: readonly CompanySecret[];
  /**
   * Emit the complete desired set of API-access grants (alias → secret_ref). The
   * parent diffs this against the current `access.*` keys to add/remove them.
   */
  onChange: (next: Record<string, EnvSecretRefBinding>) => void;
  disabled?: boolean;
}

function DeliveryBadge({ mode }: { mode: "env" | "api" }) {
  if (mode === "env") {
    return (
      <Badge
        variant="outline"
        className="h-5 gap-1 px-1.5 text-(length:--text-nano) font-normal border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300"
      >
        <Variable className="size-3" /> Env var
      </Badge>
    );
  }
  return (
    <Badge
      variant="outline"
      className="h-5 gap-1 px-1.5 text-(length:--text-nano) font-normal border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300"
    >
      <ServerCog className="size-3" /> API access
    </Badge>
  );
}

export function AgentSecretAccessEditor({ config, secrets, onChange, disabled }: AgentSecretAccessEditorProps) {
  const envBindings = useMemo(() => parseEnvSecretRefs(config), [config]);
  const apiBindings = useMemo(() => parseAccessGrants(config), [config]);
  const summaries = useMemo(() => summarizeAgentBindings(envBindings, apiBindings), [envBindings, apiBindings]);

  const incomingMap = useMemo(() => rowsToAccessMap(entriesToRows(apiBindings)), [apiBindings]);
  const incomingKey = useMemo(() => normalizeAccessMapKey(incomingMap), [incomingMap]);

  const [rows, setRows] = useState<AccessRow[]>(() => entriesToRows(apiBindings));
  const lastEmittedKeyRef = useRef(incomingKey);
  const lastIncomingKeyRef = useRef(incomingKey);

  // Controlled sync (mirrors the env editor): adopt genuine external changes
  // (Cancel / agent refetch) but never clobber a local draft that produced the
  // incoming value (the echo of our own emit) or an in-progress incomplete row.
  useEffect(() => {
    if (incomingKey === lastIncomingKeyRef.current) return;
    lastIncomingKeyRef.current = incomingKey;
    if (incomingKey === lastEmittedKeyRef.current) return;
    setRows(entriesToRows(apiBindings));
  }, [incomingKey, apiBindings]);

  const secretName = (secretId: string): string =>
    secrets.find((secret) => secret.id === secretId)?.name ?? `${secretId.slice(0, 8)}…`;

  function emit(nextRows: AccessRow[]) {
    setRows(nextRows);
    const map = rowsToAccessMap(nextRows);
    lastEmittedKeyRef.current = normalizeAccessMapKey(map);
    onChange(map);
  }

  function patchRow(id: string, patch: Partial<AccessRow>) {
    emit(rows.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    emit(rows.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((prev) => [...prev, { id: nextAccessRowId(), alias: "", secretId: "", version: "latest" }]);
  }

  const aliasCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const alias = row.alias.trim();
      if (alias) counts.set(alias, (counts.get(alias) ?? 0) + 1);
    }
    return counts;
  }, [rows]);

  const hasBindings = summaries.length > 0;

  return (
    <div className="space-y-3">
      {/* Overview: every secret bound to this agent + how it is delivered. */}
      {hasBindings ? (
        <div className="space-y-1.5">
          {summaries.map((summary) => (
            <div
              key={summary.secretId}
              className="flex flex-wrap items-center gap-x-2 gap-y-1 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs"
            >
              <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="font-medium">{secretName(summary.secretId)}</span>
              {summary.envKeys.length > 0 ? <DeliveryBadge mode="env" /> : null}
              {summary.apiAliases.length > 0 ? <DeliveryBadge mode="api" /> : null}
              <span className="min-w-0 truncate font-mono text-(length:--text-micro) text-muted-foreground">
                {[
                  ...summary.envKeys.map((key) => `${ENV_CONFIG_PATH_PREFIX}${key}`),
                  ...summary.apiAliases.map((alias) => `${AGENT_ACCESS_CONFIG_PATH_PREFIX}${alias}`),
                ].join(" · ")}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No secrets are bound to this agent yet.</p>
      )}

      {/* Editable API-access grants (access.<ALIAS>). */}
      <div className="space-y-2">
        <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          API access (no env var)
        </div>
        {rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => {
              const trimmedAlias = row.alias.trim();
              const aliasInvalid = Boolean(trimmedAlias) && !SECRET_ALIAS_RE.test(trimmedAlias);
              const aliasDuplicate = Boolean(trimmedAlias) && (aliasCounts.get(trimmedAlias) ?? 0) > 1;
              const bindingValue: SecretBindingValue | null = row.secretId
                ? { secretId: row.secretId, version: row.version }
                : null;
              return (
                <div key={row.id} className="space-y-1">
                  <div className="grid grid-cols-(--gtc-65) items-start gap-1.5">
                    <div>
                      <Input
                        value={row.alias}
                        onChange={(event) => patchRow(row.id, { alias: event.target.value })}
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (next && !SECRET_ALIAS_RE.test(next)) {
                            const suggested = envKeyFromSecretName(next);
                            if (suggested && suggested !== next) patchRow(row.id, { alias: suggested });
                          }
                        }}
                        placeholder="ALIAS"
                        aria-label="Access alias"
                        disabled={disabled}
                        className={cn(
                          "h-9 font-mono text-sm",
                          (aliasInvalid || aliasDuplicate) && "border-destructive text-destructive",
                        )}
                      />
                    </div>
                    <div>
                      <SecretBindingPicker
                        value={bindingValue}
                        onChange={(next) =>
                          patchRow(row.id, {
                            secretId: next?.secretId ?? "",
                            version: next?.version ?? "latest",
                            alias:
                              !row.alias.trim() && next?.secretId
                                ? envKeyFromSecretName(secretName(next.secretId))
                                : row.alias,
                          })
                        }
                        label=""
                        placeholder="Select secret"
                        disabled={disabled}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={() => removeRow(row.id)}
                      disabled={disabled}
                      aria-label="Remove API access"
                      className="mt-1 inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </div>
                  {aliasInvalid ? (
                    <p className="pl-0.5 text-(length:--text-micro) text-destructive">
                      Invalid alias — use letters, digits and _
                    </p>
                  ) : aliasDuplicate ? (
                    <p className="pl-0.5 text-(length:--text-micro) text-destructive">Duplicate alias</p>
                  ) : null}
                </div>
              );
            })}
          </div>
        ) : null}

        <button
          type="button"
          onClick={addRow}
          disabled={disabled}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:pointer-events-none disabled:opacity-50"
        >
          <Plus className="size-3.5" />
          Add API access
        </button>
      </div>

      <p className="text-(length:--text-micro) text-muted-foreground/70">
        {deliveryModeDescription("api")} The agent reads them by alias through <code>GET /agents/me/secrets</code>.
      </p>
    </div>
  );
}
