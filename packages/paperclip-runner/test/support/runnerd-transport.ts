import { join, resolve } from "node:path";
import { expect } from "vitest";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  nativeRuntimePromptDigest,
  type NativeRuntimeContextSnapshot,
} from "../../src/contracts/runtime-context.js";
import { defaultCapabilityRunnerdBinary as qualifiedCapabilityRunnerdBinary } from "../../src/live/runnerd-codex-transport.js";

export const defaultCapabilityRunnerdBinary = () =>
  process.env.PAPERCLIP_ATTACH_TRANSITION_RUNNER ??
  qualifiedCapabilityRunnerdBinary();

export async function expectTurnStarted(
  notifications: AsyncIterator<{ method: string }>,
) {
  for (let index = 0; index < 32; index += 1) {
    const next = await notifications.next();
    expect(next.done).not.toBe(true);
    if (next.value.method === "turn/started") return;
    // Startup ownership and capability facts can precede the active turn.
    expect(next.value.method).toBe("paperclip/canonicalProviderEvent");
  }
  throw new Error(
    "provider turn did not start within the bounded notification prefix",
  );
}

export const fakeCodex = resolve(
  import.meta.dirname,
  "../../runner/target/debug/fake-codex-app-server",
);

export function fakeCodexArgs(stateDirectory: string, ...args: string[]): string[] {
  return [
    "--state-file",
    join(stateDirectory, "fake-codex-state.json"),
    ...args,
  ];
}

export function assignedRuntimeContext(
  skillRoot: string,
  instructionRoot: string,
): NativeRuntimeContextSnapshot {
  const digest = "0".repeat(64);
  const value = {
    prompt: {
      revision: PAPERCLIP_EXECUTION_PROMPT_REVISION,
      text: PAPERCLIP_EXECUTION_PROMPT,
      digest: nativeRuntimePromptDigest(),
    },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: {
        schema: NATIVE_RUNTIME_ASSET_SCHEMA,
        digest,
        manifestDigest: digest,
        rootPath: instructionRoot,
        fileCount: 1,
        totalBytes: 1,
      },
    },
    skills: [
      {
        key: "company/assigned",
        runtimeName: "assigned",
        versionId: "version-1",
        bundle: {
          schema: NATIVE_RUNTIME_ASSET_SCHEMA,
          digest,
          manifestDigest: digest,
          rootPath: skillRoot,
          fileCount: 1,
          totalBytes: 1,
        },
      },
    ],
    mcp: { assignmentSetId: "assigned", digest, bindingId: "binding" },
  } satisfies Omit<NativeRuntimeContextSnapshot, "aggregateDigest">;
  return {
    ...value,
    aggregateDigest: canonicalNativeRuntimeContextDigest(value),
  };
}
