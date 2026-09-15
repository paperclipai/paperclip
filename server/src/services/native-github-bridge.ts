import path from "node:path";
import {
  adapterExecutionTargetDuplexObservabilityRecorder,
  adapterExecutionTargetEnablesSandboxDuplexBridge,
  startAdapterExecutionTargetPaperclipBridge,
} from "@paperclipai/adapter-utils/execution-target";

type BridgeInput = Parameters<typeof startAdapterExecutionTargetPaperclipBridge>[0];

/** Native Git uses the same opt-in and capability gates as managed adapters. */
export async function startNativeGitHubCallbackBridge(
  input: Pick<BridgeInput, "runId" | "target" | "hostApiToken" | "onLog">,
) {
  const target = input.target;
  if (target?.kind !== "remote") return null;
  return startAdapterExecutionTargetPaperclipBridge({
    ...input,
    target,
    runtimeRootDir: path.posix.join(target.remoteCwd, ".paperclip-runtime", "github", input.runId),
    adapterKey: "native-github",
    // Without forwarding this opt-in, native Git silently selects remote-file
    // polling even when the same sandbox uses HTTP/2 for its legacy adapters.
    enableSandboxDuplexBridge: adapterExecutionTargetEnablesSandboxDuplexBridge(target),
    duplexObservabilityRecorder: adapterExecutionTargetDuplexObservabilityRecorder(target),
  });
}
