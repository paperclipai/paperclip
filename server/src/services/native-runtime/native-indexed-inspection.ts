import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { IndexedInspectionDecoder, type IndexedLocalSnapshot } from "../../vendor/paperclip-runner/index.js";

export type NativeIndexedInspection = IndexedLocalSnapshot;

/** A single read-only native snapshot, streamed through an owned remote
 * channel. The wire limit bounds current state, never lifetime history. */
export async function inspectRemoteIndexedState(input: {
  runner: CommandManagedRuntimeRunner;
  runnerBinary: string;
  path: string;
  timeoutMs?: number;
}): Promise<NativeIndexedInspection> {
  if (!input.runner.openDuplexChannel || ![input.runnerBinary, input.path].every(path => path.startsWith("/") && !path.includes("\0"))) {
    throw new Error("native_indexed_inspection_transport_unavailable");
  }
  const channel = await input.runner.openDuplexChannel({ command: [input.runnerBinary, "storage", "inspect-state", "--path", input.path] });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<NativeIndexedInspection>((resolve, reject) => {
      const decoder = new IndexedInspectionDecoder();
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        try { channel.stop(); } catch { /* Still await owned close below. */ }
        reject(new Error("native_indexed_inspection_invalid_or_incomplete"));
      };
      timer = setTimeout(fail, input.timeoutMs ?? 30_000);
      channel.onData(chunk => { if (!settled) { try { decoder.push(chunk); } catch { fail(); } } });
      channel.onExit(exit => {
        if (settled) return;
        try {
          if (exit.transportClosed || exit.exitCode !== 0) throw new Error();
          const value = decoder.finish();
          settled = true; resolve(value);
        } catch { fail(); }
      });
    });
  } finally { if (timer) clearTimeout(timer); await channel.close(); }
}
