import { useLayoutEffect, useState } from "react";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { expect, within } from "storybook/test";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { Routes, Route } from "@/lib/router";
import { Layout } from "@/components/Layout";
import { TaskChatThread } from "@/components/TaskChatThread";
import { PluginLauncherProvider } from "@/plugins/launchers";
import { queryKeys } from "@/lib/queryKeys";
import { storybookAuthSession } from "../../fixtures/paperclipData";
import { mixedComments as initialComments, profiles, alexId, samId, issueId, agentMap } from "./fixtures";

function Conversation({ viewer = alexId, fullHistory = false }: { viewer?: string; fullHistory?: boolean }) {
  const [comments, setComments] = useState(() => fullHistory ? initialComments : [...initialComments.slice(0, 2), ...initialComments.slice(-2)]);
  const [client] = useState(() => {
    const cache = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity, retry: false } } });
    cache.setQueryData([...queryKeys.issues.documents(issueId), "plan"], null);
    return cache;
  });
  return <QueryClientProvider client={client}><div className="flex h-full min-h-0 flex-col bg-background text-foreground">
    <TaskChatThread comments={comments} issueId={issueId} issueStatus="todo" currentUserId={viewer}
      userProfileMap={profiles} userLabelMap={new Map([...profiles].map(([id, p]) => [id, p.label]))}
      agentMap={agentMap} enableLiveTranscriptPolling={false}
      threadHeader={<div className="px-4 pt-4"><p className="text-xs text-muted-foreground">Task conversation</p><h1 className="text-lg font-semibold">Notification names and avatars</h1></div>}
      onAdd={async body => { setComments(rows => [...rows, { ...initialComments[0]!, id: `preview-${rows.length}`, authorUserId: viewer, body, createdAt: new Date(), updatedAt: new Date() }]); }}
    />
  </div></QueryClientProvider>;
}
function Journey(props: { viewer?: string; fullHistory?: boolean }) {
  const client = useQueryClient();
  const viewer = props.viewer ?? alexId;
  useLayoutEffect(() => {
    const previous = client.getQueryData(queryKeys.auth.session);
    client.setQueryData(queryKeys.auth.session, {
      ...storybookAuthSession,
      session: { ...storybookAuthSession.session, userId: viewer },
      user: { ...storybookAuthSession.user, id: viewer, name: profiles.get(viewer)?.label },
    });
    return () => { client.setQueryData(queryKeys.auth.session, previous); };
  }, [client, viewer]);
  return <PluginLauncherProvider><Routes><Route path="/:companyPrefix" element={<Layout />}>
    <Route path="issues/:issueId" element={<Conversation {...props} />} />
  </Route></Routes></PluginLauncherProvider>;
}
const meta = {
  title: "Chat & Comments/Human identity/02 Mixed-author journey", component: Journey,
  args: { viewer: alexId, fullHistory: false },
  parameters: { layout: "fullscreen", initialEntries: ["/PAP/issues/human-identity-example"], docs: { story: { inline: false }, description: { component: "Representative turns from two humans and an agent in the production app shell and TaskChatThread, including its composer. Photos remain null so the shared initials fallback is visible. Swap the viewer: identity follows authorUserId. The default excerpt fits all three speakers in one view; Full Conversation includes all fixture messages. Sending is local to this preview." } } },
} satisfies Meta<typeof Journey>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ViewingAsAlex: Story = { play: async ({ canvasElement }) => {
  const identities = await within(canvasElement).findAllByTestId("task-chat-human-identity");
  await expect(identities).toHaveLength(1);
  for (const identity of identities) await expect(identity).toHaveTextContent("Sam Rivera");
  const canvas = within(canvasElement);
  await expect(canvas.getByTestId("task-chat-agent-identity")).toHaveTextContent("Fable");
  await expect(canvas.getByTestId("task-chat-agent-bubble").parentElement).toHaveClass("items-start");
  const humanBubbles = canvas.getAllByTestId("task-chat-human-bubble");
  await expect(humanBubbles.filter(bubble => bubble.parentElement?.classList.contains("items-end"))).toHaveLength(2);
  await expect(humanBubbles.filter(bubble => bubble.parentElement?.classList.contains("items-start"))).toHaveLength(1);
} };
export const ViewingAsSam: Story = { args: { viewer: samId }, play: async ({ canvasElement }) => {
  const canvas = within(canvasElement);
  const identities = await canvas.findAllByTestId("task-chat-human-identity");
  await expect(identities).toHaveLength(2);
  for (const identity of identities) await expect(identity).toHaveTextContent("Alex Morgan");
  await expect(canvas.getByTestId("task-chat-agent-bubble").parentElement).toHaveClass("items-start");
} };
export const FullConversation: Story = { args: { fullHistory: true } };
export const Light: Story = { globals: { theme: "light" } };
export const Mobile: Story = { globals: { viewport: { value: "mobile", isRotated: false } } };
