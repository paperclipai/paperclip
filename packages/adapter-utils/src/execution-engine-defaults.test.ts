import { describe, expect, it } from "vitest";
import { parseExecutionEngineDefaults, resolveExecutionEngineDefault } from "./execution-engine-defaults.js";

describe("installation-wide execution engine defaults", () => {
  it("preserves ACP when unset", () => {
    expect(parseExecutionEngineDefaults(undefined)).toEqual({});
    expect(resolveExecutionEngineDefault("claude_local", {})).toBe("acp");
  });

  it("resolves each adapter independently", () => {
    const env = { PAPERCLIP_DEFAULT_EXECUTION_ENGINES: '{"claude_local":"cli","codex_local":"acp"}' };
    expect(resolveExecutionEngineDefault("claude_local", env)).toBe("cli");
    expect(resolveExecutionEngineDefault("codex_local", env)).toBe("acp");
    expect(resolveExecutionEngineDefault("gemini_local", env)).toBe("acp");
    expect(resolveExecutionEngineDefault("kimi_local", env)).toBe("acp");
  });

  it("accepts all advertised adapters", () => {
    const input = '{"claude_local":"cli","codex_local":"cli","gemini_local":"cli","kimi_local":"cli"}';
    expect(Object.keys(parseExecutionEngineDefaults(input))).toHaveLength(4);
  });

  it.each(["not json", "[]", "null", '{"claude_local":"auto"}', '{"unknown":"cli"}'])(
    "rejects invalid configuration: %s",
    (value) => {
      expect(() => parseExecutionEngineDefaults(value)).toThrow("PAPERCLIP_DEFAULT_EXECUTION_ENGINES");
    },
  );
});
