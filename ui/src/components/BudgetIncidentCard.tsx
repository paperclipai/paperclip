import { useState } from "react";
import type { BudgetIncident } from "@paperclipai/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

function centsInputValue(value: number) {
  return (value / 100).toFixed(2);
}

function parseDollarInput(value: string) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.round(parsed * 100);
}

export function BudgetIncidentCard({
  incident,
  onRaiseAndResume,
  onKeepPaused,
  isMutating,
}: {
  incident: BudgetIncident;
  onRaiseAndResume: (amountCents: number) => void;
  onKeepPaused: () => void;
  isMutating?: boolean;
}) {
  const [draftAmount, setDraftAmount] = useState(
    centsInputValue(Math.max(incident.amountObserved + 1000, incident.amountLimit)),
  );
  const parsed = parseDollarInput(draftAmount);

  return (
    <Card className="overflow-hidden rounded-[2px] border-[var(--status-error)]/20 bg-[linear-gradient(180deg,rgba(255,70,70,0.10),rgba(255,255,255,0.02))]">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-[var(--font-display)] uppercase tracking-[0.06em] text-[var(--status-error)]/80">
              {incident.scopeType} hard stop
            </div>
            <CardTitle className="mt-1 text-base font-[var(--font-display)] uppercase tracking-[0.06em] text-[var(--status-error)]">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-[var(--status-error)]/70">
              Spending reached {formatCents(incident.amountObserved)} against a limit of {formatCents(incident.amountLimit)}.
            </CardDescription>
          </div>
          <div className="rounded-[2px] border border-[var(--status-error)]/30 bg-[var(--status-error)]/10 p-2 text-[var(--status-error)]">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-[2px] border border-[var(--status-error)]/20 bg-[var(--status-error)]/10 px-3 py-2 text-sm text-[var(--status-error)]/90">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            {incident.scopeType === "project"
              ? "Project execution is paused. New work in this project will not start until you resolve the budget incident."
              : "This scope is paused. New heartbeats will not start until you resolve the budget incident."}
          </div>
        </div>

        <div className="rounded-[2px] border border-border/60 bg-background/60 p-3">
          <label className="text-[11px] font-[var(--font-display)] uppercase tracking-[0.06em] text-muted-foreground">
            New budget (USD)
          </label>
          <div className="mt-2 flex flex-col gap-3 sm:flex-row">
            <Input
              value={draftAmount}
              onChange={(event) => setDraftAmount(event.target.value)}
              inputMode="decimal"
              placeholder="0.00"
            />
            <Button
              className="gap-2"
              disabled={isMutating || parsed === null || parsed <= incident.amountObserved}
              onClick={() => {
                if (typeof parsed === "number") onRaiseAndResume(parsed);
              }}
            >
              <ArrowUpRight className="h-4 w-4" />
              {isMutating ? "Applying..." : "Raise budget & resume"}
            </Button>
          </div>
          {parsed !== null && parsed <= incident.amountObserved ? (
            <p className="mt-2 text-xs text-[var(--status-error)]/80">
              The new budget must exceed current observed spend.
            </p>
          ) : null}
        </div>

        <div className="flex justify-end">
          <Button variant="ghost" className="text-muted-foreground" disabled={isMutating} onClick={onKeepPaused}>
            Keep paused
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
