import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api/client";
import { agentsApi } from "../api/agents";
import { ChevronDown, UserCircle2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "../lib/utils";
import { useToastActions } from "../context/ToastContext";
import type { Agent } from "@paperclipai/shared";

interface OAuthProfile {
  id: string;
  label: string;
  userProfilePath: string;
}

function extractCurrentProfile(agent: Agent): string | null {
  const env = (agent.adapterConfig as Record<string, unknown>)?.env as Record<string, unknown> | undefined;
  const val = env?.USERPROFILE;
  if (typeof val === "string" && val.length > 0) return val;
  // Server normalizes env vars to {type:"plain",value:"..."} before persistence;
  // unwrap so the switcher can display the active profile name correctly.
  if (val && typeof val === "object") {
    const wrapped = val as Record<string, unknown>;
    if (wrapped.type === "plain" && typeof wrapped.value === "string" && (wrapped.value as string).length > 0) {
      return wrapped.value as string;
    }
  }
  return null;
}

function shortName(profile: OAuthProfile): string {
  return profile.label || profile.userProfilePath.split(/[\\/]/).pop() || profile.userProfilePath;
}

export function OAuthProfileSwitcher({
  agent,
  companyId,
  onSwitched,
  variant = "default",
}: {
  agent: Agent;
  companyId: string;
  onSwitched?: () => void;
  variant?: "default" | "compact";
}) {
  const isClaudeLocal = agent.adapterType === "claude_local";
  const [open, setOpen] = useState(false);
  const { pushToast } = useToastActions();
  const queryClient = useQueryClient();

  const currentProfile = extractCurrentProfile(agent);

  // Early-return must come after all hook calls — React requires identical
  // hook order across renders, otherwise navigating between adapter types
  // crashes the page ("Rendered fewer hooks than during the previous render").
  const { data: profiles } = useQuery<OAuthProfile[]>({
    queryKey: ["oauth-profiles", companyId],
    queryFn: () =>
      api
        .get<{ profiles: OAuthProfile[] }>(`/companies/${companyId}/claude-oauth-profiles`)
        .then((r) => r.profiles),
    retry: false,
    staleTime: 5 * 60 * 1000,
    enabled: isClaudeLocal,
  });

  const switchProfile = useMutation({
    mutationFn: async (profile: OAuthProfile) => {
      const existingConfig = (agent.adapterConfig ?? {}) as Record<string, unknown>;
      const existingEnv = (existingConfig.env ?? {}) as Record<string, unknown>;
      return agentsApi.update(
        agent.id,
        {
          adapterConfig: {
            ...existingConfig,
            env: { ...existingEnv, USERPROFILE: profile.userProfilePath },
          },
          replaceAdapterConfig: true,
        },
        companyId,
      );
    },
    onSuccess: () => {
      pushToast({ title: "OAuth 账号已切换", tone: "success" });
      queryClient.invalidateQueries({ queryKey: ["agents", companyId] });
      queryClient.invalidateQueries({ queryKey: ["agents", "detail"] });
      setOpen(false);
      onSwitched?.();
    },
    onError: (err) => {
      pushToast({
        title: "切换失败",
        body: err instanceof Error ? err.message : "未知错误",
        tone: "error",
      });
    },
  });

  if (!isClaudeLocal) return null;
  // Don't render until backend endpoint is ready (handles pre-VOG-2730 gracefully)
  if (!profiles || profiles.length === 0) return null;

  const activeProfile = profiles.find((p) => p.userProfilePath === currentProfile);
  const currentLabel = activeProfile ? shortName(activeProfile) : (currentProfile?.split(/[\\/]/).pop() ?? "默认");

  const isCompact = variant === "compact";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center gap-1 border border-border transition-colors hover:bg-accent/50",
            isCompact
              ? "rounded px-1.5 py-0.5 text-[11px]"
              : "rounded-md px-2.5 py-1 text-xs",
            switchProfile.isPending && "opacity-50 cursor-not-allowed",
          )}
          disabled={switchProfile.isPending}
          title="切换 OAuth 账号"
        >
          <UserCircle2 className={cn("text-muted-foreground", isCompact ? "h-3 w-3" : "h-3.5 w-3.5")} />
          <span>{switchProfile.isPending ? "切换中..." : currentLabel}</span>
          <ChevronDown className="h-3 w-3 text-muted-foreground" />
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-48 p-1" align="start">
        <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-muted-foreground">
          OAuth 账号
        </div>
        {profiles.map((profile) => {
          const isActive = profile.userProfilePath === currentProfile;
          return (
            <button
              key={profile.id}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-sm rounded text-left hover:bg-accent/50",
                isActive && "bg-accent",
                (switchProfile.isPending || isActive) && "cursor-default",
              )}
              disabled={switchProfile.isPending || isActive}
              onClick={() => {
                if (!isActive) switchProfile.mutate(profile);
              }}
            >
              <span className="flex-1 truncate">{shortName(profile)}</span>
              {isActive && (
                <span className="shrink-0 text-[10px] text-muted-foreground">当前</span>
              )}
            </button>
          );
        })}
      </PopoverContent>
    </Popover>
  );
}
