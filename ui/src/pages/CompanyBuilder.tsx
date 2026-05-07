import { type ReactNode, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  BuilderHandoffTarget,
  BuilderMessage,
  BuilderProposal,
  BuilderSession,
  BuilderSessionDetail,
  BuilderToolResult,
} from "@paperclipai/shared";
import {
  Archive,
  ArchiveRestore,
  ArrowUpRight,
  Bot,
  ChevronDown,
  Loader2,
  Plus,
  Send,
  Settings2,
  Sparkles,
} from "lucide-react";
import { builderApi } from "@/api/builder";
import {
  ApprovalPayloadRenderer,
  approvalLabel,
} from "@/components/ApprovalPayload";
import { EmptyState } from "@/components/EmptyState";
import { EntityRow } from "@/components/EntityRow";
import { MarkdownBody } from "@/components/MarkdownBody";
import { StatusBadge } from "@/components/StatusBadge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { Textarea } from "@/components/ui/textarea";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useToastActions } from "@/context/ToastContext";
import { formatDateTime } from "@/lib/utils";
import { Link } from "@/lib/router";
import { cn } from "@/lib/utils";

const QUERY_KEY = ["builder"] as const;

function hasMeaningfulSessionTitle(title: string | null | undefined): boolean {
  const normalized = (title ?? "").trim();
  return normalized.length > 0 && normalized.toLowerCase() !== "new session";
}

function getSessionDisplayTitle(session: Pick<BuilderSession, "title" | "createdAt">): string {
  return hasMeaningfulSessionTitle(session.title)
    ? session.title.trim()
    : formatDateTime(session.createdAt);
}

function getSessionSubtitle(session: Pick<BuilderSession, "updatedAt" | "effectiveRuntimeConfig">): string {
  const model = session.effectiveRuntimeConfig?.model?.trim();
  if (model) {
    return `${model} · ${formatDateTime(session.updatedAt)}`;
  }
  return formatDateTime(session.updatedAt);
}

function buildTransientBuilderMessage(input: {
  id: string;
  companyId: string;
  sessionId: string;
  role: BuilderMessage["role"];
  text: string;
}): BuilderMessage {
  return {
    id: input.id,
    sessionId: input.sessionId,
    companyId: input.companyId,
    sequence: Number.MAX_SAFE_INTEGER,
    role: input.role,
    content: { text: input.text },
    inputTokens: 0,
    outputTokens: 0,
    costCents: 0,
    createdAt: new Date(),
  };
}

function getPayloadSummary(payload: Record<string, unknown>): string | null {
  const candidateKeys = [
    "summary",
    "title",
    "name",
    "recommendedAction",
    "description",
    "goal",
    "role",
  ] as const;
  for (const key of candidateKeys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  const patch = payload.patch;
  if (patch && typeof patch === "object" && !Array.isArray(patch)) {
    const nextName = (patch as Record<string, unknown>).name;
    if (typeof nextName === "string" && nextName.trim()) {
      return `Update name to ${nextName.trim()}`;
    }
  }

  return null;
}

function getProposalSummary(proposal: BuilderProposal): string {
  return (
    getPayloadSummary(proposal.payload) ??
    approvalLabel(proposal.kind, proposal.payload).replace(/^[^:]+:\s*/, "") ??
    proposal.kind.replace(/_/g, " ")
  );
}

function getToolResultSummary(
  toolResult: BuilderToolResult,
  proposal: BuilderProposal | null,
): string {
  if (proposal) return getProposalSummary(proposal);

  const result = toolResult.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const summary = getPayloadSummary(result as Record<string, unknown>);
    if (summary) return summary;
  }

  if (typeof result === "string" && result.trim()) {
    return result.trim();
  }

  return toolResult.ok ? "Completed." : "Failed.";
}

function stringifyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function updateProposalCollection(
  proposals: BuilderProposal[] | undefined,
  nextProposal: BuilderProposal,
): BuilderProposal[] {
  if (!proposals) return [nextProposal];
  const existingIndex = proposals.findIndex((proposal) => proposal.id === nextProposal.id);
  if (existingIndex === -1) return [nextProposal, ...proposals];
  const next = proposals.slice();
  next[existingIndex] = nextProposal;
  return next;
}

function updateSessionProposalState(
  session: BuilderSessionDetail | null | undefined,
  proposal: BuilderProposal,
): BuilderSessionDetail | null | undefined {
  if (!session) return session;
  return {
    ...session,
    messages: session.messages.map((message) => {
      const toolResult = message.content.toolResult;
      if (!toolResult || toolResult.proposalId !== proposal.id) return message;
      return {
        ...message,
        content: {
          ...message.content,
          toolResult: {
            ...toolResult,
            proposalStatus: proposal.status,
            handoff: proposal.handoff ?? toolResult.handoff,
          },
        },
      };
    }),
  };
}

function ProposalCard({
  proposal,
  pendingProposalId,
  onApply,
  onReject,
}: {
  proposal: BuilderProposal;
  pendingProposalId: string | null;
  onApply: (proposalId: string) => void;
  onReject: (proposalId: string) => void;
}) {
  const approvalBacked = Boolean(proposal.approvalId);
  const canApplyInline =
    !approvalBacked &&
    (proposal.status === "pending" || proposal.status === "approved");
  const detailsTitle = approvalBacked ? "Review governed payload" : "Review proposal details";

  return (
    <div className="mt-3 rounded-xl border border-border/70 bg-background/70 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="text-sm font-medium text-foreground">
          {getProposalSummary(proposal)}
        </div>
        <StatusBadge status={proposal.status} />
      </div>

      <p className="mt-2 text-sm text-muted-foreground">
        {approvalBacked
          ? "This action is governed. Continue from the standard approvals queue."
          : "This is a transcript-linked proposal. Apply inline only when the action is local and safe."}
      </p>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        {canApplyInline ? (
          <>
            <Button
              size="sm"
              onClick={() => onApply(proposal.id)}
              disabled={pendingProposalId === proposal.id}
            >
              {pendingProposalId === proposal.id ? "Applying..." : "Apply"}
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => onReject(proposal.id)}
              disabled={pendingProposalId === proposal.id}
            >
              Reject
            </Button>
          </>
        ) : null}

        {proposal.handoff?.href ? (
          <Button asChild size="sm" variant={canApplyInline ? "ghost" : "outline"}>
            <Link to={proposal.handoff.href}>
              {proposal.handoff.label}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        ) : null}
      </div>

      {proposal.failureReason ? (
        <div className="mt-3 rounded-lg border border-red-500/20 bg-red-500/10 px-3 py-2 text-sm text-red-700 dark:text-red-300">
          {proposal.failureReason}
        </div>
      ) : null}

      <Collapsible className="mt-3">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-left text-sm text-foreground hover:bg-accent/40">
          <span>{detailsTitle}</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent className="space-y-3 px-1 pt-3">
          <div className="rounded-xl border border-border/70 bg-card p-4">
            <ApprovalPayloadRenderer
              type={proposal.kind}
              payload={proposal.payload}
              hidePrimaryTitle
            />
          </div>
          <div className="rounded-xl border border-border/70 bg-muted/30 p-3">
            <div className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Raw payload
            </div>
            <pre className="overflow-x-auto whitespace-pre-wrap text-xs text-muted-foreground">
              {stringifyJson(proposal.payload)}
            </pre>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function ToolCallList({
  toolCalls,
}: {
  toolCalls: BuilderMessage["content"]["toolCalls"];
}) {
  if (!toolCalls?.length) return null;

  return (
    <div className="mt-3 space-y-2">
      {toolCalls.map((call) => (
        <Collapsible
          key={call.id}
          className="rounded-xl border border-border/70 bg-background/60"
        >
          <CollapsibleTrigger className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent/40">
            <div className="flex items-center gap-2">
              <StatusBadge status="planned" />
              <span className="font-medium text-foreground">{call.name}</span>
            </div>
            <ChevronDown className="h-4 w-4 text-muted-foreground" />
          </CollapsibleTrigger>
          <CollapsibleContent className="px-3 pb-3">
            <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
              {stringifyJson(call.arguments)}
            </pre>
          </CollapsibleContent>
        </Collapsible>
      ))}
    </div>
  );
}

function ToolResultCard({
  toolResult,
  proposal,
  pendingProposalId,
  onApplyProposal,
  onRejectProposal,
}: {
  toolResult: BuilderToolResult;
  proposal: BuilderProposal | null;
  pendingProposalId: string | null;
  onApplyProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
}) {
  const summary = getToolResultSummary(toolResult, proposal);
  const status = proposal?.status ?? (toolResult.ok ? "completed" : "failed");
  const handoff = proposal?.handoff ?? toolResult.handoff ?? null;

  return (
    <div className="mt-3 rounded-2xl border border-border/70 bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium text-foreground">{toolResult.name}</span>
        <StatusBadge status={status} />
      </div>

      <p className="mt-2 text-sm text-foreground/90">{summary}</p>

      {handoff?.href && !proposal ? (
        <div className="mt-3">
          <Button asChild size="sm" variant="outline">
            <Link to={handoff.href}>
              {handoff.label}
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
          </Button>
        </div>
      ) : null}

      {proposal ? (
        <ProposalCard
          proposal={proposal}
          pendingProposalId={pendingProposalId}
          onApply={onApplyProposal}
          onReject={onRejectProposal}
        />
      ) : null}

      <Collapsible className="mt-3">
        <CollapsibleTrigger className="flex w-full items-center justify-between rounded-lg border border-border/70 px-3 py-2 text-left text-sm text-foreground hover:bg-accent/40">
          <span>View raw tool result</span>
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        </CollapsibleTrigger>
        <CollapsibleContent className="px-1 pt-3">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded-lg bg-muted/40 p-3 text-xs text-muted-foreground">
            {stringifyJson(toolResult.result)}
          </pre>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}

function MessageCard({
  message,
  proposal,
  pendingProposalId,
  onApplyProposal,
  onRejectProposal,
  pendingLabel,
  showSpinner = false,
}: {
  message: BuilderMessage;
  proposal: BuilderProposal | null;
  pendingProposalId: string | null;
  onApplyProposal: (proposalId: string) => void;
  onRejectProposal: (proposalId: string) => void;
  pendingLabel?: string | null;
  showSpinner?: boolean;
}) {
  const isUser = message.role === "user";
  const roleLabel =
    message.role === "assistant"
      ? "AI Builder"
      : message.role === "tool"
        ? "Tool result"
        : "You";

  return (
    <div className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "w-full max-w-3xl rounded-2xl border p-4 shadow-sm",
          isUser
            ? "border-primary/20 bg-primary/5"
            : "border-border/70 bg-card",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            {!isUser ? <Bot className="h-4 w-4 text-muted-foreground" /> : null}
            <span className="text-sm font-medium text-foreground">{roleLabel}</span>
          </div>
          <span className="text-xs text-muted-foreground">
            {formatDateTime(message.createdAt)}
          </span>
        </div>

        {message.content.text ? (
          <div className="mt-3 text-sm text-foreground">
            <MarkdownBody className="prose prose-sm max-w-none dark:prose-invert">
              {message.content.text}
            </MarkdownBody>
          </div>
        ) : null}

        <ToolCallList toolCalls={message.content.toolCalls} />

        {message.content.toolResult ? (
          <ToolResultCard
            toolResult={message.content.toolResult}
            proposal={proposal}
            pendingProposalId={pendingProposalId}
            onApplyProposal={onApplyProposal}
            onRejectProposal={onRejectProposal}
          />
        ) : null}

        {pendingLabel ? (
          <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
            {showSpinner ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            <span>{pendingLabel}</span>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function ConversationPane({
  companyId,
  session,
  onBusyChange,
}: {
  companyId: string;
  session: BuilderSessionDetail;
  onBusyChange?: (busy: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const [input, setInput] = useState("");
  const [pendingProposalId, setPendingProposalId] = useState<string | null>(null);
  const [pendingUserText, setPendingUserText] = useState<string | null>(null);
  const [pendingAssistant, setPendingAssistant] = useState(false);
  const [streamMessages, setStreamMessages] = useState<BuilderMessage[]>([]);

  const sessionQueryKey = [...QUERY_KEY, "session", companyId, session.id] as const;
  const proposalsQueryKey = [...QUERY_KEY, "proposals", companyId, session.id] as const;

  const proposalsQuery = useQuery({
    queryKey: proposalsQueryKey,
    queryFn: () => builderApi.listProposals(companyId, { sessionId: session.id }),
  });

  const proposalsById = useMemo(
    () =>
      new Map(
        (proposalsQuery.data?.proposals ?? []).map((proposal) => [proposal.id, proposal]),
      ),
    [proposalsQuery.data?.proposals],
  );

  const appendStreamMessage = (message: BuilderMessage) => {
    setStreamMessages((current) => {
      const withoutDuplicate = current.filter((existing) => existing.id !== message.id);
      return [...withoutDuplicate, message].sort((a, b) => a.sequence - b.sequence);
    });
  };

  const displayedMessages = useMemo(() => {
    const merged = new Map<string, BuilderMessage>();
    for (const message of session.messages) merged.set(message.id, message);
    for (const message of streamMessages) merged.set(message.id, message);
    return Array.from(merged.values()).sort((a, b) => a.sequence - b.sequence);
  }, [session.messages, streamMessages]);

  const hasLiveAssistantMessage = streamMessages.some((message) => message.role !== "user");
  const isArchived = Boolean(session.archivedAt);

  useEffect(() => {
    setPendingUserText(null);
    setPendingAssistant(false);
    setStreamMessages([]);
  }, [session.id]);

  const submitInput = () => {
    const text = input.trim();
    if (!text || composerDisabled) return;
    sendMutation.mutate(text);
  };

  const sendMutation = useMutation({
    mutationFn: async (text: string) =>
      builderApi.streamMessage(companyId, session.id, { text }, {
        onStart: () => setPendingAssistant(true),
        onUserMessage: (message) => {
          setPendingUserText(null);
          appendStreamMessage(message);
        },
        onMessage: (message) => {
          appendStreamMessage(message);
        },
        onDone: () => setPendingAssistant(false),
        onError: () => setPendingAssistant(false),
      }),
    onMutate: async (text: string) => {
      setPendingUserText(text);
      setPendingAssistant(true);
      setStreamMessages([]);
    },
    onSuccess: async () => {
      setInput("");
      setPendingUserText(null);
      setPendingAssistant(false);
      setStreamMessages([]);
      await queryClient.invalidateQueries({ queryKey: sessionQueryKey });
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "sessions", companyId],
      });
      await queryClient.invalidateQueries({ queryKey: proposalsQueryKey });
    },
    onError: (error) => {
      setPendingUserText(null);
      setPendingAssistant(false);
      setStreamMessages([]);
      toast.pushToast({
        title: "Failed to send message",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  useEffect(() => {
    onBusyChange?.(sendMutation.isPending);
  }, [onBusyChange, sendMutation.isPending]);

  const composerDisabled = sendMutation.isPending || session.state !== "active" || isArchived;
  const canSubmit = Boolean(input.trim()) && !composerDisabled;

  const decideProposal = async (proposalId: string, action: "apply" | "reject") => {
    setPendingProposalId(proposalId);
    try {
      const response =
        action === "apply"
          ? await builderApi.applyProposal(companyId, proposalId)
          : await builderApi.rejectProposal(companyId, proposalId);

      queryClient.setQueryData<{ proposals: BuilderProposal[] } | undefined>(
        proposalsQueryKey,
        (current) => ({
          proposals: updateProposalCollection(current?.proposals, response.proposal),
        }),
      );
      queryClient.setQueryData<{ session: BuilderSessionDetail | null } | undefined>(
        sessionQueryKey,
        (current) => ({
          session: updateSessionProposalState(current?.session, response.proposal) ?? null,
        }),
      );

      toast.pushToast({
        title: action === "apply" ? "Proposal applied" : "Proposal rejected",
        tone: action === "apply" ? "success" : "info",
      });
    } catch (error) {
      toast.pushToast({
        title: action === "apply" ? "Failed to apply proposal" : "Failed to reject proposal",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    } finally {
      setPendingProposalId(null);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 space-y-4 overflow-y-auto pr-2">
        {isArchived ? (
          <div className="rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-sm text-muted-foreground">
            Archived sessions are read-only until restored.
          </div>
        ) : null}

        {displayedMessages.length === 0 && !pendingUserText && !pendingAssistant ? (
          <EmptyState
            icon={Sparkles}
            message="Ask about your company, draft changes, or start a governed workflow."
          />
        ) : (
          <>
            {displayedMessages.map((message) => {
              const proposalId = message.content.toolResult?.proposalId ?? null;
              const proposal = proposalId ? proposalsById.get(proposalId) ?? null : null;
              return (
                <MessageCard
                  key={message.id}
                  message={message}
                  proposal={proposal}
                  pendingProposalId={pendingProposalId}
                  onApplyProposal={(id) => decideProposal(id, "apply")}
                  onRejectProposal={(id) => decideProposal(id, "reject")}
                />
              );
            })}

            {pendingUserText ? (
              <MessageCard
                message={buildTransientBuilderMessage({
                  id: "__pending_user__",
                  companyId,
                  sessionId: session.id,
                  role: "user",
                  text: pendingUserText,
                })}
                proposal={null}
                pendingProposalId={pendingProposalId}
                onApplyProposal={() => undefined}
                onRejectProposal={() => undefined}
                pendingLabel="Sending..."
              />
            ) : null}

            {pendingAssistant && !hasLiveAssistantMessage ? (
              <MessageCard
                message={buildTransientBuilderMessage({
                  id: "__pending_assistant__",
                  companyId,
                  sessionId: session.id,
                  role: "assistant",
                  text: "AI Builder is working through the next step.",
                })}
                proposal={null}
                pendingProposalId={pendingProposalId}
                onApplyProposal={() => undefined}
                onRejectProposal={() => undefined}
                pendingLabel="Waiting for response..."
                showSpinner
              />
            ) : null}
          </>
        )}
      </div>

      <form
        className="mt-4 flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          submitInput();
        }}
      >
        <Textarea
          className="max-h-40 min-h-[3.25rem] flex-1 rounded-xl px-4 py-3 text-sm"
          placeholder="Ask the AI Builder…"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" || event.nativeEvent.isComposing) return;
            if (event.shiftKey) return;
            event.preventDefault();
            submitInput();
          }}
          disabled={composerDisabled}
        />
        <Button
          type="submit"
          disabled={!canSubmit}
        >
          {sendMutation.isPending ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Send className="h-4 w-4" />
          )}
        </Button>
      </form>
    </div>
  );
}

function RuntimeSummaryCard({
  runtime,
  messageCount,
  pendingProposals,
}: {
  runtime: BuilderSession["effectiveRuntimeConfig"] | null | undefined;
  messageCount: number;
  pendingProposals: number;
}) {
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Settings2 className="h-4 w-4" />
          Live runtime
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="rounded-xl border border-border/70 bg-muted/20 px-3 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Current adapter
          </div>
          <div className="mt-1 font-medium text-foreground">
            {runtime?.adapterType ?? "Not configured"}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {runtime?.model?.trim() || "No model selected"}
          </div>
          {runtime?.updatedAt ? (
            <div className="mt-2 text-xs text-muted-foreground">
              Updated {formatDateTime(runtime.updatedAt)}
            </div>
          ) : null}
        </div>

        <div className="rounded-xl border border-border/70 bg-card px-3 py-3">
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            Session context
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Transcript messages</span>
            <span className="font-medium text-foreground">{messageCount}</span>
          </div>
          <div className="mt-2 flex items-center justify-between text-sm">
            <span className="text-muted-foreground">Pending proposals</span>
            <span className="font-medium text-foreground">{pendingProposals}</span>
          </div>
        </div>

        <div className="rounded-xl border border-amber-500/20 bg-amber-500/10 px-3 py-3 text-sm text-foreground">
          Old sessions still run with the current company Builder settings on their next turn.
        </div>

        <Button asChild variant="outline" className="w-full">
          <Link to="/company/settings/builder">
            Open Builder settings
            <ArrowUpRight className="h-4 w-4" />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

function WorkflowCard({
  handoff,
}: {
  handoff: BuilderHandoffTarget | null;
}) {
  return (
    <Card className="border-border/70">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm">Workflow</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-sm text-muted-foreground">
        <p>
          Start work here, then continue governed or multi-step actions in the standard surface.
        </p>
        <p>
          Direct actions stay inline only when the change is local and safe.
        </p>
        {handoff?.href ? (
          <Button asChild size="sm" variant="outline" className="w-full">
            <Link to={handoff.href}>
              {handoff.label}
              <ArrowUpRight className="h-4 w-4" />
            </Link>
          </Button>
        ) : null}
      </CardContent>
    </Card>
  );
}

function SessionRowAction({
  label,
  icon,
  disabled,
  onClick,
}: {
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      size="sm"
      variant="ghost"
      disabled={disabled}
      aria-label={label}
      title={label}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {icon}
    </Button>
  );
}

export function CompanyBuilder() {
  const { selectedCompany, selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const toast = useToastActions();
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [archivedSectionOpen, setArchivedSectionOpen] = useState(false);
  const [sidebarBusy, setSidebarBusy] = useState(false);

  useEffect(() => {
    setBreadcrumbs([
      { label: selectedCompany?.name ?? "Company", href: "/dashboard" },
      { label: "AI Builder" },
    ]);
  }, [selectedCompany?.name, setBreadcrumbs]);

  const sessionsQuery = useQuery({
    queryKey: [...QUERY_KEY, "sessions", selectedCompanyId] as const,
    queryFn: () =>
      selectedCompanyId
        ? builderApi.listSessions(selectedCompanyId, { includeArchived: true })
        : Promise.resolve({ sessions: [] }),
    enabled: !!selectedCompanyId,
  });

  const sessionDetailQuery = useQuery({
    queryKey: [...QUERY_KEY, "session", selectedCompanyId, activeSessionId] as const,
    queryFn: () =>
      selectedCompanyId && activeSessionId
        ? builderApi.getSession(selectedCompanyId, activeSessionId)
        : Promise.resolve({ session: null as BuilderSessionDetail | null }),
    enabled: !!selectedCompanyId && !!activeSessionId,
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      if (!selectedCompanyId) return null;
      return builderApi.createSession(selectedCompanyId, {});
    },
    onSuccess: async (created) => {
      if (!created) return;
      setActiveSessionId(created.session.id);
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "sessions", selectedCompanyId],
      });
    },
    onError: (error) => {
      toast.pushToast({
        title: "Failed to create session",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const archiveMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!selectedCompanyId) return null;
      return builderApi.archiveSession(selectedCompanyId, sessionId);
    },
    onSuccess: async () => {
      setArchivedSectionOpen(true);
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "sessions", selectedCompanyId],
      });
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "session", selectedCompanyId, activeSessionId],
      });
    },
    onError: (error) => {
      toast.pushToast({
        title: "Failed to archive session",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const restoreMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      if (!selectedCompanyId) return null;
      return builderApi.restoreSession(selectedCompanyId, sessionId);
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "sessions", selectedCompanyId],
      });
      await queryClient.invalidateQueries({
        queryKey: [...QUERY_KEY, "session", selectedCompanyId, activeSessionId],
      });
    },
    onError: (error) => {
      toast.pushToast({
        title: "Failed to restore session",
        body: error instanceof Error ? error.message : String(error),
        tone: "error",
      });
    },
  });

  const sessions = sessionsQuery.data?.sessions ?? [];
  const activeSessions = sessions.filter((session) => !session.archivedAt);
  const archivedSessions = sessions.filter((session) => Boolean(session.archivedAt));
  const sessionActionPendingId = archiveMutation.isPending
    ? archiveMutation.variables
    : restoreMutation.isPending
      ? restoreMutation.variables
      : null;
  const sessionActionBusy =
    sidebarBusy || archiveMutation.isPending || restoreMutation.isPending;

  useEffect(() => {
    if (!sessions.length) {
      setActiveSessionId(null);
      return;
    }
    if (!activeSessionId || !sessions.some((session) => session.id === activeSessionId)) {
      setActiveSessionId(sessions[0]?.id ?? null);
    }
  }, [activeSessionId, sessions]);

  const detail = sessionDetailQuery.data?.session ?? null;
  const activeSession =
    sessions.find((session) => session.id === activeSessionId) ?? null;
  const effectiveRuntimeConfig =
    detail?.effectiveRuntimeConfig ?? activeSession?.effectiveRuntimeConfig ?? null;

  const lastHandoff = useMemo(() => {
    if (!detail) return null;
    const messages = [...detail.messages].reverse();
    for (const message of messages) {
      const handoff = message.content.toolResult?.handoff;
      if (handoff?.href) return handoff;
    }
    return null;
  }, [detail]);

  if (!selectedCompanyId) {
    return (
      <div className="text-sm text-muted-foreground">
        Select a company to use the AI Builder.
      </div>
    );
  }

  return (
    <div className="grid h-full gap-4 lg:grid-cols-[280px_minmax(0,1fr)_320px]">
      <Card className="overflow-hidden border-border/70">
        <CardHeader className="border-b border-border/70 pb-3">
          <div className="flex items-center justify-between gap-3">
            <CardTitle className="text-sm">Sessions</CardTitle>
            <Button size="sm" variant="outline" onClick={() => createMutation.mutate()}>
              {createMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Plus className="h-4 w-4" />
              )}
              New
            </Button>
          </div>
        </CardHeader>
        <CardContent className="p-0">
          {sessions.length === 0 ? (
            <div className="p-4 text-sm text-muted-foreground">
              No sessions yet. Start one to plan, draft, or launch company work.
            </div>
          ) : (
            <div>
              <div className="border-b border-border/70 px-4 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Active
              </div>
              {activeSessions.length === 0 ? (
                <div className="border-b border-border/70 px-4 py-3 text-sm text-muted-foreground">
                  No active sessions.
                </div>
              ) : (
                activeSessions.map((session) => (
                  <EntityRow
                    key={session.id}
                    title={getSessionDisplayTitle(session)}
                    subtitle={getSessionSubtitle(session)}
                    selected={session.id === activeSessionId}
                    onClick={() => setActiveSessionId(session.id)}
                    trailing={(
                      <>
                        <StatusBadge status={session.state} />
                        <SessionRowAction
                          label="Archive session"
                          icon={archiveMutation.isPending && sessionActionPendingId === session.id ? (
                            <Loader2 className="h-4 w-4 animate-spin" />
                          ) : (
                            <Archive className="h-4 w-4" />
                          )}
                          disabled={sessionActionBusy}
                          onClick={() => archiveMutation.mutate(session.id)}
                        />
                      </>
                    )}
                    className="py-3"
                  />
                ))
              )}

              {archivedSessions.length > 0 ? (
                <Collapsible
                  open={archivedSectionOpen}
                  onOpenChange={setArchivedSectionOpen}
                >
                  <CollapsibleTrigger className="flex w-full items-center justify-between border-b border-border/70 px-4 py-2 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground hover:bg-accent/40">
                    <span>Archived</span>
                    <div className="flex items-center gap-2">
                      <span>{archivedSessions.length}</span>
                      <ChevronDown className={cn("h-4 w-4 transition-transform", archivedSectionOpen ? "rotate-180" : "")} />
                    </div>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    {archivedSessions.map((session) => (
                      <EntityRow
                        key={session.id}
                        title={getSessionDisplayTitle(session)}
                        subtitle={getSessionSubtitle(session)}
                        selected={session.id === activeSessionId}
                        onClick={() => setActiveSessionId(session.id)}
                        trailing={(
                          <>
                            <StatusBadge status="archived" />
                            <SessionRowAction
                              label="Restore session"
                              icon={restoreMutation.isPending && sessionActionPendingId === session.id ? (
                                <Loader2 className="h-4 w-4 animate-spin" />
                              ) : (
                                <ArchiveRestore className="h-4 w-4" />
                              )}
                              disabled={sessionActionBusy}
                              onClick={() => restoreMutation.mutate(session.id)}
                            />
                          </>
                        )}
                        className="py-3"
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ) : null}
            </div>
          )}
        </CardContent>
      </Card>

      <Card className="overflow-hidden border-border/70">
        <CardHeader className="border-b border-border/70 pb-3">
          <CardTitle className="text-sm">
            {activeSession ? getSessionDisplayTitle(activeSession) : "Conversation"}
          </CardTitle>
        </CardHeader>
        <CardContent className="h-[78vh] p-4">
          {detail ? (
            <ConversationPane
              companyId={selectedCompanyId}
              session={detail}
              onBusyChange={setSidebarBusy}
            />
          ) : (
            <EmptyState
              icon={Sparkles}
              message="No session selected. Create one to start a Builder conversation."
            />
          )}
        </CardContent>
      </Card>

      <div className="space-y-4">
        <RuntimeSummaryCard
          runtime={effectiveRuntimeConfig}
          messageCount={detail?.messages.length ?? 0}
          pendingProposals={detail?.messages.filter((message) => {
            const status = message.content.toolResult?.proposalStatus;
            return status === "pending" || status === "approved";
          }).length ?? 0}
        />
        <WorkflowCard handoff={lastHandoff} />
      </div>
    </div>
  );
}
