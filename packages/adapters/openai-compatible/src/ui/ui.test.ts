import { describe, expect, it } from "vitest";
import type { CreateConfigValues } from "@paperclipai/adapter-utils";
import { buildOpenAiCompatibleConfig } from "./build-config.js";
import { parseOpenAiCompatibleStdoutLine } from "./parse-stdout.js";

const ts = "2026-10-07T00:00:00.000Z";

describe("parseOpenAiCompatibleStdoutLine", () => {
  it("maps adapter events to transcript entries", () => {
    const line = (event: Record<string, unknown>) => parseOpenAiCompatibleStdoutLine(JSON.stringify(event), ts);
    expect(line({ type: "openai_compatible.init", sessionId: "s", model: "m" })).toEqual([
      { kind: "init", ts, model: "m", sessionId: "s" },
    ]);
    expect(line({ type: "openai_compatible.assistant", text: "Hi" })).toEqual([{ kind: "assistant", ts, text: "Hi" }]);
    expect(line({ type: "openai_compatible.thinking", text: "hmm" })).toEqual([{ kind: "thinking", ts, text: "hmm" }]);
    expect(line({ type: "openai_compatible.tool_call", id: "c1", name: "load_skill", input: { name: "paperclip" } })).toEqual([
      { kind: "tool_call", ts, name: "load_skill", toolUseId: "c1", input: { name: "paperclip" } },
    ]);
    expect(line({ type: "openai_compatible.tool_result", id: "c1", name: "load_skill", content: "x", isError: false })).toEqual([
      { kind: "tool_result", ts, toolUseId: "c1", toolName: "load_skill", content: "x", isError: false },
    ]);
    expect(line({
      type: "openai_compatible.result",
      status: "max_turns",
      text: "",
      usage: { inputTokens: 3, outputTokens: 2, cachedInputTokens: 1 },
      error: "Reached maxTurns (2)",
    })).toEqual([{
      kind: "result",
      ts,
      text: "",
      inputTokens: 3,
      outputTokens: 2,
      cachedTokens: 1,
      costUsd: 0,
      subtype: "max_turns",
      isError: true,
      errors: ["Reached maxTurns (2)"],
    }]);
    expect(parseOpenAiCompatibleStdoutLine("plain", ts)).toEqual([{ kind: "stdout", ts, text: "plain" }]);
  });
});

describe("buildOpenAiCompatibleConfig", () => {
  it("normalizes the API URL and keeps the key as an env binding", () => {
    const config = buildOpenAiCompatibleConfig({
      adapterType: "openai_compatible",
      model: " provider/model ",
      promptTemplate: "",
      instructionsFilePath: "",
      bootstrapPrompt: "",
      envVars: "",
      envBindings: {
        OPENAI_COMPATIBLE_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" },
      },
      adapterSchemaValues: { apiUrl: "https://llm.example.com/v1/chat/completions", enableWorkspaceTools: true },
    } as unknown as CreateConfigValues);
    expect(config).toEqual({
      apiUrl: "https://llm.example.com/v1",
      enableWorkspaceTools: true,
      model: "provider/model",
      env: { OPENAI_COMPATIBLE_API_KEY: { type: "secret_ref", secretId: "secret-1", version: "latest" } },
    });
  });
});
