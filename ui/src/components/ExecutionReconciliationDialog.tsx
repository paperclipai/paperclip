import { useId, useState, type RefObject } from "react";
import type { ExecutionReconciliation } from "@paperclipai/shared";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

export function ExecutionReconciliationDialog({
  open,
  onOpenChange,
  runId,
  nextAction,
  onSubmit,
  returnFocusRef,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  runId: string;
  nextAction: string;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onSubmit: (decision: ExecutionReconciliation) => Promise<void>;
}) {
  const id = useId();
  const [stopped, setStopped] = useState(false);
  const [outcome, setOutcome] = useState<
    ExecutionReconciliation["actionOutcome"] | null
  >(null);
  const [evidence, setEvidence] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit() {
    if (!outcome || !stopped || evidence.trim().length < 20) return;
    setPending(true);
    setError(null);
    try {
      await onSubmit({
        runId,
        providerStopped: true,
        actionOutcome: outcome,
        outcomeEvidence: evidence.trim(),
      });
      onOpenChange(false);
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not record the recovery decision.",
      );
    } finally {
      setPending(false);
    }
  }
  return (
    <Dialog open={open} onOpenChange={pending ? undefined : onOpenChange}>
      <DialogContent
        showCloseButton={!pending}
        className="max-h-(--sz-85vh) overflow-y-auto"
        onCloseAutoFocus={(event) => {
          if (returnFocusRef?.current) {
            event.preventDefault();
            returnFocusRef.current.focus();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Reconcile execution</DialogTitle>
          <DialogDescription>{nextAction}</DialogDescription>
        </DialogHeader>
        <fieldset className="space-y-3" disabled={pending}>
          <legend className="mb-2 text-sm font-medium">
            What happened to the recorded actions?
          </legend>
          {(
            [
              ["completed", "The actions completed"],
              ["not_performed", "The actions did not happen"],
              ["mixed", "Some completed; others did not happen"],
            ] as const
          ).map(([value, label]) => (
            <label key={value} className="flex items-center gap-2 text-sm">
              <input
                type="radio"
                name={`${id}-outcome`}
                value={value}
                checked={outcome === value}
                onChange={() => setOutcome(value)}
              />
              {label}
            </label>
          ))}
          <label
            htmlFor={`${id}-evidence`}
            className="block text-sm font-medium"
          >
            Evidence and remaining work
          </label>
          <Textarea
            id={`${id}-evidence`}
            value={evidence}
            onChange={(event) => setEvidence(event.target.value)}
            maxLength={12000}
            placeholder="Name each action, how you verified its outcome, and what the agent should do next."
          />
          <label className="flex items-start gap-2 text-sm">
            <Checkbox
              checked={stopped}
              onCheckedChange={(value) => setStopped(value === true)}
            />
            I verified that the previous provider stopped and the workspace is
            available.
          </label>
        </fieldset>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            disabled={
              pending || !outcome || !stopped || evidence.trim().length < 20
            }
            onClick={() => void submit()}
          >
            {pending ? "Recording decision…" : "Record and continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
