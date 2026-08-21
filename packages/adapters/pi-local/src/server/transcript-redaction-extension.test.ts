import { afterEach, describe, expect, it } from "vitest";
import transcriptRedactionExtension, {
  collectTranscriptSecretValues,
} from "./transcript-redaction-extension.js";

const originalEnv = process.env;

afterEach(() => {
  process.env = originalEnv;
});

describe("Pi transcript redaction extension", () => {
  it("redacts runtime and granted secrets before a tool result is persisted", () => {
    const apiCanary = "canary-paperclip-api-key-value";
    const signingCanary = "canary-paperclip-signing-secret-value";
    const grantedCanary = "canary-granted-secret-value";
    process.env = {
      ...originalEnv,
      PAPERCLIP_API_KEY: apiCanary,
      PAPERCLIP_AGENT_JWT_SECRET: signingCanary,
      GRANTED_VALUE: grantedCanary,
      PAPERCLIP_TRANSCRIPT_SECRET_ENV_KEYS: JSON.stringify([
        "PAPERCLIP_API_KEY",
        "GRANTED_VALUE",
      ]),
    };

    let toolResultHandler:
      | ((event: { content: unknown; details?: unknown }) => { content: unknown; details?: unknown })
      | undefined;
    transcriptRedactionExtension({
      on: (_event, handler) => {
        toolResultHandler = handler;
      },
    });

    const controlledEnvOutput = [
      `PAPERCLIP_API_KEY=${apiCanary}`,
      `PAPERCLIP_AGENT_JWT_SECRET=${signingCanary}`,
      `GRANTED_VALUE=${grantedCanary}`,
      "SAFE_VALUE=visible",
    ].join("\n");
    const redacted = toolResultHandler?.({
      content: [{ type: "text", text: controlledEnvOutput }],
      details: { rawOutput: controlledEnvOutput },
    });
    const persistedSessionJsonl = `${JSON.stringify({
      type: "message",
      message: { role: "toolResult", ...redacted },
    })}\n`;

    expect(persistedSessionJsonl).toContain("***REDACTED***");
    expect(persistedSessionJsonl).toContain("SAFE_VALUE=visible");
    expect(persistedSessionJsonl).not.toContain(apiCanary);
    expect(persistedSessionJsonl).not.toContain(signingCanary);
    expect(persistedSessionJsonl).not.toContain(grantedCanary);
  });

  it("ignores empty and very short sensitive values", () => {
    const values = collectTranscriptSecretValues({
      EMPTY_TOKEN: "",
      SHORT_TOKEN: "abc",
      LONG_TOKEN: "long-canary-value",
    });

    expect(values).toEqual(["long-canary-value"]);
  });
});
