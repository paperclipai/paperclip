import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

export function createNativeRestartRuntimeRoot(): Promise<string> {
  return mkdtemp(resolve(tmpdir(), "native-restart-runtime-"));
}
