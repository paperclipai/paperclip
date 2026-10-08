import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { HISTORICAL_PAPERCLIP_EXECUTION_PROMPTS } from "./execution-prompt-history.js";
import {
  NATIVE_RUNTIME_ASSET_SCHEMA,
  PAPERCLIP_EXECUTION_PROMPT,
  PAPERCLIP_EXECUTION_PROMPT_REVISION,
  canonicalNativeRuntimeContextDigest,
  composeNativeSystemInstructions,
  parseNativeRuntimeContext,
} from "./runtime-context.js";

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const historicalDigests = {
  "paperclip-execution.v1": "a5c04f5348b87b263107ba2086aebe27bc0ffba6f39eeba3a2498655e41896ae",
  "paperclip-execution.v2": "155cc542689877833af26658e617224cb06f95676dfc408e737c94ca3ecbd413",
  "paperclip-execution.v3": "9d1564ec6c745a5bc96bb3239bccba44aa0cf89dfdc87c384ec20fd5b85e89fa",
  "paperclip-execution.v4": "2584948928abc6fdf662ffb46d893a76d63dd536e06ec13226c566e89dd4de2b",
  "paperclip-execution.v5": "bec3e633d8d828103ce50b3a8b8dc9991c8ef65e07538bdab1a7663957c2ef9b",
} as const;

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
  it("retains every released historical revision", () => {
    expect(Object.keys(HISTORICAL_PAPERCLIP_EXECUTION_PROMPTS)).toEqual(Object.keys(historicalDigests));
  });

  it.each(Object.entries(HISTORICAL_PAPERCLIP_EXECUTION_PROMPTS))(
    "recovers %s without rewriting its pinned context or system instructions",
    (revision, text) => {
      expect(hash(text)).toBe(historicalDigests[revision as keyof typeof historicalDigests]);
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

  it.each(["paperclip-execution.v0", "paperclip-execution.v999", "__proto__", "constructor"])(
    "rejects unknown revision %s even with a matching text hash",
    (revision) => {
      expect(() => parseNativeRuntimeContext(savedContext(revision, PAPERCLIP_EXECUTION_PROMPT))).toThrow("fixed Paperclip prompt revision");
    },
  );

  it.each(Object.entries(HISTORICAL_PAPERCLIP_EXECUTION_PROMPTS))(
    "rejects tampered text and hashes for %s",
    (revision, text) => {
      expect(() => parseNativeRuntimeContext(savedContext(revision, `${text} Extra instructions`))).toThrow("fixed Paperclip prompt revision");
      expect(() => parseNativeRuntimeContext(savedContext(revision, PAPERCLIP_EXECUTION_PROMPT))).toThrow("fixed Paperclip prompt revision");
      const persisted = savedContext(revision, text);
      expect(() => parseNativeRuntimeContext({ ...persisted, prompt: { ...persisted.prompt, digest: hash(PAPERCLIP_EXECUTION_PROMPT) } })).toThrow("prompt.digest does not match prompt text");
      expect(() => parseNativeRuntimeContext({ ...persisted, aggregateDigest: "f".repeat(64) })).toThrow("aggregateDigest");
    },
  );
});
