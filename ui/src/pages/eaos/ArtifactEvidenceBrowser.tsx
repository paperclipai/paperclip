/**
 * LET-326: read-only Artifact / Evidence browser.
 *
 * Sources normalized into a single ArtifactRow shape:
 *   - Sandbox lease artifact summaries (count/present only) — from LET-314
 *     read-models. These are never opened, just counted.
 *   - Approval entries — surfaced as "approval evidence" rows.
 *   - Pending live runs — surfaced as "runtime evidence" rows for traceability.
 *
 * No raw paths, no signed URLs, no env. Every row has explicit source class,
 * status, redaction, expiry (when known), and provenance labels. Missing
 * fields render as <UnknownChip /> rather than collapsing into "ok".
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { FileBox } from "lucide-react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { sandboxApi, type SandboxLeaseReadModel } from "@/api/sandbox";
import { approvalsApi } from "@/api/approvals";
import { heartbeatsApi } from "@/api/heartbeats";
import { queryKeys } from "@/lib/queryKeys";
import {
  BackendBackedChip,
  PreviewChip,
  ReadOnlyChip,
  RedactedChip,
  StateChip,
  UnknownChip,
} from "./EaosChips";
import { truthToSourceClass, type SourceClass } from "./eaos-state-labels";

export interface ArtifactRow {
  id: string;
  kind: "lease-artifact" | "approval-evidence" | "run-evidence";
  type: string;
  title: string;
  status: string;
  sourceClass: SourceClass;
  provenance: string;
  expiry: string | null;
  redacted: boolean;
  /** Optional pointer back to source row (lease id, approval id, run id). */
  sourceId?: string;
  /** Optional creation/observed time string. */
  observedAt?: string | null;
}

interface ArtifactEvidenceBrowserProps {
  companyId: string;
}

export function ArtifactEvidenceBrowser({ companyId }: ArtifactEvidenceBrowserProps) {
  const leasesQuery = useQuery({
    queryKey: queryKeys.sandbox.leases(companyId, { kind: "for-artifacts" }),
    queryFn: () => sandboxApi.listLeases(companyId, { limit: 50 }),
  });

  const approvalsQuery = useQuery({
    queryKey: queryKeys.approvals.list(companyId, "pending"),
    queryFn: () => approvalsApi.list(companyId, "pending"),
  });

  const runsQuery = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { limit: 25 }),
    refetchInterval: 15_000,
  });

  const rows = useMemo<ArtifactRow[]>(() => {
    const out: ArtifactRow[] = [];
    for (const lease of leasesQuery.data?.leases ?? []) {
      out.push(...artifactRowsFromLease(lease));
    }
    for (const approval of approvalsQuery.data ?? []) {
      out.push({
        id: `approval-${approval.id}`,
        kind: "approval-evidence",
        type: approval.type,
        title: approvalEvidenceTitle(approval),
        status: approval.status,
        sourceClass: "backend-backed",
        provenance: "approvals API",
        expiry: null,
        redacted: false,
        sourceId: approval.id,
        observedAt: approval.createdAt ? new Date(approval.createdAt).toISOString() : null,
      });
    }
    for (const run of runsQuery.data ?? []) {
      out.push({
        id: `run-${run.id}`,
        kind: "run-evidence",
        type: "heartbeat-run",
        title: `Run ${run.id.slice(0, 8)} (${run.adapterType})`,
        status: run.status,
        sourceClass: "backend-backed",
        provenance: "heartbeat-runs API",
        expiry: null,
        redacted: false,
        sourceId: run.id,
        observedAt: run.startedAt ? new Date(run.startedAt).toISOString() : null,
      });
    }
    return out;
  }, [leasesQuery.data, approvalsQuery.data, runsQuery.data]);

  const loading = leasesQuery.isLoading || approvalsQuery.isLoading || runsQuery.isLoading;
  const error = leasesQuery.isError || approvalsQuery.isError || runsQuery.isError;
  const partial = leasesQuery.isError || approvalsQuery.isError || runsQuery.isError;

  return (
    <Card className="rounded-2xl border-border/80">
      <CardHeader>
        <div className="flex flex-wrap items-center gap-2">
          <FileBox aria-hidden="true" className="h-4 w-4 text-muted-foreground" />
          <CardTitle className="text-base">Artifacts &amp; evidence</CardTitle>
          <ReadOnlyChip />
          <PreviewChip />
        </div>
        <CardDescription>
          Normalized from lease artifact summaries, approvals, and run records. No raw paths or URLs are
          rendered. Missing fields show <strong>Unknown</strong> rather than green.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="rounded-md border border-dashed border-border bg-muted/30 p-4 text-sm text-muted-foreground" role="status" aria-live="polite">
            Loading…
          </div>
        ) : null}
        {error ? (
          <div className="rounded-md border border-red-400/40 bg-red-500/5 p-4 text-sm text-red-600 dark:text-red-300" role="alert">
            One or more sources failed to load. Missing rows are not green — treat as <UnknownChip className="ml-1 inline-flex" />.
          </div>
        ) : null}
        {!loading && !error && rows.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-muted/20 p-4 text-sm text-muted-foreground">
            No artifacts reported. Lease artifacts, approvals, and runs are all empty.
          </div>
        ) : null}
        {rows.length > 0 ? (
          <div className="overflow-x-auto rounded-md border border-border">
            <table className="min-w-full divide-y divide-border text-sm">
              <thead className="bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                <tr>
                  <th scope="col" className="px-3 py-2 font-medium">Artifact</th>
                  <th scope="col" className="px-3 py-2 font-medium">Type</th>
                  <th scope="col" className="px-3 py-2 font-medium">Status</th>
                  <th scope="col" className="px-3 py-2 font-medium">Source</th>
                  <th scope="col" className="px-3 py-2 font-medium">Redaction</th>
                  <th scope="col" className="px-3 py-2 font-medium">Expiry</th>
                  <th scope="col" className="px-3 py-2 font-medium">Provenance</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border bg-card">
                {rows.map((row) => (
                  <tr key={row.id} className="hover:bg-muted/30">
                    <td className="px-3 py-2 align-top">
                      <div className="text-xs font-medium">{row.title}</div>
                      {row.sourceId ? (
                        <div className="mt-1 font-mono text-[11px] text-muted-foreground">{row.sourceId.slice(0, 16)}…</div>
                      ) : null}
                      {row.observedAt ? (
                        <div className="mt-1 text-[11px] text-muted-foreground">
                          {new Date(row.observedAt).toLocaleString()}
                        </div>
                      ) : null}
                    </td>
                    <td className="px-3 py-2 align-top text-xs">{row.type}</td>
                    <td className="px-3 py-2 align-top text-xs">
                      <StateChip label={row.status} tone={artifactStatusTone(row.status)} />
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.sourceClass === "backend-backed" ? <BackendBackedChip /> : null}
                      {row.sourceClass === "backend-derived" ? (
                        <StateChip label="Backend-derived" tone="info" />
                      ) : null}
                      {row.sourceClass === "preview" ? <PreviewChip /> : null}
                      {row.sourceClass === "unknown" ? <UnknownChip /> : null}
                    </td>
                    <td className="px-3 py-2 align-top">
                      {row.redacted ? <RedactedChip short /> : <StateChip label="No redaction" tone="neutral" />}
                    </td>
                    <td className="px-3 py-2 align-top text-xs">
                      {row.expiry ? new Date(row.expiry).toLocaleString() : <UnknownChip label="No expiry" />}
                    </td>
                    <td className="px-3 py-2 align-top text-xs text-muted-foreground">{row.provenance}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}
        {partial && rows.length > 0 ? (
          <p className="mt-3 text-xs text-muted-foreground" role="status" aria-live="polite">
            Some sources failed to load. Rows below are partial; missing entries are not green.
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}

export function artifactRowsFromLease(lease: SandboxLeaseReadModel): ArtifactRow[] {
  if (!lease.artifacts.present) return [];
  return [
    {
      id: `lease-artifacts-${lease.id}`,
      kind: "lease-artifact",
      type: "sandbox-artifact",
      title: `Sandbox lease artifacts (${lease.artifacts.count})`,
      status: lease.cleanupStatus ?? "unknown",
      sourceClass: truthToSourceClass(lease.truth),
      provenance: lease.provider ? `provider:${lease.provider}` : "sandbox",
      expiry: lease.expiresAt,
      redacted: true,
      sourceId: lease.id,
      observedAt: lease.lastUsedAt,
    },
  ];
}

function approvalEvidenceTitle(approval: { type: string; id: string }): string {
  return `Approval ${approval.id.slice(0, 8)} (${approval.type})`;
}

function artifactStatusTone(status: string) {
  if (status === "active" || status === "ready" || status === "approved") return "success" as const;
  if (status === "complete" || status === "delivered" || status === "succeeded" || status === "completed") return "success" as const;
  if (status === "failed" || status === "error" || status === "rejected") return "danger" as const;
  if (status === "pending" || status === "in_progress") return "info" as const;
  if (!status || status === "unknown") return "warn" as const;
  return "neutral" as const;
}

export const __testing = {
  artifactRowsFromLease,
  artifactStatusTone,
};
