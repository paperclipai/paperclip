import { createHash } from "node:crypto";
import path from "node:path";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

const STATE_ONLY = `for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  if [ ! -L "$entry" ]; then
    case "\${entry##*/}" in
      sessions|archived_sessions|session_index.jsonl|history.jsonl|state_*.sqlite|state_*.sqlite-*|thread_history_*.sqlite|thread_history_*.sqlite-*) continue ;;
    esac
  fi
  rm -rf -- "$entry"
done`;

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
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scope = hash([input.companyId, input.agentId, input.accountIdentity, input.executionIdentity]);
  const savedId = input.saved.sshCodexConversationId;
  const canResume = input.saved.sshCodexAccountScope === scope && typeof savedId === "string" && /^[a-f0-9]{64}$/.test(savedId);
  const conversationId = canResume ? savedId : hash(input.runId);
  const home = path.posix.join(input.remoteRoot, ".paperclip-runtime", "codex", "conversations", scope, conversationId);
  const prefix = `set -eu\numask 077\nhome=${shellQuote(home)}\n[ ! -L "$home" ]\n`;
  const cleanup = () => input.run(`${prefix}if [ -d "$home" ]; then\n${STATE_ONLY}\nfi`);
  try {
    await input.run(`${prefix}mkdir -p "$home"\nchmod 700 "$home"\n${STATE_ONLY}\ncp -RP ${shellQuote(input.stagedHome + "/.")} "$home/"`);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { home, scope, conversationId, canResume, cleanup };
}
