import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hydrateLiteLlmApiKey } from "./auth.js";

describe("hydrateLiteLlmApiKey", () => {
  it("reuses an existing LITELLM_API_KEY", async () => {
    const result = await hydrateLiteLlmApiKey({
      LITELLM_API_KEY: "litellm-key",
      OPENAI_API_KEY: "openai-key",
    });

    expect(result.source).toBe("existing_litellm_env");
    expect(result.env.LITELLM_API_KEY).toBe("litellm-key");
  });

  it("copies OPENAI_API_KEY when LITELLM_API_KEY is absent", async () => {
    const result = await hydrateLiteLlmApiKey({
      OPENAI_API_KEY: "openai-key",
    });

    expect(result.source).toBe("openai_env");
    expect(result.env.LITELLM_API_KEY).toBe("openai-key");
  });

  it("loads the key from OpenCode auth storage when env keys are absent", async () => {
    const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-opencode-auth-home-"));
    const authPath = path.join(homeDir, ".local", "share", "opencode", "auth.json");

    try {
      await fs.mkdir(path.dirname(authPath), { recursive: true });
      await fs.writeFile(
        authPath,
        JSON.stringify({
          litellm: {
            type: "api-key",
            key: "auth-store-key",
          },
        }),
        "utf8",
      );

      const result = await hydrateLiteLlmApiKey({}, { homeDir });
      expect(result.source).toBe("opencode_auth");
      expect(result.env.LITELLM_API_KEY).toBe("auth-store-key");
    } finally {
      await fs.rm(homeDir, { recursive: true, force: true });
    }
  });
});
