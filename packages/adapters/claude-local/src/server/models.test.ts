import { describe, expect, it } from "vitest";
import {
  DEFAULT_CLAUDE_MODELS,
  resolveClaudeModelsFromSettings,
} from "../models.js";

describe("claude model discovery", () => {
  it("falls back to built-in Claude models when no settings exist", () => {
    expect(resolveClaudeModelsFromSettings(null)).toEqual([
      { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
      { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
      { id: "claude-haiku-4-6", label: "Claude Haiku 4.6" },
      { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ]);
  });

  it("uses configured default family models from Claude settings env", () => {
    expect(
      resolveClaudeModelsFromSettings({
        model: "sonnet",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.5-plus",
          ANTHROPIC_DEFAULT_HAIKU_MODEL: "kimi-k2.5",
        },
      }),
    ).toEqual([
      { id: "qwen3.5-plus", label: "Claude Sonnet default (qwen3.5-plus)" },
      { id: "glm-5", label: "Claude Opus default (glm-5)" },
      { id: "kimi-k2.5", label: "Claude Haiku default (kimi-k2.5)" },
      { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
      { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
    ]);
  });

  it("prefers the configured top-level Claude model family when ordering models", () => {
    expect(
      resolveClaudeModelsFromSettings({
        model: "opus",
        env: {
          ANTHROPIC_DEFAULT_OPUS_MODEL: "glm-5",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "qwen3.5-plus",
        },
      }).map((entry) => entry.id),
    ).toEqual([
      "glm-5",
      "qwen3.5-plus",
      "claude-haiku-4-6",
      "claude-sonnet-4-5-20250929",
      "claude-haiku-4-5-20251001",
    ]);
  });
});