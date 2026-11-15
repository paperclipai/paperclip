import type { ComponentProps } from "react";
import { useIssueNavigationPrefetch } from "@/hooks/useIssueNavigationPrefetch";
import { SidebarNavItem } from "./SidebarNavItem";

/** The route reference a Recents link opens: the identifier when the task has one. */
export function recentTaskPathRef(task: { id: string; identifier: string | null }) {
  return task.identifier ?? task.id;
}

/**
 * A sidebar task link (Recents, a project's recent tasks). It warms the task
 * on open intent the same way task lists do, under the reference the task
 * page reads.
 */
export function RecentTaskNavItem({
  task,
  to,
  ...props
}: Omit<ComponentProps<typeof SidebarNavItem>, "to" | "linkHandlers"> & {
  task: { id: string; identifier: string | null };
  /** Defaults to the board-relative task path. */
  to?: string;
}) {
  const pathRef = recentTaskPathRef(task);
  const linkHandlers = useIssueNavigationPrefetch(pathRef);
  return <SidebarNavItem {...props} to={to ?? `/issues/${pathRef}`} linkHandlers={linkHandlers} />;
}
