import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keeps a decision's task reference and its existing controls in one wrapping row. */
export function DecisionCardFooter({ leading, children, className }: {
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  if (!leading) return <>{children}</>;
  return (
    <div data-decision-footer className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}>
      <div className="min-w-0 flex-1 basis-48">{leading}</div>
      {children ? <div className="ml-auto max-w-full">{children}</div> : null}
    </div>
  );
}
