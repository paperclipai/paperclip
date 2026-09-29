import { lstatSync } from "node:fs";
import { join } from "node:path";
import { readIndexedLocalState, type IndexedLocalSnapshot } from "../../vendor/paperclip-runner/index.js";
import { readNativeHarnessBackupManifestBytes } from "./native-harness-tree.js";

export interface NativeCheckpointBindings {
  schema: "paperclip.native-checkpoint-bindings.v1";
  runId: string;
  runner: { generation: string; sha256: string };
  provider: { generation: string; sha256: string };
}
const invalid = () => new Error("runner_harness_state_mismatch: indexed_snapshot_binding");
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const present = (path: string) => !!lstatSync(path, { throwIfNoEntry: false });

/** Verify bounded native current-state bindings before a transferred checkpoint
 * can be published or restored. Full file/receipt integrity belongs to the
 * native snapshot and outer streamed archive digest, not this current read. */
export async function readNativeIndexedCheckpointProof(directory: string): Promise<{
  bindings: NativeCheckpointBindings;
  runner: IndexedLocalSnapshot;
  provider: IndexedLocalSnapshot;
} | null> {
  const manifest = join(directory, "indexed-session-snapshot.json");
  if (!present(manifest)) {
    // A legacy backup has no native databases. A naked indexed directory is
    // never accepted as a legacy backup merely because its marker is missing.
    if (["runner-state.sqlite", "codex-provider-state.sqlite"].some(name => present(join(directory, name)))) throw invalid();
    return null;
  }
  const value: unknown = JSON.parse(readNativeHarnessBackupManifestBytes(manifest).toString("utf8"));
  if (!object(value) || value.schema !== "paperclip.runner.indexed-session-snapshot.v1" || !Array.isArray(value.states) || value.states.length !== 2 ||
    !Array.isArray(value.locators) || value.locators.length !== 2 || value.locators.some(locator => typeof locator !== "string" || Buffer.byteLength(locator) > 4096)) throw invalid();
  const runner = await readIndexedLocalState(join(directory, "runner-state.json"));
  const provider = await readIndexedLocalState(join(directory, "codex-provider-state.json"));
  const states = [runner, provider];
  for (let index = 0; index < 2; index++) {
    const expected: unknown = value.states[index], locator: unknown = JSON.parse(value.locators[index]);
    const actualLocator: unknown = JSON.parse(readNativeHarnessBackupManifestBytes(join(directory, index ? "codex-provider-state.json" : "runner-state.json")).toString("utf8"));
    if (!object(expected) || expected.generation !== states[index]!.generation || expected.sha256 !== states[index]!.stateDigest ||
      !object(locator) || !object(actualLocator) || locator.schema !== actualLocator.schema || locator.binding !== actualLocator.binding) throw invalid();
  }
  const runId = runner.state.runId;
  if (typeof runId !== "string" || !runId || runId.length > 240 || runner.state.lifecycle !== "suspended" ||
    !Array.isArray(runner.state.outbox) || runner.state.outbox.length !== 0) throw invalid();
  return { bindings: { schema: "paperclip.native-checkpoint-bindings.v1", runId,
    runner: { generation: runner.generation, sha256: runner.stateDigest }, provider: { generation: provider.generation, sha256: provider.stateDigest } }, runner, provider };
}
