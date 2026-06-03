import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { AccountWithHealth, PoolState, ProviderQuotaResult, QuotaWindow } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { accountPoolApi } from "../api/account-pool";
import { costsApi } from "../api/costs";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

const POLL_INTERVAL_MS = 30_000;

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString();
}

/** "Resets 1:10 PM" if today, else "Resets Jun 9, 11:00 AM" — friendly quota-reset text. */
function formatResetTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return `Resets ${iso}`;
  const now = new Date();
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (sameDay) return `Resets ${time}`;
  const day = date.toLocaleDateString([], { month: "short", day: "numeric" });
  return `Resets ${day}, ${time}`;
}

function healthBarColor(usedPercent: number | null, capped: boolean): string {
  if (capped) return "bg-red-600";
  if (usedPercent == null) return "bg-muted-foreground/30";
  if (usedPercent >= 80) return "bg-amber-500";
  return "bg-green-600";
}

/**
 * The live quota source can report the same window more than once (e.g. session
 * + week listed twice). Collapse by label+detail so each window shows once.
 */
function uniqueWindows(windows: QuotaWindow[]): QuotaWindow[] {
  const seen = new Set<string>();
  const out: QuotaWindow[] = [];
  for (const window of windows) {
    const fingerprint = `${window.label}|${window.detail ?? ""}|${window.usedPercent ?? ""}`;
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    out.push(window);
  }
  return out;
}

/** synthetic id for the implicit machine-default account card (never a real secret id) */
const DEFAULT_ACCOUNT_ID = "__default__";

/**
 * Build the implicit "Default — this machine" card from the existing
 * quota-windows query (provider "anthropic" = the account logged in on this
 * machine). This reuses the SAFE 5-min quota query — it does NOT add any
 * per-poll live Anthropic call (that caused the 429). Returns an
 * AccountWithHealth-shaped view model that the existing AccountCard can render.
 */
function buildDefaultCard(quota: ProviderQuotaResult[] | undefined): AccountWithHealth {
  const result = quota?.find((r) => r.provider === "anthropic");
  const windows = result?.windows ?? [];
  const pcts = windows.map((w) => w.usedPercent).filter((p): p is number => p != null);
  const usedPercent = pcts.length ? Math.max(...pcts) : null;
  const capped = pcts.some((p) => p >= 100);
  const resetsAt =
    windows
      .filter((w) => (w.usedPercent ?? 0) >= 100 && w.resetsAt)
      .map((w) => w.resetsAt as string)
      .sort()[0] ?? null;
  return {
    id: DEFAULT_ACCOUNT_ID,
    name: "Default — this machine",
    key: "Machine login (~/.claude)",
    status: "active",
    windows,
    usedPercent,
    resetsAt,
    capped,
    error: result && !result.ok ? result.error : undefined,
  };
}

/** one quota window row: label, %, mini-bar, and reset detail */
function WindowRow({ window }: { window: QuotaWindow }) {
  const pct = window.usedPercent;
  const barWidth = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const capped = pct != null && pct >= 100;
  // Reset text: prefer the provider's human text (`detail`), else format the ISO `resetsAt`.
  const resetText = window.detail ?? (window.resetsAt ? formatResetTime(window.resetsAt) : null);
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center justify-between text-xs">
        <span className="truncate text-muted-foreground">{window.label}</span>
        <span className="font-medium text-foreground">
          {pct == null ? "—" : `${Math.round(pct)}%`}
          {window.valueLabel ? ` · ${window.valueLabel}` : ""}
        </span>
      </div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted">
        <div
          className={cn("h-full rounded-full transition-all", healthBarColor(pct, capped))}
          style={{ width: `${barWidth}%` }}
        />
      </div>
      {resetText ? <span className="text-[11px] text-muted-foreground">{resetText}</span> : null}
    </div>
  );
}

function AccountCard(props: {
  account: AccountWithHealth;
  isActive: boolean;
  removable: boolean;
  onRemove: (account: AccountWithHealth) => void;
  removeDisabled: boolean;
}) {
  const { account, isActive, removable, onRemove, removeDisabled } = props;
  const pct = account.usedPercent;
  const barWidth = pct == null ? 0 : Math.min(100, Math.max(0, pct));
  const windows = uniqueWindows(account.windows);

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-md border bg-background p-4",
        isActive ? "border-green-600/60 ring-1 ring-green-600/30" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">{account.name}</span>
            {isActive ? (
              <Badge className="bg-green-600 text-white hover:bg-green-600">ACTIVE</Badge>
            ) : null}
            {account.capped ? (
              <Badge variant="destructive">Capped</Badge>
            ) : null}
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">{account.key}</p>
        </div>
        {removable ? (
          <Button
            variant="ghost"
            size="icon"
            onClick={() => onRemove(account)}
            disabled={removeDisabled}
            aria-label={`Remove ${account.name}`}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        ) : null}
      </div>

      <div className="flex flex-col gap-2">
        {/* Peak usage across all windows — the number the Balancer ranks on */}
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between text-xs">
            <span className="text-muted-foreground">Peak usage</span>
            <span className="font-medium text-foreground">
              {pct == null ? "Unknown" : `${Math.round(pct)}%`}
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted">
            <div
              className={cn("h-full rounded-full transition-all", healthBarColor(pct, account.capped))}
              style={{ width: `${barWidth}%` }}
            />
          </div>
        </div>

        {/* Per-window breakdown (session / week / …) with reset times */}
        {windows.length > 0 ? (
          <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
            {windows.map((window, index) => (
              <WindowRow key={`${window.label}-${index}`} window={window} />
            ))}
          </div>
        ) : null}

        {account.error ? (
          <p className="flex items-center gap-1 text-xs text-amber-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {account.error}
          </p>
        ) : null}
        {windows.length === 0 && !account.error ? (
          <p className="text-xs text-muted-foreground">
            {isActive
              ? "No quota windows reported yet — waiting for the next Balancer probe."
              : "Live quota is only available for the active account."}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function AccountPool() {
  const queryClient = useQueryClient();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { pushToast } = useToastActions();

  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCredentials, setAddCredentials] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AccountWithHealth | null>(null);

  useEffect(() => {
    setBreadcrumbs([{ label: "Account Pool" }]);
  }, [setBreadcrumbs]);

  const poolQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.accountPool.list(selectedCompanyId)
      : (["account-pool", "__disabled__"] as const),
    queryFn: () => accountPoolApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Live-ish health for the machine's DEFAULT account (provider "anthropic").
  // Shares the Costs page's query key + safe 5-min cadence — this does NOT add a
  // per-poll live Anthropic call (the 429 we just fixed). React Query dedupes it.
  const quotaQuery = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.usageQuotaWindows(selectedCompanyId)
      : (["usage-quota-windows", "__disabled__"] as const),
    queryFn: () => costsApi.quotaWindows(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: 300_000,
    staleTime: 60_000,
  });

  function invalidatePool() {
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.accountPool.list(selectedCompanyId) });
    }
  }

  const addMutation = useMutation({
    mutationFn: () =>
      accountPoolApi.add(selectedCompanyId!, { name: addName.trim(), credentialsJson: addCredentials }),
    onSuccess: () => {
      setAddOpen(false);
      setAddName("");
      setAddCredentials("");
      setAddError(null);
      invalidatePool();
      pushToast({ title: "Account added to pool", tone: "success" });
    },
    onError: (error) => {
      setAddError(error instanceof ApiError ? error.message : "Failed to add account");
    },
  });

  const removeMutation = useMutation({
    mutationFn: (id: string) => accountPoolApi.remove(selectedCompanyId!, id),
    onSuccess: () => {
      setRemoveTarget(null);
      invalidatePool();
      pushToast({ title: "Account removed", body: "Balancer will rebalance on next tick.", tone: "info" });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to remove account",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const refreshMutation = useMutation({
    mutationFn: () => accountPoolApi.refresh(selectedCompanyId!),
    onSuccess: (data) => {
      // write the freshly-probed list straight into the cache so the bars update now
      if (selectedCompanyId) {
        queryClient.setQueryData(queryKeys.accountPool.list(selectedCompanyId), data);
        // also refresh the default-account health (separate quota query)
        queryClient.invalidateQueries({ queryKey: queryKeys.usageQuotaWindows(selectedCompanyId) });
      }
      const erroredCount = data.accounts.filter((a) => a.error).length;
      pushToast({
        title: "Health refreshed",
        body: erroredCount > 0 ? `${erroredCount} account(s) couldn't be reached (showing last known).` : undefined,
        tone: erroredCount > 0 ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to refresh health",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const stopMutation = useMutation({
    mutationFn: (next: boolean) =>
      next ? accountPoolApi.engageStop(selectedCompanyId!) : accountPoolApi.releaseStop(selectedCompanyId!),
    onSuccess: (_data, next) => {
      invalidatePool();
      pushToast({
        title: next ? "Rotation STOPPED" : "Rotation resumed",
        tone: next ? "warn" : "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update STOP switch",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const data = poolQuery.data;
  const accounts: AccountWithHealth[] = data?.accounts ?? [];
  const state: PoolState | null = data?.state ?? null;
  const activeId = state?.activeAccountId ?? null;
  const rotationStopped = state?.rotationStopped ?? false;

  // The implicit "Default — this machine" account, always shown first. It's
  // ACTIVE whenever no pooled account is active (Slice 3's fallback semantics).
  const defaultCard = useMemo(() => buildDefaultCard(quotaQuery.data), [quotaQuery.data]);
  const poolActive = activeId != null;

  function openAdd() {
    setAddName("");
    setAddCredentials("");
    setAddError(null);
    setAddOpen(true);
  }

  function submitAdd() {
    if (!addName.trim()) {
      setAddError("Name is required.");
      return;
    }
    if (!addCredentials.trim()) {
      setAddError("Paste the .credentials.json content.");
      return;
    }
    try {
      JSON.parse(addCredentials);
    } catch {
      setAddError("Credentials must be valid JSON.");
      return;
    }
    addMutation.mutate();
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-6 p-4 sm:p-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-lg font-bold text-foreground">Account Pool</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Pool Claude Max accounts. The whole team rides together on the healthiest account; the
            Balancer rotates automatically when one hits its quota.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            onClick={() => refreshMutation.mutate()}
            disabled={!selectedCompanyId || refreshMutation.isPending}
            title="Re-probe live quota for every account now"
          >
            <RefreshCw className={cn("mr-1.5 h-4 w-4", refreshMutation.isPending && "animate-spin")} />
            Reload
          </Button>
          <Button onClick={openAdd} disabled={!selectedCompanyId}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add account
          </Button>
        </div>
      </header>

      {/* STOP switch + last rotation */}
      <div className="flex flex-col gap-3 rounded-md border border-border bg-muted/30 p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-start gap-2">
          <ShieldAlert
            className={cn("mt-0.5 h-5 w-5 shrink-0", rotationStopped ? "text-amber-600" : "text-muted-foreground")}
          />
          <div>
            <p className="text-sm font-medium text-foreground">Automatic rotation STOP switch</p>
            <p className="text-xs text-muted-foreground">
              {rotationStopped
                ? `Frozen — the team stays on the current account even if it hits its quota${state?.stopReason ? ` (${state.stopReason})` : ""}.`
                : "Auto-rotate is on — when the active account hits its quota, the Balancer moves the whole team to the healthiest one. (Only takes effect with 2+ accounts.)"}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Last assignment: {formatTimestamp(state?.assignedAt ?? null)}
              {state?.reason ? ` (${state.reason})` : ""}
            </p>
          </div>
        </div>
        <ToggleSwitch
          checked={rotationStopped}
          onCheckedChange={(next) => stopMutation.mutate(next)}
          disabled={!selectedCompanyId || stopMutation.isPending}
          aria-label="Toggle rotation STOP switch"
        />
      </div>

      {/* Body states */}
      {poolQuery.isLoading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="mr-2 h-5 w-5 animate-spin" />
          Loading accounts…
        </div>
      ) : poolQuery.isError ? (
        <div className="flex flex-col items-center justify-center gap-3 rounded-md border border-destructive/40 bg-destructive/5 py-16 text-center">
          <AlertCircle className="h-8 w-8 text-destructive" />
          <p className="text-sm text-destructive">
            {poolQuery.error instanceof ApiError
              ? poolQuery.error.message
              : "Failed to load the account pool."}
          </p>
          <Button variant="outline" onClick={() => poolQuery.refetch()}>
            Retry
          </Button>
        </div>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {/* The machine's default account — always shown, never removable */}
            <AccountCard
              key={defaultCard.id}
              account={defaultCard}
              isActive={!poolActive}
              removable={false}
              onRemove={setRemoveTarget}
              removeDisabled={false}
            />
            {accounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                isActive={account.id === activeId}
                removable
                onRemove={setRemoveTarget}
                removeDisabled={removeMutation.isPending}
              />
            ))}
          </div>
          {accounts.length === 0 ? (
            <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Layers className="h-3.5 w-3.5 shrink-0" />
              This is the account your agents already use. Add more Claude accounts to rotate across them when one hits its quota.
            </p>
          ) : null}
        </div>
      )}

      {/* Add account dialog */}
      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add account to pool</DialogTitle>
            <DialogDescription>
              Paste the raw contents of the account&apos;s <code>.credentials.json</code> file. It is
              stored encrypted in the company secret store.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="pool-account-name">
                Name
              </label>
              <Input
                id="pool-account-name"
                value={addName}
                onChange={(event) => setAddName(event.target.value)}
                placeholder="Claude Max #1"
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs font-medium text-foreground" htmlFor="pool-account-creds">
                .credentials.json
              </label>
              <Textarea
                id="pool-account-creds"
                value={addCredentials}
                onChange={(event) => setAddCredentials(event.target.value)}
                placeholder='{"claudeAiOauth":{ ... }}'
                rows={8}
                className="font-mono text-xs"
              />
            </div>
            {addError ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {addError}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addMutation.isPending}>
              Cancel
            </Button>
            <Button onClick={submitAdd} disabled={addMutation.isPending}>
              {addMutation.isPending ? (
                <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
              ) : (
                <CheckCircle2 className="mr-1.5 h-4 w-4" />
              )}
              Add account
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Remove confirm dialog */}
      <Dialog open={Boolean(removeTarget)} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Remove account</DialogTitle>
            <DialogDescription>
              Remove <strong>{removeTarget?.name}</strong> from the pool? If it is the active account,
              the Balancer will rebalance the team onto another account.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)} disabled={removeMutation.isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={() => removeTarget && removeMutation.mutate(removeTarget.id)}
              disabled={removeMutation.isPending}
            >
              {removeMutation.isPending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
              Remove
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
