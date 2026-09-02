import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { NativeExecutionInput } from "../contracts/native-execution.js";
import { nativeSystemInstructions } from "./runtime-context.js";

const temporaryRoots: string[] = [];

function runtimeInput(rootPath: string, entryPath: string): NativeExecutionInput {
  return {
    runtimeContext: {
      prompt: { text: "Paperclip runtime." },
      instructions: { bundle: { rootPath }, entryPath },
    },
  } as unknown as NativeExecutionInput;
}

describe("native runtime context files", () => {
  afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads an instruction entry contained by its bundle root", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "paperclip-runtime-context-"));
    temporaryRoots.push(temporaryRoot);
    const bundleRoot = join(temporaryRoot, "bundle");
    mkdirSync(bundleRoot);
    writeFileSync(join(bundleRoot, "AGENTS.md"), "Stay inside the bundle.\n");

    expect(nativeSystemInstructions(runtimeInput(bundleRoot, "AGENTS.md")))
      .toContain("Stay inside the bundle.");
  });

  it("rejects traversal and symlink escapes from the bundle root", () => {
    const temporaryRoot = mkdtempSync(join(tmpdir(), "paperclip-runtime-context-"));
    temporaryRoots.push(temporaryRoot);
    const bundleRoot = join(temporaryRoot, "bundle");
    mkdirSync(bundleRoot);
    writeFileSync(join(temporaryRoot, "outside.md"), "outside");
    symlinkSync(join(temporaryRoot, "outside.md"), join(bundleRoot, "linked.md"));

    expect(() => nativeSystemInstructions(runtimeInput(bundleRoot, "../outside.md")))
      .toThrow("native_runtime_context_entry_outside_bundle");
    expect(() => nativeSystemInstructions(runtimeInput(bundleRoot, "linked.md")))
      .toThrow("native_runtime_context_entry_outside_bundle");
  });
});
