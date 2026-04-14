import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { PauseReason } from "@paperclipai/shared";
import { Pause, Play } from "lucide-react";

interface CompanyRuntimeButtonProps {
  companyPaused: boolean;
  pauseReason: PauseReason | null;
  isPending?: boolean;
  pendingAction?: "pause" | "resume";
  onPause: () => void;
  onResume: () => void;
}

export function CompanyRuntimeButton({
  companyPaused,
  pauseReason,
  isPending = false,
  pendingAction,
  onPause,
  onResume,
}: CompanyRuntimeButtonProps) {
  if (companyPaused && pauseReason === "budget") {
    return (
      <Button size="sm" variant="outline" asChild>
        <Link to="/costs" aria-label="Resolve company budget pause">
          Resolve budget
        </Link>
      </Button>
    );
  }

  return (
    <Button
      size="sm"
      disabled={isPending}
      className={companyPaused
        ? "bg-emerald-600 text-white hover:bg-emerald-700"
        : "bg-amber-500 text-amber-950 hover:bg-amber-400"}
      onClick={companyPaused ? onResume : onPause}
      title={companyPaused ? "Run company" : "Pause company"}
      aria-label={companyPaused ? "Run company" : "Pause company"}
    >
      {isPending
        ? (pendingAction === "resume" ? "Running..." : "Pausing...")
        : companyPaused
          ? (
            <>
              <Play className="mr-1 h-3.5 w-3.5" />
              Run
            </>
          )
          : (
            <>
              <Pause className="mr-1 h-3.5 w-3.5" />
              Pause
            </>
          )}
    </Button>
  );
}
