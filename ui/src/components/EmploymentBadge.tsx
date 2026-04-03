import { cn } from "@/lib/utils";

interface EmploymentBadgeProps {
  type: string;
  className?: string;
}

export function EmploymentBadge({ type, className }: EmploymentBadgeProps) {
  if (type === "contractor") {
    return (
      <span
        className={cn(
          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400 ring-1 ring-inset ring-amber-500/20",
          className,
        )}
      >
        Contractor
      </span>
    );
  }
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium bg-blue-500/10 text-blue-600 dark:text-blue-400 ring-1 ring-inset ring-blue-500/20",
        className,
      )}
    >
      Full-Time
    </span>
  );
}
