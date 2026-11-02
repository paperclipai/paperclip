import type { ComponentProps } from "react";
import { cn } from "../lib/utils";

/**
 * One root task and its visible descendants. The group owns the outer dividers;
 * IssueRow owns indentation and vertical guides, with no interior separators.
 * Render separate groups as adjacent siblings to share their boundary line.
 */
export function TaskRowGroup({ className, ...props }: ComponentProps<"div">) {
  return (
    <div
      data-slot="task-row-group"
      role="group"
      className={cn("task-row-group", className)}
      {...props}
    />
  );
}
