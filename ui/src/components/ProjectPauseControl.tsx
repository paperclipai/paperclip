import { Link } from "@/lib/router";
import { Button } from "@/components/ui/button";
import type { PauseReason } from "@paperclipai/shared";
import { Pause, Play } from "lucide-react";

interface ProjectPauseControlProps {
  projectRef: string;
  paused: boolean;
  pauseReason: PauseReason | null;
  isPending?: boolean;
  pendingAction?: "pause" | "resume";
  onPause: () => void;
  onResume: () => void;
}

export function ProjectPauseControl({
  projectRef,
  paused,
  pauseReason,
  isPending = false,
  pendingAction,
  onPause,
  onResume,
}: ProjectPauseControlProps) {
  if (paused && pauseReason === "budget") {
    return (
      <Button size="sm" variant="outline" asChild>
        <Link to={`/projects/${projectRef}/budget`} aria-label="Resolve project budget pause">
          Resolve budget
        </Link>
      </Button>
    );
  }

  const action = paused ? "resume" : "pause";

  return (
    <Button
      size="sm"
      disabled={isPending}
      className={paused
        ? "bg-emerald-600 text-white hover:bg-emerald-700"
        : "bg-amber-500 text-amber-950 hover:bg-amber-400"}
      onClick={action === "pause" ? onPause : onResume}
      title={paused ? "Resume project execution" : "Pause project execution"}
      aria-label={paused ? "Resume project execution" : "Pause project execution"}
    >
      {isPending
        ? (pendingAction === "resume" ? "Resuming..." : "Pausing...")
        : paused
          ? (
            <>
              <Play className="mr-1 h-3.5 w-3.5" />
              Resume
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
