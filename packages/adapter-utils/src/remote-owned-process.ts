import { parseRemoteProcessLaunchReceipt, remoteProcessIdentityPrelude, type RemoteProcessIdentity } from "./remote-process-identity.js";

/** These wrappers execute before the agent. Caller values remain argv entries;
 * no agent-writable identity file or agent output supplies the launch receipt. */
export function remoteOwnedProcessCommand(input: { nonce: string; command: string; args: string[]; detached: boolean }) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.nonce)) throw new Error("Invalid remote launch nonce");
  const child = 'set -eu; identity_nonce=$1; shift; '
    + (input.detached ? "" : "exec 3>&1; ")
    + remoteProcessIdentityPrelude + 'exec "$@"';
  if (!input.detached) return {
    command: "setsid",
    args: ["--wait", "sh", "-c", child, "paperclip-owned-process", input.nonce, input.command, ...input.args],
  };
  return {
    command: "sh",
    args: ["-c", 'set -eu; identity_nonce=$1; child_script=$2; shift 2; { nohup setsid sh -c "$child_script" paperclip-owned-process "$identity_nonce" "$@" 3>&1 </dev/null >/dev/null 2>&1 & } | cat',
      "paperclip-owned-process-launch", input.nonce, child, input.command, ...input.args],
  };
}

/** Strip one trusted pre-exec header, then treat every later byte as agent data.
 * A provider's final replay must contain that same header. Callbacks and output
 * are serialized so provider frames cannot overtake ownership persistence. */
export class RemoteProcessReceiptStream {
  #prefix = "";
  #header: string | null = null;
  #pending: Promise<unknown> = Promise.resolve();
  #failed = false;
  #failure: unknown = null;
  constructor(private readonly nonce: string, private readonly onIdentity: (identity: RemoteProcessIdentity) => Promise<void>) {}

  #serialize<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#pending.then(async () => {
      if (this.#failed) throw this.#failure;
      return work();
    });
    this.#pending = result.catch((error: unknown) => { this.#failed = true; this.#failure = error; });
    return result;
  }

  async #read(chunk: string) {
    if (this.#header) return chunk;
    const newline = chunk.indexOf("\n");
    const count = newline < 0 ? chunk.length : newline + 1;
    if (this.#prefix.length + count > 512) throw new Error("remote_process_ownership_unverified");
    this.#prefix += chunk.slice(0, count);
    if (newline < 0) return "";
    const identity = parseRemoteProcessLaunchReceipt(this.#prefix, this.nonce);
    if (!identity) throw new Error("remote_process_ownership_unverified");
    this.#header = this.#prefix;
    this.#prefix = "";
    await this.onIdentity(identity);
    return chunk.slice(count);
  }

  consume(chunk: string): Promise<string> { return this.#serialize(() => this.#read(chunk)); }

  finish(stdout: string): Promise<string> {
    return this.#serialize(async () => {
      // Final stdout is a replay of the complete command stream, not a suffix.
      if (!this.#header) {
        if (!stdout.startsWith(this.#prefix)) throw new Error("remote_process_ownership_unverified");
        const pendingPrefixLength = this.#prefix.length;
        await this.#read(stdout.slice(pendingPrefixLength));
      }
      if (!this.#header || !stdout.startsWith(this.#header)) throw new Error("remote_process_ownership_unverified");
      return stdout.slice(this.#header.length);
    });
  }
}
