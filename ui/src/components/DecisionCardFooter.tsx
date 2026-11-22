import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Keeps a decision's task reference and its existing controls in one wrapping row. */
export function DecisionCardFooter({ leading, children, className }: {
  leading?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <div data-decision-footer className={cn("flex flex-wrap items-center justify-between gap-x-4 gap-y-3", className)}>
      {leading ? <div className="min-w-0 flex-1 basis-48">{leading}</div> : null}
      {children ? <div data-decision-actions className="ml-auto flex max-w-full flex-wrap items-center justify-end gap-1.5">{children}</div> : null}
    </div>
  );
}
