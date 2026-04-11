import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { AlertTriangle, PauseCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn, formatCents } from "../lib/utils";
import { useLocale } from "../context/LocaleContext";
import {
  formatBudgetPolicyLimitSubtitle,
  formatBudgetPolicyPausedDescription,
  formatBudgetPolicyScopeTypeLabel,
  formatBudgetPolicySoftAlertSummary,
  formatBudgetPolicyStatusLabel,
  formatBudgetPolicyWindowLabel,
  getCostsCopy,
} from "../lib/costs-copy";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning") return "text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amountCents: number) => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  const { locale } = useLocale();
  const copy = getCostsCopy(locale);
  const [draftBudget, setDraftBudget] = useState(centsInputValue(summary.amount));

  useEffect(() => {
    setDraftBudget(centsInputValue(summary.amount));
  }, [summary.amount]);

  const parsedDraft = parseDollarInput(draftBudget);
  const canSave = typeof parsedDraft === "number" && parsedDraft !== summary.amount && Boolean(onSave);
  const progress = summary.amount > 0 ? Math.min(100, summary.utilizationPercent) : 0;
  const StatusIcon = summary.status === "hard_stop" ? ShieldAlert : summary.status === "warning" ? AlertTriangle : Wallet;
  const isPlain = variant === "plain";

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy.budgetCardObserved}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatBudgetPolicyLimitSubtitle(summary.amount, summary.utilizationPercent, locale)}
        </div>
      </div>
      <div>
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy.budgetCardBudget}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : copy.budgetCardDisabled}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatBudgetPolicySoftAlertSummary(summary.warnPercent, summary.paused ? summary.pauseReason : null, locale)}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy.budgetCardObserved}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatBudgetPolicyLimitSubtitle(summary.amount, summary.utilizationPercent, locale)}
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">{copy.budgetCardBudget}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : copy.budgetCardDisabled}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {formatBudgetPolicySoftAlertSummary(summary.warnPercent, summary.paused ? summary.pauseReason : null, locale)}
        </div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{copy.budgetCardRemaining}</span>
        <span>{summary.amount > 0 ? formatCents(summary.remainingAmount) : copy.budgetCardUnlimited}</span>
      </div>
      <div className={cn("h-2 overflow-hidden rounded-full", isPlain ? "bg-border/70" : "bg-muted/70")}>
        <div
          className={cn(
            "h-full rounded-full transition-[width,background-color] duration-200",
            summary.status === "hard_stop"
              ? "bg-red-400"
              : summary.status === "warning"
                ? "bg-amber-300"
                : "bg-emerald-300",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>{formatBudgetPolicyPausedDescription(summary.scopeType, locale)}</div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      <div className="min-w-0 flex-1">
        <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
          {copy.budgetCardBudgetUsdLabel}
        </label>
        <Input
          value={draftBudget}
          onChange={(event) => setDraftBudget(event.target.value)}
          className="mt-2"
          inputMode="decimal"
          placeholder="0.00"
        />
      </div>
        <Button
          onClick={() => {
            if (typeof parsedDraft === "number" && onSave) onSave(parsedDraft);
          }}
          disabled={!canSave || isSaving || parsedDraft === null}
        >
          {isSaving ? copy.budgetCardSaving : summary.amount > 0 ? copy.budgetCardUpdateBudget : copy.budgetCardSetBudget}
        </Button>
      </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              {formatBudgetPolicyScopeTypeLabel(summary.scopeType, locale)}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{formatBudgetPolicyWindowLabel(summary.windowKind, locale)}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-[11px] uppercase tracking-[0.18em]",
              summary.status === "hard_stop"
                ? "text-red-300"
                : summary.status === "warning"
                  ? "text-amber-200"
                  : "text-muted-foreground",
              )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {formatBudgetPolicyStatusLabel(summary.status, summary.paused, locale)}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{copy.budgetCardInvalidDollarAmount}</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/80", compact ? "" : "shadow-[0_20px_80px_-40px_rgba(0,0,0,0.55)]")}>
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] uppercase tracking-[0.22em] text-muted-foreground">
              {formatBudgetPolicyScopeTypeLabel(summary.scopeType, locale)}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{formatBudgetPolicyWindowLabel(summary.windowKind, locale)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] uppercase tracking-[0.18em]", statusTone(summary.status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {formatBudgetPolicyStatusLabel(summary.status, summary.paused, locale)}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{copy.budgetCardInvalidDollarAmount}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
