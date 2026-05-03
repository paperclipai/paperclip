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
  send: (text: string, attachmentIds?: string[]) => Promise<void>;
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

  // Lightweight refresh: only re-pull the per-session data that actually
  // changes during a turn. The sessions LIST is invalidated separately at
  // turn end (or when the title changes via session_state) so we don't
  // re-fetch the entire rail on every text_delta-adjacent event.
  const refresh = useCallback(() => {
    if (!sessionId) return;
    qc.invalidateQueries({ queryKey: ["clippy", "messages", sessionId] });
    qc.invalidateQueries({ queryKey: ["clippy", "session", sessionId] });
  }, [qc, sessionId]);

  const refreshSessionsList = useCallback(() => {
    qc.invalidateQueries({ queryKey: ["clippy", "sessions"] });
  }, [qc]);

  const send = useCallback(
    async (text: string, attachmentIds: string[] = []) => {
      if (!sessionId) throw new Error("No active session");
      if (streaming) throw new Error("A turn is already streaming");
      // Optimistically add user message + start an empty assistant entry.
      const optimisticBlocks: ChatContentBlock[] = [];
      if (text.length > 0) optimisticBlocks.push({ type: "text", text });
      // Server resolves attachment metadata when persisting; the optimistic
      // entry is replaced by the canonical message after `done`. We don't
      // duplicate attachment metadata here.
      const optimisticUser: ClippyTranscriptEntry = {
        id: `optimistic-user-${Date.now()}`,
        role: "user",
        blocks: optimisticBlocks,
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

      const handle = postChatMessageStream(
        sessionId,
        text,
        (event) => {
          handleStreamEvent(event);
        },
        attachmentIds,
      );
      abortRef.current = handle.abort;

      // Helper that lazily ensures a pending assistant entry exists so a
      // `text_delta` arriving after `message_completed` (i.e. the second LLM
      // turn after a tool call in agent mode) still streams visibly.
      const ensurePending = (prev: ClippyTranscriptEntry | null): ClippyTranscriptEntry =>
        prev ?? {
          id: `pending-${Date.now()}`,
          role: "assistant",
          blocks: [],
          pending: true,
        };

      function handleStreamEvent(event: ChatStreamEvent) {
        switch (event.type) {
          case "message_started":
            // Server is starting a new assistant turn. Make sure we have a
            // pending entry so subsequent text_deltas render — this is what
            // covers the gap between tool-loop iterations.
            setPendingAssistant((prev) => ensurePending(prev));
            break;
          case "text_delta":
            setPendingAssistant((prev) => {
              const base = ensurePending(prev);
              const blocks = [...base.blocks];
              const last = blocks[blocks.length - 1];
              if (last && last.type === "text") {
                blocks[blocks.length - 1] = { type: "text", text: last.text + event.delta };
              } else {
                blocks.push({ type: "text", text: event.delta });
              }
              return { ...base, blocks };
            });
            break;
          case "tool_use_block":
            setPendingAssistant((prev) => {
              const base = ensurePending(prev);
              return {
                ...base,
                blocks: [
                  ...base.blocks,
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
            // Title may have changed (e.g. auto-derived from the first user
            // message) — refresh the rail so the dropdown reflects it.
            refreshSessionsList();
            break;
          case "done":
            setStreaming(false);
            setPendingAssistant(null);
            refresh();
            refreshSessionsList();
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
    [qc, refresh, refreshSessionsList, sessionId, streaming],
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
