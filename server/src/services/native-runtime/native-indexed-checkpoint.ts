import { createHash } from "node:crypto";
import { posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { inspectRemoteIndexedState } from "./native-indexed-inspection.js";
import { runCheckpointCommand } from "./native-checkpoint-command.js";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

/** Replace raw copies of live SQLite files with native, verified snapshots.
 * Caller owns the stopped-session/maintenance admission and must bind the
 * provider home and controller authority before publishing a harness backup. */
export async function createRemoteIndexedSessionCheckpoint(input: {
  runner: CommandManagedRuntimeRunner;
  runnerBinary: string;
  directory: string;
}): Promise<{ directory: string; dispose(): Promise<void> }> {
  if (!input.runner.openDuplexChannel || ![input.runnerBinary, input.directory].every(path => path.startsWith("/") && !path.includes("\0"))) {
    throw new Error("native_indexed_checkpoint_transport_unavailable");
  }
  const states = [];
  for (const name of ["runner-state.json", "codex-provider-state.json"]) {
    const current = await inspectRemoteIndexedState({ ...input, path: posix.join(input.directory, name) });
    states.push({ generation: current.generation, sha256: current.stateDigest });
  }
  // A controller restart retries the same durable native copy. No aggregate
  // transfer deadline or in-memory history is introduced here.
  const id = createHash("sha256").update(JSON.stringify({ directory: input.directory, states })).digest("hex").slice(0, 32);
  const directory = posix.join(posix.dirname(input.directory), `.paperclip-indexed-snapshot-${id}`);
  const command = [input.runnerBinary, "storage", "snapshot-session", "--directory", input.directory, "--destination", directory,
    "--runner-generation", states[0]!.generation, "--runner-sha256", states[0]!.sha256,
    "--provider-generation", states[1]!.generation, "--provider-sha256", states[1]!.sha256];
  const result: unknown = JSON.parse(await runCheckpointCommand(input.runner, command.map(quote).join(" ")));
  const response = result as { snapshot?: unknown; destination?: unknown; states?: unknown } | null;
  if (!response || response.snapshot !== "complete" || response.destination !== directory || JSON.stringify(response.states) !== JSON.stringify(states)) {
    throw new Error("native_indexed_checkpoint_incomplete");
  }
  return { directory, async dispose() {
    // Only a successfully copied and published host backup calls this. Failed
    // transfers retain native source pins/staging for an exact retry. These
    // two fixed job paths were created by the command above; never delete the
    // live runner directory or discover cleanup targets by a wildcard.
    const staging = posix.join(posix.dirname(directory), `.${posix.basename(directory)}.preparing`);
    await runCheckpointCommand(input.runner, `rm -rf -- ${quote(directory)} ${quote(staging)}`);
  } };
}
