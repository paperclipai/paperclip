import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Plus, ServerCog, Trash2, Variable } from "lucide-react";
import type {
  CompanySecret,
  EnvSecretRefBinding,
  SecretProposalView,
  SecretVersionSelector,
} from "@paperclipai/shared";
import { looksLikeCredentialToken } from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { ANALYTICS_NO_CAPTURE_CLASS } from "@/lib/analytics/privacy";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { SecretPicker } from "./environment-variables-editor/SecretPicker";
import { CreateSecretPopover } from "./environment-variables-editor/CreateSecretPopover";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import {
  AGENT_ACCESS_CONFIG_PATH_PREFIX,
  ENV_CONFIG_PATH_PREFIX,
  SECRET_ALIAS_RE,
  deliveryModeDescription,
} from "../lib/secret-delivery";
import { envKeyFromSecretName, secretNameFromKey } from "./environment-variables-editor/model";
import {
  DeliveryBadge as ProposalDeliveryBadge,
  ProposalActions,
  ProposedBadge,
  bindingEnvKey,
  bindingSecretLabel,
} from "../pages/secrets/proposal-review";

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
    if (!alias || looksLikeCredentialToken(alias) || !SECRET_ALIAS_RE.test(alias) || !row.secretId) continue;
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

export interface BindAsEnvVarRequest {
  envKey: string;
  secretId: string;
  version: SecretVersionSelector;
  replaceExisting?: boolean;
}

export interface AgentSecretAccessEditorProps {
  /** Effective adapter config (env + top-level `access.*`), reflecting unsaved edits. */
  config: Record<string, unknown>;
  secrets: readonly CompanySecret[];
  /**
   * Emit the complete desired set of API-access grants (alias → secret_ref). The
   * parent diffs this against the current `access.*` keys to add/remove them.
   */
  onChange: (next: Record<string, EnvSecretRefBinding>) => void;
  /** Create a company secret from the shared picker's pinned create action. */
  onCreateSecret?: (name: string, value: string) => Promise<CompanySecret>;
  /** Rotate an existing company secret when a name collision occurs during creation. */
  onRotateSecret?: (secretId: string, value: string) => Promise<CompanySecret>;
  /** Quick action to also expose an API-only secret binding as an environment variable. */
  onBindAsEnvVar?: (binding: BindAsEnvVarRequest) => void;
  disabled?: boolean;
  /** Pending binding proposals targeting this agent (PAP-14731). */
  proposals?: readonly SecretProposalView[];
  /** Open the approve confirm dialog for a proposal (wired by the parent surface). */
  onApproveProposal?: (proposal: SecretProposalView) => void;
  /** Open the reject dialog for a proposal (wired by the parent surface). */
  onRejectProposal?: (proposal: SecretProposalView) => void;
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

export function AgentSecretAccessEditor({
  config,
  secrets,
  onChange,
  onCreateSecret,
  onRotateSecret,
  onBindAsEnvVar,
  disabled,
  proposals,
  onApproveProposal,
  onRejectProposal,
}: AgentSecretAccessEditorProps) {
  const bindingProposals = useMemo(
    () => (proposals ?? []).filter((proposal) => proposal.kind === "binding"),
    [proposals],
  );
  const envBindings = useMemo(() => parseEnvSecretRefs(config), [config]);
  const apiBindings = useMemo(() => parseAccessGrants(config), [config]);
  const summaries = useMemo(() => summarizeAgentBindings(envBindings, apiBindings), [envBindings, apiBindings]);
  const secretById = useMemo(() => {
    const map = new Map<string, CompanySecret>();
    for (const secret of secrets) map.set(secret.id, secret);
    return map;
  }, [secrets]);
  const apiBindingByAlias = useMemo(() => {
    const map = new Map<string, AgentSecretRefEntry>();
    for (const entry of apiBindings) {
      map.set(entry.name, entry);
    }
    return map;
  }, [apiBindings]);
  const apiBindingBySecretId = useMemo(() => {
    const map = new Map<string, AgentSecretRefEntry>();
    for (const entry of apiBindings) {
      if (!map.has(entry.secretId)) map.set(entry.secretId, entry);
    }
    return map;
  }, [apiBindings]);
  const occupiedEnvKeys = useMemo(() => new Set(Object.keys(asRecord(config?.env) ?? {})), [config]);

  const incomingMap = useMemo(() => rowsToAccessMap(entriesToRows(apiBindings)), [apiBindings]);
  const incomingKey = useMemo(() => normalizeAccessMapKey(incomingMap), [incomingMap]);

  const [rows, setRows] = useState<AccessRow[]>(() => entriesToRows(apiBindings));
  const [createRequest, setCreateRequest] = useState<{ rowId: string; name: string } | null>(null);
  const [pendingEnvConflict, setPendingEnvConflict] = useState<{
    secretId: string;
    envKey: string;
    availableEnvKey: string;
    version: SecretVersionSelector;
  } | null>(null);
  const pickerAnchorRefs = useRef(new Map<string, HTMLDivElement>());
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
    secretById.get(secretId)?.name ?? `${secretId.slice(0, 8)}…`;

  function nextAvailableEnvKey(baseKey: string): string {
    let suffix = 2;
    while (occupiedEnvKeys.has(`${baseKey}_${suffix}`)) {
      suffix += 1;
    }
    return `${baseKey}_${suffix}`;
  }

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
          {summaries.map((summary) => {
            const isApiOnly = summary.apiAliases.length > 0 && summary.envKeys.length === 0;
            const validAliases = summary.apiAliases.filter(
              (alias) => SECRET_ALIAS_RE.test(alias) && !looksLikeCredentialToken(alias),
            );
            const chosenAlias =
              validAliases.find((alias) => !occupiedEnvKeys.has(alias)) ?? validAliases[0] ?? null;
            const derivedEnvKey = envKeyFromSecretName(secretName(summary.secretId));
            const fallbackEnvKey =
              SECRET_ALIAS_RE.test(derivedEnvKey) && !looksLikeCredentialToken(derivedEnvKey)
                ? derivedEnvKey
                : "";
            const suggestedEnvKey = chosenAlias ?? fallbackEnvKey;
            const matchingApiBinding = chosenAlias
              ? apiBindingByAlias.get(chosenAlias)
              : apiBindingBySecretId.get(summary.secretId);
            const envKeyOccupied = Boolean(suggestedEnvKey && occupiedEnvKeys.has(suggestedEnvKey));
            const conflictForRow =
              pendingEnvConflict?.secretId === summary.secretId ? pendingEnvConflict : null;
            return (
              <div
                key={summary.secretId}
                className="space-y-1.5 rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
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
                  {isApiOnly && onBindAsEnvVar && !disabled && suggestedEnvKey ? (
                    <button
                      type="button"
                      onClick={() => {
                        const version = matchingApiBinding?.version ?? "latest";
                        if (envKeyOccupied) {
                          setPendingEnvConflict({
                            secretId: summary.secretId,
                            envKey: suggestedEnvKey,
                            availableEnvKey: nextAvailableEnvKey(suggestedEnvKey),
                            version,
                          });
                          return;
                        }
                        onBindAsEnvVar({
                          envKey: suggestedEnvKey,
                          secretId: summary.secretId,
                          version,
                        });
                      }}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-border bg-background px-2 py-0.5 text-(length:--text-micro) font-medium text-foreground transition-colors hover:bg-accent"
                      title={
                        envKeyOccupied
                          ? `$${suggestedEnvKey} already exists — click to choose a new name or confirm replacement`
                          : `Bind as $${suggestedEnvKey} under Environment variables`
                      }
                    >
                      <Variable className="size-3" />
                      Also bind as env var
                    </button>
                  ) : null}
                </div>
                {conflictForRow && onBindAsEnvVar ? (
                  <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 text-(length:--text-micro)">
                    <span className="text-foreground">
                      <code className="font-mono">${conflictForRow.envKey}</code> already exists under Environment
                      variables.
                    </span>
                    <button
                      type="button"
                      onClick={() => {
                        onBindAsEnvVar({
                          envKey: conflictForRow.availableEnvKey,
                          secretId: conflictForRow.secretId,
                          version: conflictForRow.version,
                        });
                        setPendingEnvConflict(null);
                      }}
                      className="inline-flex items-center rounded-md border border-border bg-muted/40 px-2 py-0.5 font-medium text-foreground transition-colors hover:bg-accent"
                    >
                      Bind as {conflictForRow.availableEnvKey}
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        onBindAsEnvVar({
                          envKey: conflictForRow.envKey,
                          secretId: conflictForRow.secretId,
                          version: conflictForRow.version,
                          replaceExisting: true,
                        });
                        setPendingEnvConflict(null);
                      }}
                      className="inline-flex items-center rounded-md border border-destructive/40 bg-destructive/10 px-2 py-0.5 font-medium text-destructive transition-colors hover:bg-destructive/15"
                    >
                      Replace {conflictForRow.envKey}
                    </button>
                    <button
                      type="button"
                      onClick={() => setPendingEnvConflict(null)}
                      className="ml-auto inline-flex items-center rounded-md px-1.5 py-0.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      Cancel
                    </button>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      ) : (
        <p className="text-sm text-muted-foreground">No company secret references are bound to this agent yet.</p>
      )}

      {/* Pending binding proposals targeting this agent (PAP-14731). */}
      {bindingProposals.length > 0 && onApproveProposal && onRejectProposal ? (
        <div className="space-y-2">
          <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            Proposed access
          </div>
          {bindingProposals.map((proposal) => {
            const secret = bindingSecretLabel(proposal);
            const envKey = bindingEnvKey(proposal);
            return (
              <div
                key={proposal.id}
                className="flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/5 px-2.5 py-2 text-xs sm:flex-row sm:items-center"
              >
                <div className="min-w-0 flex-1 space-y-1">
                  <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                    <ProposalDeliveryBadge configPath={proposal.configPath} />
                    <code className="font-mono">{envKey || proposal.configPath}</code>
                    <span className="text-muted-foreground">→</span>
                    <KeyRound className="size-3 text-muted-foreground" />
                    <span className="font-medium">{secret.name}</span>
                    {secret.pending ? <ProposedBadge /> : null}
                  </div>
                  <p className="flex flex-wrap items-center gap-1 text-muted-foreground">
                    <span>proposed by {proposal.proposedBy.name}</span>
                    <span aria-hidden="true">·</span>
                    <span className="truncate italic">“{proposal.justification}”</span>
                  </p>
                </div>
                <ProposalActions
                  proposal={proposal}
                  onApprove={onApproveProposal}
                  onReject={onRejectProposal}
                  disabled={disabled}
                  size="xs"
                />
              </div>
            );
          })}
        </div>
      ) : null}

      {/* Editable API-access grants (access.<ALIAS>). */}
      <div className="space-y-2">
        <div className="space-y-1">
          <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
            API access (no env var)
          </div>
          <p className="text-(length:--text-micro) text-muted-foreground">
            Processes and shell scripts will not see <code className="font-mono">$NAME</code> for API-access secrets.
            To expose a secret as <code className="font-mono">$NAME</code>, bind it under Environment variables above.
          </p>
        </div>
        {rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => {
              const trimmedAlias = row.alias.trim();
              const aliasLooksLikeSecret = looksLikeCredentialToken(trimmedAlias);
              const aliasInvalid = Boolean(trimmedAlias) && !aliasLooksLikeSecret && !SECRET_ALIAS_RE.test(trimmedAlias);
              const aliasDuplicate = Boolean(trimmedAlias) && (aliasCounts.get(trimmedAlias) ?? 0) > 1;
              const selectedSecret = secretById.get(row.secretId) ?? null;
              return (
                <div key={row.id} className="space-y-1">
                  <div className="grid grid-cols-(--gtc-65) items-start gap-1.5">
                    <div>
                      <Input
                        type={aliasLooksLikeSecret ? "password" : "text"}
                        value={row.alias}
                        onChange={(event) => patchRow(row.id, { alias: event.target.value })}
                        onBlur={(event) => {
                          const next = event.target.value.trim();
                          if (next && !looksLikeCredentialToken(next) && !SECRET_ALIAS_RE.test(next)) {
                            const suggested = envKeyFromSecretName(next);
                            if (suggested && suggested !== next) patchRow(row.id, { alias: suggested });
                          }
                        }}
                        placeholder="ALIAS"
                        aria-label="Access alias"
                        disabled={disabled}
                        className={cn(
                          "h-9 font-mono text-sm",
                          aliasLooksLikeSecret && ANALYTICS_NO_CAPTURE_CLASS,
                          (aliasLooksLikeSecret || aliasInvalid || aliasDuplicate) && "border-destructive text-destructive",
                        )}
                      />
                    </div>
                    <div className="flex min-w-0 items-start gap-1.5">
                      <Popover
                        open={createRequest?.rowId === row.id}
                        onOpenChange={(open) => {
                          if (!open && createRequest?.rowId === row.id) setCreateRequest(null);
                        }}
                      >
                        <PopoverAnchor asChild>
                          <div
                            ref={(node) => {
                              if (node) pickerAnchorRefs.current.set(row.id, node);
                              else pickerAnchorRefs.current.delete(row.id);
                            }}
                            className="min-w-0 flex-1"
                          >
                            <SecretPicker
                              secretId={row.secretId}
                              secrets={secrets}
                              onSelect={(secretId) =>
                                patchRow(row.id, {
                                  secretId,
                                  version: "latest",
                                  alias:
                                    !row.alias.trim() && secretId
                                      ? envKeyFromSecretName(secretName(secretId))
                                      : row.alias,
                                })
                              }
                              onCreateNew={onCreateSecret
                                ? (query) => {
                                    window.setTimeout(() => {
                                      setCreateRequest({
                                        rowId: row.id,
                                        name: secretNameFromKey(query) || query.trim(),
                                      });
                                    }, 0);
                                  }
                                : undefined}
                              disabled={disabled}
                              triggerClassName="h-9 min-h-9"
                            />
                          </div>
                        </PopoverAnchor>
                        <PopoverContent
                          align="start"
                          className="w-auto p-3"
                          onInteractOutside={(event) => {
                            // Closing the picker returns focus to its trigger inside
                            // this popover's anchor. Keep that focus restoration from
                            // dismissing the create form that just opened.
                            const target = event.detail.originalEvent.target as Node | null;
                            if (target && pickerAnchorRefs.current.get(row.id)?.contains(target)) {
                              event.preventDefault();
                            }
                          }}
                        >
                          {createRequest?.rowId === row.id && onCreateSecret ? (
                            <CreateSecretPopover
                              initialName={createRequest.name}
                              initialValue=""
                              existingSecrets={secrets}
                              onCancel={() => setCreateRequest(null)}
                              onSubmit={async (name, value) => {
                                const created = await onCreateSecret(name, value);
                                patchRow(row.id, {
                                  secretId: created.id,
                                  version: "latest",
                                  alias: row.alias.trim() || envKeyFromSecretName(created.name),
                                });
                                setCreateRequest(null);
                              }}
                              onSelectExisting={(existing) => {
                                patchRow(row.id, {
                                  secretId: existing.id,
                                  version: "latest",
                                  alias: row.alias.trim() || envKeyFromSecretName(existing.name),
                                });
                                setCreateRequest(null);
                              }}
                              onRotateExisting={onRotateSecret
                                ? async (existing, value) => {
                                    const rotated = await onRotateSecret(existing.id, value);
                                    patchRow(row.id, {
                                      secretId: rotated.id,
                                      version: "latest",
                                      alias: row.alias.trim() || envKeyFromSecretName(rotated.name),
                                    });
                                    setCreateRequest(null);
                                  }
                                : undefined}
                            />
                          ) : null}
                        </PopoverContent>
                      </Popover>
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
                        aria-label="Version"
                      >
                        <option value="latest">latest</option>
                        {selectedSecret
                          ? Array.from({ length: Math.max(0, selectedSecret.latestVersion) }, (_, index) => {
                              const version = selectedSecret.latestVersion - index;
                              if (version <= 0) return null;
                              return (
                                <option key={version} value={version}>
                                  v{version}
                                </option>
                              );
                            })
                          : null}
                      </select>
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
                  {aliasLooksLikeSecret ? (
                    <p className="pl-0.5 text-(length:--text-micro) text-destructive">
                      Looks like a secret value — enter an alias name (e.g. GH_TOKEN), not the token itself
                    </p>
                  ) : aliasInvalid ? (
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
