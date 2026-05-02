import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  chatApi,
  type ChatContentBlock,
  type ChatMessage,
  type ChatSession,
} from "../api/chat";
import { postChatMessageStream, type ChatStreamEvent } from "../lib/chat-stream";

interface PendingPermission {
  toolUseId: string;
  name: string;
  input: unknown;
}

export interface ClippyTranscriptEntry {
  id: string;
  role: "user" | "assistant" | "tool";
  blocks: ChatContentBlock[];
  pending?: boolean;
}

export interface UseChatSessionResult {
  session: ChatSession | null;
  messages: ChatMessage[];
  transcript: ClippyTranscriptEntry[];
  loading: boolean;
  streaming: boolean;
  pendingPermissions: PendingPermission[];
  send: (text: string) => Promise<void>;
  decidePermission: (toolUseId: string, decision: "approve" | "deny") => Promise<void>;
  patchSession: (
    patch: Parameters<typeof chatApi.patchSession>[1],
  ) => Promise<ChatSession | null>;
  abort: () => void;
}

export function useChatSession(sessionId: string | null): UseChatSessionResult {
  const qc = useQueryClient();
  const sessionQuery = useQuery({
    queryKey: ["clippy", "session", sessionId],
    queryFn: () => chatApi.getSession(sessionId as string).then((r) => r.session),
    enabled: !!sessionId,
  });
  const messagesQuery = useQuery({
    queryKey: ["clippy", "messages", sessionId],
    queryFn: () => chatApi.listMessages(sessionId as string).then((r) => r.messages),
    enabled: !!sessionId,
  });

  const [streaming, setStreaming] = useState(false);
  const [pendingAssistant, setPendingAssistant] = useState<ClippyTranscriptEntry | null>(null);
  const [pendingPermissions, setPendingPermissions] = useState<PendingPermission[]>([]);
  const abortRef = useRef<(() => void) | null>(null);

  // When the session changes, clear stream state.
  useEffect(() => {
    return () => {
      abortRef.current?.();
      abortRef.current = null;
      setPendingAssistant(null);
      setPendingPermissions([]);
      setStreaming(false);
    };
  }, [sessionId]);

  const refresh = useCallback(() => {
    if (!sessionId) return;
    qc.invalidateQueries({ queryKey: ["clippy", "messages", sessionId] });
    qc.invalidateQueries({ queryKey: ["clippy", "session", sessionId] });
    qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
  }, [qc, sessionId]);

  const send = useCallback(
    async (text: string) => {
      if (!sessionId) throw new Error("No active session");
      if (streaming) throw new Error("A turn is already streaming");
      // Optimistically add user message + start an empty assistant entry.
      const optimisticUser: ClippyTranscriptEntry = {
        id: `optimistic-user-${Date.now()}`,
        role: "user",
        blocks: [{ type: "text", text }],
      };
      qc.setQueryData<ChatMessage[] | undefined>(
        ["clippy", "messages", sessionId],
        (prev) => {
          const list = prev ?? [];
          return [
            ...list,
            {
              id: optimisticUser.id,
              sessionId,
              role: "user",
              content: optimisticUser.blocks,
              createdAt: new Date().toISOString(),
            },
          ];
        },
      );
      setStreaming(true);
      setPendingAssistant({
        id: `pending-${Date.now()}`,
        role: "assistant",
        blocks: [],
        pending: true,
      });

      const handle = postChatMessageStream(sessionId, text, (event) => {
        handleStreamEvent(event);
      });
      abortRef.current = handle.abort;

      function handleStreamEvent(event: ChatStreamEvent) {
        switch (event.type) {
          case "text_delta":
            setPendingAssistant((prev) => {
              if (!prev) return prev;
              const blocks = [...prev.blocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                blocks[blocks.length - 1] = { type: "text", text: last.text + event.delta };
              } else {
                blocks.push({ type: "text", text: event.delta });
              }
              return { ...prev, blocks };
            });
            break;
          case "tool_use_block":
            setPendingAssistant((prev) => {
              if (!prev) return prev;
              return {
                ...prev,
                blocks: [
                  ...prev.blocks,
                  { type: "tool_use", id: event.toolUseId, name: event.name, input: event.input },
                ],
              };
            });
            break;
          case "permission_required":
            setPendingPermissions((prev) => [
              ...prev,
              { toolUseId: event.toolUseId, name: event.name, input: event.input },
            ]);
            break;
          case "tool_result_block":
            // Drop matching pending permission, server-side state already advanced.
            setPendingPermissions((prev) =>
              prev.filter((p) => p.toolUseId !== event.toolUseId),
            );
            break;
          case "message_completed":
            // Server has persisted the assistant message; refresh canonical history.
            refresh();
            setPendingAssistant(null);
            break;
          case "session_state":
            qc.setQueryData(["clippy", "session", sessionId], event.session);
            break;
          case "done":
            setStreaming(false);
            setPendingAssistant(null);
            refresh();
            break;
          case "error":
            setPendingAssistant({
              id: `pending-error-${Date.now()}`,
              role: "assistant",
              blocks: [{ type: "text", text: `Error: ${event.error}` }],
            });
            setStreaming(false);
            setPendingPermissions([]);
            refresh();
            break;
          case "ping":
          case "message_started":
            break;
          default:
            break;
        }
      }

      try {
        await handle.done;
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [qc, refresh, sessionId, streaming],
  );

  const decidePermission = useCallback(
    async (toolUseId: string, decision: "approve" | "deny") => {
      if (!sessionId) return;
      // Remove from pending list optimistically; server resolution drives the next event.
      setPendingPermissions((prev) => prev.filter((p) => p.toolUseId !== toolUseId));
      try {
        await chatApi.decidePermission(sessionId, toolUseId, decision);
      } catch (err) {
        // If the server lost the pending permission, surface as a transcript error.
        const message = err instanceof Error ? err.message : String(err);
        setPendingAssistant((prev) => ({
          id: prev?.id ?? `pending-perm-err-${Date.now()}`,
          role: "assistant",
          blocks: [
            ...(prev?.blocks ?? []),
            { type: "text", text: `\n\nFailed to record permission decision: ${message}` },
          ],
        }));
      }
    },
    [sessionId],
  );

  const patchSession = useCallback(
    async (patch: Parameters<typeof chatApi.patchSession>[1]) => {
      if (!sessionId) return null;
      const { session } = await chatApi.patchSession(sessionId, patch);
      qc.setQueryData(["clippy", "session", sessionId], session);
      qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
      return session;
    },
    [qc, sessionId],
  );

  const messages = messagesQuery.data ?? [];
  const transcript: ClippyTranscriptEntry[] = messages.map((m) => ({
    id: m.id,
    role: m.role,
    blocks: m.content,
  }));
  if (pendingAssistant) {
    // Avoid double-rendering if the server already persisted the same message id.
    if (!messages.some((m) => m.id === pendingAssistant.id)) {
      transcript.push(pendingAssistant);
    }
  }

  return {
    session: sessionQuery.data ?? null,
    messages,
    transcript,
    loading: sessionQuery.isLoading || messagesQuery.isLoading,
    streaming,
    pendingPermissions,
    send,
    decidePermission,
    patchSession,
    abort: () => {
      abortRef.current?.();
      abortRef.current = null;
      setStreaming(false);
    },
  };
}
