import { describe, expect, it } from "vitest";
import {
  stripPaperclipRuntimeEnvBindings,
  stripPaperclipRuntimeEnvFromAdapterConfig,
} from "../services/runtime-env.ts";

describe("runtime-env sanitizer", () => {
  it("removes PAPERCLIP_* keys from env bindings", () => {
    expect(
      stripPaperclipRuntimeEnvBindings({
        PAPERCLIP_API_KEY: "spoofed",
        PAPERCLIP_RUN_ID: "spoofed-run",
        OPENAI_API_KEY: "real",
        APP_MODE: "prod",
      }),
    ).toEqual({
      OPENAI_API_KEY: "real",
      APP_MODE: "prod",
    });
  });

  it("returns null when all bindings are runtime-owned", () => {
    expect(
      stripPaperclipRuntimeEnvBindings({
        PAPERCLIP_API_KEY: "spoofed",
      }),
    ).toBeNull();
  });

  it("sanitizes adapter config env without mutating unrelated keys", () => {
    const input = {
      command: "codex",
      env: {
        PAPERCLIP_API_KEY: "spoofed",
        MODEL: "gpt-5",
      },
      other: { keep: true },
    };

    expect(stripPaperclipRuntimeEnvFromAdapterConfig(input)).toEqual({
      command: "codex",
      env: {
        MODEL: "gpt-5",
      },
      other: { keep: true },
    });
    expect(input.env).toEqual({
      PAPERCLIP_API_KEY: "spoofed",
      MODEL: "gpt-5",
    });
  });
});
