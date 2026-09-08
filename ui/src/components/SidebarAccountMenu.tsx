import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Flag,
  LogOut,
  Settings,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSignOut } from "@/hooks/useSignOut";
import { useSidebar } from "../context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** Contextual navigation occupies a full sidebar even if the saved global nav mode is collapsed. */
  forceExpanded?: boolean;
}

interface MenuActionProps {
  label: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  external?: boolean;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function deriveUserSlug(name: string | null | undefined, email: string | null | undefined, id: string | null | undefined) {
  const candidates = [name, email?.split("@")[0], email, id];
  for (const candidate of candidates) {
    const slug = candidate
      ?.trim()
      .toLowerCase()
      .replace(/['"]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (slug) return slug;
  }
  return "me";
}

function MenuAction({
  label,
  icon: Icon,
  onClick,
  href,
  external = false,
}: MenuActionProps) {
  const className =
    "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-accent";

  const content = (
    <>
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </>
  );

  if (href) {
    if (external) {
      return (
        <a href={href} target="_blank" rel="noreferrer" className={className} onClick={onClick}>
          {content}
        </a>
      );
    }

    return (
      <Link to={href} className={className} onClick={onClick}>
        {content}
      </Link>
    );
  }

  return (
    <button type="button" className={className} onClick={onClick}>
      {content}
    </button>
  );
}

export function SidebarAccountMenu({
  deploymentMode,
  open: controlledOpen,
  onOpenChange,
  forceExpanded = false,
}: SidebarAccountMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking && !forceExpanded;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useSignOut({ onSignedOut: closeNavigationChrome });

  const displayName = session?.user.name?.trim() || "Board";
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? "Signed in" : "Local workspace board");
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function handleSignOut() {
    signOutMutation.mutate();
  }

  return (
    <div className="bg-border/50 px-3 py-2 dark:bg-muted">
      <div className={cn("flex items-center gap-0.5", !rail && "px-2")}>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className={cn(
                "flex min-w-0 items-center gap-2.5 rounded-lg text-left text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                rail ? "w-full px-3 py-2" : "flex-1 px-2 py-1.5",
              )}
              aria-label="Open account menu"
            >
              <Avatar size="sm">
                {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                <AvatarFallback>{initials}</AvatarFallback>
              </Avatar>
              <span className={cn("min-w-0 flex-1 truncate", rail && SIDEBAR_RAIL_HIDDEN_LABEL)}>{displayName}</span>
            </button>
          </PopoverTrigger>
          <PopoverContent
            side="top"
            align="start"
            sideOffset={10}
            className="min-h-(--profile-popover-min-height) w-(--profile-popover-width) max-w-(--sz-calc-24) overflow-hidden rounded-xl border-border bg-popover p-0 shadow-(--shadow-profile-popover)"
          >
            <div className="flex h-(--profile-popover-header-height) shrink-0 items-center gap-2.5 px-3.5">
              <Avatar className="size-9">
                {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                <AvatarFallback className="text-xs text-foreground">{initials}</AvatarFallback>
              </Avatar>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-sm font-semibold leading-(--profile-popover-label-line-height) text-foreground">
                  {displayName}
                </h2>
                <p className="truncate text-(length:--text-micro) leading-(--profile-popover-meta-line-height) text-muted-foreground">
                  {secondaryLabel}
                </p>
              </div>
            </div>

            <div className="flex flex-1 flex-col gap-0.5 border-t border-border px-2.5 pb-2.5 pt-2">
              <MenuAction
                label="Settings"
                icon={Settings}
                href="/company/settings"
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="View profile"
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="Edit profile"
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="Documentation"
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <ThemeToggle variant="compact-menu-action" onAfterToggle={() => setOpen(false)} />
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex h-(--profile-popover-row-height) w-full items-center gap-(--profile-popover-row-gap) rounded-lg px-2.5 text-left text-(length:--text-compact) font-medium leading-(--profile-popover-label-line-height) text-foreground transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={handleSignOut}
                  disabled={signOutMutation.isPending}
                >
                  <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1 truncate">
                    {signOutMutation.isPending ? "Signing out..." : "Sign out"}
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </PopoverContent>
        </Popover>
        {!rail ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={FEEDBACK_URL}
                target="_blank"
                rel="noreferrer"
                aria-label="Share feedback"
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">Share feedback</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
