import { useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { McpAppCallToolResult } from "@paperclipai/shared";
import { McpAppIssueProvider } from "@/components/mcp-app/McpAppIssueContext";
import { McpAppViewContent } from "@/components/mcp-app/McpAppView";
import { TaskChatToolCard } from "@/components/task-chat/TaskChatToolCard";
import type { TaskChatToolItem } from "@/components/task-chat/task-chat-model";
import { queryKeys } from "@/lib/queryKeys";
import {
  ISSUE_ID,
  MEETINGS,
  MEETINGS_VIEW_DETAIL,
  MEETINGS_VIEW_SUMMARY,
  RUN_ID,
} from "../../support/mcp-app/fixtures";

const toolRow: TaskChatToolItem = {
  id: `${RUN_ID}:tool:toolu_display_meetings`,
  kind: "tool",
  name: "Display meetings",
  rawName: "mcp__paperclip__mcp_circleback-44444444_displaymeetings",
  status: "completed",
  input: { meetingIds: ["m1", "m2"] },
};

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-(--tc-shell-max-w) p-6">{children}</div>;
}

/** The production tool row with its recorded view already in the query cache. */
function SeededToolRow() {
  const queryClient = useQueryClient();
  const [seeded] = useState(() => {
    queryClient.setQueryData(queryKeys.mcpApps.views(ISSUE_ID), [MEETINGS_VIEW_SUMMARY]);
    queryClient.setQueryData(queryKeys.mcpApps.detail(ISSUE_ID, MEETINGS_VIEW_SUMMARY.id), MEETINGS_VIEW_DETAIL);
    return true;
  });
  if (!seeded) return null;
  return (
    <McpAppIssueProvider issueId={ISSUE_ID}>
      <Frame>
        <TaskChatToolCard item={toolRow} />
      </Frame>
    </McpAppIssueProvider>
  );
}

const refreshedResult: McpAppCallToolResult = {
  content: [{ type: "text", text: "Refreshed" }],
  structuredContent: { meetings: [...MEETINGS, { ...MEETINGS[0]!, id: "m3", name: "Weekly product sync", tag: "Product Meeting", when: "Today" }] },
};

function ViewState({ state }: { state: "ready" | "loading" | "error" | "tool-call-denied" }) {
  const callTool = async (): Promise<McpAppCallToolResult> => state === "tool-call-denied"
    ? { content: [{ type: "text", text: "This action needs approval first. It was sent for review." }], isError: true }
    : refreshedResult;
  return (
    <Frame>
      <McpAppViewContent
        detail={state === "loading" ? undefined : MEETINGS_VIEW_DETAIL}
        status={state === "tool-call-denied" ? "ready" : state}
        errorMessage={state === "error" ? "Circleback could not show this view. The tool result is still in the row above." : null}
        callTool={callTool}
        displayName="Display meetings"
      />
    </Frame>
  );
}

const meta = {
  id: "tasks-task-chat-mcp-app",
  title: "Tasks and conversations/Task creation and lifecycle/Tasks/MCP App views",
  component: ViewState,
  parameters: {
    layout: "fullscreen",
    docs: {
      description: {
        component:
          "MCP Apps (io.modelcontextprotocol/ui) views under their tool row, such as Circleback meeting cards. The view runs in an opaque-origin sandboxed iframe and talks to Paperclip only through the MCP Apps postMessage protocol: initialize, tool input and result, size changes, tool calls and opening links.",
      },
    },
    paperclip: {
      "capabilities": [
        "tasks/discussion",
        "runs-adapters/runs"
      ],
      "status": "current",
      "implementation": "production",
      "boundary": "fixtures",
      "notes": "The view document is an original fixture that follows the 2026-01-26 MCP Apps protocol. Provider HTML comes from the connection at runtime.",
    },
  },
} satisfies Meta<typeof ViewState>;
export default meta;
type Story = StoryObj<typeof meta>;

export const InToolRow: Story = { name: "01 · Meeting cards under the tool row", render: () => <SeededToolRow />, args: { state: "ready" } };
export const Ready: Story = { name: "02 · View (Refresh calls a tool)", args: { state: "ready" } };
export const Loading: Story = { name: "03 · Loading", args: { state: "loading" } };
export const ErrorFallback: Story = { name: "04 · View unavailable", args: { state: "error" } };
export const ToolCallNeedsApproval: Story = { name: "05 · Tool call needs approval", args: { state: "tool-call-denied" } };
