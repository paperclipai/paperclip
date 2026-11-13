import { useCallback, useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createAgentConversationSchema, type Agent, type Issue } from "@paperclipai/shared";
import { agentsApi } from "@/api/agents";
import { agentChatsApi } from "@/api/agentChats";
import { authApi } from "@/api/auth";
import { useCompany } from "@/context/CompanyContext";
import { useSidebar } from "@/context/SidebarContext";
import { queryKeys } from "@/lib/queryKeys";
import { useNavigate } from "@/lib/router";
import { agentRouteRef } from "@/lib/utils";
import { useAgentChatEnabled } from "./useAgentChatEnabled";
import { classifySendFailure, clearPendingSend, pendingSendKeyFor, readPendingSend, writePendingSend } from "@/lib/pending-send";
import { errorStatus } from "@/api/errors";

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
    : { idempotencyKey: crypto.randomUUID(), payload: { companyId, userId, agentId }, createdAt: Date.now() };
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
