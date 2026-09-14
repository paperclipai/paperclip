import type { CommandManagedRuntimeRunner } from "./command-managed-runtime.js";
import { isRemoteProcessIdentity, type RemoteProcessIdentity } from "./remote-process-identity.js";
import { parseRemoteProcessControlResponse, remoteProcessControlSource, type RemoteProcessControlOperation, type RemoteProcessControlState } from "@paperclipai/shared/remote-process-control";
export { remoteProcessControlSource, type RemoteProcessControlOperation, type RemoteProcessControlState } from "@paperclipai/shared/remote-process-control";

export async function controlRemoteProcess(
  runner: Pick<CommandManagedRuntimeRunner, "execute">,
  owner: RemoteProcessIdentity,
  operation: RemoteProcessControlOperation,
): Promise<RemoteProcessControlState> {
  if (!isRemoteProcessIdentity(owner)) return "unverified";
  try {
    const result = await runner.execute({ command: "node", args: ["-e", remoteProcessControlSource],
      env: { PAPERCLIP_REMOTE_PROCESS_CONTROL: JSON.stringify({ owner, operation }), NODE_OPTIONS: "", NODE_PATH: "" },
      bypassSession: true, timeoutMs: 10_000 });
    if (result.timedOut || result.exitCode !== 0 || result.stdout.length > 128) return "unverified";
    return parseRemoteProcessControlResponse(result.stdout, operation);
  } catch { return "unverified"; }
}
