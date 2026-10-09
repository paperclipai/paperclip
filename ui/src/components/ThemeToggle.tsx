import { Moon, Sun } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { useTheme } from "../context/ThemeContext";

type ThemeToggleVariant = "icon" | "menu-action" | "compact-menu-action";

interface ThemeToggleProps {
  className?: string;
  /**
   * `icon` (default): compact icon button — suitable for headers,
   * floating chrome (e.g. the unauthenticated `/auth` page), and any
   * other surface that just wants a toggle affordance.
   *
   * `menu-action`: full-width row with label + description + icon —
   * suitable for explanatory menus.
   *
   * `compact-menu-action`: compact label + icon row — matches the
   * surrounding actions in `SidebarAccountMenu`.
   */
  variant?: ThemeToggleVariant;
  /**
   * Called after `toggleTheme` runs. Surfaces like a popover menu use
   * this to dismiss the menu once the user has acted.
   */
  onAfterToggle?: () => void;
}

const MENU_ACTION_DESCRIPTION = "Toggle the app appearance.";

/**
 * Canonical theme-toggle widget. Both the signed-out `/auth` chrome and
 * the in-app account menu render through this component so the label,
 * icon, and toggle behaviour stay in sync as the theme model evolves.
 */
export function ThemeToggle({ className, variant = "icon", onAfterToggle }: ThemeToggleProps) {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  const label = isDark ? "Switch to light mode" : "Switch to dark mode";
  const Icon = isDark ? Sun : Moon;

  function handleClick() {
    toggleTheme();
    onAfterToggle?.();
  }

  if (variant === "compact-menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
      >
        <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">{label}</span>
      </button>
    );
  }

  if (variant === "menu-action") {
    return (
      <button
        type="button"
        className={cn(
          "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60",
          className,
        )}
        onClick={handleClick}
        aria-label={label}
      >
        <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
          <Icon className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-medium text-foreground">{label}</span>
          <span className="block text-xs text-muted-foreground">{MENU_ACTION_DESCRIPTION}</span>
        </span>
      </button>
    );
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      onClick={handleClick}
      aria-label={label}
      title={label}
      className={cn("text-muted-foreground", className)}
    >
      <Icon />
    </Button>
  );
}
