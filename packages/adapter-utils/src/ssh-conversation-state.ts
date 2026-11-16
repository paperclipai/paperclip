import { createHash } from "node:crypto";
import path from "node:path";
import { shellQuote } from "./ssh.js";

/** Retain provider-owned conversation files while scrubbing per-turn credentials. */
export async function prepareSshConversationState(input: {
  adapterKey: string;
  preserve: readonly string[];
  remoteRoot: string;
  companyId: string;
  agentId: string;
  accountIdentity: string;
  executionIdentity: unknown;
  runId: string;
  savedScope: unknown;
  savedConversationId: unknown;
  stagedHome?: string;
  run: (command: string) => Promise<void>;
}) {
  if (!/^[a-z0-9_-]+$/.test(input.adapterKey) || input.preserve.length === 0
    || input.preserve.some(pattern => !/^[A-Za-z0-9_.*-]+$/.test(pattern))) {
    throw new Error("Invalid SSH conversation retention policy");
  }
  const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
  const scope = hash([input.companyId, input.agentId, input.accountIdentity, input.executionIdentity]);
  const savedId = input.savedConversationId;
  const canResume = input.savedScope === scope && typeof savedId === "string" && /^[a-f0-9]{64}$/.test(savedId);
  const conversationId = canResume ? savedId : hash(input.runId);
  const home = path.posix.join(input.remoteRoot, ".paperclip-runtime", input.adapterKey, "conversations", scope, conversationId);
  const prefix = `set -eu\numask 077\nhome=${shellQuote(home)}\n[ ! -L "$home" ]\n`;
  const stateOnly = `for entry in "$home"/* "$home"/.[!.]* "$home"/..?*; do
  [ -e "$entry" ] || [ -L "$entry" ] || continue
  if [ ! -L "$entry" ]; then
    case "\${entry##*/}" in
      ${input.preserve.join("|")} ) continue ;;
    esac
  fi
  rm -rf -- "$entry"
done`;
  const cleanup = () => input.run(`${prefix}if [ -d "$home" ]; then\n${stateOnly}\nfi`);
  try {
    await input.run(`${prefix}mkdir -p "$home"\nchmod 700 "$home"\n${stateOnly}${input.stagedHome ? `\ncp -RP ${shellQuote(input.stagedHome + "/.")} "$home/"` : ""}`);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { home, scope, conversationId, canResume, cleanup };
}
