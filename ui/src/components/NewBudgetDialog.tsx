import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { DollarSign } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "../lib/utils";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { api } from "../api/client";

type ScopeType = "company" | "agent" | "project";

interface ScopeOption {
  id: string;
  name: string;
}

interface NewBudgetDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSubmit: (policy: {
    scopeType: ScopeType;
    scopeId: string;
    amount: number;
    windowKind: "calendar_month_utc" | "lifetime";
    hardStopEnabled: boolean;
    warnPercent: number;
  }) => void;
  isPending?: boolean;
}

export function NewBudgetDialog({
  open,
  onOpenChange,
  onSubmit,
  isPending,
}: NewBudgetDialogProps) {
  const { selectedCompanyId } = useCompany();
  const [scopeType, setScopeType] = useState<ScopeType>("agent");
  const [scopeId, setScopeId] = useState("");
  const [amount, setAmount] = useState("");
  const [hardStop, setHardStop] = useState(true);
  const [warnPercent, setWarnPercent] = useState("80");

  // Load agents and projects for the scope selector
  const { data: agentsList } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => api.get<ScopeOption[]>(`/companies/${selectedCompanyId}/agents`),
    enabled: !!selectedCompanyId && open && scopeType === "agent",
  });

  const { data: projectsList } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => api.get<ScopeOption[]>(`/companies/${selectedCompanyId}/projects`),
    enabled: !!selectedCompanyId && open && scopeType === "project",
  });

  const scopeOptions: ScopeOption[] =
    scopeType === "agent"
      ? (agentsList ?? [])
      : scopeType === "project"
        ? (projectsList ?? [])
        : selectedCompanyId
          ? [{ id: selectedCompanyId, name: "Company-wide" }]
          : [];

  // Auto-select first option when scope type changes
  useEffect(() => {
    if (scopeType === "company" && selectedCompanyId) {
      setScopeId(selectedCompanyId);
    } else if (scopeOptions.length > 0 && !scopeOptions.find((o) => o.id === scopeId)) {
      setScopeId(scopeOptions[0].id);
    }
  }, [scopeType, scopeOptions.length]);

  function reset() {
    setScopeType("agent");
    setScopeId("");
    setAmount("");
    setHardStop(true);
    setWarnPercent("80");
  }

  function handleClose(isOpen: boolean) {
    if (!isOpen) reset();
    onOpenChange(isOpen);
  }

  function handleSubmit() {
    const amountNum = parseFloat(amount);
    if (!amountNum || amountNum <= 0 || !scopeId) return;

    onSubmit({
      scopeType,
      scopeId,
      amount: Math.round(amountNum * 100), // Convert to cents
      windowKind: scopeType === "project" ? "lifetime" as const : "calendar_month_utc" as const,
      hardStopEnabled: hardStop,
      warnPercent: parseInt(warnPercent, 10) || 80,
    });
    reset();
  }

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" />
            Set Budget Policy
          </DialogTitle>
          <DialogDescription>
            Create a spend limit for an agent, project, or the entire company. Hard stops pause execution when the budget is exceeded.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Scope Type */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">Scope</label>
            <div className="grid grid-cols-3 gap-2 mt-1">
              {(["agent", "project", "company"] as const).map((s) => (
                <button
                  key={s}
                  onClick={() => setScopeType(s)}
                  className={cn(
                    "px-3 py-2 rounded-full text-sm font-medium border transition-colors capitalize",
                    scopeType === s
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border text-muted-foreground hover:border-foreground/30",
                  )}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Scope Target */}
          {scopeType !== "company" && (
            <div>
              <label className="text-xs font-medium text-muted-foreground">
                {scopeType === "agent" ? "Agent" : "Project"}
              </label>
              <select
                value={scopeId}
                onChange={(e) => setScopeId(e.target.value)}
                className="mt-1 w-full h-9 rounded-full border border-border bg-background px-3 text-sm"
              >
                <option value="">Select {scopeType}...</option>
                {scopeOptions.map((opt) => (
                  <option key={opt.id} value={opt.id}>
                    {opt.name}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Amount */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Monthly Budget (USD)
              {scopeType === "project" && " — lifetime limit"}
            </label>
            <Input
              type="number"
              inputMode="numeric"
              step="1"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="e.g. 50"
              className="mt-1"
            />
          </div>

          {/* Warning Threshold */}
          <div>
            <label className="text-xs font-medium text-muted-foreground">
              Warning threshold (%)
            </label>
            <Input
              type="number"
              inputMode="numeric"
              min="50"
              max="99"
              value={warnPercent}
              onChange={(e) => setWarnPercent(e.target.value)}
              className="mt-1"
            />
            <p className="text-[10px] text-muted-foreground mt-1">
              Alert when spend reaches this percentage of the budget.
            </p>
          </div>

          {/* Hard Stop */}
          <div className="flex items-center justify-between">
            <div>
              <label className="text-sm font-medium">Hard stop</label>
              <p className="text-xs text-muted-foreground">
                Pause agent execution when budget is exceeded
              </p>
            </div>
            <button
              onClick={() => setHardStop(!hardStop)}
              className={cn(
                "relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full transition-colors",
                hardStop ? "bg-foreground" : "bg-muted",
              )}
            >
              <span
                className={cn(
                  "inline-block h-4 w-4 transform rounded-full bg-background transition-transform mt-0.5",
                  hardStop ? "translate-x-4 ml-0.5" : "translate-x-0.5",
                )}
              />
            </button>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => handleClose(false)}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={!amount || !scopeId || isPending}
          >
            {isPending ? "Saving..." : "Set Budget"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
