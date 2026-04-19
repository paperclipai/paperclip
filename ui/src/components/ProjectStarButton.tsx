import { Star } from "lucide-react";
import { cn } from "../lib/utils";

interface ProjectStarButtonProps {
  starred: boolean;
  projectName: string;
  onToggle: () => void;
  className?: string;
  iconClassName?: string;
}

export function ProjectStarButton({
  starred,
  projectName,
  onToggle,
  className,
  iconClassName,
}: ProjectStarButtonProps) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onToggle();
      }}
      aria-label={`${starred ? "Unstar" : "Star"} project ${projectName}`}
      aria-pressed={starred}
      title={starred ? "Unstar project" : "Star project"}
      className={cn(
        "flex items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        starred && "text-foreground",
        className,
      )}
    >
      <Star className={cn("h-3.5 w-3.5", starred && "fill-current", iconClassName)} />
    </button>
  );
}
