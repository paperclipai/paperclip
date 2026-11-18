import { useId, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { centsToUsd, compareCents, usdToCents } from "@paperclipai/shared";
import { ApiError } from "../api/client";
import { costsApi } from "../api/costs";
import { formatCents, formatNumber } from "../lib/utils";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/** Settlement refusals are Paperclip's own explanations. Anything else could
 * carry raw server detail, so it gets generic copy. */
function refusal(error: unknown, fallback: string) {
  return error instanceof ApiError && [403, 404, 409, 422].includes(error.status) ? error.message : fallback;
}

/** An owner settles a stopped run whose final usage receipt is missing. */
export function RunCostSettlementDialog({ companyId, runId, open, onOpenChange, onSettled }: {
  companyId: string; runId: string; open: boolean; onOpenChange: (open: boolean) => void;
  onSettled: (result: { settledBy: "owner_estimate" | "recovered_receipt" }) => void;
}) {
  const ids = { amount: useId(), amountError: useId(), reason: useId(), confirm: useId() };
  const [idempotencyKey, setIdempotencyKey] = useState(() => crypto.randomUUID());
  const [amount, setAmount] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const preview = useQuery({
    queryKey: ["costs", companyId, "run-settlement", runId],
    queryFn: () => costsApi.runSettlement(companyId, runId),
    enabled: open,
    // The figures never change under the owner while they review them, and
    // reopening the dialog always loads the run again.
    staleTime: Infinity,
    gcTime: 0,
  });
  const data = preview.data;
  const value = amount ?? (data ? centsToUsd(data.proposedCents) : "");
  let estimatedCents: string | null = null;
  try { if (data && !value.trim().startsWith("-")) estimatedCents = usdToCents(value.trim()); } catch { /* Shown as invalid input below. */ }
  const tooLow = estimatedCents !== null && data !== undefined && compareCents(estimatedCents, data.recordedCents) < 0;
  const settle = useMutation({
    mutationFn: () => costsApi.settleRun(companyId, runId, { idempotencyKey, expectedRevision: data!.revision,
      estimatedCents: estimatedCents!, reason: reason.trim(), confirmStopped: true }),
    onSuccess: result => { onOpenChange(false); onSettled(result); },
    // A conflict means the run changed since review. Load what it records now
    // and wait for a fresh decision: a new key, the new proposal and a new
    // confirmation. Nothing is resubmitted.
    onError: error => {
      if (!(error instanceof ApiError) || error.status !== 409) return;
      setIdempotencyKey(crypto.randomUUID());
      setAmount(null);
      setConfirmed(false);
      void preview.refetch();
    },
  });
  const reviewChanged = settle.error instanceof ApiError && settle.error.status === 409;
  const ready = data && !preview.error && !preview.isFetching && estimatedCents !== null && !tooLow
    && reason.trim().length > 0 && confirmed && !settle.isPending;
  const cents = (value: string) => formatCents(Number(value));

  return <Dialog open={open} onOpenChange={onOpenChange}>
    <DialogContent>
      <DialogHeader>
        <DialogTitle>Settle run cost with an estimate</DialogTitle>
        <DialogDescription>
          This run stopped without its final usage data, and Paperclip cannot confirm that it stopped.
          Settling records an estimated charge and releases the run's budget reservation.
        </DialogDescription>
      </DialogHeader>
      {(preview.isPending || preview.isRefetching) && <p role="status" className="text-sm text-muted-foreground">Loading recorded usage…</p>}
      {preview.error && <p role="alert" className="text-sm text-destructive">
        {refusal(preview.error, "Recorded usage could not be loaded. Try again shortly.")}
      </p>}
      {data && !preview.error && <div className="space-y-4 text-sm">
        <dl className="space-y-1">
          {([
            ["Model", [data.provider, data.model].filter(Boolean).join(" · ") || "Not reported", false],
            ["Recorded tokens", `${formatNumber(data.inputTokens)} input · ${formatNumber(data.cachedInputTokens)} cached · ${formatNumber(data.outputTokens)} output`, true],
            ["Recorded cost", cents(data.recordedCents), true],
            ["Reserved", cents(data.reservedCents), true],
            ["Proposed estimate", cents(data.proposedCents), true],
          ] as const).map(([term, detail, machine]) => <div key={term} className="flex gap-4">
            <dt className="w-36 shrink-0 text-muted-foreground">{term}</dt>
            <dd className={machine ? "font-mono" : undefined}>{detail}</dd>
          </div>)}
        </dl>
        <p className="text-muted-foreground">
          The provider did not send a final receipt, so the run may have used more than Paperclip recorded.
          Check the provider's console before you settle. The estimate is not a provider charge. Paperclip keeps
          the run and its recorded usage, and a receipt that arrives later is kept for review instead of being charged again.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor={ids.amount}>Estimated cost (USD)</Label>
          <Input id={ids.amount} className="font-mono" value={value} inputMode="decimal" onChange={event => setAmount(event.target.value)}
            aria-invalid={estimatedCents === null || tooLow} aria-describedby={estimatedCents === null || tooLow ? ids.amountError : undefined} />
          {(estimatedCents === null || tooLow) && <p id={ids.amountError} className="text-xs text-destructive">
            {tooLow ? `Enter at least ${cents(data.recordedCents)}, the cost Paperclip already recorded.` : "Enter an amount in US dollars."}
          </p>}
        </div>
        <div className="space-y-1.5">
          <Label htmlFor={ids.reason}>Reason</Label>
          <Textarea id={ids.reason} value={reason} maxLength={1000} onChange={event => setReason(event.target.value)}
            placeholder="For example, the amount shown in the provider's console" />
        </div>
        <div className="flex items-start gap-2">
          <Checkbox id={ids.confirm} checked={confirmed} onCheckedChange={checked => setConfirmed(checked === true)} />
          <Label htmlFor={ids.confirm} className="font-normal leading-snug">
            I confirm that this run has stopped and cannot use the provider any more.
          </Label>
        </div>
        {settle.error && <p role="alert" className="text-sm text-destructive">
          {refusal(settle.error, "The run could not be settled. Try again shortly.")}
          {reviewChanged && !preview.isFetching && " The figures above are current. Review them and settle again."}
        </p>}
      </div>}
      <DialogFooter className="flex-row items-center justify-between sm:justify-between">
        <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
        <Button type="button" disabled={!ready} onClick={() => settle.mutate()}>
          {settle.isPending ? "Settling…" : estimatedCents !== null && !tooLow ? `Settle at ${cents(estimatedCents)}` : "Settle"}
        </Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>;
}
