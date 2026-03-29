import { useState, useEffect, useRef, useCallback } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useDialog, type ComposerMode } from "../context/DialogContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  MessageCircle,
  ListTodo,
  CheckCircle2,
  Send,
  Loader2,
  Sparkles,
  Bot,
} from "lucide-react";
import { cn } from "../lib/utils";
import { Identity } from "./Identity";
import type { Agent } from "@paperclipai/shared";

const MODE_CONFIG: Record<
  ComposerMode,
  {
    label: string;
    description: string;
    icon: typeof MessageCircle;
    issuePrefix: string;
    priority: string;
  }
> = {
  ask: {
    label: "질문",
    description: "에이전트에게 질문하고 답변을 받습니다",
    icon: MessageCircle,
    issuePrefix: "[질문]",
    priority: "medium",
  },
  task: {
    label: "작업",
    description: "에이전트에게 작업을 할당합니다",
    icon: ListTodo,
    issuePrefix: "[작업]",
    priority: "medium",
  },
  decision: {
    label: "결정",
    description: "승인이나 결정을 요청합니다",
    icon: CheckCircle2,
    issuePrefix: "[결정]",
    priority: "high",
  },
};

export function GlobalComposer() {
  const { selectedCompanyId } = useCompany();
  const { globalComposerOpen, globalComposerDefaults, closeGlobalComposer } =
    useDialog();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [mode, setMode] = useState<ComposerMode>("ask");
  const [agentId, setAgentId] = useState<string>("");
  const [message, setMessage] = useState("");

  // Load agents
  const { data: agents = [] } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && globalComposerOpen,
  });

  const activeAgents = agents.filter(
    (a: Agent) => a.status !== "terminated",
  );

  // Find CEO agent as default
  const ceoAgent = activeAgents.find((a: Agent) => a.role === "ceo");

  // Reset state when opened with defaults
  useEffect(() => {
    if (globalComposerOpen) {
      setMode(globalComposerDefaults.mode ?? "ask");
      setAgentId(globalComposerDefaults.agentId ?? "");
      setMessage("");
      // Focus textarea after render
      setTimeout(() => textareaRef.current?.focus(), 100);
    }
  }, [globalComposerOpen, globalComposerDefaults]);

  // Set default agent to CEO if no agent selected
  useEffect(() => {
    if (globalComposerOpen && !agentId && ceoAgent) {
      setAgentId(ceoAgent.id);
    }
  }, [globalComposerOpen, agentId, ceoAgent]);

  const selectedAgent = activeAgents.find((a: Agent) => a.id === agentId);
  const modeConfig = MODE_CONFIG[mode];

  const submitMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId || !message.trim()) {
        throw new Error("내용을 입력해주세요");
      }

      const body = message.trim();
      const title =
        body.length > 55
          ? `${modeConfig.issuePrefix} ${body.slice(0, 52)}...`
          : `${modeConfig.issuePrefix} ${body}`;

      // Build issue creation payload
      const payload: Record<string, unknown> = {
        title,
        description: body,
        status: "todo",
        priority: modeConfig.priority,
      };

      // Assign to selected agent if any
      if (agentId) {
        payload.assigneeAgentId = agentId;
      }

      // Create the issue
      const issue = await issuesApi.create(selectedCompanyId, payload);

      // Add the initial message as a comment
      await issuesApi.addComment(issue.id, body);

      // Wakeup the assigned agent
      if (agentId) {
        try {
          await agentsApi.wakeup(
            agentId,
            {
              source: "assignment",
              triggerDetail: "manual",
              reason: `${modeConfig.label}: ${body.slice(0, 100)}`,
            },
            selectedCompanyId,
          );
        } catch {
          // wakeup failure is non-fatal
        }
      }

      return issue;
    },
    onSuccess: (issue) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({
          queryKey: queryKeys.issues.list(selectedCompanyId),
        });
      }
      closeGlobalComposer();
      navigate(`/issues/${issue.identifier ?? issue.id}?view=chat`);
    },
    onError: (err) => {
      pushToast({
        title:
          err instanceof Error ? err.message : "전송에 실패했습니다",
        tone: "error",
      });
    },
  });

  const canSend = message.trim().length > 0 && !submitMutation.isPending;

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      // Cmd/Ctrl+Enter to submit
      if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && canSend) {
        e.preventDefault();
        submitMutation.mutate();
      }
    },
    [canSend, submitMutation],
  );

  if (!selectedCompanyId) return null;

  return (
    <Dialog open={globalComposerOpen} onOpenChange={(open) => {
      if (!open) closeGlobalComposer();
    }}>
      <DialogContent className="sm:max-w-[560px] p-0 gap-0 overflow-hidden">
        {/* Header */}
        <div className="px-4 pt-4 pb-3 border-b border-border">
          <div className="flex items-center gap-2 mb-3">
            <Sparkles className="h-4 w-4 text-primary" />
            <h2 className="text-sm font-semibold">Board 커맨드</h2>
            <span className="text-xs text-muted-foreground ml-auto">
              {"\u2318"}J
            </span>
          </div>

          {/* Mode selector */}
          <div className="flex gap-1 p-0.5 bg-muted rounded-lg">
            {(Object.keys(MODE_CONFIG) as ComposerMode[]).map((m) => {
              const cfg = MODE_CONFIG[m];
              const Icon = cfg.icon;
              const isActive = mode === m;
              return (
                <button
                  key={m}
                  type="button"
                  onClick={() => setMode(m)}
                  className={cn(
                    "flex-1 flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                    isActive
                      ? "bg-background text-foreground shadow-sm"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {cfg.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Body */}
        <div className="p-4 space-y-3">
          {/* Agent selector */}
          <div className="flex items-center gap-2">
            <Bot className="h-4 w-4 text-muted-foreground shrink-0" />
            <Select value={agentId} onValueChange={setAgentId}>
              <SelectTrigger className="h-8 text-xs flex-1">
                <SelectValue placeholder="에이전트 선택..." />
              </SelectTrigger>
              <SelectContent>
                {activeAgents.map((agent: Agent) => (
                  <SelectItem key={agent.id} value={agent.id}>
                    <span className="flex items-center gap-2">
                      <Identity name={agent.name} size="sm" />
                      <span>{agent.name}</span>
                      <span className="text-muted-foreground">
                        {agent.role}
                      </span>
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Description line */}
          <p className="text-xs text-muted-foreground pl-6">
            {selectedAgent
              ? `${selectedAgent.name}에게 ${modeConfig.description.replace("에이전트에게 ", "")}`
              : modeConfig.description}
          </p>

          {/* Message input */}
          <Textarea
            ref={textareaRef}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={
              mode === "ask"
                ? "질문을 입력하세요..."
                : mode === "task"
                  ? "작업 내용을 입력하세요..."
                  : "결정 사항을 입력하세요..."
            }
            className="min-h-[120px] max-h-[300px] resize-none text-sm"
            disabled={submitMutation.isPending}
          />

          {/* Footer */}
          <div className="flex items-center justify-between pt-1">
            <span className="text-[11px] text-muted-foreground">
              {"\u2318"}+Enter로 전송
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={closeGlobalComposer}
                disabled={submitMutation.isPending}
              >
                취소
              </Button>
              <Button
                size="sm"
                disabled={!canSend}
                onClick={() => submitMutation.mutate()}
              >
                {submitMutation.isPending ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                    전송 중...
                  </>
                ) : (
                  <>
                    <Send className="h-3.5 w-3.5 mr-1.5" />
                    보내기
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
