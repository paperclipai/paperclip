import { Bot } from "lucide-react";
import { DispositionRecoveryNotice, DispositionRecoveryProvider, type DispositionRecoverySnapshot, type DispositionRecoveryContextValue } from "@/components/DispositionRecoveryNotice";
import { TaskChatSystemNotice } from "@/components/task-chat/TaskChatSystemNotice";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import { cn } from "@/lib/utils";

export type RecoveryNoticePreviewProps = {
  agentName?: string;
  defaultExpanded?: boolean;
  holdRequest?: boolean;
  retryOutcome?: "queued" | "failed";
  retryBlockedReason?: string;
  mobile?: boolean;
  comparison?: boolean;
  noticeOnly?: boolean;
};

const originalNotice: TaskChatMessageItem = {
  id: "recovery-before",
  kind: "message",
  author: "system",
  text: "Paperclip exhausted the bounded original-owner disposition repair without a durable source-state change.\n\n- Attempts: 2/2\n- Terminal reason: `unchanged_source_state_exhausted`\n- Recovery owner: board\n- Source ownership: unchanged\n\nNext action: repair the liveness disposition or request an explicit source-owner decision.",
  presentation: {
    kind: "system_notice",
    title: "Recovery: disposition repair escalated — source owner preserved",
    tone: "warning",
    density: "compact",
    detailsDefaultOpen: false,
  },
};

// Only the request is simulated. Rendering and interaction use the shipped component.
function RecoveryNotice(props: RecoveryNoticePreviewProps) {
  const snapshot: DispositionRecoverySnapshot = {
    kind: "disposition_repair_escalated", actionId: "preview-action", attemptCount: 2,
    maxAttempts: 2, reason: "unchanged_source_state_exhausted", assigneeAgentId: "preview-agent",
  };
  const value: DispositionRecoveryContextValue = {
    issue: { executionRunId: null, checkoutRunId: null, status: "blocked", assigneeAgentId: "preview-agent", activeRecoveryAction: {
      id: "preview-action", status: "active", kind: "deliberate_wait_without_target", ownerType: "board",
      returnOwnerAgentId: "preview-agent", wakePolicy: { type: "board_escalation" },
    } as NonNullable<DispositionRecoveryContextValue["issue"]["activeRecoveryAction"]> },
    agentMap: new Map([["preview-agent", { name: props.agentName ?? "Alex", status: "idle" }]]),
    unavailableReason: props.retryBlockedReason,
    onRetry: async () => {
      if (props.holdRequest) await new Promise<void>(() => {});
      await new Promise(resolve => window.setTimeout(resolve, 600));
      if (props.retryOutcome === "failed") throw new Error("Connection lost. Refresh the task to check its current state before trying again.");
    },
  };
  return <DispositionRecoveryProvider value={value}><DispositionRecoveryNotice key={String(props.defaultExpanded)} snapshot={snapshot} createdAt={new Date().toISOString()} defaultExpanded={props.defaultExpanded} /></DispositionRecoveryProvider>;
}

export function RecoveryNoticePreview(props: RecoveryNoticePreviewProps) {
  return (
    <main className={cn("mx-auto flex w-full flex-col gap-6 p-4 sm:p-6", props.mobile ? "max-w-sm" : "max-w-3xl")}>
      {props.comparison ? (
        <>
          <div className="flex flex-col gap-3 border-b border-border pb-6">
            <h1 className="text-lg font-semibold">Recovery notice</h1>
            <p className="text-sm text-muted-foreground">The same event, with a clearer explanation and a visible next action.</p>
          </div>
          <section className="flex min-w-0 flex-col gap-2" aria-label="Previous notice">
            <h2 className="text-xs font-medium text-muted-foreground">Previous</h2>
            <TaskChatSystemNotice item={originalNotice} />
          </section>
          <section className="flex flex-col gap-2" aria-label="Implemented notice">
            <h2 className="text-xs font-medium text-muted-foreground">Implemented</h2>
            <RecoveryNotice {...props} />
          </section>
        </>
      ) : (
        <>
          {!props.noticeOnly ? (
            <>
              <header className="flex flex-col gap-2 border-b border-border pb-5">
                <span className="font-mono text-xs text-muted-foreground">PAP-204</span>
                <h1 className="text-xl font-semibold">Update the onboarding checklist</h1>
              </header>
              <p className="max-w-md self-end rounded-xl bg-muted px-4 py-3 text-sm leading-relaxed">
                Review the setup steps and update the checklist with anything we’re missing.
              </p>
              <div className="flex flex-col gap-2">
                <div className="flex items-center gap-2 text-sm">
                  <Bot aria-hidden="true" className="size-4 text-muted-foreground" />
                  <span className="font-medium">{props.agentName ?? "Alex"}</span>
                </div>
                <p className="text-sm leading-relaxed">I’ve reviewed the setup steps and started updating the checklist.</p>
              </div>
            </>
          ) : null}
          <RecoveryNotice {...props} />
        </>
      )}
    </main>
  );
}
