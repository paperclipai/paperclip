import { useState } from "react";
import { useNavigate } from "@/lib/router";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { useCompany } from "../context/CompanyContext";
import { useToast } from "../context/ToastContext";
import { queryKeys } from "../lib/queryKeys";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { MessageCircle, Send, Loader2, X } from "lucide-react";
import { cn } from "../lib/utils";
import type { Agent, Issue } from "@paperclipai/shared";

export function AskCeoButton() {
  const { selectedCompanyId } = useCompany();
  const navigate = useNavigate();
  const { pushToast } = useToast();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState("");

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const ceoAgent = (agents ?? []).find(
    (a: Agent) => a.role === "ceo" && a.status !== "terminated",
  );

  const createAndNavigate = useMutation({
    mutationFn: async (body: string) => {
      if (!selectedCompanyId || !ceoAgent) throw new Error("No CEO agent");

      // Create the issue assigned to CEO
      const issue: Issue = await issuesApi.create(selectedCompanyId, {
        title: body.length > 60 ? body.slice(0, 57) + "..." : body,
        description: body,
        status: "todo",
        priority: "medium",
        assigneeAgentId: ceoAgent.id,
      });

      // Add the initial question as a comment too
      await issuesApi.addComment(issue.id, body);

      // Wakeup the CEO agent
      try {
        await agentsApi.wakeup(
          ceoAgent.id,
          {
            source: "assignment",
            triggerDetail: "manual",
            reason: `New question: ${body.slice(0, 100)}`,
          },
          selectedCompanyId,
        );
      } catch {
        // wakeup failure is non-fatal
      }

      return issue;
    },
    onSuccess: (issue) => {
      if (selectedCompanyId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(selectedCompanyId) });
      }
      setQuestion("");
      setOpen(false);
      // Navigate to chat view of the new issue
      navigate(`/issues/${issue.identifier ?? issue.id}?view=chat`);
    },
    onError: (err) => {
      pushToast({
        title: err instanceof Error ? err.message : "질문 전송에 실패했습니다",
        tone: "error",
      });
    },
  });

  // Don't render if no CEO agent exists
  if (!ceoAgent) return null;

  const canSend = question.trim().length > 0 && !createAndNavigate.isPending;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="icon"
          className={cn(
            "fixed bottom-6 right-6 z-50 h-12 w-12 rounded-full shadow-lg",
            "bg-primary hover:bg-primary/90 text-primary-foreground",
            "md:bottom-6 md:right-6",
            // On mobile, account for bottom nav
            "bottom-[calc(1.5rem+5rem+env(safe-area-inset-bottom))] md:bottom-6",
          )}
          title="CEO에게 질문하기"
        >
          <MessageCircle className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="top"
        sideOffset={8}
        className="w-80 p-0"
      >
        <div className="px-3 py-2.5 border-b border-border">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold">CEO에게 질문하기</h4>
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="text-muted-foreground hover:text-foreground"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground mt-0.5">
            {ceoAgent.name}에게 새로운 질문을 보냅니다
          </p>
        </div>
        <div className="p-3 space-y-3">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="질문을 입력하세요..."
            className="min-h-[80px] max-h-[200px] resize-none text-sm"
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && canSend) {
                e.preventDefault();
                createAndNavigate.mutate(question.trim());
              }
            }}
            disabled={createAndNavigate.isPending}
          />
          <div className="flex justify-end">
            <Button
              size="sm"
              disabled={!canSend}
              onClick={() => createAndNavigate.mutate(question.trim())}
            >
              {createAndNavigate.isPending ? (
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
      </PopoverContent>
    </Popover>
  );
}
