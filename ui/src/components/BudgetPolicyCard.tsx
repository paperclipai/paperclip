import { t, useTranslation } from "@/i18n";
import { useEffect, useState } from "react";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { AlertTriangle, PauseCircle, ShieldAlert, Wallet } from "lucide-react";
import { cn, formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const normalized = value.trim().replace(",", ".");
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  return windowKind === "lifetime" ? t("localizationActivity.lifetimeBudget") : t("localizationActivity.monthlyBudget");
}

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning") return "text-amber-700 dark:text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-700 dark:text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
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
  const { t } = useTranslation();
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
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationActivity.observed")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? t("localizationActivity.percentOfLimit", { percent: summary.utilizationPercent }) : t("localizationActivity.noCap")}
        </div>
      </div>
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationActivity.budget")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : t("localizationActivity.disabled")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t("localizationActivity.softAlert", { percent: summary.warnPercent })}{summary.paused && summary.pauseReason ? ` · ${t("localizationActivity.pauseReason", { reason: t(`localizationActivity.pauseReason_${summary.pauseReason}`, { defaultValue: summary.pauseReason }) })}` : ""}
        </div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationActivity.observed")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? t("localizationActivity.percentOfLimit", { percent: summary.utilizationPercent }) : t("localizationActivity.noCap")}
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("localizationActivity.budget")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : t("localizationActivity.disabled")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">
          {t("localizationActivity.softAlert", { percent: summary.warnPercent })}{summary.paused && summary.pauseReason ? ` · ${t("localizationActivity.pauseReason", { reason: t(`localizationActivity.pauseReason_${summary.pauseReason}`, { defaultValue: summary.pauseReason }) })}` : ""}
        </div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("localizationActivity.remaining")}</span>
        <span>{summary.amount > 0 ? formatCents(summary.remainingAmount) : t("localizationActivity.unlimited")}</span>
      </div>
      <div className={cn("h-2 overflow-hidden rounded-full", isPlain ? "bg-border/70" : "bg-muted/70")}>
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("localizationActivity.budgetUtilization", { percent: Math.round(progress) })}
          className={cn(
            "h-full rounded-full transition-(--tp-width-background-color) duration-200",
            summary.status === "hard_stop"
              ? "bg-(--status-task-blocked)"
              : summary.status === "warning"
                ? "bg-(--status-task-todo)"
                : "bg-(--status-task-done)",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );

  const pausedPane = summary.paused ? (
    <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-900 dark:text-red-100">
      <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
      <div>
        {summary.scopeType === "project"
          ? t("localizationActivity.projectPaused")
          : t("localizationActivity.scopePaused")}
      </div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      <div className="min-w-0 flex-1">
        <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
          {t("localizationActivity.budgetUsd")}
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
        {isSaving ? t("localizationActivity.saving") : summary.amount > 0 ? t("localizationActivity.updateBudget") : t("localizationActivity.setBudget")}
      </Button>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t(`localizationActivity.scope_${summary.scopeType}`, { defaultValue: summary.scopeType })}
            </div>
            <div className="mt-2 text-xl font-semibold">{summary.scopeName}</div>
            <div className="mt-2 text-sm text-muted-foreground">{windowLabel(summary.windowKind)}</div>
          </div>
          <div
            className={cn(
              "inline-flex items-center gap-2 text-(length:--text-micro) uppercase tracking-(--tracking-caps)",
              summary.status === "hard_stop"
                ? "text-red-700 dark:text-red-300"
                : summary.status === "warning"
                  ? "text-amber-800 dark:text-amber-200"
                  : "text-muted-foreground",
            )}
          >
            <StatusIcon className="h-3.5 w-3.5" />
            {summary.paused ? t("localizationActivity.paused") : summary.status === "warning" ? t("localizationActivity.warning") : summary.status === "hard_stop" ? t("localizationActivity.hardStop") : t("localizationActivity.healthy")}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{t("localizationActivity.invalidBudget")}</p>
        ) : null}
      </div>
    );
  }

  return (
    <Card className={cn("overflow-hidden border-border/70 bg-card/80", compact ? "" : "shadow-(--shadow-extract-2)")}>
      <CardHeader className={cn("gap-3", compact ? "px-4 pt-4 pb-2" : "px-5 pt-5 pb-3")}>
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {t(`localizationActivity.scope_${summary.scopeType}`, { defaultValue: summary.scopeType })}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-caps)", statusTone(summary.status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {summary.paused ? t("localizationActivity.paused") : summary.status === "warning" ? t("localizationActivity.warning") : summary.status === "hard_stop" ? t("localizationActivity.hardStop") : t("localizationActivity.healthy")}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{t("localizationActivity.invalidBudget")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
