import { useEffect, useMemo, useRef, useState } from "react";
import { KeyRound, Plus, Trash2 } from "lucide-react";
import type {
  CompanySecret,
  EnvSecretRefBinding,
  SecretProposalView,
} from "@paperclipai/shared";
import { cn } from "../lib/utils";
import { Input } from "@/components/ui/input";
import { SecretPicker } from "./environment-variables-editor/SecretPicker";
import {
  AGENT_ACCESS_CONFIG_PATH_PREFIX,
  SECRET_ALIAS_RE,
  deliveryModeDescription,
} from "../lib/secret-delivery";
import { envKeyFromSecretName } from "./environment-variables-editor/model";
import { AgentEnvironmentSecretAccessEditor } from "./AgentEnvironmentSecretAccessEditor";
import {
  entriesToAccessRows,
  nextAccessRowId,
  normalizeAccessMapKey,
  parseAccessGrants,
  parseEnvSecretRefs,
  rowsToAccessMap,
  type AccessRow,
} from "./agent-secret-access-model";
export {
  nextAvailableEnvKey,
  normalizeAccessMapKey,
  parseAccessGrants,
  parseEnvSecretRefs,
  rowsToAccessMap,
  rowsToEnvMap,
  summarizeAgentBindings,
} from "./agent-secret-access-model";
import {
  DeliveryBadge as ProposalDeliveryBadge,
  ProposalActions,
  ProposedBadge,
  bindingEnvKey,
  bindingSecretLabel,
} from "../pages/secrets/proposal-review";

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
  /** Replace environment-delivered company-secret bindings (`env.<KEY>`). */
  onEnvChange?: (next: Record<string, EnvSecretRefBinding>) => void;
  disabled?: boolean;
  /** Pending binding proposals targeting this agent (PAP-14731). */
  proposals?: readonly SecretProposalView[];
  /** Open the approve confirm dialog for a proposal (wired by the parent surface). */
  onApproveProposal?: (proposal: SecretProposalView) => void;
  /** Open the reject dialog for a proposal (wired by the parent surface). */
  onRejectProposal?: (proposal: SecretProposalView) => void;
}

export function AgentSecretAccessEditor({
  config,
  secrets,
  onChange,
  onEnvChange,
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

  const incomingMap = useMemo(() => rowsToAccessMap(entriesToAccessRows(apiBindings)), [apiBindings]);
  const incomingKey = useMemo(() => normalizeAccessMapKey(incomingMap), [incomingMap]);

  const [rows, setRows] = useState<AccessRow[]>(() => entriesToAccessRows(apiBindings));
  const lastEmittedKeyRef = useRef(incomingKey);
  const lastIncomingKeyRef = useRef(incomingKey);

  // Controlled sync (mirrors the env editor): adopt genuine external changes
  // (Cancel / agent refetch) but never clobber a local draft that produced the
  // incoming value (the echo of our own emit) or an in-progress incomplete row.
  useEffect(() => {
    if (incomingKey === lastIncomingKeyRef.current) return;
    lastIncomingKeyRef.current = incomingKey;
    if (incomingKey === lastEmittedKeyRef.current) return;
    setRows(entriesToAccessRows(apiBindings));
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

  return (
    <div className="space-y-3">
      <AgentEnvironmentSecretAccessEditor
        bindings={envBindings}
        secrets={secrets}
        onChange={onEnvChange ?? (() => {})}
        disabled={disabled || !onEnvChange}
      />

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
        <div className="text-(length:--text-micro) font-medium uppercase tracking-wide text-muted-foreground">
          API access (no env var)
        </div>
        {rows.length > 0 ? (
          <div className="space-y-2">
            {rows.map((row) => {
              const trimmedAlias = row.alias.trim();
              const aliasInvalid = Boolean(trimmedAlias) && !SECRET_ALIAS_RE.test(trimmedAlias);
              const aliasDuplicate = Boolean(trimmedAlias) && (aliasCounts.get(trimmedAlias) ?? 0) > 1;
              const selectedSecret = secrets.find((secret) => secret.id === row.secretId) ?? null;
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
                    <div className="flex min-w-0 items-start gap-1.5">
                      <div className="min-w-0 flex-1">
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
                          disabled={disabled}
                          triggerClassName="h-9 min-h-9"
                        />
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
