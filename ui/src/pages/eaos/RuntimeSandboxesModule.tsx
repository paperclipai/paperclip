/**
 * LET-326: Runtime & Sandboxes read-only module.
 *
 * Sources, in order of preference:
 *   1. /api/companies/:id/sandbox/providers (LET-314): preview-only
 *      provider descriptors (kind, enabled, previewOnly).
 *   2. /api/companies/:id/sandbox/leases    (LET-314): lease read-models
 *      with `truth` ∈ { backend-backed | derived | preview }.
 *   3. /api/companies/:id/live-runs         (existing): heartbeat run
 *      activity. Used purely as "runtime activity" context.
 *   4. /api/companies/:id/execution-workspaces (existing): workspace
 *      summary rows for cross-reference.
 *   5. /api/companies/:id/approvals (existing): release-hold / approval
 *      surface labels.
 *
 * Every row gets explicit source-class + lifecycle chips. Risky controls
 * (start / stop / cleanup / proxy) are intentionally never rendered.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Activity, Boxes, ServerCog, ShieldAlert, Workflow } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@/components/ui/tabs";
import { Button } from "@/components/ui/button";
import { sandboxApi, type SandboxLeaseReadModel } from "@/api/sandbox";
import { heartbeatsApi } from "@/api/heartbeats";
import { executionWorkspacesApi } from "@/api/execution-workspaces";
import { approvalsApi } from "@/api/approvals";
import { queryKeys } from "@/lib/queryKeys";
import {
  BackendBackedChip,
  PreviewChip,
  ReadOnlyChip,
  RedactedChip,
  ReleaseHeldChip,
  SourceClassChip,
  StateChip,
  UnknownChip,
} from "./EaosChips";
import {
  cleanupChipFor,
  displayRedactedValue,
  isRedactedValue,
  lifecycleChipFor,
  providerChipFor,
  truthToSourceClass,
} from "./eaos-state-labels";

interface RuntimeSandboxesModuleProps {
  companyId: string;
  onGeneratedAt?: (timestamp: string | null, partial: boolean) => void;
  onSelectLease?: (lease: SandboxLeaseReadModel | null) => void;
}

export function RuntimeSandboxesModule({
  companyId,
  onGeneratedAt,
  onSelectLease,
}: RuntimeSandboxesModuleProps) {
  const providersQuery = useQuery({
    queryKey: queryKeys.sandbox.providers(companyId),
    queryFn: () => sandboxApi.listProviders(companyId),
  });

  const leasesQuery = useQuery({
    queryKey: queryKeys.sandbox.leases(companyId),
    queryFn: () => sandboxApi.listLeases(companyId, { limit: 50 }),
  });

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { limit: 25 }),
    refetchInterval: 15_000,
  });

  const workspacesQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(companyId, { status: "active" }),
    queryFn: () => executionWorkspacesApi.list(companyId, { status: "active" }),
  });

  const approvalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
  });

  const partial =
    providersQuery.isError ||
    leasesQuery.isError ||
    liveRunsQuery.isError ||
    workspacesQuery.isError ||
    approvalsQuery.isError;

  // Push the most recent backend `generatedAt` to the parent banner so the
  // user sees a real freshness time, not a UI clock.
  const generatedAt = leasesQuery.data?.generatedAt ?? providersQuery.data?.generatedAt ?? null;
  useEffect(() => {
    onGeneratedAt?.(generatedAt, partial);
  }, [generatedAt, partial, onGeneratedAt]);

  const [tab, setTab] = useState<string>("leases");

  return (
    <Card className="rounded-2xl border-border/80">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <ServerCog aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Runtime &amp; sandboxes</CardTitle>
          <ReadOnlyChip />
          <PreviewChip />
        </div>
        <CardDescription>
          Lease, provider, run, workspace, and approval visibility from existing read-only sources. No live
          start/stop, no real egress, no runtime service mutation.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={setTab}>
          <TabsList variant="line" aria-label="Runtime and sandboxes views">
            <TabsTrigger value="leases">
              <Boxes aria-hidden="true" className="h-4 w-4" />
              Leases
            </TabsTrigger>
            <TabsTrigger value="providers">
              <ServerCog aria-hidden="true" className="h-4 w-4" />
              Providers
            </TabsTrigger>
            <TabsTrigger value="runs">
              <Activity aria-hidden="true" className="h-4 w-4" />
              Live runs
            </TabsTrigger>
            <TabsTrigger value="workspaces">
              <Workflow aria-hidden="true" className="h-4 w-4" />
              Workspaces
            </TabsTrigger>
            <TabsTrigger value="approvals">
              <ShieldAlert aria-hidden="true" className="h-4 w-4" />
              Approvals
            </TabsTrigger>
          </TabsList>

          <TabsContent value="leases" className="mt-4">
            <SandboxLeaseTable
              loading={leasesQuery.isLoading}
              error={leasesQuery.error}
              leases={leasesQuery.data?.leases ?? []}
              onSelect={onSelectLease}
            />
          </TabsContent>

          <TabsContent value="providers" className="mt-4">
            <ProvidersTable
              loading={providersQuery.isLoading}
              error={providersQuery.error}
              providers={providersQuery.data?.providers ?? []}
            />
          </TabsContent>

          <TabsContent value="runs" className="mt-4">
            <LiveRunsTable
              loading={liveRunsQuery.isLoading}
              error={liveRunsQuery.error}
              runs={liveRunsQuery.data ?? []}
            />
          </TabsContent>

          <TabsContent value="workspaces" className="mt-4">
            <WorkspaceTable
              loading={workspacesQuery.isLoading}
              error={workspacesQuery.error}
              workspaces={workspacesQuery.data ?? []}
            />
          </TabsContent>

          <TabsContent value="approvals" className="mt-4">
            <ApprovalsTable
              loading={approvalsQuery.isLoading}
              error={approvalsQuery.error}
              approvals={approvalsQuery.data ?? []}
            />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

/* ============================================================ */
/* Table components — all text-first, semantic <table> markup.  */
/* ============================================================ */

interface AsyncTableProps {
  loading: boolean;
  error: unknown;
}

function AsyncStatus({ loading, error, empty }: AsyncTableProps & { empty: boolean }) {
  if (loading) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground" role="status" aria-live="polite">
        Loading…
      </div>
    );
  }
  if (error) {
    return (
      <div className="rounded-md border border-red-400/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300" role="alert">
        Unable to load. Treated as <UnknownChip className="ml-1 inline-flex" /> rather than green.
      </div>
    );
  }
  if (empty) {
    return (
      <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
        No rows. Backend returned an empty list.
      </div>
    );
  }
  return null;
}

interface SandboxLeaseTableProps extends AsyncTableProps {
  leases: SandboxLeaseReadModel[];
  onSelect?: (lease: SandboxLeaseReadModel | null) => void;
}

function SandboxLeaseTable({ loading, error, leases, onSelect }: SandboxLeaseTableProps) {
  const status = <AsyncStatus loading={loading} error={error} empty={leases.length === 0} />;
  if (loading || error || leases.length === 0) return status;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Lease</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
            <th scope="col" className="px-3 py-2 font-medium">Lifecycle</th>
            <th scope="col" className="px-3 py-2 font-medium">Provider</th>
            <th scope="col" className="px-3 py-2 font-medium">Network</th>
            <th scope="col" className="px-3 py-2 font-medium">Cleanup</th>
            <th scope="col" className="px-3 py-2 font-medium">Artifacts</th>
            <th scope="col" className="px-3 py-2 font-medium">Acquired</th>
            <th scope="col" className="px-3 py-2 font-medium">
              <span className="sr-only">Details</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {leases.map((lease) => {
            const sourceClass = truthToSourceClass(lease.truth);
            const lifecycle = lifecycleChipFor(lease);
            const cleanup = cleanupChipFor(lease);
            const provider = providerChipFor(lease.provider, lease.providerEnabled);
            const network = lease.network;
            return (
              <tr key={lease.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 align-top">
                  <div className="font-mono text-xs">{lease.id.slice(0, 12)}…</div>
                  <div className="mt-1 text-xs text-muted-foreground">env {lease.environmentId.slice(0, 8)}</div>
                  {lease.heartbeatRunId ? (
                    <div className="mt-1 text-xs text-muted-foreground">run {lease.heartbeatRunId.slice(0, 8)}</div>
                  ) : null}
                </td>
                <td className="px-3 py-2 align-top">
                  <SourceClassChip source={sourceClass} />
                </td>
                <td className="px-3 py-2 align-top">
                  <StateChip label={lifecycle.label} tone={lifecycle.tone} />
                </td>
                <td className="px-3 py-2 align-top">
                  <StateChip label={provider.label} tone={provider.tone} />
                  <div className="mt-1 flex flex-wrap gap-1">
                    <StateChip
                      label={provider.enabled ? "Flag: enabled" : "Flag: disabled"}
                      tone={provider.enabled ? "info" : "neutral"}
                    />
                    <PreviewChip />
                  </div>
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {lease.egressPreview ? (
                    <div className="space-y-1">
                      <div>
                        Mode: <span className="font-medium">{lease.egressPreview.mode ?? "—"}</span>
                      </div>
                      <div>
                        Allow loopback: <span className="font-medium">{String(lease.egressPreview.allowLoopback ?? "—")}</span>
                      </div>
                      <div>
                        Egress allow ({lease.egressPreview.egressAllowlistCount}) · DNS ({lease.egressPreview.dnsAllowlistCount}) · Inbound ({lease.egressPreview.allowInboundPortCount})
                      </div>
                      {network && hasRedactedValue(network) ? <RedactedChip short /> : null}
                    </div>
                  ) : (
                    <UnknownChip />
                  )}
                </td>
                <td className="px-3 py-2 align-top">
                  <StateChip label={cleanup.label} tone={cleanup.tone} />
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {lease.artifacts.present ? (
                    <span>
                      {lease.artifacts.count} artifact{lease.artifacts.count === 1 ? "" : "s"}
                    </span>
                  ) : (
                    <UnknownChip label="None reported" />
                  )}
                </td>
                <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                  {new Date(lease.acquiredAt).toLocaleString()}
                </td>
                <td className="px-3 py-2 align-top text-xs">
                  {onSelect ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      aria-label={`Open lease ${lease.id} details`}
                      onClick={() => onSelect(lease)}
                    >
                      Details
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function hasRedactedValue(record: Record<string, unknown>): boolean {
  for (const value of Object.values(record)) {
    if (isRedactedValue(value)) return true;
    if (typeof value === "string" && value.includes("[REDACTED]")) return true;
  }
  return false;
}

interface ProvidersTableProps extends AsyncTableProps {
  providers: Array<{ provider: string; kind: string; enabled: boolean; previewOnly: boolean }>;
}

function ProvidersTable({ loading, error, providers }: ProvidersTableProps) {
  const status = <AsyncStatus loading={loading} error={error} empty={providers.length === 0} />;
  if (loading || error || providers.length === 0) return status;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Provider</th>
            <th scope="col" className="px-3 py-2 font-medium">Kind</th>
            <th scope="col" className="px-3 py-2 font-medium">Flag</th>
            <th scope="col" className="px-3 py-2 font-medium">Surface</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {providers.map((p) => (
            <tr key={p.provider} className="hover:bg-muted/30">
              <td className="px-3 py-2 font-mono text-xs">{p.provider}</td>
              <td className="px-3 py-2 text-xs">{p.kind}</td>
              <td className="px-3 py-2 text-xs">
                <StateChip label={p.enabled ? "enabled" : "disabled"} tone={p.enabled ? "info" : "neutral"} />
              </td>
              <td className="px-3 py-2 text-xs">
                {p.previewOnly ? <PreviewChip /> : <BackendBackedChip />}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

interface LiveRunsTableProps extends AsyncTableProps {
  runs: Array<{
    id: string;
    status: string;
    agentName: string;
    adapterType: string;
    startedAt: string | Date | null;
    livenessState?: string | null;
    livenessReason?: string | null;
    issueId?: string | null;
  }>;
}

function LiveRunsTable({ loading, error, runs }: LiveRunsTableProps) {
  const status = <AsyncStatus loading={loading} error={error} empty={runs.length === 0} />;
  if (loading || error || runs.length === 0) return status;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Run</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Liveness</th>
            <th scope="col" className="px-3 py-2 font-medium">Agent</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {runs.map((run) => (
            <tr key={run.id} className="hover:bg-muted/30">
              <td className="px-3 py-2 align-top">
                <div className="font-mono text-xs">{run.id.slice(0, 12)}…</div>
                <div className="mt-1 text-xs text-muted-foreground">
                  {run.startedAt ? new Date(run.startedAt).toLocaleString() : "—"}
                </div>
              </td>
              <td className="px-3 py-2 align-top text-xs">
                <StateChip label={run.status} tone={runStatusTone(run.status)} />
              </td>
              <td className="px-3 py-2 align-top text-xs">
                {run.livenessState ? (
                  <StateChip label={String(run.livenessState)} tone={livenessTone(String(run.livenessState))} />
                ) : (
                  <UnknownChip />
                )}
              </td>
              <td className="px-3 py-2 align-top text-xs">
                <div>{run.agentName}</div>
                <div className="text-muted-foreground">{run.adapterType}</div>
              </td>
              <td className="px-3 py-2 align-top">
                <BackendBackedChip />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function runStatusTone(status: string) {
  if (status === "running") return "success" as const;
  if (status === "completed" || status === "succeeded") return "success" as const;
  if (status === "failed" || status === "error") return "danger" as const;
  if (status === "cancelled" || status === "canceled") return "neutral" as const;
  return "info" as const;
}

function livenessTone(state: string) {
  if (state === "alive" || state === "ok") return "success" as const;
  if (state === "stalled" || state === "looping") return "danger" as const;
  if (state === "covered" || state === "snoozed") return "info" as const;
  return "warn" as const;
}

interface WorkspaceTableProps extends AsyncTableProps {
  workspaces: Array<{
    id: string;
    name?: string | null;
    status: string;
    projectId?: string | null;
    createdAt?: string | Date | null;
  }>;
}

function WorkspaceTable({ loading, error, workspaces }: WorkspaceTableProps) {
  const status = <AsyncStatus loading={loading} error={error} empty={workspaces.length === 0} />;
  if (loading || error || workspaces.length === 0) return status;

  return (
    <div className="overflow-x-auto rounded-md border border-border">
      <table className="min-w-full divide-y divide-border text-sm">
        <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
          <tr>
            <th scope="col" className="px-3 py-2 font-medium">Workspace</th>
            <th scope="col" className="px-3 py-2 font-medium">Status</th>
            <th scope="col" className="px-3 py-2 font-medium">Created</th>
            <th scope="col" className="px-3 py-2 font-medium">Source</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-border bg-card">
          {workspaces.map((w) => (
            <tr key={w.id} className="hover:bg-muted/30">
              <td className="px-3 py-2 align-top">
                <div className="font-mono text-xs">{w.id.slice(0, 12)}…</div>
                <div className="text-xs text-muted-foreground">{w.name ?? "—"}</div>
              </td>
              <td className="px-3 py-2 align-top text-xs">
                <StateChip label={w.status} tone={workspaceStatusTone(w.status)} />
              </td>
              <td className="px-3 py-2 align-top text-xs text-muted-foreground">
                {w.createdAt ? new Date(w.createdAt).toLocaleString() : "—"}
              </td>
              <td className="px-3 py-2 align-top">
                <BackendBackedChip />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function workspaceStatusTone(status: string) {
  if (status === "active") return "success" as const;
  if (status === "archived" || status === "closed") return "neutral" as const;
  if (status === "error" || status === "failed") return "danger" as const;
  return "info" as const;
}

interface ApprovalsTableProps extends AsyncTableProps {
  approvals: Array<{
    id: string;
    type: string;
    status: string;
    createdAt?: string | Date;
    payload?: unknown;
  }>;
}

function ApprovalsTable({ loading, error, approvals }: ApprovalsTableProps) {
  const status = <AsyncStatus loading={loading} error={error} empty={approvals.length === 0} />;
  if (loading || error || approvals.length === 0) {
    return (
      <div className="space-y-2">
        {status}
        <p className="text-xs text-muted-foreground">
          The dashboard never approves on its own. Open <code>/approvals</code> to act.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">
        Pending approvals owned by this company. Approve / reject lives at <code>/approvals/:id</code>.
      </p>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="min-w-full divide-y divide-border text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium">Approval</th>
              <th scope="col" className="px-3 py-2 font-medium">Type</th>
              <th scope="col" className="px-3 py-2 font-medium">Status</th>
              <th scope="col" className="px-3 py-2 font-medium">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {approvals.map((a) => (
              <tr key={a.id} className="hover:bg-muted/30">
                <td className="px-3 py-2 font-mono text-xs">{a.id.slice(0, 12)}…</td>
                <td className="px-3 py-2 text-xs">{a.type}</td>
                <td className="px-3 py-2 text-xs">
                  <StateChip label={a.status} tone={approvalStatusTone(a.status)} />
                  {a.status === "pending" ? <ReleaseHeldChip className="ml-2" /> : null}
                </td>
                <td className="px-3 py-2 text-xs text-muted-foreground">
                  {a.createdAt ? new Date(a.createdAt).toLocaleString() : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function approvalStatusTone(status: string) {
  if (status === "approved") return "success" as const;
  if (status === "rejected") return "danger" as const;
  if (status === "pending") return "warn" as const;
  return "neutral" as const;
}

// Re-export for tests
export const __testing = {
  hasRedactedValue,
  displayRedactedValue,
  runStatusTone,
  livenessTone,
  workspaceStatusTone,
  approvalStatusTone,
};
