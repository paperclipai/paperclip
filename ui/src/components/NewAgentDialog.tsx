import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@/lib/router";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { accessApi } from "../api/access";
import { agentsApi } from "../api/agents";
import { adaptersApi } from "../api/adapters";
import { queryKeys } from "@/lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  ArrowLeft,
  Bot,
  Check,
  MailPlus,
  Settings2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { buildAgentOnboardingPrompt } from "@/lib/agent-onboarding-prompt";
import { listUIAdapters } from "../adapters";
import { isVisualAdapterChoice } from "../adapters/metadata";
import { getLocalizedAdapterDisplay } from "../adapters/adapter-display-registry";
import { useDisabledAdaptersSync } from "../adapters/use-disabled-adapters";
import { useToast } from "../context/ToastContext";
import { useLocalizedCopy } from "@/i18n/ui-copy";

/**
 * Adapter types that are suitable for agent creation (excludes internal
 * system adapters like "process" and "http").
 */
const SYSTEM_ADAPTER_TYPES = new Set(["process", "http"]);

type NewAgentDialogMode = "choices" | "runtime" | "invite" | "prompt";

function isAgentAdapterType(type: string): boolean {
  return !SYSTEM_ADAPTER_TYPES.has(type);
}

export function NewAgentDialog() {
  const copy = useLocalizedCopy();
  const { newAgentOpen, closeNewAgent, openNewIssue } = useDialog();
  const { selectedCompanyId } = useCompany();
  const { pushToast } = useToast();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<NewAgentDialogMode>("choices");
  const [agentMessage, setAgentMessage] = useState("");
  const [latestAgentPrompt, setLatestAgentPrompt] = useState<string | null>(null);
  const [latestAgentPromptCopied, setLatestAgentPromptCopied] = useState(false);
  const disabledTypes = useDisabledAdaptersSync();

  function resetDialogState() {
    setMode("choices");
    setAgentMessage("");
    setLatestAgentPrompt(null);
    setLatestAgentPromptCopied(false);
  }

  useEffect(() => {
    if (!latestAgentPromptCopied) return;
    const timeout = window.setTimeout(() => {
      setLatestAgentPromptCopied(false);
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [latestAgentPromptCopied]);

  // Fetch registered adapters from server (syncs disabled store + provides data)
  const { data: serverAdapters } = useQuery({
    queryKey: queryKeys.adapters.all,
    queryFn: () => adaptersApi.list(),
    staleTime: 5 * 60 * 1000,
  });

  // Fetch existing agents for the "Ask CEO" flow
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && newAgentOpen,
  });

  const ceoAgent = (agents ?? []).find((a) => a.role === "ceo");
  const inviteHistoryQueryKey = queryKeys.access.invites(selectedCompanyId ?? "", "all", 5);

  // Build the adapter grid from the UI registry merged with display metadata.
  // This automatically includes external/plugin adapters.
  const adapterGrid = useMemo(() => {
    const registered = listUIAdapters()
      .filter((a) =>
        isAgentAdapterType(a.type) &&
        !disabledTypes.has(a.type) &&
        isVisualAdapterChoice(a.type)
      );

    // Sort: recommended first, then alphabetical
    return registered
      .map((a) => {
        const display = getLocalizedAdapterDisplay(a.type, copy);
        return {
          value: a.type,
          label: display.label,
          desc: display.description,
          icon: display.icon,
          recommended: display.recommended,
          comingSoon: display.comingSoon,
          disabledLabel: display.disabledLabel,
        };
      })
      .sort((a, b) => {
        if (a.recommended && !b.recommended) return -1;
        if (!a.recommended && b.recommended) return 1;
        return a.label.localeCompare(b.label);
      });
  }, [copy, disabledTypes, serverAdapters]);

  function handleAskCeo() {
    closeNewAgent();
    openNewIssue({
      assigneeAgentId: ceoAgent?.id,
      title: copy("newAgent.askCeoTitle", "Create a new agent", "새 직원 만들기"),
      description: copy("newAgent.askCeoDescription", "(type in what kind of agent you want here)", "(원하는 직원 종류를 여기에 입력하세요)"),
    });
  }

  function handleAdvancedConfig() {
    setMode("runtime");
  }

  function handleInviteExternalAgent() {
    setMode("invite");
  }

  function handleAdvancedAdapterPick(adapterType: string) {
    closeNewAgent();
    resetDialogState();
    navigate(`/agents/new?adapterType=${encodeURIComponent(adapterType)}`);
  }

  async function copyText(text: string, unavailableBody: string) {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch {
      // Fall through to the unavailable message below.
    }

    pushToast({
      title: copy("newAgent.clipboardUnavailable", "Clipboard unavailable", "클립보드 사용 불가"),
      body: unavailableBody,
      tone: "warn",
    });
    return false;
  }

  const createAgentInviteMutation = useMutation({
    mutationFn: () =>
      accessApi.createCompanyInvite(selectedCompanyId!, {
        allowedJoinTypes: "agent",
        humanRole: null,
        agentMessage: agentMessage.trim() || null,
      }),
    onSuccess: async (invite) => {
      const base = window.location.origin.replace(/\/+$/, "");
      const onboardingTextLink =
        invite.onboardingTextUrl ??
        invite.onboardingTextPath ??
        `/api/invites/${invite.token}/onboarding.txt`;
      const onboardingTextUrl = onboardingTextLink.startsWith("http")
        ? onboardingTextLink
        : `${base}${onboardingTextLink}`;

      let prompt: string;
      try {
        const manifest = await accessApi.getInviteOnboarding(invite.token);
        prompt = buildAgentOnboardingPrompt({
          onboardingTextUrl,
          connectionCandidates:
            manifest.onboarding.connectivity?.connectionCandidates ?? null,
          testResolutionUrl:
            manifest.onboarding.connectivity?.testResolutionEndpoint?.url ??
            null,
        });
      } catch {
        prompt = buildAgentOnboardingPrompt({
          onboardingTextUrl,
          connectionCandidates: null,
          testResolutionUrl: null,
        });
      }

      setLatestAgentPrompt(prompt);
      setLatestAgentPromptCopied(false);
      setMode("prompt");
      const copied = await copyText(prompt, copy("newAgent.copyPromptManual", "Copy the agent onboarding prompt manually from the field below.", "아래 필드에서 직원 온보딩 프롬프트를 직접 복사하세요."));

      await queryClient.invalidateQueries({ queryKey: inviteHistoryQueryKey });
      pushToast({
        title: copy("newAgent.inviteCreated", "Agent invite created", "직원 초대 생성됨"),
        body: copied
          ? copy("newAgent.promptReadyCopied", "Agent onboarding prompt ready below and copied to clipboard.", "직원 온보딩 프롬프트가 아래에 준비되었고 클립보드에 복사되었습니다.")
          : copy("newAgent.promptReady", "Agent onboarding prompt ready below.", "직원 온보딩 프롬프트가 아래에 준비되었습니다."),
        tone: "success",
      });
    },
    onError: (error) => {
      pushToast({
        title: copy("newAgent.inviteFailed", "Failed to create agent invite", "직원 초대 생성 실패"),
        body: error instanceof Error ? error.message : copy("common.unknownError", "Unknown error", "알 수 없는 오류"),
        tone: "error",
      });
    },
  });

  return (
    <Dialog
      open={newAgentOpen}
      onOpenChange={(open) => {
        if (!open) {
          resetDialogState();
          closeNewAgent();
        }
      }}
    >
      <DialogContent
        showCloseButton={false}
        className={cn(
          "max-h-[min(calc(100dvh-2rem),46rem)] p-0 gap-0 overflow-hidden flex flex-col",
          mode === "invite" || mode === "prompt" ? "sm:max-w-2xl" : "sm:max-w-md",
        )}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border">
          <span className="text-sm text-muted-foreground">{copy("newAgent.header", "Add a new agent", "새 직원 추가")}</span>
          <Button
            variant="ghost"
            size="icon-xs"
            className="text-muted-foreground"
            onClick={() => {
              resetDialogState();
              closeNewAgent();
            }}
          >
            <span className="text-lg leading-none">&times;</span>
          </Button>
        </div>

        <div className="min-h-0 overflow-y-auto p-6 space-y-6">
          {mode === "choices" ? (
            <>
              {/* Recommendation */}
              <div className="text-center space-y-3">
                <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-accent">
                  <Bot className="h-6 w-6 text-foreground" />
                </div>
                <p className="text-sm text-muted-foreground">
                  {copy(
                    "newAgent.choiceHelp",
                    "Ask a leader to propose the hire, configure a runtime yourself, or send an onboarding prompt to an external agent.",
                    "리더에게 채용 제안을 맡기거나, 런타임을 직접 설정하거나, 외부 직원에게 온보딩 프롬프트를 보냅니다.",
                  )}
                </p>
              </div>

              <Button className="w-full" size="lg" onClick={handleAskCeo}>
                <Bot className="h-4 w-4 mr-2" />
                {copy("newAgent.askCeo", "Ask the CEO to create a new agent", "CEO에게 새 직원 생성을 요청")}
              </Button>

              <div className="grid gap-2">
                <Button variant="outline" className="w-full" onClick={handleAdvancedConfig}>
                  <Settings2 className="h-4 w-4 mr-2" />
                  {copy("newAgent.configureRuntime", "Configure a runtime manually", "런타임 직접 설정")}
                </Button>
                <div className="space-y-1">
                  <Button variant="outline" className="w-full" onClick={handleInviteExternalAgent}>
                    <MailPlus className="h-4 w-4 mr-2" />
                    {copy("newAgent.inviteExternal", "Invite an external agent", "외부 직원 초대")}
                  </Button>
                  <p className="text-xs text-muted-foreground text-center">
                    {copy("newAgent.externalHint", "(OpenClaw, Hermes, or any agent that can call the invite API.)", "(OpenClaw, Hermes 또는 초대 API를 호출할 수 있는 직원)")}
                  </p>
                </div>
              </div>
            </>
          ) : mode === "runtime" ? (
            <>
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {copy("common.back", "Back", "뒤로")}
                </button>
                <p className="text-sm text-muted-foreground">
                  {copy("newAgent.runtimeHelp", "Choose the runtime Paperclip should start or resume directly.", "Paperclip이 직접 시작하거나 재개할 런타임을 선택하세요.")}
                </p>
              </div>

              <div className="grid grid-cols-2 gap-2">
                {adapterGrid.map((opt) => (
                  <button
                    key={opt.value}
                    className={cn(
                      "flex flex-col items-center gap-1.5 rounded-md border border-border p-3 text-xs transition-colors hover:bg-accent/50 relative",
                      opt.comingSoon && "opacity-40 cursor-not-allowed",
                    )}
                    disabled={!!opt.comingSoon}
                    title={opt.comingSoon ? opt.disabledLabel : undefined}
                    onClick={() => {
                      if (!opt.comingSoon) handleAdvancedAdapterPick(opt.value);
                    }}
                  >
                    {opt.recommended && (
                      <span className="absolute -top-1.5 right-1.5 bg-green-500 text-white text-[9px] font-semibold px-1.5 py-0.5 rounded-full leading-none">
                        {copy("common.recommended", "Recommended", "추천")}
                      </span>
                    )}
                    <opt.icon className="h-4 w-4" />
                    <span className="font-medium">{opt.label}</span>
                    <span className="text-muted-foreground text-[10px]">
                      {opt.desc}
                    </span>
                  </button>
                ))}
              </div>
            </>
          ) : mode === "invite" ? (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("choices")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {copy("common.back", "Back", "뒤로")}
                </button>
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold">{copy("newAgent.inviteExternal", "Invite an external agent", "외부 직원 초대")}</h2>
                  <p className="text-sm text-muted-foreground">
                    {copy(
                      "newAgent.inviteHelp",
                      "Generate a one-time onboarding prompt that any compatible agent can use to request access, wait for approval, and claim its Paperclip API key.",
                      "호환 직원이 접근을 요청하고 승인을 기다린 뒤 Paperclip API 키를 받을 수 있는 일회성 온보딩 프롬프트를 생성합니다.",
                    )}
                  </p>
                </div>
              </div>

              <label className="block space-y-2">
                <span className="text-sm font-medium">{copy("newAgent.optionalMessage", "Optional message for the agent", "직원에게 보낼 선택 메시지")}</span>
                <Textarea
                  value={agentMessage}
                  onChange={(event) => setAgentMessage(event.target.value)}
                  className="min-h-24 resize-y"
                  placeholder={copy("newAgent.optionalMessagePlaceholder", "Add onboarding context, expected role, or first instructions.", "온보딩 맥락, 기대 역할, 첫 지시를 입력하세요.")}
                  maxLength={4000}
                />
              </label>

              <div className="rounded-lg border border-border px-4 py-3 text-sm text-muted-foreground">
                {copy(
                  "newAgent.inviteApprovalHelp",
                  "Agent invites create a join request first. A company admin still approves the request before the agent can claim its API key.",
                  "직원 초대는 먼저 가입 요청을 만듭니다. 직원이 API 키를 받기 전 회사 관리자가 요청을 승인해야 합니다.",
                )}
              </div>

              <div>
                <Button
                  onClick={() => createAgentInviteMutation.mutate()}
                  disabled={!selectedCompanyId || createAgentInviteMutation.isPending}
                >
                  {createAgentInviteMutation.isPending ? copy("newAgent.generating", "Generating...", "생성 중...") : copy("newAgent.generatePrompt", "Generate onboarding prompt", "온보딩 프롬프트 생성")}
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="space-y-2">
                <button
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
                  onClick={() => setMode("invite")}
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  {copy("common.back", "Back", "뒤로")}
                </button>
                <div className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <h2 className="text-sm font-semibold">{copy("newAgent.onboardingPrompt", "Agent onboarding prompt", "직원 온보딩 프롬프트")}</h2>
                    {latestAgentPromptCopied ? (
                      <div className="inline-flex items-center gap-1 text-xs font-medium text-foreground">
                        <Check className="h-3.5 w-3.5" />
                        {copy("common.copied", "Copied", "복사됨")}
                      </div>
                    ) : null}
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {copy("newAgent.sendPromptHelp", "Send this prompt to the external agent that should join this company.", "이 회사에 합류할 외부 직원에게 이 프롬프트를 보내세요.")}
                  </p>
                </div>
              </div>

              <Textarea
                readOnly
                value={latestAgentPrompt ?? ""}
                className="h-[24rem] resize-y font-mono text-xs"
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!latestAgentPrompt}
                onClick={async () => {
                  if (!latestAgentPrompt) return;
                  const copied = await copyText(latestAgentPrompt, copy("newAgent.copyPromptManualAbove", "Copy the agent onboarding prompt manually from the field above.", "위 필드에서 직원 온보딩 프롬프트를 직접 복사하세요."));
                  setLatestAgentPromptCopied(copied);
                }}
              >
                {latestAgentPromptCopied ? copy("newAgent.copiedPrompt", "Copied prompt", "프롬프트 복사됨") : copy("newAgent.copyPrompt", "Copy prompt", "프롬프트 복사")}
              </Button>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
