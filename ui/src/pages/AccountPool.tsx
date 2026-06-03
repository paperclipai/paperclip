import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  Layers,
  Loader2,
  Plus,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { AccountWithHealth, PoolState } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { accountPoolApi } from "../api/account-pool";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { EmptyState } from "../components/EmptyState";
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

function healthBarColor(usedPercent: number | null, capped: boolean): string {
  if (capped) return "bg-red-600";
  if (usedPercent == null) return "bg-muted-foreground/30";
  if (usedPercent >= 80) return "bg-amber-500";
  return "bg-green-600";
}

function AccountCard(props: {
  account: AccountWithHealth;
  isActive: boolean;
  onRemove: (account: AccountWithHealth) => void;
  removeDisabled: boolean;
}) {
  const { account, isActive, onRemove, removeDisabled } = props;
  const pct = account.usedPercent;
  const barWidth = pct == null ? 0 : Math.min(100, Math.max(0, pct));

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
        <Button
          variant="ghost"
          size="icon"
          onClick={() => onRemove(account)}
          disabled={removeDisabled}
          aria-label={`Remove ${account.name}`}
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </div>

      <div className="flex flex-col gap-1">
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">Usage</span>
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
        <div className="mt-1 flex items-center justify-between text-xs text-muted-foreground">
          <span>{account.resetsAt ? `Resets ${formatTimestamp(account.resetsAt)}` : "No reset reported"}</span>
        </div>
        {account.error ? (
          <p className="mt-1 flex items-center gap-1 text-xs text-amber-600">
            <AlertCircle className="h-3.5 w-3.5 shrink-0" />
            {account.error}
          </p>
        ) : null}
        {!isActive && account.windows.length === 0 && !account.error ? (
          <p className="mt-1 text-xs text-muted-foreground">
            Live quota is only available for the active account.
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
        <Button onClick={openAdd} disabled={!selectedCompanyId}>
          <Plus className="mr-1.5 h-4 w-4" />
          Add account
        </Button>
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
                ? `Rotation is halted${state?.stopReason ? ` — ${state.stopReason}` : ""}.`
                : "Rotation is active. Engage to freeze the team on the current account."}
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
      ) : accounts.length === 0 ? (
        <EmptyState
          icon={Layers}
          message="No accounts in the pool yet. Add a Claude account to get started."
          action="Add account"
          onAction={openAdd}
        />
      ) : (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          {accounts.map((account) => (
            <AccountCard
              key={account.id}
              account={account}
              isActive={account.id === activeId}
              onRemove={setRemoveTarget}
              removeDisabled={removeMutation.isPending}
            />
          ))}
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
