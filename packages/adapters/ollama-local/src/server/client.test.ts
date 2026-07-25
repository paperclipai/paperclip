import { describe, expect, it } from "vitest";
import {
  buildChatEndpoint,
  classifyOllamaFailure,
  parseSseEvents,
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
