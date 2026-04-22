import { cn } from "../lib/utils";

interface ProjectCodeBadgeProps {
  code: string | null | undefined;
  className?: string;
}

export function ProjectCodeBadge({ code, className }: ProjectCodeBadgeProps) {
  if (!code) return null;
  return (
    <span
      className={cn(
        "inline-flex max-w-full shrink-0 items-center rounded-sm border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] leading-none text-muted-foreground",
        className,
      )}
      title={`Project code ${code}`}
    >
      {code}
    </span>
  );
}
