import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { QueryClient } from "@tanstack/react-query";
import { createAgentConversationSchema, type Agent, type Issue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { agentChatsApi } from "@/api/agentChats";
import { authApi } from "@/api/auth";
import { issuesApi } from "@/api/issues";
import { mergeComposerRunSettings, type ComposerRunSettings } from "@/components/task-chat/composer-run-settings";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { useAgentChatEnabled } from "./useAgentChatEnabled";
import { classifySendFailure, clearPendingSend, pendingSendKeyFor, readPendingSend, writePendingSend } from "@/lib/pending-send";
import { errorStatus } from "@/api/errors";
import { createUuid } from "@/lib/uuid";

function pendingChatCreate(companyId: string, userId: string | null, agentId: string) {
  // A tab owns its pending selection across picker closes and reloads.
  const key = pendingSendKeyFor(`agent-chat-create:${companyId}:${agentId}`, userId ?? "local-board");
  const pending = readPendingSend(key, (value): value is { companyId: string; userId: string | null; agentId: string } => {
    if (!value || typeof value !== "object") return false;
    const saved = value as Record<string, unknown>;
    return saved.companyId === companyId && saved.userId === userId && saved.agentId === agentId;
  }, "session");
  const record = pending && createAgentConversationSchema.safeParse({ clientRequestId: pending.idempotencyKey }).success
    ? pending
    : { idempotencyKey: createUuid(), payload: { companyId, userId, agentId }, createdAt: Date.now() };
  if (record !== pending && !writePendingSend(key, record, "session")) {
    throw new Error("Couldn’t save the chat request. Check browser storage and try again.");
  }
  return { key, clientRequestId: record.idempotencyKey };
}

export function useAgentChatNavigation() {
  const { selectedCompanyId: companyId } = useCompany();
  const { enabled, loaded } = useAgentChatEnabled();
  const session = useQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession() });
  const userId = session.data?.user?.id ?? session.data?.session?.userId ?? null;
  const agents = useQuery({
    queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!),
    enabled: enabled && !!companyId,
  });
  const chats = useQuery({
    queryKey: queryKeys.agentChats.list(companyId, userId), queryFn: () => agentChatsApi.list(companyId!),
    enabled: enabled && !!companyId && session.isSuccess,
  });
  return { companyId, userId, enabled, loaded, agents, chats, session };
}

/** Puts a resolved chat where the Chat pages read it, newest first in the list. */
function rememberChat(client: QueryClient, companyId: string, userId: string | null, agentId: string, chat: Issue) {
  client.setQueryData(queryKeys.agentChats.detail(companyId, userId, agentId), chat);
  client.setQueryData(queryKeys.issues.detail(chat.id), chat);
  client.setQueryData<Issue[]>(queryKeys.agentChats.list(companyId, userId), previous =>
    [chat, ...(previous ?? []).filter(item => item.id !== chat.id)]
      .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || b.id.localeCompare(a.id)));
}

export interface StartAgentChatMessage {
  agent: Agent;
  body: string;
  /** Files to attach to the first message; uploaded once the chat exists. */
  files?: readonly File[];
  /** Model and effort chosen in the composer, saved on the chat before the message as the chat composer does. */
  runSettings?: ComposerRunSettings | null;
  /** Reused when the same message is sent again, so the server can tell it is the same one. */
  clientRequestId: string;
}

function escapeMarkdownLabel(name: string): string {
  return name.replace(/[[\]]/g, "\\$&");
}

/**
 * Start a chat from elsewhere with its first message: the same one-per-agent
 * resolver as opening a chat, then the ordered, idempotent comments endpoint
 * the chat composer uses, then the Chat section on that conversation.
 *
 * Files are uploaded once per message: a retry with the same
 * `clientRequestId` reuses the attachments already uploaded, so it sends the
 * same body and attachment ids the server may already have saved.
 */
export function useStartAgentChat(companyId: string | null, userId: string | null) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const uploads = useRef(new Map<string, Awaited<ReturnType<typeof issuesApi.uploadAttachment>>[]>());
  const scope = useRef({ companyId, userId, mounted: true });
  useEffect(() => {
    const current = { companyId, userId, mounted: true };
    scope.current = current;
    return () => { current.mounted = false; };
  }, [companyId, userId]);
  return useCallback(async ({ agent, body, files = [], runSettings, clientRequestId }: StartAgentChatMessage) => {
    if (!companyId || agent.companyId !== companyId) throw new Error("Choose an agent from this company.");
    const current = scope.current;
    const chat = await agentChatsApi.ensure(companyId, agent.id);
    rememberChat(client, companyId, userId, agent.id, chat);
    if (runSettings) {
      // Read the complete overrides first so unrelated options survive.
      const fresh = await issuesApi.getCore(chat.id, { cache: "no-store", fresh: true });
      const updated = await issuesApi.update(chat.id, {
        assigneeAdapterOverrides: mergeComposerRunSettings(fresh.assigneeAdapterOverrides, agent.adapterType, runSettings),
      });
      client.setQueryData(queryKeys.issues.detail(chat.id), updated);
    }
    const uploadKey = `${chat.id}\n${clientRequestId}`;
    const uploaded = uploads.current.get(uploadKey) ?? [];
    uploads.current.set(uploadKey, uploaded);
    for (let index = uploaded.length; index < files.length; index += 1) {
      uploaded.push(await issuesApi.uploadAttachment(companyId, chat.id, files[index]!));
    }
    const refLines = uploaded
      .map((attachment, index) => {
        const name = files[index]?.name ?? attachment.originalFilename ?? "attachment";
        const image = attachment.contentType?.startsWith("image/") ? "!" : "";
        return `${image}[${escapeMarkdownLabel(name)}](${attachment.contentPath})`;
      })
      .join("\n");
    const fullBody = [body.trim(), refLines].filter(Boolean).join("\n\n");
    // A finished or blocked conversation picks up again with a new message, as in the chat itself.
    const reopen = chat.status === "done" || chat.status === "cancelled" || chat.status === "blocked" ? true : undefined;
    await issuesApi.addComment(chat.id, fullBody, reopen, undefined, uploaded.map((attachment) => attachment.id), clientRequestId);
    uploads.current.delete(uploadKey);
    void client.invalidateQueries({ queryKey: queryKeys.issues.comments(chat.id) });
    void client.invalidateQueries({ queryKey: queryKeys.agentChats.list(companyId, userId) });
    // The message is sent either way; only follow it when the person is still where they sent it from.
    if (!current.mounted || scope.current !== current) return;
    navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}`);
  }, [client, companyId, userId, navigate]);
}

/**
 * The latest chat selection per company and user, shared by every chat picker (the Coordinator's
 * New chat and the history's Add chat), so an older dismissed selection never replaces a newer one.
 */
const latestChatSelection = new Map<string, number>();

/** Opens the default conversation or explicitly creates a new one. Resolves to whether it navigated to the chat. */
export function useOpenAgentChat(companyId: string | null, userId: string | null, createNew = false) {
  const client = useQueryClient();
  const navigate = useNavigate();
  const { isMobile, setSidebarOpen } = useSidebar();
  const scope = useRef({ companyId, userId, mounted: true });
  useEffect(() => {
    const current = { companyId, userId, mounted: true };
    scope.current = current;
    return () => { current.mounted = false; };
  }, [companyId, userId]);
  return useCallback(async (agent: Agent, signal?: AbortSignal): Promise<boolean> => {
    if (!companyId || agent.companyId !== companyId) throw new Error("Choose an agent from this company.");
    const session = client.getQueryData<Awaited<ReturnType<typeof authApi.getSession>>>(queryKeys.auth.session);
    const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
    if (createNew && (client.getQueryState(queryKeys.auth.session)?.status !== "success" || currentUserId !== userId)) {
      throw new Error("Your account changed or is still loading. Try again.");
    }
    const current = scope.current;
    const selectionKey = `${companyId}:${userId ?? ""}`;
    const open = (latestChatSelection.get(selectionKey) ?? 0) + 1;
    latestChatSelection.set(selectionKey, open);
    const request = createNew ? pendingChatCreate(companyId, userId, agent.id) : null;
    const completeCreate = () => { if (request) clearPendingSend(request.key, request.clientRequestId, "session"); };
    const chat = await (request ? agentChatsApi.create(companyId, agent.id, request.clientRequestId) : agentChatsApi.ensure(companyId, agent.id)).catch(error => {
      const status = errorStatus(error);
      if (status !== null && status >= 400 && status < 500 && classifySendFailure(error) === "rejected") completeCreate();
      throw error;
    });
    if (!createNew) client.setQueryData(queryKeys.agentChats.detail(companyId, userId, agent.id), chat);
    client.setQueryData(queryKeys.issues.detail(chat.id), chat);
    client.setQueryData<Issue[]>(queryKeys.agentChats.list(companyId, userId), previous =>
      [chat, ...(previous ?? []).filter(item => item.id !== chat.id)]
        .sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime() || b.id.localeCompare(a.id)));
    // Dismissing the picker cannot stop a create the server may already have committed. Open a
    // confirmed new chat unless a newer selection replaced it; a dismissed default open stays closed.
    const superseded = latestChatSelection.get(selectionKey) !== open;
    if (!current.mounted || scope.current !== current || (signal?.aborted && (!createNew || superseded))) { completeCreate(); return false; }
    navigate(`/chats/${encodeURIComponent(agentRouteRef(agent))}${createNew ? `/${chat.id}` : ""}`);
    if (isMobile) setSidebarOpen(false);
    completeCreate();
    return true;
  }, [client, companyId, userId, navigate, isMobile, setSidebarOpen, createNew]);
}
