import { prepareSshConversationState } from "@paperclipai/adapter-utils/ssh-conversation-state";

export async function prepareCodexSshSessionState(input: {
  remoteRoot: string;
  companyId: string;
  agentId: string;
  accountIdentity: string;
  executionIdentity: unknown;
  runId: string;
  saved: Record<string, unknown>;
  stagedHome: string;
  run: (command: string) => Promise<void>;
}) {
  return prepareSshConversationState({
    ...input,
    adapterKey: "codex",
    preserve: ["sessions", "archived_sessions", "session_index.jsonl", "history.jsonl", "state_*.sqlite", "state_*.sqlite-*", "thread_history_*.sqlite", "thread_history_*.sqlite-*"],
    savedScope: input.saved.sshCodexAccountScope,
    savedConversationId: input.saved.sshCodexConversationId,
  });
}
