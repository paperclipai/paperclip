import { useChatSession } from "../hooks/useChatSession";
import { ClippyComposer } from "./ClippyComposer";
import { ClippyMessageList } from "./ClippyMessageList";

interface Props {
  sessionId: string | null;
}

export function ClippyConversation({ sessionId }: Props) {
  const {
    session,
    transcript,
    streaming,
    pendingPermissions,
    send,
    decidePermission,
    patchSession,
    abort,
  } = useChatSession(sessionId);

  if (!sessionId) {
    return (
      <div className="flex h-full flex-col items-center justify-center p-6 text-sm text-muted-foreground">
        <p>Pick a chat from the list — or start a new one — to talk to Clippy.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border px-4 py-2 text-sm font-medium">
        {session?.title ?? "Loading…"}
      </div>
      <ClippyMessageList
        transcript={transcript}
        pendingPermissions={pendingPermissions}
        onPermissionDecision={decidePermission}
        streaming={streaming}
      />
      <ClippyComposer
        sessionId={sessionId}
        mode={session?.mode ?? "chat"}
        permissionMode={session?.permissionMode ?? "ask"}
        effort={session?.effort ?? "auto"}
        model={session?.model ?? "claude-opus-4-7"}
        streaming={streaming}
        onSend={(text, attachmentIds) => {
          void send(text, attachmentIds);
        }}
        onAbort={abort}
        onPatch={(patch) => {
          void patchSession(patch);
        }}
      />
    </div>
  );
}
