/**
 * Shared visual contract for the Streamlined UI primary navigation surface.
 * Settings reuses this contract when it takes over the global sidebar.
 */
export const primarySidebarStyles = {
  surface: "bg-border/50 dark:bg-muted",
  nav: "flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto scrollbar-auto-hide px-3 py-2 pointer-coarse:gap-3",
  group: "flex flex-col gap-0.5",
} as const;
