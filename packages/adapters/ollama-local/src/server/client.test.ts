import { describe, expect, it } from "vitest";
import {
  buildChatEndpoint,
  classifyOllamaFailure,
  parseSseEvents,
  readResponseBody,
} from "./client.js";

describe("ollama_local native client", () => {
  it("builds both supported Ollama HTTP surfaces without double-appending paths", () => {
    expect(buildChatEndpoint("http://127.0.0.1:11434", "openai")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    expect(buildChatEndpoint("http://127.0.0.1:11434/v1/", "openai")).toBe(
      "http://127.0.0.1:11434/v1/chat/completions",
    );
    expect(buildChatEndpoint("http://ollama:11434/", "ollama")).toBe(
      "http://ollama:11434/api/chat",
    );
  });

  it("assembles SSE delta events while ignoring keepalive lines", () => {
    expect(
      parseSseEvents(
        "data: {\"choices\":[{\"delta\":{\"content\":\"hel\"}}]}\n\n: keepalive\n\ndata: [DONE]\n\n",
      ),
    ).toEqual([
      { choices: [{ delta: { content: "hel" } }] },
      "[DONE]",
    ]);
  });

  it("assembles streamed tool calls independently by index", async () => {
    const chunks = [
      {
        choices: [{ delta: { tool_calls: [
          { index: 0, id: "call-0", type: "function", function: { name: "one", arguments: "{\"x\":" } },
          { index: 1, id: "call-1", type: "function", function: { name: "two", arguments: "{\"y\":" } },
        ] } }],
      },
      {
        choices: [{ delta: { tool_calls: [
          { index: 0, function: { arguments: "1}" } },
          { index: 1, function: { arguments: "2}" } },
        ] } }],
      },
    ];
    const response = new Response(
      chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("") +
      "data: [DONE]\n\n",
      { status: 200, headers: { "content-type": "text/event-stream" } },
    );

    const body = await readResponseBody(response, { stream: true });

    const choice = (body.choices as Array<{ message: unknown }>)[0];
    expect(choice.message).toEqual({
      role: "assistant",
      content: "",
      tool_calls: [
        { index: 0, id: "call-0", type: "function", function: { name: "one", arguments: "{\"x\":1}" } },
        { index: 1, id: "call-1", type: "function", function: { name: "two", arguments: "{\"y\":2}" } },
      ],
    });
  });

  it.each([
    [401, "auth", "transient_upstream"],
    [429, "quota", "provider_quota"],
    [503, "overload", "transient_upstream"],
    [408, "timeout", "transient_upstream"],
    [400, "model_refusal", "model_refusal"],
  ] as const)("classifies HTTP %s as %s", (status, errorCode, errorFamily) => {
    expect(classifyOllamaFailure(status, `status ${status}`)).toMatchObject({ errorCode, errorFamily });
  });
});
