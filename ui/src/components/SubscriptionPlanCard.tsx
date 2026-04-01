import { useState } from "react";
import type { SubscriptionPlan } from "@paperclipai/shared";
import { Pencil, Power, PowerOff, Trash2 } from "lucide-react";
import { formatCents, providerDisplayName } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface SubscriptionPlanCardProps {
  plan: SubscriptionPlan;
  onUpdate: (planId: string, data: { monthlyCostCents?: number; isActive?: boolean }) => void;
  onDelete: (planId: string) => void;
  isMutating: boolean;
}

export function SubscriptionPlanCard({ plan, onUpdate, onDelete, isMutating }: SubscriptionPlanCardProps) {
  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(String((plan.monthlyCostCents / 100).toFixed(2)));

  const handleSave = () => {
    const cents = Math.round(Number(editValue) * 100);
    if (Number.isFinite(cents) && cents >= 0) {
      onUpdate(plan.id, { monthlyCostCents: cents });
      setEditing(false);
    }
  };

  return (
    <Card className="border-border/70">
      <CardContent className="flex items-start justify-between gap-4 px-5 py-4">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2 text-sm font-medium">
            <span>{providerDisplayName(plan.provider)}</span>
            {plan.provider !== plan.biller && (
              <span className="text-muted-foreground">via {plan.biller}</span>
            )}
            {!plan.isActive && (
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase text-muted-foreground">
                inactive
              </span>
            )}
          </div>
          <div className="text-xs text-muted-foreground">
            {plan.agentId ? "Agent-specific" : "Company-wide"}
            {plan.seatCount > 1 ? ` · ${plan.seatCount} seats` : ""}
            {plan.effectiveUntil ? ` · until ${new Date(plan.effectiveUntil).toLocaleDateString()}` : ""}
          </div>
          {editing ? (
            <div className="flex items-end gap-2 pt-1">
              <div>
                <Label className="text-xs">Monthly cost (USD)</Label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  className="h-8 w-32 text-sm"
                />
              </div>
              <Button size="sm" variant="default" onClick={handleSave} disabled={isMutating}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          ) : (
            <div className="text-lg font-semibold tabular-nums">
              {formatCents(plan.monthlyCostCents)}<span className="text-sm font-normal text-muted-foreground">/mo</span>
            </div>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title="Edit"
            onClick={() => setEditing(!editing)}
            disabled={isMutating}
          >
            <Pencil className="h-3.5 w-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            title={plan.isActive ? "Deactivate" : "Activate"}
            onClick={() => onUpdate(plan.id, { isActive: !plan.isActive })}
            disabled={isMutating}
          >
            {plan.isActive ? <PowerOff className="h-3.5 w-3.5" /> : <Power className="h-3.5 w-3.5" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 text-destructive hover:text-destructive"
            title="Delete"
            onClick={() => onDelete(plan.id)}
            disabled={isMutating}
          >
            <Trash2 className="h-3.5 w-3.5" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
