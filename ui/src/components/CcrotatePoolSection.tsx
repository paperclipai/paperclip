import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ccrotateApi, type CcrotateAccountRow, type CcrotateTarget } from "../api/ccrotate";
import { queryKeys } from "@/lib/queryKeys";
import { ApiError } from "../api/client";
import { cn } from "@/lib/utils";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

interface CcrotatePoolSectionProps {
  companyId: string;
  target: CcrotateTarget;
}

/** Renders the multi-account ccrotate pool for a single target (claude or codex).
 * Designed to slot into ProviderQuotaCard alongside the single-account
 * ClaudeSubscriptionPanel / CodexSubscriptionPanel — those show the *active*
 * account; this shows every snapped account so an operator can see what the
 * pool will rotate to next. */
export function CcrotatePoolSection({ companyId, target }: CcrotatePoolSectionProps) {
  const queryClient = useQueryClient();
  const [importOpen, setImportOpen] = useState(false);
  const [importBlob, setImportBlob] = useState("");
  const [importError, setImportError] = useState<string | null>(null);
  const [refreshError, setRefreshError] = useState<string | null>(null);

  const { data, error, isLoading } = useQuery({
    queryKey: queryKeys.ccrotate.snapshot(companyId),
    queryFn: () => ccrotateApi.snapshot(companyId),
    enabled: !!companyId,
    refetchInterval: 30_000,
    retry: false,
  });

  const refreshMutation = useMutation({
    mutationFn: () => ccrotateApi.refresh(companyId),
    onSuccess: (res) => {
      setRefreshError(null);
      // Partial-failure case: 200 with errors[]. Surface a short note but
      // still re-render the snapshot since ccrotate writes through whatever
      // it was able to update.
      if (res.errors && res.errors.length > 0) {
        setRefreshError(
          `partial: ${res.errors.map((e) => `${e.target}: ${e.error}`).join("; ")}`,
        );
      }
      queryClient.invalidateQueries({ queryKey: queryKeys.ccrotate.snapshot(companyId) });
    },
    onError: (err) => {
      setRefreshError(err instanceof Error ? err.message : String(err));
    },
  });

  const importMutation = useMutation({
    mutationFn: (blob: string) => ccrotateApi.import(companyId, blob),
    onSuccess: (res) => {
      setImportError(null);
      setImportOpen(false);
      setImportBlob("");
      queryClient.invalidateQueries({ queryKey: queryKeys.ccrotate.snapshot(companyId) });
      // After import the cache is fresh-but-imported (no API hit) — kick off
      // a refresh so the UI reflects current per-account utilization rather
      // than whatever was captured at export time on the source host.
      void refreshMutation.mutateAsync();
      void res; // imported summary is in the response if we ever want to surface it
    },
    onError: (err) => {
      setImportError(err instanceof Error ? err.message : String(err));
    },
  });

  // Plugin-not-installed (404) is expected for instances that haven't installed
  // kkroo.ccrotate — render nothing rather than an error.
  if (error instanceof ApiError && error.status === 404) return null;

  const slot = data?.targets?.[target];

  // Nothing useful to show: no plugin response yet, or the plugin returned an
  // empty pool for this target. Stay silent rather than render an empty card.
  if (!data && !isLoading) return null;
  if (data && !slot?.error && (!slot?.accounts || slot.accounts.length === 0)) return null;

  const accounts = slot?.accounts ?? [];

  return (
    <>
      <div className="border-t border-border" />
      <div className="space-y-2">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            ccrotate pool
          </p>
          <div className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
              {accounts.length} account{accounts.length === 1 ? "" : "s"}
              {data?.cacheAge ? ` · ${data.cacheAge}` : ""}
            </span>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] uppercase tracking-wider"
              disabled={refreshMutation.isPending}
              onClick={() => refreshMutation.mutate()}
              aria-label="Refresh ccrotate pool"
            >
              {refreshMutation.isPending ? "Refreshing…" : "Refresh"}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-2 text-[10px] uppercase tracking-wider"
              onClick={() => {
                setImportError(null);
                setImportOpen(true);
              }}
              aria-label="Import ccrotate snapshot"
            >
              Import
            </Button>
          </div>
        </div>
        {refreshError ? <p className="text-xs text-destructive">{refreshError}</p> : null}
        {error instanceof Error && !(error instanceof ApiError && error.status === 404) ? (
          <p className="text-xs text-destructive">{error.message}</p>
        ) : null}
        {slot?.error ? <p className="text-xs text-destructive">{slot.error}</p> : null}
        <div className="space-y-1.5">
          <PoolHeader />
          {accounts.map((row) => (
            <PoolRow key={row.email} row={row} />
          ))}
        </div>
      </div>
      <Dialog open={importOpen} onOpenChange={setImportOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Import ccrotate snapshot</DialogTitle>
            <DialogDescription>
              Paste a <code className="font-mono">mp-gz-b64:…</code> blob from{" "}
              <code className="font-mono">ccrotate export</code> on a healthy host. The
              snapshot is imported on this pod (sync-aware merge — local entries
              fresher than the import are kept) and persisted so future Job pods
              re-import the same canonical state on preRun.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={importBlob}
            onChange={(e) => setImportBlob(e.target.value)}
            placeholder="mp-gz-b64:…"
            rows={8}
            className="font-mono text-[11px] leading-snug"
            disabled={importMutation.isPending}
            spellCheck={false}
          />
          {importError ? <p className="text-xs text-destructive">{importError}</p> : null}
          <DialogFooter>
            <Button
              variant="ghost"
              onClick={() => setImportOpen(false)}
              disabled={importMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              disabled={importMutation.isPending || !importBlob.trim().startsWith("mp-gz-b64:")}
              onClick={() => importMutation.mutate(importBlob.trim())}
            >
              {importMutation.isPending ? "Importing…" : "Import"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Column headings for the pool table — kept in sync with PoolRow widths.
 * Model-specific 7d-Sonnet and 7d-Opus columns were removed: the per-model
 * breakdown is rarely actionable for an operator (rotation decisions hinge on
 * the all-models 7d total + the 5h session window), and dropping them frees
 * horizontal space for the availability text on narrow viewports. The data
 * is still in the API row if a future view needs it. */
function PoolHeader() {
  return (
    <div className="flex items-center gap-2 text-[10px] uppercase tracking-wider text-muted-foreground">
      <span className="shrink-0 w-3" aria-hidden />
      <span className="flex-1 min-w-0">Email</span>
      <span className="shrink-0 w-14 text-center">Tier</span>
      <span className="shrink-0 w-12 text-right" title="5-hour session window">5h</span>
      <span className="shrink-0 w-12 text-right" title="7-day window (all models)">7d</span>
      <span className="shrink-0 w-24 text-right">Availability</span>
      <span className="shrink-0 w-28 text-right">API limit</span>
    </div>
  );
}

function PoolRow({ row }: { row: CcrotateAccountRow }) {
  const tierColor = tierColorClass(row.tier);
  const u5Color = utilColorClass(row.utilization5h);
  const u7Color = utilColorClass(row.utilization7d);
  return (
    <div
      className={cn(
        "flex items-center gap-2 text-xs tabular-nums",
        !row.isHealthy && "opacity-55",
      )}
    >
      <span
        className={cn(
          "shrink-0 w-3 text-center font-bold",
          row.isActive ? "text-yellow-400" : row.isHealthy ? "text-green-400" : "text-red-400",
        )}
      >
        {row.isActive ? "★" : row.isHealthy ? "✓" : "✗"}
      </span>
      <span className="font-mono truncate flex-1 min-w-0">{row.email}</span>
      <span
        className={cn(
          "shrink-0 w-14 text-center px-1.5 py-0.5 rounded text-[10px] font-semibold lowercase",
          tierColor,
        )}
      >
        {row.tier}
      </span>
      <span className={cn("font-mono shrink-0 w-12 text-right", u5Color)}>
        {row.utilization5h === null ? "—" : `${row.utilization5h}%`}
      </span>
      <span className={cn("font-mono shrink-0 w-12 text-right", u7Color)}>
        {row.utilization7d === null ? "—" : `${row.utilization7d}%`}
      </span>
      <span className="text-muted-foreground shrink-0 w-24 text-right truncate">
        {row.availability}
      </span>
      <span className="text-muted-foreground shrink-0 w-28 text-right truncate" title={row.apiLimit ?? "unknown"}>
        {row.apiLimit ?? "unknown"}
      </span>
    </div>
  );
}

function tierColorClass(tier: string): string {
  const t = tier.toLowerCase();
  if (t === "base" || t === "available") return "bg-green-500/15 text-green-400";
  if (t === "extra" || t === "near_limit") return "bg-yellow-500/15 text-yellow-400";
  if (t === "exhausted" || t === "stale") return "bg-red-500/15 text-red-400";
  return "bg-muted text-muted-foreground";
}

function utilColorClass(pct: number | null): string {
  if (pct === null) return "text-muted-foreground";
  if (pct >= 95) return "text-red-400";
  if (pct >= 70) return "text-yellow-400";
  return "text-foreground";
}
