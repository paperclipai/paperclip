import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { ToolDefinition } from "@paperclipai/mcp-server";
import { dispatchToolCall, stringifyToolResult } from "./tool-dispatch.js";

function makeFakeTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  const schema = (overrides.schema ?? z.object({ x: z.number() })) as z.AnyZodObject;
  return {
    name: overrides.name ?? "fakeTool",
    description: overrides.description ?? "fake tool",
    schema,
    execute:
      overrides.execute ??
      (async (input: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: JSON.stringify({ echoed: input }) }],
      })),
  };
}

describe("dispatchToolCall", () => {
  it("returns ok=false unknown_tool when name is not in the map", async () => {
    const result = await dispatchToolCall({
      toolsByName: new Map(),
      call: { id: "call_1", type: "function", function: { name: "doesNotExist", arguments: "{}" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("unknown_tool");
      expect(result.message).toContain("doesNotExist");
    }
  });

  it("returns ok=false bad_arguments when JSON is malformed", async () => {
    const tool = makeFakeTool();
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: "{ not json" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_arguments");
    }
  });

  it("returns ok=false bad_arguments when arguments are an array (not an object)", async () => {
    const tool = makeFakeTool();
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: "[1,2,3]" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("bad_arguments");
    }
  });

  it("returns ok=true with unwrapped output on success", async () => {
    const tool = makeFakeTool({
      execute: async (input) => ({ content: [{ type: "text" as const, text: JSON.stringify({ greeting: `hi ${input.name}` }) }] }),
    });
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: '{"name":"world"}' } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.output).toEqual({ greeting: "hi world" });
      expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
    }
  });

  it("returns ok=false tool_threw when the tool function throws", async () => {
    const tool = makeFakeTool({
      execute: async () => {
        throw new Error("boom");
      },
    });
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: "{}" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tool_threw");
      expect(result.message).toBe("boom");
    }
  });

  it("recognizes formatErrorResponse-shaped tool returns and surfaces them as tool_threw", async () => {
    const tool = makeFakeTool({
      execute: async () => ({
        content: [{ type: "text" as const, text: JSON.stringify({ error: { message: "api 404", status: 404 } }) }],
      }),
    });
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: "{}" } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe("tool_threw");
      expect(result.message).toBe("api 404");
    }
  });

  it("treats empty arguments string as an empty object (not an error)", async () => {
    const tool = makeFakeTool({
      schema: z.object({}),
      execute: async () => ({ content: [{ type: "text" as const, text: JSON.stringify({ ok: 1 }) }] }),
    });
    const result = await dispatchToolCall({
      toolsByName: new Map([[tool.name, tool]]),
      call: { id: "call_1", type: "function", function: { name: "fakeTool", arguments: "" } },
    });
    expect(result.ok).toBe(true);
  });
});

describe("stringifyToolResult", () => {
  it("encodes ok=true with output payload", () => {
    const json = JSON.parse(stringifyToolResult({ ok: true, output: { foo: "bar" }, elapsedMs: 42 }));
    expect(json).toEqual({ ok: true, output: { foo: "bar" } });
  });

  it("encodes ok=false with structured error", () => {
    const json = JSON.parse(
      stringifyToolResult({ ok: false, code: "bad_arguments", message: "nope", elapsedMs: 1 }),
    );
    expect(json).toEqual({ ok: false, error: { code: "bad_arguments", message: "nope" } });
  });

  it("includes detail when present", () => {
    const json = JSON.parse(
      stringifyToolResult({
        ok: false,
        code: "tool_threw",
        message: "API failed",
        detail: { status: 500 },
        elapsedMs: 1,
      }),
    );
    expect(json.error.detail).toEqual({ status: 500 });
  });
});
