import { describe, expect, it } from "vitest";
import { llmConfigSchema, paperclipConfigSchema } from "./config-schema.js";

describe("paperclip config schema", () => {
  it("defaults omitted runtime paths to legacy instance-root locations", () => {
    const parsed = paperclipConfigSchema.parse({
      $meta: {
        version: 1,
        updatedAt: "2026-05-10T00:00:00.000Z",
        source: "configure",
      },
      database: {
        mode: "embedded-postgres",
      },
      logging: {
        mode: "file",
      },
      server: {},
    });

    expect(parsed.database.embeddedPostgresDataDir).toBe("~/.paperclip/instances/default/db");
    expect(parsed.database.backup.dir).toBe("~/.paperclip/instances/default/data/backups");
    expect(parsed.logging.logDir).toBe("~/.paperclip/instances/default/logs");
    expect(parsed.storage.localDisk.baseDir).toBe("~/.paperclip/instances/default/data/storage");
    expect(parsed.secrets.localEncrypted.keyFilePath).toBe("~/.paperclip/instances/default/secrets/master.key");
  });

  it("accepts an OpenAI-compatible llm baseUrl", () => {
    const parsed = llmConfigSchema.parse({
      provider: "openai",
      apiKey: "sk-test",
      baseUrl: "http://localhost:11434/v1",
    });
    expect(parsed.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("treats llm baseUrl as optional", () => {
    const parsed = llmConfigSchema.parse({ provider: "openai", apiKey: "sk-test" });
    expect(parsed.baseUrl).toBeUndefined();
  });

  it("rejects a non-URL llm baseUrl", () => {
    expect(() =>
      llmConfigSchema.parse({ provider: "openai", apiKey: "sk-test", baseUrl: "not-a-url" }),
    ).toThrow();
  });
});
