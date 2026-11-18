import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export function SecondarySidebar({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-secondary-sidebar=""
      className={cn(
        "h-full w-60 shrink-0 overflow-y-auto border-r border-border bg-background",
        className,
      )}
    >
      {children}
    </div>
  );
}
