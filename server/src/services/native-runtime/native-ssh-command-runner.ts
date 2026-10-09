import { createSshCommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/ssh";
import { MAX_REMOTE_DELIVERABLE_BYTES } from "./remote-deliverable-file.js";

/** The command transport used by a native session on an operator-bound SSH host. */
export function createNativeSshCommandRunner(
  input: Pick<Parameters<typeof createSshCommandManagedRuntimeRunner>[0], "spec" | "defaultCwd">,
) {
  return createSshCommandManagedRuntimeRunner({
    ...input,
    // The verified reader returns base64. Bound the command output to one
    // maximum-size encoded file; the adapter's 1 MiB default truncates it.
    maxBufferBytes: 4 * Math.ceil(MAX_REMOTE_DELIVERABLE_BYTES / 3),
  });
}
