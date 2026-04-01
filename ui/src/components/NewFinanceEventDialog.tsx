import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";

const EVENT_KINDS = [
  { value: "top_up", label: "Top-up", desc: "Add funds to balance" },
  { value: "monthly_fee", label: "Monthly Fee", desc: "Recurring subscription/platform charge" },
  { value: "credit_return", label: "Credit/Refund", desc: "Refund or credit adjustment" },
  { value: "commitment", label: "Commitment", desc: "Pre-paid commitment or deposit" },
  { value: "usage_charge", label: "Usage Charge", desc: "Variable usage-based charge" },
  { value: "adjustment", label: "Adjustment", desc: "Manual balance adjustment" },
];

interface NewFinanceEventDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (event: {
    eventKind: string;
    direction: "debit" | "credit";
    biller: string;
    provider?: string;
    amountCents: number;
    currency: string;
    description: string;
    occurredAt: string;
  }) => void;
  isPending?: boolean;
}

export function NewFinanceEventDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: NewFinanceEventDialogProps) {
  const [eventKind, setEventKind] = useState("top_up");
  const [direction, setDirection] = useState<"debit" | "credit">("credit");
  const [biller, setBiller] = useState("");
  const [provider, setProvider] = useState("");
  const [amount, setAmount] = useState("");
  const [description, setDescription] = useState("");
  const [occurredAt, setOccurredAt] = useState(
    new Date().toISOString().split("T")[0],
  );

  function reset() {
    setEventKind("top_up");
    setDirection("credit");
    setBiller("");
    setProvider("");
    setAmount("");
    setDescription("");
    setOccurredAt(new Date().toISOString().split("T")[0]);
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  function handleSubmit() {
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0 || !biller.trim()) return;

    onSubmit({
      eventKind,
      direction,
      biller: biller.trim(),
      provider: provider.trim() || undefined,
      amountCents: Math.round(amountNum * 100),
      currency: "USD",
      description: description.trim(),
      occurredAt: new Date(occurredAt + "T12:00:00Z").toISOString(),
    });
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New Finance Event</DialogTitle>
          <DialogDescription>
            Record a payment, charge, credit, or adjustment to the finance ledger.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Direction */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Direction</label>
            <div className="grid grid-cols-2 gap-2 mt-1">
              {(["credit", "debit"] as const).map((d) => (
                <button
                  key={d}
                  onClick={() => setDirection(d)}
                  className={cn(
                    "px-3 py-2 rounded-full text-sm font-medium border transition-colors",
                    direction === d
                      ? d === "credit"
                        ? "border-emerald-500 bg-emerald-500/10 text-emerald-600"
                        : "border-red-500 bg-red-500/10 text-red-600"
                      : "border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {d === "credit" ? "+ Credit (money in)" : "- Debit (money out)"}
                </button>
              ))}
            </div>
          </div>

          {/* Event Kind */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Type</label>
            <div className="flex flex-wrap gap-1.5 mt-1">
              {EVENT_KINDS.map((kind) => (
                <button
                  key={kind.value}
                  onClick={() => setEventKind(kind.value)}
                  className={cn(
                    "px-2.5 py-1 rounded-full text-xs font-medium border transition-colors",
                    eventKind === kind.value
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {kind.label}
                </button>
              ))}
            </div>
          </div>

          {/* Amount + Biller */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Amount (USD)</label>
              <Input
                type="number"
                inputMode="decimal"
                step="0.01"
                min="0"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Biller</label>
              <Input
                value={biller}
                onChange={(e) => setBiller(e.target.value)}
                placeholder="e.g. Anthropic"
                className="mt-1"
              />
            </div>
          </div>

          {/* Provider + Date */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Provider (optional)</label>
              <Input
                value={provider}
                onChange={(e) => setProvider(e.target.value)}
                placeholder="e.g. anthropic"
                className="mt-1"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Date</label>
              <Input
                type="date"
                value={occurredAt}
                onChange={(e) => setOccurredAt(e.target.value)}
                className="mt-1"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Description</label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Monthly subscription credit, API usage charge, etc."
              className="mt-1 min-h-[60px]"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!amount || !biller.trim() || isPending}
          >
            {isPending ? "Recording..." : "Record Event"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
