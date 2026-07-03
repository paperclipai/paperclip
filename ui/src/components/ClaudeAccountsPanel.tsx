import type {
  ClaudeAccountUsageSnapshot,
  ClaudeAccountsUsageResponse,
  ClaudeUsageWindow,
} from "@paperclipai/shared";
import { CheckCircle2, CircleDot } from "lucide-react";
import { cn } from "@/lib/utils";

interface ClaudeAccountsPanelProps {
  data: ClaudeAccountsUsageResponse | undefined;
  error?: string | null;
}

const TIER_LABEL: Record<string, string> = {
  ours: "Ours",
  wameling: "Wameling",
  unknown: "Unknown",
};

const SOURCE_LABEL: Record<string, string> = {
  live: "Live",
  snapshot: "Snapshot",
  refreshed: "Refreshed",
  error: "Error",
};

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
}

function fillClass(pct: number | null): string {
  if (pct == null) return "bg-zinc-700";
  if (pct >= 90) return "bg-red-400";
  if (pct >= 70) return "bg-amber-400";
  return "bg-primary/70";
}

/** Sort active account first, then Wameling accounts near reset, then by name. */
function sortAccounts(accounts: ClaudeAccountUsageSnapshot[]): ClaudeAccountUsageSnapshot[] {
  const tierRank: Record<string, number> = { wameling: 0, ours: 1, unknown: 2 };
  return accounts.toSorted((a, b) => {
    if (a.active !== b.active) return a.active ? -1 : 1;
    const tierDelta = (tierRank[a.tier] ?? 3) - (tierRank[b.tier] ?? 3);
    if (tierDelta !== 0) return tierDelta;
    return a.profile.localeCompare(b.profile);
  });
}

function WindowBar({ label, window }: { label: string; window: ClaudeUsageWindow | null }) {
  if (!window || window.pct == null) {
    return (
      <div>
        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">{label}</span>
          <span className="tabular-nums text-muted-foreground">—</span>
        </div>
        <div className="mt-1 h-1.5 overflow-hidden bg-muted">
          <div className="h-full bg-zinc-700" style={{ width: "0%" }} />
        </div>
      </div>
    );
  }
  const width = Math.max(0, Math.min(100, window.pct));
  return (
    <div>
      <div className="flex items-center justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums font-medium text-foreground">{window.pct}%</span>
      </div>
      <div className="mt-1 h-1.5 overflow-hidden bg-muted">
        <div
          className={cn("h-full transition-[width] duration-200", fillClass(window.pct))}
          style={{ width: `${width}%` }}
        />
      </div>
      {window.resetsAt ? (
        <div className="mt-1 text-[11px] text-muted-foreground">
          Resets {formatTimestamp(window.resetsAt)}
        </div>
      ) : null}
    </div>
  );
}

function AccountCard({ account }: { account: ClaudeAccountUsageSnapshot }) {
  return (
    <div
      className={cn(
        "border px-4 py-3.5",
        account.active ? "border-emerald-500/60 bg-emerald-500/5" : "border-border",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            {account.active ? (
              <CheckCircle2 className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
            ) : (
              <CircleDot className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            )}
            <span className="truncate text-sm font-medium text-foreground">{account.profile}</span>
          </div>
          <div className="mt-0.5 truncate text-xs text-muted-foreground">
            {account.email ?? "No email on profile"}
            {account.subscriptionType ? ` · ${account.subscriptionType}` : ""}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          {account.active ? (
            <span className="border border-emerald-500/60 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-emerald-500">
              Logged in
            </span>
          ) : null}
          <span className="border border-border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            {TIER_LABEL[account.tier] ?? account.tier}
          </span>
        </div>
      </div>

      {account.source === "error" || account.error ? (
        <div className="mt-3 border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {account.error ?? "Usage probe failed for this account."}
        </div>
      ) : (
        <div className="mt-3 grid gap-2.5 sm:grid-cols-2">
          <WindowBar label="5-hour" window={account.fiveHour} />
          <WindowBar label="7-day (all)" window={account.sevenDay} />
          <WindowBar label="7-day Opus" window={account.sevenDayOpus} />
          <WindowBar label="7-day Sonnet" window={account.sevenDaySonnet} />
        </div>
      )}

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{SOURCE_LABEL[account.source] ?? account.source}</span>
        <span>Probed {formatTimestamp(account.probedAt)}</span>
      </div>
    </div>
  );
}

export function ClaudeAccountsPanel({ data, error = null }: ClaudeAccountsPanelProps) {
  if (error) {
    return (
      <div className="border border-border px-4 py-4 text-sm text-muted-foreground">
        {error}
      </div>
    );
  }

  const accounts = data?.accounts ?? [];
  if (accounts.length === 0) {
    return (
      <div className="border border-border px-4 py-4 text-sm text-muted-foreground">
        No Claude auth profiles were found on this host. The active login is shown under
        “Claude Code” above.
      </div>
    );
  }

  const sorted = sortAccounts(accounts);
  return (
    <div className="space-y-3">
      <div className="grid gap-3 lg:grid-cols-2">
        {sorted.map((account) => (
          <AccountCard key={account.profile} account={account} />
        ))}
      </div>
      <div className="text-[11px] text-muted-foreground">
        Snapshot captured {formatTimestamp(data?.capturedAt ?? null)}. Reads each profile’s own
        token without switching the host login.
      </div>
    </div>
  );
}
