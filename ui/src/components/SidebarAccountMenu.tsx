import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  Languages,
  LogOut,
  Megaphone,
  type LucideIcon,
  UserRound,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode, ServerGitInfo } from "@paperclipai/shared";
import { useTranslation } from "react-i18next";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn, SIDEBAR_RAIL_HIDDEN_LABEL } from "../lib/utils";
import { ThemeToggle } from "./ThemeToggle";
import { SidebarServerInfo } from "./SidebarServerInfo";
import { Badge } from "@/components/ui/badge";
import { appLocales, setLocale } from "@/i18n";

const PROFILE_SETTINGS_PATH = "/company/settings/instance/profile";
const DOCS_URL = "https://docs.paperclip.ing/";
const FEEDBACK_URL = "https://paperclip.ing/feedback";
const SOURCE_REPOSITORY_URL = "https://github.com/paperclipai/paperclip";
const SOURCE_VERSION_RE = /\+\d+\.git\.([0-9a-f]{7,40})(?:\.dirty)?$/i;

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  serverGit?: ServerGitInfo;
  version?: string | null;
}

interface MenuActionProps {
  label: string;
  description: string;
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

function sourceVersionSha(version: string): string | null {
  const sourceVersion = version.match(SOURCE_VERSION_RE);
  return sourceVersion?.[1] ?? null;
}

function MenuAction({ label, description, icon: Icon, onClick, href, external = false }: MenuActionProps) {
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
  serverGit,
  version,
}: SidebarAccountMenuProps) {
  const { t, i18n } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen, collapsed, peeking } = useSidebar();
  const rail = collapsed && !peeking;
  const open = controlledOpen ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
    retry: false,
  });

  const signOutMutation = useMutation({
    mutationFn: () => authApi.signOut(),
    onSuccess: async () => {
      setOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.auth.session });
      await queryClient.invalidateQueries({ queryKey: queryKeys.health });
    },
  });

  const displayName = session?.user.name?.trim() || t("account.board");
  const secondaryLabel =
    session?.user.email?.trim() ||
    (deploymentMode === "authenticated" ? t("account.signedIn") : t("account.localWorkspaceBoard"));
  const accountBadge = deploymentMode === "authenticated" ? t("account.account") : t("account.local");
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;
  const sourceSha = version ? sourceVersionSha(version) : null;
  const sourceFullSha =
    sourceSha && serverGit?.available && serverGit.fullSha.toLowerCase().startsWith(sourceSha.toLowerCase())
      ? serverGit.fullSha
      : sourceSha;
  const sourceBranch = sourceSha && serverGit?.available ? serverGit.branchName : null;

  function closeNavigationChrome() {
    setOpen(false);
    if (isMobile) setSidebarOpen(false);
  }

  return (
    <div className="border-t border-r border-border bg-background px-3 py-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-(length:--text-compact) font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label={t("account.openMenu")}
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
            <div className="flex items-start gap-3">
              <div className="rounded-2xl border-4 border-popover bg-popover p-0.5 shadow-sm">
                <Avatar size="lg">
                  {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
                  <AvatarFallback>{initials}</AvatarFallback>
                </Avatar>
              </div>
              <div className="min-w-0 flex-1 pt-1">
                <div className="flex items-center gap-2">
                  <h2 className="truncate text-base font-semibold text-foreground">{displayName}</h2>
                  <Badge variant="ghost" className="bg-accent text-(length:--text-nano) font-semibold uppercase tracking-wide text-muted-foreground">
                    {accountBadge}
                  </Badge>
                </div>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                {sourceSha && sourceFullSha ? (
                  <div className="mt-1 text-xs text-muted-foreground">
                    {sourceBranch ? (
                      <a
                        href={`${SOURCE_REPOSITORY_URL}/tree/${encodeURIComponent(sourceBranch)}`}
                        target="_blank"
                        rel="noreferrer"
                        className="block truncate transition-colors hover:text-foreground"
                      >
                        {sourceBranch}
                      </a>
                    ) : null}
                    <p>
                      Paperclip{" "}
                      <a
                        href={`${SOURCE_REPOSITORY_URL}/commit/${sourceFullSha}`}
                        target="_blank"
                        rel="noreferrer"
                        className="transition-colors hover:text-foreground"
                      >
                        {sourceSha.slice(0, 7)}
                      </a>
                    </p>
                  </div>
                ) : version ? (
                  <p className="mt-1 text-xs text-muted-foreground">Paperclip v{version}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 space-y-1">
              <MenuAction
                label={t("account.viewProfile")}
                description={t("account.viewProfileDescription")}
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label={t("account.editProfile")}
                description={t("account.editProfileDescription")}
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label={t("account.documentation")}
                description={t("account.documentationDescription")}
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <MenuAction
                label={t("account.feedback")}
                description={t("account.feedbackDescription")}
                icon={Megaphone}
                href={FEEDBACK_URL}
                external
                onClick={() => setOpen(false)}
              />
              <div className="flex items-start gap-3 rounded-xl px-3 py-3">
                <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                  <Languages className="size-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <span className="block text-sm font-medium text-foreground">{t("account.language")}</span>
                  <span className="block text-xs text-muted-foreground">{t("account.languageDescription")}</span>
                  <div
                    className="mt-2 grid grid-cols-2 gap-1 rounded-lg bg-muted/70 p-1"
                    role="group"
                    aria-label={t("account.language")}
                  >
                    {appLocales.map((locale) => (
                      <button
                        key={locale.value}
                        type="button"
                        aria-pressed={i18n.resolvedLanguage === locale.value}
                        className={cn(
                          "rounded-md px-2 py-1.5 text-xs font-medium transition-colors",
                          i18n.resolvedLanguage === locale.value
                            ? "bg-background text-foreground shadow-sm"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                        onClick={() => void setLocale(locale.value)}
                      >
                        {locale.label}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
              <ThemeToggle variant="menu-action" onAfterToggle={() => setOpen(false)} />
              {deploymentMode === "authenticated" ? (
                <button
                  type="button"
                  className={cn(
                    "flex w-full items-start gap-3 rounded-xl px-3 py-3 text-left transition-colors hover:bg-destructive/10",
                    signOutMutation.isPending && "cursor-not-allowed opacity-60",
                  )}
                  onClick={() => signOutMutation.mutate()}
                  disabled={signOutMutation.isPending}
                >
                  <span className="mt-0.5 rounded-lg border border-border bg-background/70 p-2 text-muted-foreground">
                    <LogOut className="size-4" />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-foreground">
                      {signOutMutation.isPending ? t("account.signingOut") : t("account.signOut")}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {t("account.signOutDescription")}
                    </span>
                  </span>
                </button>
              ) : null}
              <SidebarServerInfo />
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
