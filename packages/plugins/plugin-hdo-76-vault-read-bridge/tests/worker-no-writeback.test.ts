import { describe, it } from "node:test";
import { ok } from "node:assert/strict";
import { readFileSync } from "node:fs";

/**
 * Contract-level lint test: the bridge MUST NOT reference
 * `writeTextAtomic` or `deleteFile` against the vault folder key.
 * This is one of the binding constraints from HDO-76 Phase 1 Note B;
 * the lint runs in this heartbeat and again on every CI gate.
 *
 * See the plugin README for the write-back prohibition.
 */

const WORKER_PATH = new URL("../src/worker.ts", import.meta.url);
const UI_PATH = new URL("../src/ui/vault-tab.tsx", import.meta.url);

function readSource(url: URL): string {
  return readFileSync(url, "utf8");
}

describe("vault read-bridge worker", () => {
  it("never references writeTextAtomic", () => {
    const source = readSource(WORKER_PATH);
    ok(!/writeTextAtomic/.test(source), "worker must not reference writeTextAtomic");
  });

  it("never references deleteFile", () => {
    const source = readSource(WORKER_PATH);
    ok(!/deleteFile/.test(source), "worker must not reference deleteFile");
  });

  it("never invokes localFolders.write*", () => {
    const source = readSource(WORKER_PATH);
    ok(!/localFolders\.write/.test(source), "worker must not call localFolders.write*");
  });
});

describe("vault read-bridge UI", () => {
  it("never references writeTextAtomic or deleteFile", () => {
    const source = readSource(UI_PATH);
    ok(!/writeTextAtomic/.test(source), "UI must not reference writeTextAtomic");
    ok(!/deleteFile/.test(source), "UI must not reference deleteFile");
  });
});
