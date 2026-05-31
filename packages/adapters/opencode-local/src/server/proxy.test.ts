import { describe, expect, it } from "vitest";
import { maybePatchSseBody, maybePatchJsonBody, needsBashDescriptionPatch, reconstructSse } from "./proxy.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Parse the tool-call arguments from the first bash tool call in an SSE body. */
function extractBashArgs(sseBody: string): Record<string, unknown> | null {
  for (const line of sseBody.split(/\r?\n/)) {
    if (!line.startsWith("data: ") || line === "data: [DONE]") continue;
    const chunk = JSON.parse(line.slice(6)) as Record<string, unknown>;
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const choice of choices as Array<Record<string, unknown>>) {
      const delta = typeof choice.delta === "object" && choice.delta !== null
        ? choice.delta as Record<string, unknown>
        : {};
      const tcs = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const tc of tcs as Array<Record<string, unknown>>) {
        const fn = typeof tc.function === "object" && tc.function !== null
          ? tc.function as Record<string, unknown>
          : {};
        if (typeof fn.arguments === "string") {
          return JSON.parse(fn.arguments) as Record<string, unknown>;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStreamLine(data: unknown): string {
  return `data: ${JSON.stringify(data)}`;
}

const BASE = { id: "chatcmpl-1", object: "chat.completion.chunk", created: 1000, model: "qwen3:30b-a3b" };

function buildSse(lines: string[]): string {
  return lines.join("\n\n") + "\n\ndata: [DONE]\n\n";
}

// ---------------------------------------------------------------------------
// maybePatchSseBody — passthrough when description is present
// ---------------------------------------------------------------------------

describe("maybePatchSseBody", () => {
  it("returns original SSE unchanged when bash description is already present", () => {
    const sseBody = buildSse([
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"pwd","description":"print cwd"}' } }] }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    expect(maybePatchSseBody(sseBody)).toBe(sseBody);
  });

  it("injects description:'' when bash tool call is missing it", () => {
    const sseBody = buildSse([
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "bash", arguments: "" } }] }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command":"ls -la"}' } }] }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const patched = maybePatchSseBody(sseBody);
    expect(patched).not.toBe(sseBody);
    expect(patched).toContain("data: [DONE]");
    // Parse the reconstructed SSE to verify the arguments are correctly patched
    const args = extractBashArgs(patched);
    expect(args).not.toBeNull();
    expect(args!.description).toBe("");
    expect(args!.command).toBe("ls -la");
  });

  it("does not patch non-bash tool calls", () => {
    const sseBody = buildSse([
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"/tmp/foo"}' } }] }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    expect(maybePatchSseBody(sseBody)).toBe(sseBody);
  });

  it("handles fragmented argument streams (name in one chunk, args in another)", () => {
    const sseBody = buildSse([
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "ba" } }] } }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { name: "sh" } }] } }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"command' } }] } }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '":"pwd"}' } }] } }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }),
    ]);
    const patched = maybePatchSseBody(sseBody);
    const args = extractBashArgs(patched);
    expect(args).not.toBeNull();
    expect(args!.description).toBe("");
    expect(args!.command).toBe("pwd");
  });

  it("returns original when SSE has no tool calls", () => {
    const sseBody = buildSse([
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: { role: "assistant", content: "hello" }, finish_reason: null }] }),
      makeStreamLine({ ...BASE, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
    ]);
    expect(maybePatchSseBody(sseBody)).toBe(sseBody);
  });
});

// ---------------------------------------------------------------------------
// maybePatchJsonBody — non-streaming completions
// ---------------------------------------------------------------------------

describe("maybePatchJsonBody", () => {
  it("injects description in non-streaming bash tool call", () => {
    const body = JSON.stringify({
      id: "chatcmpl-1",
      choices: [{
        message: {
          role: "assistant",
          tool_calls: [{
            id: "c1", type: "function",
            function: { name: "bash", arguments: '{"command":"echo hi"}' },
          }],
        },
      }],
    });
    const patched = maybePatchJsonBody(body);
    const parsed = JSON.parse(patched) as { choices: Array<{ message: { tool_calls: Array<{ function: { arguments: string } }> } }> };
    const args = JSON.parse(parsed.choices[0].message.tool_calls[0].function.arguments) as Record<string, unknown>;
    expect(args.description).toBe("");
    expect(args.command).toBe("echo hi");
  });

  it("leaves non-bash tool calls untouched", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: { name: "glob", arguments: '{"pattern":"*.ts"}' },
          }],
        },
      }],
    });
    expect(maybePatchJsonBody(body)).toBe(body);
  });

  it("returns original when description is already present", () => {
    const body = JSON.stringify({
      choices: [{
        message: {
          tool_calls: [{
            function: { name: "bash", arguments: '{"command":"ls","description":"list files"}' },
          }],
        },
      }],
    });
    expect(maybePatchJsonBody(body)).toBe(body);
  });

  it("returns original on invalid JSON", () => {
    const body = "not json";
    expect(maybePatchJsonBody(body)).toBe(body);
  });
});

// ---------------------------------------------------------------------------
// needsBashDescriptionPatch
// ---------------------------------------------------------------------------

describe("needsBashDescriptionPatch", () => {
  it("returns true when bash is missing description", () => {
    const tc = new Map([[0, { id: "", type: "function", name: "bash", args: '{"command":"pwd"}' }]]);
    expect(needsBashDescriptionPatch(tc)).toBe(true);
  });

  it("returns false when bash has description", () => {
    const tc = new Map([[0, { id: "", type: "function", name: "bash", args: '{"command":"pwd","description":"x"}' }]]);
    expect(needsBashDescriptionPatch(tc)).toBe(false);
  });

  it("returns false for non-bash tools", () => {
    const tc = new Map([[0, { id: "", type: "function", name: "read_file", args: '{"path":"/tmp/x"}' }]]);
    expect(needsBashDescriptionPatch(tc)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// reconstructSse — output structure
// ---------------------------------------------------------------------------

describe("reconstructSse", () => {
  it("produces a valid SSE stream with patched tool call", () => {
    const toolCalls = new Map([[
      0,
      { id: "c1", type: "function", name: "bash", args: '{"command":"pwd","description":""}' },
    ]]);
    const result = reconstructSse("data: " + JSON.stringify(BASE), toolCalls);
    expect(result).toContain("data: [DONE]");
    expect(result).toContain('"finish_reason":"tool_calls"');
    // Ends with proper SSE double-newline
    expect(result.endsWith("\n\n")).toBe(true);
    // Parse and verify the arguments are correct
    const args = extractBashArgs(result);
    expect(args).not.toBeNull();
    expect(args!.command).toBe("pwd");
    expect(args!.description).toBe("");
  });
});
