import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";

/** Archive/hash commands write their large payload to a private remote spool.
 * Only this bounded completion output crosses the channel. A long-lived owned
 * channel avoids the provider's single-RPC execution deadline. */
export async function runCheckpointCommand(
  runner: CommandManagedRuntimeRunner,
  script: string,
): Promise<string> {
  if (!runner.openDuplexChannel) {
    // SSH and local runners implement execute's explicit zero deadline. A
    // provider without duplex still owns its execute contract; its restrictions
    // must be reported as provider limitations, not unlimited qualification.
    const result = await runner.execute({ command: "sh", args: ["-c", script], bypassSession: true, timeoutMs: 0 });
    if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) > 64 * 1024) {
      throw new Error("runner_remote_checkpoint_transfer_failed");
    }
    return result.stdout;
  }
  const channel = await runner.openDuplexChannel({ command: ["sh", "-c", script] });
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        // Release only this channel's owned child, never a PID/name search.
        try { channel.stop(); } catch { /* The transport can already be closed. */ }
        reject(new Error("runner_remote_checkpoint_transfer_failed"));
      };
      channel.onData(chunk => {
        if (settled) return;
        size += chunk.byteLength;
        if (size > 64 * 1024) { fail(); return; }
        chunks.push(Buffer.from(chunk));
      });
      channel.onExit(exit => {
        if (settled) return;
        if (exit.transportClosed || exit.exitCode !== 0) { fail(); return; }
        settled = true;
        resolve(Buffer.concat(chunks, size).toString("utf8"));
      });
    });
  } finally { await channel.close(); }
}
