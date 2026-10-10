import { type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { SidebarNavExpandedProvider } from "./SidebarNavItem";

/**
 * Content adapter for a contextual sidebar. Depending on the route, Layout
 * either places it inside the primary SidebarShell or mounts it as an adjacent
 * secondary rail.
 */
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
        "h-full w-full min-w-0 overflow-hidden",
        className,
      )}
    >
      <SidebarNavExpandedProvider>{children}</SidebarNavExpandedProvider>
    </div>
  );
}
