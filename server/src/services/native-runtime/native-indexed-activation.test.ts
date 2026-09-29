import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { expect, it } from "vitest";
import { useIndexedNativeAuthority } from "./native-indexed-activation.js";

it("keeps retained indexed sessions recoverable when fresh activation is disabled", () => {
  const root = mkdtempSync(resolve(tmpdir(), "indexed-activation-"));
  const control = resolve(root, "control-plane");
  mkdirSync(control, { mode: 0o700 });
  mkdirSync(resolve(root, "runner"), { mode: 0o700 });
  const file = resolve(control, "control-plane-state.json");
  const write = (path: string, schema: string) => writeFileSync(path, JSON.stringify({ schema }), { mode: 0o600 });
  try {
    expect(useIndexedNativeAuthority(control, false)).toBe(false);
    expect(useIndexedNativeAuthority(control, true)).toBe(true);
    write(file, "paperclip.runner.control-plane-state.v1");
    expect(useIndexedNativeAuthority(control, true)).toBe(false);
    write(file, "paperclip.runner.authority-locator.v1");
    expect(useIndexedNativeAuthority(control, false)).toBe(true);
    rmSync(file);
    write(resolve(root, "runner/codex-provider-state.json"), "paperclip.runner.codex-provider-state.indexed.v1");
    expect(useIndexedNativeAuthority(control, false)).toBe(true);
    write(resolve(root, "runner/codex-provider-state.json"), "paperclip.runner.codex-provider-state.v1");
    expect(useIndexedNativeAuthority(control, true)).toBe(false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
