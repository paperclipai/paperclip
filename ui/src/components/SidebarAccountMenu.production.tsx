import { useTranslation, t } from "@/i18n";
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  BookOpen,
  Flag,
  LogOut,
  type LucideIcon,
  UserPlus,
} from "lucide-react";
import { hidesCompanyPage, type DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useCloudInstance } from "@/hooks/useCloudInstance";
import { useCloudInviteUrl } from "@/hooks/useCloudInviteUrl";
import { useCanInviteCompanyMembers } from "@/hooks/useCompanyInviteAccess";
import { useHiddenSettings } from "@/hooks/useHiddenSettings";
import { useSignOut } from "@/hooks/useSignOut";
import { useStagingCommit } from "@/hooks/useStagingCommit";
import { userProfilePath } from "@/lib/userProfileLinks";
import { useSidebar } from "../context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";

const INVITES_PATH = "/company/settings/members?tab=invites";
const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface MenuActionProps {
  label: string;
  description: string;
  icon: LucideIcon;
  onClick?: () => void;
  href?: string;
  /** Opens `href` in a new tab (docs and other off-product links). */
  external?: boolean;
  /**
   * Leaves the app in the current tab with a full navigation. Cloud links
   * must use this: the cloud harness shadows those paths on tenant hosts, so
   * the in-app router can never reach them.
   */
  topLevel?: boolean;
}

function deriveInitials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0]?.[0] ?? ""}${parts[parts.length - 1]?.[0] ?? ""}`.toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

function MenuAction({
  label,
  description,
  icon: Icon,
  onClick,
  href,
  external = false,
  topLevel = false,
}: MenuActionProps) {
  useTranslation();
  const className =
    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-accent/60";

  const content = (
    <>
      <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{description}</span>
      </span>
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

    if (topLevel) {
      return (
        <a href={href} className={className} onClick={onClick}>
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
}: SidebarAccountMenuProps) {
  const { t } = useTranslation();
  const cloud = useCloudInstance();
  const isCloud = Boolean(cloud);
  // Invites live on the Members page (or in Cloud's People settings). Hide the
  // shortcut when the hosting operator hides either surface, and until the
  // health response resolves so a hidden surface never flashes.
  const { hidden: hiddenSettings, loaded: hiddenSettingsLoaded } = useHiddenSettings();
  // On Cloud the shortcut exists only for the current stack's owner/admin and
  // only once the stack metadata is known; the in-app Invites tab is never a
  // fallback there because it drives a different invitation flow.
  const cloudInviteUrl = useCloudInviteUrl();
  // Self-hosted invites need the `users:invite` grant. Offer the shortcut only
  // to boards with role-default access (company owner/admin/operator,
  // instance admins, local boards). The server checks the actual grants.
  const canInviteMembers = useCanInviteCompanyMembers(!isCloud);
  const inviteHref = isCloud ? cloudInviteUrl : canInviteMembers ? INVITES_PATH : null;
  const showInvite =
    hiddenSettingsLoaded &&
    inviteHref !== null &&
    !hidesCompanyPage(hiddenSettings, "company.members") &&
    !hidesCompanyPage(hiddenSettings, "company.invites");
  const [internalOpen, setInternalOpen] = useState(false);
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const stagingCommit = useStagingCommit(open);
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useSignOut({ onSignedOut: closeNavigationChrome });

  const displayName = session?.user.name?.trim() || t("localizationActivity.board");
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? t("account.signedIn") : t("account.localWorkspaceBoard"));
  const initials = deriveInitials(displayName);
  const profileHref = userProfilePath(session?.user);

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  function handleSignOut() {
    signOutMutation.mutate();
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <div className={cn("flex items-center gap-0.5", !rail && "px-2")}>
        <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className={cn(
              "flex min-w-0 items-center gap-2.5 rounded-lg text-left text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground",
              rail ? "w-full px-3 py-2" : "flex-1 px-2 py-1.5",
            )}
            aria-label={t("account.openAccountMenu")}
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
          className="w-(--sz-277px) max-w-(--sz-calc-24) overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-(image:--gradient-extract-25)" />
          <div className="-mt-8 px-4 pb-4">
            {/* The profile link is a stretched overlay so the staging SHA anchor can sit beside the email without nesting anchors. */}
            <div className="relative flex items-start gap-3">
              <Link
                to={profileHref}
                aria-label={t("oct5Core.s0425")}
                onClick={closeNavigationChrome}
                className="absolute inset-0 rounded-xl transition-colors hover:bg-accent/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
              <div className="pointer-events-none relative rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="pointer-events-none relative min-w-0 flex-1 pt-1">
                <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                {stagingCommit ? (
                  <a
                    className="pointer-events-auto block truncate font-mono text-(length:--text-micro) leading-(--profile-popover-meta-line-height) text-muted-foreground hover:underline focus-visible:underline"
                    href={`https://github.com/paperclipai/paperclip/commit/${stagingCommit}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label={t("oct5Core.viewCommit", { commit: stagingCommit })}
                    title={stagingCommit}
                  >
                    SHA {stagingCommit.slice(0, 7)}
                  </a>
                ) : null}
              </div>
            </div>

            <div className="mt-4 space-y-1">
              {showInvite && inviteHref ? (
                <MenuAction
                  label={t("oct5Core.invite")}
                  description={t("oct5Core.invitePeople")}
                  icon={UserPlus}
                  href={inviteHref}
                  topLevel={isCloud}
                  onClick={closeNavigationChrome}
                />
              ) : null}
              <MenuAction
                label={t("account.documentation")}
                description={t("account.documentationDescription")}
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <ThemeToggle variant="menu-action" onAfterToggle={() => setOpen(false)} />
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={handleSignOut}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending ? t("account.signingOut") : t("account.signOut")}
                    </span>
                    <span className="block text-xs text-muted-foreground">{t("account.signOutDescription")}</span>
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
        </Popover>
        {!rail && !isCloud ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <a
                href={FEEDBACK_URL}
                target="_blank"
                rel="noreferrer"
                aria-label={t("localizationAgentChrome.ui138_Share_feedback")}
                className="flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground/50 transition-colors hover:bg-accent/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Flag className="h-4 w-4" aria-hidden="true" />
              </a>
            </TooltipTrigger>
            <TooltipContent side="top">{t("localizationAgentChrome.ui138_Share_feedback")}</TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}
