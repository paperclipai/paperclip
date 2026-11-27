import { useCallback, useRef, useState, type ReactNode } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import type { McpAppCallToolResult } from "@paperclipai/shared";
import { McpAppIssueProvider } from "@/components/mcp-app/McpAppIssueContext";
import { McpAppTurnViews } from "@/components/mcp-app/McpAppTurnViews";
import { McpAppViewContent, type McpAppMessageProposal } from "@/components/mcp-app/McpAppView";
import type { McpAppDisplayMode } from "@/components/mcp-app/mcp-app-host";
import { queryKeys } from "@/lib/queryKeys";
import {
  ISSUE_ID,
  MEETINGS,
  MEETINGS_VIEW_DETAIL,
  MEETINGS_VIEW_SUMMARY,
  RUN_ID,
} from "../../support/mcp-app/fixtures";
import { ProviderToolIconsStaticProvider } from "@/components/ProviderToolIcon";
import { TaskChatToolCard } from "@/components/task-chat/TaskChatToolCard";
import type { TaskChatToolItem } from "@/components/task-chat/task-chat-model";

function Frame({ children }: { children: ReactNode }) {
  return <div className="mx-auto w-full max-w-(--tc-shell-max-w) p-6">{children}</div>;
}

/** The production reply-level block with the run's recorded view in the query cache. */
function SeededRunViews() {
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
        <McpAppTurnViews runId={RUN_ID} />
        <p className="mt-3 text-sm text-foreground">Your most recent meetings are shown above.</p>
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
          "MCP Apps (io.modelcontextprotocol/ui) views shown with the agent's reply, such as Circleback meeting cards. The view runs in an opaque-origin sandboxed iframe and talks to Paperclip only through the MCP Apps postMessage protocol: initialize, tool input and result, size changes, tool calls and opening links.",
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

export const WithReply: Story = { name: "01 · Meeting cards with the agent's reply", render: () => <SeededRunViews />, args: { state: "ready" } };
export const Ready: Story = { name: "02 · View (Refresh calls a tool)", args: { state: "ready" } };
export const Loading: Story = { name: "03 · Loading", args: { state: "loading" } };
export const ErrorFallback: Story = { name: "04 · View unavailable", args: { state: "error" } };
export const ToolCallNeedsApproval: Story = { name: "05 · Tool call needs approval", args: { state: "tool-call-denied" } };

const PROPOSED_TEXT = "Summarize the action items from Paperclip <> Heavybit, Partner Meeting.";

/**
 * A view's `ui/message`. The card starts with a proposal; the view's "Ask the
 * agent" button proposes another once it is handled. Send only appends to the
 * story's sent list: nothing is sent without the click.
 */
function MessageConfirmationStory() {
  const [proposal, setProposal] = useState<McpAppMessageProposal | null>({ text: PROPOSED_TEXT, status: "pending" });
  const [sent, setSent] = useState<string[]>([]);
  const pending = useRef<{ resolve: () => void; reject: (error: Error) => void } | null>(null);
  const proposeMessage = useCallback((text: string) => new Promise<void>((resolve, reject) => {
    if (pending.current) {
      reject(new Error("A message from this view is already waiting for the user"));
      return;
    }
    pending.current = { resolve, reject };
    setProposal({ text, status: "pending" });
  }), []);
  const settle = (send: boolean) => {
    if (send && proposal) setSent((list) => [...list, proposal.text]);
    if (send) pending.current?.resolve();
    else pending.current?.reject(new Error("Message sending denied"));
    pending.current = null;
    setProposal(null);
  };
  return (
    <Frame>
      <McpAppViewContent
        detail={MEETINGS_VIEW_DETAIL}
        status="ready"
        callTool={async () => refreshedResult}
        displayName="Display meetings"
        proposeMessage={proposeMessage}
        proposal={proposal}
        onSendProposal={() => settle(true)}
        onDismissProposal={() => settle(false)}
      />
      {sent.length > 0 ? (
        <div className="mt-3 flex flex-col gap-1 text-sm text-foreground" data-testid="story-sent-messages">
          {sent.map((text, index) => <p key={index}>You: {text}</p>)}
        </div>
      ) : null}
    </Frame>
  );
}

/** The view full screen. "Exit full screen", Escape or the view's own button return it to the chat. */
function FullscreenStory() {
  const [mode, setMode] = useState<McpAppDisplayMode>("fullscreen");
  return (
    <Frame>
      <McpAppViewContent
        detail={MEETINGS_VIEW_DETAIL}
        status="ready"
        callTool={async () => refreshedResult}
        displayName="Display meetings"
        displayMode={mode}
        onDisplayModeChange={setMode}
      />
    </Frame>
  );
}

export const MessageConfirmation: Story = { name: "06 · View asks to send a message", render: () => <MessageConfirmationStory />, args: { state: "ready" } };
export const Fullscreen: Story = { name: "07 · Full screen", render: () => <FullscreenStory />, args: { state: "ready" } };

/* Provider tool icons (SEP-973) on task chat tool rows. */
const CIRCLEBACK_ICON = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><circle cx="8" cy="8" r="7" fill="#6d28d9"/><circle cx="8" cy="8" r="3" fill="#fff"/></svg>')}`;
const ICON_ENTRIES = [
  { gatewayToolName: "mcp.circleback-1a2b3c4d:displaymeetings", icons: [{ src: CIRCLEBACK_ICON, mimeType: "image/svg+xml" }] },
  { gatewayToolName: "mcp.circleback-1a2b3c4d:searchmeetings", icons: [{ src: CIRCLEBACK_ICON, mimeType: "image/svg+xml" }] },
  // An icon that fails to load falls back to the taxonomy icon.
  { gatewayToolName: "mcp.linear-5e6f7a8b:list-issues", icons: [{ src: "https://icons.invalid/linear.png", mimeType: "image/png" }] },
];
const ICON_ROWS: TaskChatToolItem[] = [
  { kind: "tool", id: "icon-1", name: "Search meetings", rawName: "mcp__paperclip__mcp.circleback-1a2b3c4d:searchmeetings", target: "Heavybit", status: "completed" },
  { kind: "tool", id: "icon-2", name: "Display meetings", rawName: "mcp__paperclip__mcp.circleback-1a2b3c4d:displaymeetings", status: "completed" },
  { kind: "tool", id: "icon-3", name: "List issues", rawName: "mcp__paperclip__mcp.linear-5e6f7a8b:list-issues", status: "completed" },
  { kind: "tool", id: "icon-4", name: "Bash", rawName: "Bash", target: "pnpm test", status: "completed" },
];

export const ProviderToolIcons: Story = {
  name: "08 · Tool rows with provider icons",
  render: () => (
    <ProviderToolIconsStaticProvider entries={ICON_ENTRIES}>
      <Frame>
        <div className="flex flex-col gap-1">
          {ICON_ROWS.map((item) => <TaskChatToolCard key={item.id} item={item} />)}
        </div>
      </Frame>
    </ProviderToolIconsStaticProvider>
  ),
  args: { state: "ready" },
};
