import { useState } from "react";
import type { BudgetIncident } from "@valadrien-os/shared";
import { AlertOctagon, ArrowUpRight, PauseCircle } from "lucide-react";
import { formatCents } from "../lib/utils";
import { Badge } from "@/components/ui/badge";
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

function incidentStateLabel(incident: BudgetIncident) {
  if (incident.status === "resolved") return "Resolved";
  if (incident.status === "dismissed") return "Dismissed";
  if (incident.approvalStatus === "revision_requested") return "Escalated";
  if (incident.approvalStatus === "pending") return "Pending approval";
  return "Open";
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
  const stateLabel = incidentStateLabel(incident);

  return (
    <Card className="overflow-hidden border-status-error/40 bg-status-error/10">
      <CardHeader className="px-5 pt-5 pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="text-[11px] uppercase tracking-[0.22em] text-status-error">
                {incident.scopeType} hard stop
              </div>
              <Badge variant={incident.status === "resolved" ? "outline" : "secondary"}>
                {stateLabel}
              </Badge>
            </div>
            <CardTitle className="mt-1 text-base text-foreground">{incident.scopeName}</CardTitle>
            <CardDescription className="mt-1 text-muted-foreground">
              Spending reached {formatCents(incident.amountObserved)} against a limit of {formatCents(incident.amountLimit)}.
            </CardDescription>
          </div>
          <div className="rounded-[3px] border border-status-error/40 bg-status-error/10 p-2 text-status-error">
            <AlertOctagon className="h-4 w-4" />
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4 px-5 pb-5 pt-0">
        <div className="flex items-start gap-2 rounded-[3px] border border-status-error/40 bg-status-error/10 px-3 py-2 text-sm text-foreground">
          <PauseCircle className="mt-0.5 h-4 w-4 shrink-0 text-status-error" />
          <div>
            {incident.scopeType === "project"
              ? "Project execution is paused. New work in this project will not start until you resolve the budget incident."
              : "This scope is paused. New heartbeats will not start until you resolve the budget incident."}
          </div>
        </div>

        <div className="rounded-[3px] border border-border bg-background p-3">
          <label className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
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
            <p className="mt-2 text-xs text-status-error">
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
