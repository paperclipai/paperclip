import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  composeNativeSystemInstructions,
  parseNativeRuntimeContext,
} from "./runtime-context.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

function savedContext(revision: string, text: string) {
  const digest = "0".repeat(64);
  const context = {
    prompt: { revision, text, digest: hash(text) },
    instructions: {
      entryPath: "AGENTS.md",
      bundle: { schema: NATIVE_RUNTIME_ASSET_SCHEMA, digest, manifestDigest: digest, rootPath: "/runtime/instructions", fileCount: 1, totalBytes: 42 },
    },
    skills: [],
    mcp: { assignmentSetId: "none", digest, bindingId: "native-mcp:run-1" },
    connectionInstructions: { text: "Saved connection instructions", digest: hash("Saved connection instructions") },
  };
  // This is persisted wire data, deliberately created independently of the parser.
  return {
    ...context,
    aggregateDigest: hash(JSON.stringify({
      prompt: context.prompt,
      instructions: { entryPath: context.instructions.entryPath, bundleDigest: digest },
      skills: [],
      mcp: { assignmentSetId: "none", digest },
      connectionInstructions: context.connectionInstructions,
    })),
  };
}

describe("persisted native execution prompts", () => {
  it("preserves an authenticated persistent home independently of instruction copies", () => {
    const context = { ...savedContext("saved", "Instructions"), persistentAgentHome: { rootPath: "/computer/agent" } };
    expect(parseNativeRuntimeContext(context).persistentAgentHome).toEqual({ rootPath: "/computer/agent" });
    expect(parseNativeRuntimeContext(context).instructions.workingCopy).toBeUndefined();
    expect(() => parseNativeRuntimeContext({ ...context, persistentAgentHome: { rootPath: "" } })).toThrow();
    expect(() => parseNativeRuntimeContext({ ...context, persistentAgentHome: { rootPath: "/computer/agent", untrusted: true } })).toThrow();
  });
  it.each([
    ["snapshot-before-upgrade", "Saved instructions from before the upgrade."],
    ["future-prompt-fixture", "  Saved instructions absent from this release.\n"],
    [PAPERCLIP_EXECUTION_PROMPT_REVISION, "Saved text under a revision reused by a later release."],
    ["__proto__", "The revision is opaque metadata."],
  ])(
    "recovers %s without a prompt catalog or rewriting its saved instructions",
    (revision, text) => {
      const persisted = JSON.parse(JSON.stringify(savedContext(revision, text)));
      const parsed = parseNativeRuntimeContext(persisted);
      expect(parsed).toEqual(persisted);
      expect(canonicalNativeRuntimeContextDigest(parsed)).toBe(persisted.aggregateDigest);
      expect(parseNativeRuntimeContext(parsed)).toEqual(persisted);
      expect(composeNativeSystemInstructions(parsed, "Agent instructions")).toBe(
        `${text}\n\nAgent instructions\n\nSaved connection instructions\n\nRead-only instruction sibling root: /runtime/instructions`,
      );
    },
  );

  it("keeps the current prompt valid for new executions", () => {
    const current = savedContext(PAPERCLIP_EXECUTION_PROMPT_REVISION, PAPERCLIP_EXECUTION_PROMPT);
    expect(parseNativeRuntimeContext(current)).toEqual(current);
  });

  it.each(["revision", "text"])("requires a non-empty prompt %s", (field) => {
    const persisted = savedContext("saved-prompt", "Saved instructions.");
    for (const value of [undefined, null, 42, {}, "", " \n"]) {
      expect(() => parseNativeRuntimeContext({
        ...persisted,
        prompt: { ...persisted.prompt, [field]: value },
      })).toThrow(`input.runtimeContext.prompt.${field} must be a non-empty string`);
    }
  });

  it("rejects altered text and malformed or mismatched prompt hashes", () => {
    const persisted = savedContext("saved-prompt", "Saved instructions.");
    expect(() => parseNativeRuntimeContext({
      ...persisted, prompt: { ...persisted.prompt, text: "Changed instructions." },
    })).toThrow("prompt.digest does not match prompt text");
    for (const digest of [undefined, null, "", "not-a-hash", "f".repeat(64)]) {
      expect(() => parseNativeRuntimeContext({
        ...persisted, prompt: { ...persisted.prompt, digest },
      })).toThrow("input.runtimeContext.prompt.digest");
    }
  });

  it("rejects a prompt change with a matching text hash but a stale aggregate digest", () => {
    const persisted = savedContext("saved-prompt", "Saved instructions.");
    const changed = savedContext("changed-prompt", "Changed instructions.");
    expect(() => parseNativeRuntimeContext({
      ...persisted, prompt: changed.prompt,
    })).toThrow("aggregateDigest does not match the canonical context");
  });

  it("includes the saved revision in the aggregate digest", () => {
    const persisted = savedContext("saved-prompt", "Saved instructions.");
    expect(() => parseNativeRuntimeContext({
      ...persisted, prompt: { ...persisted.prompt, revision: "changed-revision" },
    })).toThrow("aggregateDigest does not match the canonical context");
  });

  it("rejects aggregate context drift", () => {
    const persisted = savedContext("saved-prompt", "Saved instructions.");
    expect(() => parseNativeRuntimeContext({
      ...persisted, aggregateDigest: "f".repeat(64),
    })).toThrow("aggregateDigest does not match the canonical context");
  });
});
