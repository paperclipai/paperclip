import { useExternalStoreRuntime, type ThreadMessage, type AppendMessage } from "@assistant-ui/react";

export interface PaperclipIssueRuntimeReassignment {
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface PaperclipIssueRuntimeSendOptions {
  body: string;
  reopen?: boolean;
  reassignment?: PaperclipIssueRuntimeReassignment;
}

interface UsePaperclipIssueRuntimeOptions {
  messages: readonly ThreadMessage[];
  isRunning: boolean;
  onSend: (options: PaperclipIssueRuntimeSendOptions) => Promise<void>;
  onCancel?: (() => Promise<void>) | undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function readTextContent(message: AppendMessage) {
  return message.content
    .filter((part): part is Extract<(typeof message.content)[number], { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("")
    .trim();
}

export function usePaperclipIssueRuntime({
  messages,
  isRunning,
  onSend,
  onCancel,
}: UsePaperclipIssueRuntimeOptions) {
  return useExternalStoreRuntime({
    messages,
    isRunning,
    onNew: async (message) => {
      const body = readTextContent(message);
      if (!body) return;

      const custom = asRecord(message.runConfig?.custom);
      const reassignmentRecord = asRecord(custom?.reassignment);
      const reassignment =
        reassignmentRecord &&
        ("assigneeAgentId" in reassignmentRecord || "assigneeUserId" in reassignmentRecord)
          ? {
              assigneeAgentId:
                typeof reassignmentRecord.assigneeAgentId === "string" ? reassignmentRecord.assigneeAgentId : null,
              assigneeUserId:
                typeof reassignmentRecord.assigneeUserId === "string" ? reassignmentRecord.assigneeUserId : null,
            }
          : undefined;

      await onSend({
        body,
        reopen: custom?.reopen === true ? true : undefined,
        reassignment,
      });
    },
    ...(onCancel ? { onCancel } : {}),
  });
}
