import { useState } from "react";
import { instanceExperimentalSettingsSchema, type Issue } from "@paperclipai/shared";
import { Sidebar } from "@/components/Sidebar";
import { CoordinatorSidebar } from "@/components/CoordinatorSidebar";
import { AgentConversationsSidebar } from "@/components/AgentConversationsSidebar";
import { TaskChatBubble } from "@/components/task-chat/TaskChatBubble";
import type { TaskChatMessageItem } from "@/components/task-chat/task-chat-model";
import { Button } from "@/components/ui/button";
import { AgentChatReadProvider } from "@/hooks/useAgentChatRead";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { useLocation, useNavigate } from "@/lib/router";
import { storybookAgents, storybookIssues } from "../../fixtures/paperclipData";
import { prepareFixtureApi } from "../capability-gaps/api";

export const proactiveCompanyId = "company-storybook";
export const proactiveChatId = "33333333-3333-4333-8333-333333333333";
export const proactiveMessage: TaskChatMessageItem = {
  id: "44444444-4444-4444-8444-444444444444",
  kind: "message",
  author: "agent",
  authorName: "Kodi",
  text: "## Morning PR digest\n\nThree PRs need your review:\n\n- **#124** — Fix chat reconnect\n- **#127** — Improve task search\n- **#130** — Add release notes",
  timestamp: "7:00 AM",
  createdAtIso: "2026-10-30T07:00:00.000Z",
  chatMessage: {
    sourceTaskId: "11111111-1111-4111-8111-111111111111",
    sourceTaskIdentifier: "PAP-42",
    sourceRunId: "22222222-2222-4222-8222-222222222222",
    contentHash: "0".repeat(64),
  },
};

const agents = [
  { ...storybookAgents[0], name: "Kodi", urlKey: "kodi", status: "idle" as const, title: "Coding and pull requests" },
  { ...storybookAgents[1], name: "Mira", urlKey: "mira", status: "idle" as const, title: "Research and planning" },
];

export function prepareProactiveMessageFixtures(readFailure = false, transientReadFailures = 0) {
  const unread = new Set(agents.map(agent => agent.id));
  let remainingReadFailures = transientReadFailures;
  const chats = () => agents.map((agent, index): Issue => ({
    ...storybookIssues[0],
    id: index === 0 ? proactiveChatId : "55555555-5555-4555-8555-555555555555",
    companyId: proactiveCompanyId,
    title: `Chat with ${agent.name}`,
    identifier: `PAP-${index + 100}`,
    assigneeAgentId: agent.id,
    conversationAgentId: agent.id,
    conversationUserId: "user-board",
    conversationState: "waiting",
    status: "in_review",
    projectId: null,
    executionRunId: null,
    updatedAt: new Date(index === 0 ? "2026-10-30T07:00:00Z" : "2026-10-30T06:45:00Z"),
    isUnreadForMe: unread.has(agent.id),
  }));
  return prepareFixtureApi([
    { path: "/api/instance/settings/experimental", read: () => instanceExperimentalSettingsSchema.parse({ enableAgentChat: true }) },
    { path: "/api/workspace-preferences/me", read: () => ({ userId: "user-board", coordinatorWorkspaceEnabled: false }) },
    { path: `/api/companies/${proactiveCompanyId}/agents`, read: () => agents },
    { path: `/api/companies/${proactiveCompanyId}/chats`, read: chats },
    { path: `/api/companies/${proactiveCompanyId}/projects`, read: () => [] },
    { path: `/api/companies/${proactiveCompanyId}/live-runs`, read: () => [] },
    { path: `/api/companies/${proactiveCompanyId}/attention`, read: () => ({ companyId: proactiveCompanyId, totalCount: 0, deskBadgeCount: 0, items: [], nextCursor: null }) },
    { path: `/api/companies/${proactiveCompanyId}/resource-memberships/me`, read: () => ({ projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [], starredDocumentIds: [], updatedAt: null }) },
    { path: "/api/cli-auth/me", read: () => ({ userId: "user-board", isInstanceAdmin: false, companyIds: [proactiveCompanyId], source: "authenticated", keyId: null, memberships: [{ companyId: proactiveCompanyId, membershipRole: "owner", status: "active" }] }) },
    { path: `/api/issues/${proactiveChatId}/read`, method: "POST", read: ({ body }) => {
      if (body.throughCommentId !== proactiveMessage.id) return Response.json({ error: "Expected the rendered message cutoff." }, { status: 400 });
      if (readFailure || remainingReadFailures > 0) {
        remainingReadFailures = Math.max(0, remainingReadFailures - 1);
        return Response.json({ error: "Read receipt unavailable." }, { status: 503 });
      }
      unread.delete(agents[0].id);
      return { issueId: proactiveChatId, userId: "user-board", lastReadAt: proactiveMessage.createdAtIso };
    } },
  ]);
}

export function ProactiveMessageReview() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const open = pathname.endsWith("/chats/kodi");
  const [opened, setOpened] = useState(false);
  return <main className="paperclip-story">
    <div className="paperclip-story__inner space-y-6">
      <header className="space-y-2">
        <p className="paperclip-story__label">Proactive agent messages · changed UX</p>
        <h1 className="text-2xl font-semibold">Kodi’s morning digest is waiting in chat</h1>
        <p className="max-w-3xl text-sm text-muted-foreground">Both Chat navigation variants count unread chats. Each agent has its own unread dot. Open Kodi at the latest message to clear its dot and reduce the count; Mira stays unread.</p>
      </header>
      <div className="grid gap-4 md:grid-cols-3">
        <section aria-label="Classic navigation" className="paperclip-story__frame overflow-hidden">
          <h2 className="border-b border-border px-4 py-3 text-sm font-medium">Classic navigation</h2>
          <div className="h-80 overflow-auto"><PluginLauncherProvider><Sidebar /></PluginLauncherProvider></div>
        </section>
        <section aria-label="Coordinator navigation" className="paperclip-story__frame overflow-hidden">
          <h2 className="border-b border-border px-4 py-3 text-sm font-medium">Coordinator navigation</h2>
          <div className="coordinator-workspace h-80 overflow-auto"><CoordinatorSidebar /></div>
        </section>
        <section aria-label="Agent unread messages" className="paperclip-story__frame overflow-hidden">
          <h2 className="border-b border-border px-4 py-3 text-sm font-medium">Unread by agent</h2>
          <div className="h-80"><AgentConversationsSidebar /></div>
        </section>
      </div>
      <section aria-label="Kodi proactive digest" className="paperclip-story__frame overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div><h2 className="text-sm font-medium">Chat with Kodi</h2><p className="text-xs text-muted-foreground">A normal agent message with a link to its source task</p></div>
          <Button variant="outline" onClick={() => { setOpened(true); navigate("/chats/kodi"); }}>Open Kodi chat</Button>
        </div>
        <AgentChatReadProvider issueId={open && opened ? proactiveChatId : undefined} companyId={proactiveCompanyId} userId="user-board">
          <div className="task-chat-scroll-viewport h-96 overflow-auto p-6" tabIndex={0} aria-label="Kodi latest messages">
            <div className="mx-auto max-w-3xl"><TaskChatBubble item={proactiveMessage} animateEntry={false} /></div>
          </div>
        </AgentChatReadProvider>
      </section>
      <p className="text-xs text-muted-foreground">Production navigation, agent list, message bubble and read-receipt hook with isolated API fixtures. Server delivery, live events, account isolation and routine execution are verified by separate app tests.</p>
    </div>
  </main>;
}
