import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  BookOpen,
  LogOut,
  type LucideIcon,
  Moon,
  Settings,
  UserRound,
  Sun,
  UserRoundPen,
} from "lucide-react";
import type { DeploymentMode } from "@paperclipai/shared";
import { Link } from "@/lib/router";
import { authApi } from "@/api/auth";
import { queryKeys } from "@/lib/queryKeys";
import { useSidebar } from "../context/SidebarContext";
import { useTheme } from "../context/ThemeContext";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "../lib/utils";

const PROFILE_SETTINGS_PATH = "/instance/settings/profile";
const DOCS_URL = "https://docs.paperclip.ing/";

interface SidebarAccountMenuProps {
  deploymentMode?: DeploymentMode;
  instanceSettingsTarget: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
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
  instanceSettingsTarget,
  open: controlledOpen,
  onOpenChange,
  version,
}: SidebarAccountMenuProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const queryClient = useQueryClient();
  const { isMobile, setSidebarOpen } = useSidebar();
  const { theme, toggleTheme } = useTheme();
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
    },
  });

  const displayName = session?.user.name?.trim() || "Board";
  const secondaryLabel =
    session?.user.email?.trim() || (deploymentMode === "authenticated" ? "로그인됨" : "로컬 업무 보드");
  const accountBadge = deploymentMode === "authenticated" ? "계정" : "로컬";
  const initials = deriveInitials(displayName);
  const profileHref = `/u/${deriveUserSlug(session?.user.name, session?.user.email, session?.user.id)}`;

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
            className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[13px] font-medium text-foreground/80 transition-colors hover:bg-accent/50 hover:text-foreground"
            aria-label="계정 메뉴 열기"
          >
            <Avatar size="sm">
              {session?.user.image ? <AvatarImage src={session.user.image} alt={displayName} /> : null}
              <AvatarFallback>{initials}</AvatarFallback>
            </Avatar>
            <span className="min-w-0 flex-1 truncate">{displayName}</span>
          </button>
        </PopoverTrigger>
        <PopoverContent
          side="top"
          align="start"
          sideOffset={10}
          className="w-[var(--radix-popover-trigger-width)] overflow-hidden rounded-t-2xl rounded-b-none border-border p-0 shadow-2xl"
        >
          <div className="h-24 bg-[linear-gradient(135deg,hsl(var(--primary))_0%,hsl(var(--accent))_55%,hsl(var(--muted))_100%)]" />
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
                  <span className="rounded-full bg-accent px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {accountBadge}
                  </span>
                </div>
                <p className="truncate text-sm text-muted-foreground">{secondaryLabel}</p>
                {version ? (
                  <p className="mt-1 text-xs text-muted-foreground">RealTycoon2 v{version}</p>
                ) : null}
              </div>
            </div>

            <div className="mt-4 space-y-1">
              <MenuAction
                label="프로필 보기"
                description="활동, 업무, 사용량 기록을 봅니다."
                icon={UserRound}
                href={profileHref}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="프로필 편집"
                description="표시 이름과 아바타를 수정합니다."
                icon={UserRoundPen}
                href={PROFILE_SETTINGS_PATH}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="RealTycoon2 설정"
                description="마지막으로 열었던 설정 화면으로 이동합니다."
                icon={Settings}
                href={instanceSettingsTarget}
                onClick={closeNavigationChrome}
              />
              <MenuAction
                label="RealTycoon2 도움말"
                description="RealTycoon2 참고 문서를 새 탭에서 엽니다."
                icon={BookOpen}
                href={DOCS_URL}
                external
                onClick={() => setOpen(false)}
              />
              <MenuAction
                label={theme === "dark" ? "라이트 모드로 전환" : "다크 모드로 전환"}
                description="앱 표시 모드를 바꿉니다."
                icon={theme === "dark" ? Sun : Moon}
                onClick={() => {
                  toggleTheme();
                  setOpen(false);
                }}
              />
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
                      {signOutMutation.isPending ? "로그아웃 중..." : "로그아웃"}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      이 브라우저 세션을 종료합니다.
                    </span>
                  </span>
                </button>
              ) : null}
            </div>
          </div>
        </PopoverContent>
      </Popover>
    </div>
  );
}
