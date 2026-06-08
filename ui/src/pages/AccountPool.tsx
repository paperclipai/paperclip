import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Layers,
  Loader2,
  Plus,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import type { AccountWithHealth, PoolProvider, PoolState, QuotaWindow } from "@paperclipai/shared";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { accountPoolApi } from "../api/account-pool";
import { ApiError } from "../api/client";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
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

/** synthetic id the server uses for the implicit machine-default account card */
const DEFAULT_ACCOUNT_ID = "__default__";

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
  showRotationToggle: boolean;
  onToggleRotation: (account: AccountWithHealth, enabled: boolean) => void;
  rotationToggleDisabled: boolean;
  /** checkbox label; defaults to "Include in auto-rotation" */
  rotationToggleLabel?: string;
  /** optional one-line clarifier shown under the checkbox */
  rotationToggleHint?: string;
}) {
  const {
    account,
    isActive,
    removable,
    onRemove,
    removeDisabled,
    showRotationToggle,
    onToggleRotation,
    rotationToggleDisabled,
    rotationToggleLabel = "Include in auto-rotation",
    rotationToggleHint,
  } = props;
  const windows = uniqueWindows(account.windows);
  const rotationEnabled = account.rotationEnabled !== false;

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
            {account.subscriptionType ? (
              <Badge variant="outline">{account.subscriptionType}</Badge>
            ) : null}
          </div>
          {/* email when known (the account identity), else the key/source line */}
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {account.email ?? account.key}
          </p>
          {showRotationToggle ? (
            <div className="mt-2 flex flex-col gap-0.5">
              <label className="flex w-fit cursor-pointer items-center gap-1.5 text-xs text-muted-foreground">
                <Checkbox
                  checked={rotationEnabled}
                  disabled={rotationToggleDisabled}
                  onCheckedChange={(checked) => onToggleRotation(account, checked === true)}
                />
                {rotationToggleLabel}
              </label>
              {rotationToggleHint ? (
                <p className="pl-6 text-[11px] text-muted-foreground/80">{rotationToggleHint}</p>
              ) : null}
            </div>
          ) : null}
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
        {/* Per-window breakdown (session / week / extra usage) with reset times */}
        {windows.length > 0 ? (
          <div className="flex flex-col gap-2">
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
            Click <span className="font-medium text-foreground">Reload</span> to load this account&apos;s quota.
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

  const [provider, setProvider] = useState<PoolProvider>("claude");
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState("");
  const [addCredentials, setAddCredentials] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [removeTarget, setRemoveTarget] = useState<AccountWithHealth | null>(null);
  // "Login with Claude" OAuth flow state
  const [oauth, setOauth] = useState<{ authorizeUrl: string; state: string; codeVerifier: string } | null>(null);
  const [pastedCode, setPastedCode] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);

  useEffect(() => {
    setBreadcrumbs([{ label: "Account Pool" }]);
  }, [setBreadcrumbs]);

  const poolQuery = useQuery({
    queryKey: selectedCompanyId
      ? ([...queryKeys.accountPool.list(selectedCompanyId), provider] as const)
      : (["account-pool", "__disabled__"] as const),
    queryFn: () => accountPoolApi.list(selectedCompanyId!, provider),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Which pool the shared `auto_rotation` adapter is currently riding (across
  // both providers). Provider-agnostic, so it polls once regardless of the tab.
  const autoRotationQuery = useQuery({
    queryKey: selectedCompanyId
      ? (["account-pool", "auto-rotation-state", selectedCompanyId] as const)
      : (["account-pool", "auto-rotation-state", "__disabled__"] as const),
    queryFn: () => accountPoolApi.autoRotationPreview(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    refetchInterval: POLL_INTERVAL_MS,
  });
  const autoRotationProvider = autoRotationQuery.data?.provider ?? null;

  function invalidatePool() {
    if (selectedCompanyId) {
      // prefix match invalidates every provider variant of the list key
      queryClient.invalidateQueries({ queryKey: queryKeys.accountPool.list(selectedCompanyId) });
    }
  }

  const addMutation = useMutation({
    mutationFn: () =>
      accountPoolApi.add(selectedCompanyId!, { name: addName.trim(), credentialsJson: addCredentials, provider }),
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

  const oauthStartMutation = useMutation({
    mutationFn: () => accountPoolApi.oauthStart(selectedCompanyId!),
    onSuccess: (data) => {
      setOauth(data);
      setAddError(null);
      // NOTE: do NOT auto-open in this browser — it's signed into the default
      // account, so it would just re-authorize the SAME account. The user must
      // open the link in a browser/profile signed into the account they want to
      // pool. We surface a copyable link instead.
    },
    onError: (error) => {
      setAddError(error instanceof ApiError ? error.message : "Failed to start login");
    },
  });

  const oauthCompleteMutation = useMutation({
    mutationFn: () =>
      accountPoolApi.oauthComplete(selectedCompanyId!, {
        code: pastedCode.trim(),
        state: oauth?.state ?? "",
        codeVerifier: oauth?.codeVerifier ?? "",
      }),
    onSuccess: (account) => {
      setAddOpen(false);
      setOauth(null);
      setPastedCode("");
      setAddError(null);
      invalidatePool();
      pushToast({ title: `Added ${account.name}`, tone: "success" });
    },
    onError: (error) => {
      setAddError(error instanceof ApiError ? error.message : "Failed to complete login");
      // A code can only be exchanged once; after any failure it's spent (or the
      // endpoint is throttled). Reset to the "Login with Claude" step so the only
      // path forward is a FRESH code + a single clean exchange — this prevents
      // re-submitting a dead code, which is what piles up into a 429.
      setOauth(null);
      setPastedCode("");
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
    mutationFn: () => accountPoolApi.refresh(selectedCompanyId!, provider),
    onSuccess: (data) => {
      // write the freshly-probed list (incl. default) straight into the cache
      if (selectedCompanyId) {
        queryClient.setQueryData([...queryKeys.accountPool.list(selectedCompanyId), provider], data);
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
      next ? accountPoolApi.engageStop(selectedCompanyId!, provider) : accountPoolApi.releaseStop(selectedCompanyId!, provider),
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

  const rotationMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      accountPoolApi.setRotationEnabled(selectedCompanyId!, id, enabled, provider),
    onSuccess: (data) => {
      if (selectedCompanyId) {
        queryClient.setQueryData([...queryKeys.accountPool.list(selectedCompanyId), provider], data);
      }
    },
    onError: (error) => {
      pushToast({
        title: "Failed to update rotation setting",
        body: error instanceof ApiError ? error.message : undefined,
        tone: "error",
      });
    },
  });

  const data = poolQuery.data;
  // The server prepends the implicit "Default — this machine" card (id
  // DEFAULT_ACCOUNT_ID) to accounts. Pooled accounts follow.
  const accounts: AccountWithHealth[] = data?.accounts ?? [];
  const state: PoolState | null = data?.state ?? null;
  const activeId = state?.activeAccountId ?? null;
  const rotationStopped = state?.rotationStopped ?? false;
  const poolCount = accounts.filter((a) => a.id !== DEFAULT_ACCOUNT_ID).length;

  // Which card is ACTIVE: the default card when no pooled account is active
  // (activeId === null == Slice 3's "use local" fallback), else the matching pool.
  function isAccountActive(account: AccountWithHealth): boolean {
    return account.id === DEFAULT_ACCOUNT_ID ? activeId == null : account.id === activeId;
  }

  function openAdd() {
    setAddName("");
    setAddCredentials("");
    setAddError(null);
    setOauth(null);
    setPastedCode("");
    setShowAdvanced(false);
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

      {/* Provider tabs — each provider has its own pool + STOP switch */}
      <div className="flex w-fit items-center gap-1 rounded-md border border-border bg-muted/30 p-1">
        {(["claude", "codex"] as const).map((p) => (
          <button
            key={p}
            type="button"
            onClick={() => setProvider(p)}
            className={cn(
              "flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors",
              provider === p
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {p === "claude" ? "Claude" : "Codex"}
            {autoRotationProvider === p ? (
              <Badge
                variant="outline"
                className="border-green-600/50 px-1.5 py-0 text-[10px] font-medium text-green-700 dark:text-green-500"
                title="The shared auto_rotation adapter is currently riding this pool"
              >
                <span className="mr-1 inline-block h-1.5 w-1.5 rounded-full bg-green-600" />
                Rotation Active
              </Badge>
            ) : null}
          </button>
        ))}
      </div>

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
            {accounts.map((account) => {
              const isDefault = account.id === DEFAULT_ACCOUNT_ID;
              return (
                <AccountCard
                  key={account.id}
                  account={account}
                  isActive={isAccountActive(account)}
                  removable={!isDefault}
                  onRemove={setRemoveTarget}
                  removeDisabled={removeMutation.isPending}
                  showRotationToggle
                  rotationToggleLabel={
                    isDefault ? "Let auto-rotation use this machine's login" : "Include in auto-rotation"
                  }
                  rotationToggleHint={
                    isDefault
                      ? "Only affects auto_rotation's cross-pool pick — claude_local / codex_local always fall back to this login."
                      : undefined
                  }
                  onToggleRotation={(acc, enabled) => rotationMutation.mutate({ id: acc.id, enabled })}
                  rotationToggleDisabled={rotationMutation.isPending}
                />
              );
            })}
          </div>
          {poolCount === 0 ? (
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
            <DialogTitle>{provider === "codex" ? "Add a Codex account" : "Add a Claude account"}</DialogTitle>
            <DialogDescription>
              {provider === "codex"
                ? "Run `codex login` on a machine signed into the account you want to pool, then paste the contents of ~/.codex/auth.json here. Stored encrypted in the company secret store."
                : "Generate a login link, open it in a browser signed into the account you want to pool, then paste the code it shows back here. Stored encrypted in the company secret store."}
            </DialogDescription>
          </DialogHeader>

          {/* Codex: paste auth.json directly (no in-app OAuth) */}
          {provider === "codex" ? (
            <div className="flex flex-col gap-3">
              <Input
                value={addName}
                onChange={(event) => setAddName(event.target.value)}
                placeholder="Account name (e.g. Codex #1)"
              />
              <Textarea
                value={addCredentials}
                onChange={(event) => setAddCredentials(event.target.value)}
                placeholder='{"tokens":{"access_token":"...","refresh_token":"...","account_id":"..."}}'
                rows={7}
                className="font-mono text-xs"
              />
              <Button onClick={submitAdd} disabled={addMutation.isPending}>
                {addMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                )}
                Add Codex account
              </Button>
              {addError ? (
                <p className="flex items-center gap-1 text-xs text-destructive">
                  <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                  {addError}
                </p>
              ) : null}
            </div>
          ) : (
          <div className="flex flex-col gap-4">
            {/* Step 1: get the login link */}
            {!oauth ? (
              <Button
                onClick={() => oauthStartMutation.mutate()}
                disabled={!selectedCompanyId || oauthStartMutation.isPending}
              >
                {oauthStartMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <ExternalLink className="mr-1.5 h-4 w-4" />
                )}
                Login with Claude
              </Button>
            ) : (
              <div className="flex flex-col gap-3">
                <div className="rounded-md border border-amber-600/40 bg-amber-600/5 p-2.5">
                  <p className="text-xs text-amber-700 dark:text-amber-500">
                    <strong>Open this link in a browser signed into the account you want to add</strong>
                    {" "}— e.g. a different browser, an incognito/private window, or another profile.
                    Opening it here would just re-add this machine&apos;s current account.
                  </p>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-foreground">Login link</label>
                  <div className="flex items-center gap-2">
                    <Input readOnly value={oauth.authorizeUrl} className="font-mono text-[11px]" onFocus={(e) => e.currentTarget.select()} />
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => {
                        void navigator.clipboard?.writeText(oauth.authorizeUrl);
                        pushToast({ title: "Login link copied", tone: "success" });
                      }}
                    >
                      Copy
                    </Button>
                  </div>
                </div>
                <div className="flex flex-col gap-1.5">
                  <label className="text-xs font-medium text-foreground" htmlFor="pool-oauth-code">
                    Authorization code
                  </label>
                  <Input
                    id="pool-oauth-code"
                    value={pastedCode}
                    onChange={(event) => setPastedCode(event.target.value)}
                    placeholder="paste the CODE#STATE shown after you approve"
                    className="font-mono text-xs"
                  />
                  <p className="text-[11px] text-muted-foreground">
                    After approving in that browser, Claude shows a code — paste it here and click Finish.
                  </p>
                </div>
              </div>
            )}

            {/* Advanced fallback: paste raw .credentials.json */}
            <div className="border-t border-border/60 pt-3">
              <button
                type="button"
                className="text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setShowAdvanced((v) => !v)}
              >
                {showAdvanced ? "▾" : "▸"} Advanced: paste .credentials.json
              </button>
              {showAdvanced ? (
                <div className="mt-2 flex flex-col gap-3">
                  <Input
                    value={addName}
                    onChange={(event) => setAddName(event.target.value)}
                    placeholder="Account name (e.g. Claude Max #1)"
                  />
                  <Textarea
                    value={addCredentials}
                    onChange={(event) => setAddCredentials(event.target.value)}
                    placeholder='{"claudeAiOauth":{ ... }}'
                    rows={6}
                    className="font-mono text-xs"
                  />
                  <Button variant="outline" onClick={submitAdd} disabled={addMutation.isPending}>
                    {addMutation.isPending ? (
                      <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                    ) : (
                      <CheckCircle2 className="mr-1.5 h-4 w-4" />
                    )}
                    Add from JSON
                  </Button>
                </div>
              ) : null}
            </div>

            {addError ? (
              <p className="flex items-center gap-1 text-xs text-destructive">
                <AlertCircle className="h-3.5 w-3.5 shrink-0" />
                {addError}
              </p>
            ) : null}
          </div>
          )}

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setAddOpen(false)}
              disabled={oauthCompleteMutation.isPending}
            >
              Cancel
            </Button>
            {provider === "claude" && oauth ? (
              <Button
                onClick={() => oauthCompleteMutation.mutate()}
                disabled={!pastedCode.trim() || oauthCompleteMutation.isPending}
              >
                {oauthCompleteMutation.isPending ? (
                  <Loader2 className="mr-1.5 h-4 w-4 animate-spin" />
                ) : (
                  <CheckCircle2 className="mr-1.5 h-4 w-4" />
                )}
                Finish adding account
              </Button>
            ) : null}
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
