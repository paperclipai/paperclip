import { parentPort } from "node:worker_threads";

// Source-mode workers run through Node's type stripping, compiled workers use
// the adjacent JS module. The worker owns only bounded decoding, never SQLite
// or a child process that could outlive worker termination.
const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
const { IndexedInspectionDecoder } = await import(new URL(`./indexed-inspection-codec.${extension}`, import.meta.url).href);
const decoder = new IndexedInspectionDecoder();
parentPort!.on("message", (message: { bytes?: Uint8Array; complete?: boolean }) => {
  try {
    if (message.bytes) {
      decoder.push(message.bytes);
      parentPort!.postMessage({ consumed: true });
    } else if (message.complete) {
      parentPort!.postMessage({ value: decoder.finish() });
      parentPort!.close();
    } else throw new Error("indexed_state_reader_invalid_message");
  } catch (error) {
    parentPort!.postMessage({ error: error instanceof Error ? error.message : "indexed_state_reader_failed" });
    parentPort!.close();
  }
});
