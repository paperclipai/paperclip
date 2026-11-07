import { t, useTranslation, Trans } from "@/i18n";
import { centsToUsd, usdToCents } from "@paperclipai/shared";
import { useEffect, useId, useState } from "react";
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
  const normalized = value.trim();
  if (normalized.length === 0) return 0;
  const parsed = Number(normalized);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

function windowLabel(windowKind: BudgetPolicySummary["windowKind"]) {
  return windowKind === "lifetime" ? t("task-components:lifetimeBudget_e4d8b974") : t("task-components:monthlyUtcBudget_cea33859");
}

function statusTone(status: BudgetPolicySummary["status"]) {
  if (status === "hard_stop") return "text-red-700 dark:text-red-300 border-red-500/30 bg-red-500/10";
  if (status === "warning") return "text-amber-700 dark:text-amber-200 border-amber-500/30 bg-amber-500/10";
  return "text-emerald-700 dark:text-emerald-200 border-emerald-500/30 bg-emerald-500/10";
}

export function BudgetPolicyCard({
  summary,
  onSave,
  onUnpricedUsagePolicyChange,
  onReservationChange,
  isSaving,
  compact = false,
  variant = "card",
}: {
  summary: BudgetPolicySummary;
  onSave?: (amountCents: number) => void;
  onReservationChange?: (cents: string) => void;
  onUnpricedUsagePolicyChange?: (policy: "block" | "allow") => void;
  isSaving?: boolean;
  compact?: boolean;
  variant?: "card" | "plain";
}) {
  useTranslation("task-components");
  const [draftBudget, setDraftBudget] = useState(centsInputValue(summary.amount));

  useEffect(() => {
    setDraftBudget(centsInputValue(summary.amount));
  }, [summary.amount]);

  const [reservation, setReservation] = useState(centsToUsd(summary.reservationCents ?? 0));
  const reservationErrorId = useId();
  useEffect(() => setReservation(centsToUsd(summary.reservationCents ?? 0)), [summary.reservationCents]);
  let reservationCents: string | null = null;
  try { if (!reservation.trim().startsWith("-")) reservationCents = usdToCents(reservation.trim()); } catch { /* Shown as invalid input below. */ }
  const reservationSection = onReservationChange ? <div className="space-y-2">
    <label className="text-sm">{t("task-components:reservePerRunUsd_30c7d936")}<Input aria-label={t("task-components:reservePerRunUsd_30c7d936")} aria-invalid={reservationCents === null} aria-describedby={reservationCents === null ? reservationErrorId : undefined}
        value={reservation} onChange={event => setReservation(event.target.value)} inputMode="decimal" />
    </label>
    {reservationCents === null && <p id={reservationErrorId} role="alert" className="text-xs text-destructive">{t("task-components:enterAValidAmountOfZeroOr_385afc73")}</p>}
    <p className="text-xs text-muted-foreground">{t("task-components:anEstimateHeldBeforeEachRunStarts_b3958261")}</p>
    <Button variant="outline" disabled={isSaving || reservationCents === null || reservationCents === (summary.reservationCents ?? "0.0000000")}
      onClick={() => { if (reservationCents !== null) onReservationChange(reservationCents); }}>{t("task-components:updateReservation_2d7f9646")}</Button>
  </div> : null;

  const advancedSettings = onReservationChange || onUnpricedUsagePolicyChange ? (
    <details className="space-y-3">
      <summary className="cursor-pointer text-sm font-medium">{t("task-components:advancedSettings_7b0bd218")}</summary>
      <div className="space-y-4">
        {onUnpricedUsagePolicyChange && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={summary.unpricedUsagePolicy !== "allow"} disabled={isSaving}
              onChange={(event) => onUnpricedUsagePolicyChange(event.target.checked ? "block" : "allow")} />{t("task-components:blockNewWorkWhenUsageHasNo_483602ab")}</label>
        )}
        {reservationSection}
      </div>
    </details>
  ) : null;

  const parsedDraft = parseDollarInput(draftBudget);
  const canSave = typeof parsedDraft === "number" && parsedDraft !== summary.amount && Boolean(onSave);
  const progress = summary.amount > 0 ? Math.min(100, summary.utilizationPercent) : 0;
  const StatusIcon = summary.status === "hard_stop" ? ShieldAlert : summary.status === "warning" ? AlertTriangle : Wallet;
  const isPlain = variant === "plain";

  const observedBudgetGrid = isPlain ? (
    <div className="grid gap-6 sm:grid-cols-2">
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:observed_64fa8a14")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? t("task-components:ofLimit_7b41c58c", { value1: summary.utilizationPercent }) : t("task-components:noCapConfigured_6310b264")}
        </div>
      </div>
      <div>
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:budget_1c6225ec")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : t("task-components:disabled_75081b59")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{t("final-components-b:Soft_alert_at_warnPercent_pause_367bf5", { warnPercent: summary.warnPercent, pause: summary.paused && summary.pauseReason ? t("final-components-b:reason_pause_70f5f6", { reason: summary.pauseReason === "manual" ? t("final-components-b:manual_36bde6") : summary.pauseReason === "budget" ? t("final-components-b:budget_0af96a") : summary.pauseReason }) : "" })}</div>
      </div>
    </div>
  ) : (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:observed_64fa8a14")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">{formatCents(summary.observedAmount)}</div>
        <div className="mt-1 text-xs text-muted-foreground">
          {summary.amount > 0 ? t("task-components:ofLimit_7b41c58c", { value1: summary.utilizationPercent }) : t("task-components:noCapConfigured_6310b264")}
        </div>
      </div>
      <div className="rounded-xl border border-border/70 bg-black/[0.18] px-4 py-3">
        <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:budget_1c6225ec")}</div>
        <div className="mt-2 text-xl font-semibold tabular-nums">
          {summary.amount > 0 ? formatCents(summary.amount) : t("task-components:disabled_75081b59")}
        </div>
        <div className="mt-1 text-xs text-muted-foreground">{t("final-components-b:Soft_alert_at_warnPercent_pause_367bf5", { warnPercent: summary.warnPercent, pause: summary.paused && summary.pauseReason ? t("final-components-b:reason_pause_70f5f6", { reason: summary.pauseReason === "manual" ? t("final-components-b:manual_36bde6") : summary.pauseReason === "budget" ? t("final-components-b:budget_0af96a") : summary.pauseReason }) : "" })}</div>
      </div>
    </div>
  );

  const progressSection = (
    <div className="space-y-2">
      {summary.pendingRunCount > 0 && <p className="text-sm text-destructive"><Trans ns="final-components-b" i18nKey="numeric.BudgetPolicyCard.de06f8fe1d25_92cef" values={{ pendingRunCount: summary.pendingRunCount }} /></p>}
      {summary.unpricedEventCount > 0 && (
        <p className="text-sm text-destructive"><Trans ns="final-components-b" i18nKey="numeric.BudgetPolicyCard.888cbbd739c5_4627c" values={{ unpricedEventCount: summary.unpricedEventCount }} /></p>
      )}
      <div className="flex items-center justify-between text-xs text-muted-foreground">
        <span>{t("task-components:remaining_f3e4352a")}</span>
        <span>{summary.amount > 0 ? formatCents(summary.remainingAmount) : t("task-components:unlimited_11dde17d")}</span>
      </div>
      <div className={cn("h-2 overflow-hidden rounded-full", isPlain ? "bg-border/70" : "bg-muted/70")}>
        <div
          role="progressbar"
          aria-valuenow={Math.round(progress)}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t("task-components:budgetUtilizationUsed_8f49dc62", { value1: Math.round(progress) })}
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
          ? t("task-components:executionIsPausedForThisProjectUntil_cbc2c7c3")
          : t("task-components:heartbeatsArePausedForThisScopeUntil_c518d1f0")}
      </div>
    </div>
  ) : null;

  const saveSection = onSave ? (
    <div className={cn("flex flex-col gap-3 sm:flex-row sm:items-end", isPlain ? "" : "rounded-xl border border-border/70 bg-background/50 p-3")}>
      <div className="min-w-0 flex-1">
        <label className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">{t("task-components:budgetUsd_e9b19e91")}</label>
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
        {isSaving ? t("task-components:saving_dc85af8f") : summary.amount > 0 ? t("task-components:updateBudget_dc98d20c") : t("task-components:setBudget_df4e88af")}
      </Button>
    </div>
  ) : null;

  if (isPlain) {
    return (
      <div className="space-y-6">
        <div className="flex items-start justify-between gap-6">
          <div>
            <div className="text-(length:--text-micro) uppercase tracking-(--tracking-caps) text-muted-foreground">
              {summary.scopeType}
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
            {summary.paused ? t("task-components:paused_e159b061") : summary.status === "warning" ? t("task-components:warning_e981ddae") : summary.status === "hard_stop" ? t("task-components:hardStop_989158fc") : t("task-components:healthy_7f1e323b")}
          </div>
        </div>

        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {advancedSettings}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{t("task-components:enterAValidNonNegativeDollarAmount_a45d063b")}</p>
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
              {summary.scopeType}
            </div>
            <CardTitle className="mt-1 text-base">{summary.scopeName}</CardTitle>
            <CardDescription className="mt-1">{windowLabel(summary.windowKind)}</CardDescription>
          </div>
          <div className={cn("inline-flex items-center gap-2 rounded-full border px-3 py-1 text-(length:--text-micro) uppercase tracking-(--tracking-caps)", statusTone(summary.status))}>
            <StatusIcon className="h-3.5 w-3.5" />
            {summary.paused ? t("task-components:paused_e159b061") : summary.status === "warning" ? t("task-components:warning_e981ddae") : summary.status === "hard_stop" ? t("task-components:hardStop_989158fc") : t("task-components:healthy_7f1e323b")}
          </div>
        </div>
      </CardHeader>
      <CardContent className={cn("space-y-4", compact ? "px-4 pb-4 pt-0" : "px-5 pb-5 pt-0")}>
        {observedBudgetGrid}
        {progressSection}
        {pausedPane}
        {saveSection}
        {advancedSettings}
        {parsedDraft === null ? (
          <p className="text-xs text-destructive">{t("task-components:enterAValidNonNegativeDollarAmount_a45d063b")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
