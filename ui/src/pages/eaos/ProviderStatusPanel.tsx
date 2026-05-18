/**
 * LET-368 (Phase 4A-S4 B3): Command Center provider-status panel for the
 * managed sandbox pilot (E2B). Read-only consumer of the B2 billing-cap
 * read-model (LET-367) plus the existing LET-314 sandbox read-model. The
 * panel inherits LET-352's preview/stub label pattern and stays in preview
 * state until `SANDBOX_PROVIDER_ALLOW_LIVE === "true"` flips post-canary
 * (gate G2 in the S4 plan doc).
 *
 * The operator toggle is the only write path on this surface; it is locked
 * for non-board roles per project pull-request policy and renders the
 * "approval required" banner exactly as inherited from LET-326 / LET-352.
 */

import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Activity,
  AlertTriangle,
  CircleAlert,
  CircleCheck,
  KeyRound,
  Power,
  ServerCog,
  ShieldAlert,
  ShieldCheck,
  Wallet,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Link } from "react-router-dom";
import { ApiError } from "@/api/client";
import {
  sandboxBillingCapApi,
  type SandboxBillingCapStatus,
  type SandboxBillingCapState,
  type SandboxKillSwitchLayer,
  type SandboxKillSwitchLayerState,
  type SandboxProviderIncident,
  type SandboxProviderLeaseSummary,
  type SandboxSpendWindow,
} from "@/api/sandbox-billing-cap";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import {
  PreviewChip,
  ReadOnlyChip,
  StateChip,
} from "./EaosChips";
import type { ChipTone } from "./eaos-state-labels";

interface ProviderStatusPanelProps {
  companyId: string;
}

export function ProviderStatusPanel({ companyId }: ProviderStatusPanelProps) {
  const queryClient = useQueryClient();
  const statusQuery = useQuery({
    queryKey: queryKeys.sandbox.billingCapStatus(companyId),
    queryFn: () => sandboxBillingCapApi.getStatus(companyId),
    retry: false,
    refetchInterval: 30_000,
  });

  const status = statusQuery.data;
  const previewMode = !status || status.meta.previewOnly || !status.meta.allowLive;

  const [toggleOpen, setToggleOpen] = useState(false);

  const flipMutation = useMutation({
    mutationFn: (vars: { enable: boolean; reason: string }) =>
      sandboxBillingCapApi.flipOperatorToggle(companyId, vars),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: queryKeys.sandbox.billingCapStatus(companyId),
      });
      setToggleOpen(false);
    },
  });

  return (
    <Card className="rounded-2xl border-border/80" aria-labelledby="provider-status-heading">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ServerCog aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <CardTitle id="provider-status-heading" className="text-base">
            Provider status
          </CardTitle>
          <ReadOnlyChip />
          {previewMode ? <PreviewChip /> : null}
        </div>
        <CardDescription>
          Managed sandbox pilot status — provider identity, kill-switch layers, billing-cap
          counters, recent leases, and the most recent incident. Spend numbers come from the
          B2 billing-cap counter store; the browser never hits the vendor usage endpoint
          directly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        {previewMode ? <PreviewBanner allowLive={status?.meta.allowLive ?? false} /> : null}

        {statusQuery.isLoading ? (
          <NoticeRow tone="info" body="Loading provider status…" role="status" />
        ) : null}

        {statusQuery.isError ? <ErrorRow error={statusQuery.error} /> : null}

        {!statusQuery.isLoading && !statusQuery.isError && !status ? (
          <NoDataRow />
        ) : null}

        {status ? (
          <>
            <ProviderIdentityBlock status={status} />
            <SpendBlock status={status} />
            <CapStateBlock capState={status.capState} />
            <KillSwitchBlock layers={status.killSwitch.layers} />
            <OperatorToggleBlock
              status={status}
              previewMode={previewMode}
              onOpen={() => setToggleOpen(true)}
            />
            <RecentLeasesBlock leases={status.recentLeases} />
            <LastIncidentBlock incident={status.lastIncident} />
            <FreshnessFooter status={status} />
          </>
        ) : null}
      </CardContent>

      <OperatorToggleDialog
        open={toggleOpen}
        onOpenChange={setToggleOpen}
        status={status}
        pending={flipMutation.isPending}
        error={flipMutation.error}
        onSubmit={(reason) =>
          flipMutation.mutate({
            enable: !(status?.operatorToggle.currentlyEnabled ?? false),
            reason,
          })
        }
      />
    </Card>
  );
}

/* ============================================================ */
/* Sub-blocks                                                    */
/* ============================================================ */

function PreviewBanner({ allowLive }: { allowLive: boolean }) {
  const body = allowLive
    ? "Provider preview-flagged. Awaiting B2 read-model + canary verification before vendor traffic flows."
    : "Vendor pilot not yet live. No vendor traffic flowing.";
  return (
    <div
      role="note"
      aria-label="EAOS provider pilot preview notice"
      className="flex items-start gap-2 rounded-md border border-amber-400/50 bg-amber-500/10 p-3 text-sm text-amber-900 dark:text-amber-200"
    >
      <CircleAlert aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        <p className="font-medium">{body}</p>
        <p className="mt-1 text-xs text-amber-900/80 dark:text-amber-200/80">
          Operator toggle and any vendor-bound action are gated until
          <span className="mx-1 font-mono text-[11px]">SANDBOX_PROVIDER_ALLOW_LIVE</span>
          flips post-canary (gate G2). See ADR{" "}
          <Link to="/issues/LET-328" className="underline">
            LET-328
          </Link>
          .
        </p>
      </div>
    </div>
  );
}

function NoticeRow({
  tone,
  body,
  role,
}: {
  tone: "info" | "warn" | "danger";
  body: string;
  role?: string;
}) {
  const cls =
    tone === "danger"
      ? "border-red-400/40 bg-red-500/5 text-red-700 dark:text-red-300"
      : tone === "warn"
        ? "border-amber-400/50 bg-amber-500/10 text-amber-700 dark:text-amber-300"
        : "border-border bg-muted/30 text-muted-foreground";
  return (
    <div
      role={role ?? (tone === "danger" ? "alert" : "status")}
      aria-live="polite"
      className={cn("rounded-md border p-3 text-sm", cls)}
    >
      {body}
    </div>
  );
}

function ErrorRow({ error }: { error: unknown }) {
  const status = error instanceof ApiError ? error.status : null;
  if (status === 404) {
    return <NoDataRow />;
  }
  return (
    <NoticeRow
      tone="danger"
      body="Unable to load provider status. Treated as Unknown rather than green."
    />
  );
}

function NoDataRow() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground"
    >
      <p className="font-medium text-foreground">No data yet.</p>
      <p className="mt-1">
        The B2 billing-cap read-model has not reported for this company. Counters, kill-switch
        state, and incident history will appear once B2 mounts the read-model route.
      </p>
    </div>
  );
}

function ProviderIdentityBlock({ status }: { status: SandboxBillingCapStatus }) {
  const { provider } = status;
  return (
    <section aria-labelledby="provider-identity-heading" className="space-y-2">
      <h3 id="provider-identity-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ServerCog aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Provider
      </h3>
      <dl className="grid gap-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">Name</dt>
          <dd className="font-medium">{provider.displayLabel}</dd>
        </div>
        <div>
          <dt className="text-xs uppercase tracking-wide text-muted-foreground">API key</dt>
          <dd className="flex flex-wrap items-center gap-2">
            <StateChip
              label={provider.apiKeyConfigured ? "Configured" : "Not configured"}
              tone={provider.apiKeyConfigured ? "success" : "warn"}
              icon={<KeyRound aria-hidden="true" className="h-3 w-3" />}
              title={
                provider.apiKeyConfigured
                  ? "Vendor API key is set in the secret store. Raw value is never sent to the browser."
                  : "Vendor API key is not set. No vendor calls are possible."
              }
            />
            {provider.secretRefRedactedSuffix ? (
              <span className="font-mono text-xs text-muted-foreground" title="Last chars of the secret-ref NAME, not the secret value.">
                ref …{provider.secretRefRedactedSuffix}
              </span>
            ) : null}
          </dd>
        </div>
      </dl>
    </section>
  );
}

function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toLocaleString("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function spendTone(window: SandboxSpendWindow): ChipTone {
  if (window.spentUsd >= window.hardCapUsd) return "danger";
  if (window.spentUsd >= window.softCapUsd) return "warn";
  return "success";
}

function SpendRow({ label, window }: { label: string; window: SandboxSpendWindow }) {
  const tone = spendTone(window);
  return (
    <div className="rounded-md border border-border bg-card/60 p-3" aria-label={`${label} spend`}>
      <div className="flex items-center justify-between gap-2 text-sm">
        <span className="font-medium">{label}</span>
        <StateChip
          label={`${formatUsd(window.spentUsd)} / ${formatUsd(window.hardCapUsd)} hard`}
          tone={tone}
        />
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Soft cap {formatUsd(window.softCapUsd)} · window {new Date(window.periodStart).toLocaleString()} →{" "}
        {new Date(window.periodEnd).toLocaleString()}
      </p>
    </div>
  );
}

function SpendBlock({ status }: { status: SandboxBillingCapStatus }) {
  return (
    <section aria-labelledby="provider-spend-heading" className="space-y-2">
      <h3 id="provider-spend-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Wallet aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Current spend
        <StateChip
          label={`Source: ${SOURCE_LABEL[status.meta.source]}`}
          tone="info"
        />
      </h3>
      <div className="grid gap-2 sm:grid-cols-2">
        <SpendRow label="Day-to-date (UTC)" window={status.spend.day} />
        <SpendRow label="Month-to-date" window={status.spend.month} />
      </div>
      <p className="text-xs text-muted-foreground">
        Counters fetched from the B2 store. The browser never calls the vendor usage API directly.
      </p>
    </section>
  );
}

const SOURCE_LABEL: Record<SandboxBillingCapStatus["meta"]["source"], string> = {
  "e2b-usage-api": "E2B usage API",
  "internal-estimate": "internal estimate",
};

function capStateLabel(state: SandboxBillingCapState): { label: string; tone: ChipTone; icon: typeof CircleCheck } {
  switch (state) {
    case "within-cap":
      return { label: "WITHIN CAP", tone: "success", icon: CircleCheck };
    case "soft-cap-breached":
      return { label: "SOFT CAP BREACHED", tone: "warn", icon: AlertTriangle };
    case "hard-cap-breached-auto-disabled":
      return { label: "HARD CAP BREACHED — auto-disabled", tone: "danger", icon: ShieldAlert };
  }
}

function CapStateBlock({ capState }: { capState: SandboxBillingCapState }) {
  const meta = capStateLabel(capState);
  const Icon = meta.icon;
  return (
    <section aria-labelledby="provider-cap-heading" className="space-y-2">
      <h3 id="provider-cap-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldCheck aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Cap state
      </h3>
      <StateChip
        label={meta.label}
        tone={meta.tone}
        icon={<Icon aria-hidden="true" className="h-3 w-3" />}
      />
    </section>
  );
}

const LAYER_STATE_LABEL: Record<SandboxKillSwitchLayerState, string> = {
  enabled: "ENABLED",
  disabled: "DISABLED",
  degraded: "DEGRADED",
};

function layerStateTone(state: SandboxKillSwitchLayerState): ChipTone {
  switch (state) {
    case "enabled":
      return "success";
    case "disabled":
      return "neutral";
    case "degraded":
      return "danger";
  }
}

function KillSwitchBlock({ layers }: { layers: SandboxKillSwitchLayer[] }) {
  return (
    <section aria-labelledby="provider-killswitch-heading" className="space-y-2">
      <h3 id="provider-killswitch-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ShieldAlert aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Kill-switch layers
      </h3>
      {layers.length === 0 ? (
        <NoticeRow tone="warn" body="No kill-switch layers reported. Treated as Unknown rather than green." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Layer</th>
                <th scope="col" className="px-3 py-2 font-medium">State</th>
                <th scope="col" className="px-3 py-2 font-medium">Last transition</th>
                <th scope="col" className="px-3 py-2 font-medium">Actor</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {layers.map((layer) => (
                <tr key={layer.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 align-top">
                    <div className="font-medium">{layer.label}</div>
                    {layer.reason ? (
                      <div className="mt-0.5 text-xs text-muted-foreground">{layer.reason}</div>
                    ) : null}
                  </td>
                  <td className="px-3 py-2 align-top">
                    <StateChip
                      label={LAYER_STATE_LABEL[layer.state]}
                      tone={layerStateTone(layer.state)}
                    />
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                    {layer.lastTransition ? new Date(layer.lastTransition.at).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                    {layer.lastTransition?.actorLabel ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function OperatorToggleBlock({
  status,
  previewMode,
  onOpen,
}: {
  status: SandboxBillingCapStatus;
  previewMode: boolean;
  onOpen: () => void;
}) {
  const toggle = status.operatorToggle;
  // Lock for non-board roles OR while the pilot is preview-only. The dialog is
  // the only write path on this surface; both the server (admin-API authz) and
  // this UI enforce the gate.
  const locked = previewMode || !toggle.canOperate;
  const buttonLabel = toggle.currentlyEnabled
    ? "Disable provider-enable config"
    : "Enable provider-enable config";

  return (
    <section aria-labelledby="provider-operator-heading" className="space-y-2">
      <h3 id="provider-operator-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Power aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Operator toggle (Layer 4)
      </h3>
      <div className="rounded-md border border-border bg-card/60 p-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1 text-sm">
            <div className="flex items-center gap-2">
              <span className="font-medium">Provider-enable config</span>
              <StateChip
                label={toggle.currentlyEnabled ? "ENABLED" : "DISABLED"}
                tone={toggle.currentlyEnabled ? "success" : "neutral"}
              />
              {locked ? (
                <StateChip
                  label="Locked"
                  tone="warn"
                  icon={<ShieldAlert aria-hidden="true" className="h-3 w-3" />}
                />
              ) : null}
            </div>
            <p className="text-xs text-muted-foreground">
              Flips are audited (operator id + reason + timestamp). A reason is required on every flip.
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={locked}
            aria-label={buttonLabel}
            onClick={onOpen}
          >
            {buttonLabel}
          </Button>
        </div>
        {locked ? (
          <div
            role="note"
            aria-label="Operator toggle locked"
            className="mt-3 rounded-md border border-amber-400/50 bg-amber-500/10 p-2 text-xs text-amber-900 dark:text-amber-200"
          >
            {previewMode
              ? "Locked while the pilot is preview-only. Flipping requires SANDBOX_PROVIDER_ALLOW_LIVE = true post-canary."
              : (toggle.lockedReason ??
                "Locked for non-board roles per the project pull-request policy. Open a PR or request board approval to change provider-enable config.")}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function OperatorToggleDialog({
  open,
  onOpenChange,
  status,
  pending,
  error,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  status: SandboxBillingCapStatus | undefined;
  pending: boolean;
  error: unknown;
  onSubmit: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  const targetEnabled = !(status?.operatorToggle.currentlyEnabled ?? false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setReason("");
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {targetEnabled ? "Enable" : "Disable"} provider-enable config
          </DialogTitle>
          <DialogDescription>
            This flip is logged to audit with your operator id, the reason, and the timestamp.
            It cannot be undone without another flip.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          <Label htmlFor="operator-toggle-reason">Reason (required)</Label>
          <Textarea
            id="operator-toggle-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why are you flipping the provider-enable config?"
            rows={4}
            aria-required="true"
            aria-invalid={!trimmed}
          />
          {error ? (
            <p role="alert" className="text-xs text-red-600 dark:text-red-300">
              {error instanceof Error ? error.message : "Flip failed."}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={() => onOpenChange(false)} disabled={pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="default"
            onClick={() => onSubmit(trimmed)}
            disabled={!trimmed || pending}
            aria-disabled={!trimmed || pending}
          >
            {pending ? "Submitting…" : targetEnabled ? "Enable" : "Disable"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function durationLabel(seconds: number | null): string {
  if (seconds == null) return "—";
  if (seconds < 60) return `${seconds.toFixed(0)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}m ${s.toString().padStart(2, "0")}s`;
}

function RecentLeasesBlock({ leases }: { leases: SandboxProviderLeaseSummary[] }) {
  const top10 = useMemo(() => leases.slice(0, 10), [leases]);
  return (
    <section aria-labelledby="provider-leases-heading" className="space-y-2">
      <h3 id="provider-leases-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <Activity aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Recent leases <span className="text-xs text-muted-foreground">(latest {top10.length} of {leases.length})</span>
      </h3>
      {top10.length === 0 ? (
        <NoticeRow tone="info" body="No leases reported yet for this provider." />
      ) : (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="min-w-full divide-y divide-border text-sm">
            <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-2 font-medium">Lease</th>
                <th scope="col" className="px-3 py-2 font-medium">State</th>
                <th scope="col" className="px-3 py-2 font-medium">Started</th>
                <th scope="col" className="px-3 py-2 font-medium">Ended</th>
                <th scope="col" className="px-3 py-2 font-medium">Duration</th>
                <th scope="col" className="px-3 py-2 font-medium">Cost est.</th>
                <th scope="col" className="px-3 py-2 font-medium">Agent</th>
                <th scope="col" className="px-3 py-2 font-medium">Run</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border bg-card">
              {top10.map((lease) => (
                <tr key={lease.id} className="hover:bg-muted/30">
                  <td className="px-3 py-2 align-top">
                    {/*
                     * LET-378 nit 1: lease detail route (`/sandbox/leases/:id`)
                     * is not declared in App.tsx yet. Render as plain text with
                     * a title rather than emit a Link that lands on the SPA
                     * not-found surface. Swap back to <Link> once the route
                     * ships alongside LET-367's read-model work.
                     */}
                    <span
                      className="font-mono text-xs text-muted-foreground"
                      aria-label={`Lease ${lease.id} (detail route not yet available)`}
                      title="Lease detail route not yet available"
                    >
                      {lease.id.slice(0, 12)}…
                    </span>
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    <StateChip label={lease.state} tone="info" />
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                    {new Date(lease.startedAt).toLocaleString()}
                  </td>
                  <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                    {lease.endedAt ? new Date(lease.endedAt).toLocaleString() : "—"}
                  </td>
                  <td className="px-3 py-2 align-top text-xs">{durationLabel(lease.durationSeconds)}</td>
                  <td className="px-3 py-2 align-top text-xs">
                    {lease.runtimeCostEstimateUsd == null ? "—" : formatUsd(lease.runtimeCostEstimateUsd)}
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    {lease.agentId ? (
                      <Link to={`/agents/${lease.agentId}`} className="underline-offset-2 hover:underline">
                        {lease.agentName ?? lease.agentId.slice(0, 8)}
                      </Link>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-3 py-2 align-top text-xs">
                    {/*
                     * LET-378 nit 1: top-level `/runs/:runId` is not declared
                     * in App.tsx. The agent-scoped route
                     * `/agents/:agentId/runs/:runId` IS defined (AgentDetail),
                     * so when both ids are present we route there. Otherwise
                     * fall back to plain text + title so clicks do not land on
                     * the SPA not-found surface.
                     */}
                    {lease.runId ? (
                      lease.agentId ? (
                        <Link
                          to={`/agents/${lease.agentId}/runs/${lease.runId}`}
                          className="font-mono underline-offset-2 hover:underline"
                        >
                          {lease.runId.slice(0, 8)}
                        </Link>
                      ) : (
                        <span
                          className="font-mono text-muted-foreground"
                          aria-label={`Run ${lease.runId} (detail route not yet available)`}
                          title="Run detail route not yet available"
                        >
                          {lease.runId.slice(0, 8)}
                        </span>
                      )
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

function LastIncidentBlock({ incident }: { incident: SandboxProviderIncident | null }) {
  return (
    <section aria-labelledby="provider-incident-heading" className="space-y-2">
      <h3 id="provider-incident-heading" className="flex items-center gap-2 text-sm font-medium text-foreground">
        <AlertTriangle aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
        Last incident
      </h3>
      {!incident ? (
        <NoticeRow tone="info" body="No cost-breach or kill-switch incidents reported." />
      ) : (
        <div className="rounded-md border border-border bg-card/60 p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <StateChip label={incident.eventKind} tone="warn" />
            <span className="text-xs text-muted-foreground">
              {new Date(incident.occurredAt).toLocaleString()}
            </span>
          </div>
          <p className="mt-2 text-sm text-foreground">{incident.summary}</p>
          {incident.issueIdentifier && incident.issueHref ? (
            <p className="mt-2 text-xs">
              Linked issue:{" "}
              <Link to={incident.issueHref} className="underline-offset-2 hover:underline">
                {incident.issueIdentifier}
              </Link>
            </p>
          ) : null}
        </div>
      )}
    </section>
  );
}

function FreshnessFooter({ status }: { status: SandboxBillingCapStatus }) {
  return (
    <p className="text-xs text-muted-foreground" aria-label="Provider status freshness">
      Snapshot:{" "}
      <span className="font-medium text-foreground">
        {new Date(status.meta.generatedAt).toLocaleString()}
      </span>
      {" · source "}
      <span className="font-mono">{SOURCE_LABEL[status.meta.source]}</span>
    </p>
  );
}
