import { Wand2, CheckCircle2 } from "lucide-react";
import { Button } from "@/components/ui/button";

export function SmartSuggestionsBanner({
  autoResolvableCount,
  onAutoResolve,
  isPending,
}: {
  autoResolvableCount: number;
  onAutoResolve: () => void;
  isPending: boolean;
}) {
  if (autoResolvableCount === 0) return null;
  return (
    <div className="flex items-center justify-between gap-3 rounded-lg border border-blue-500/20 bg-blue-500/[0.04] px-4 py-2.5">
      <div className="flex items-center gap-2.5 min-w-0">
        <Wand2 className="h-4 w-4 text-blue-400 shrink-0" />
        <p className="text-sm">
          <span className="font-medium">{autoResolvableCount} item{autoResolvableCount !== 1 ? "s" : ""}</span>
          <span className="text-muted-foreground ml-1">can be auto-resolved (completed missions, resolved approvals)</span>
        </p>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 h-8"
        onClick={onAutoResolve}
        disabled={isPending}
      >
        <CheckCircle2 className="h-3.5 w-3.5 mr-1.5" />
        {isPending ? "Resolving..." : "Auto-resolve all"}
      </Button>
    </div>
  );
}
