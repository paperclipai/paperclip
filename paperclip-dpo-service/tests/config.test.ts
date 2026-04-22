import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";

describe("loadConfig", () => {
  it("reads env vars with defaults", () => {
    const cfg = loadConfig({
      DPO_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    });
    expect(cfg.port).toBe(4711);
    expect(cfg.bind).toBe("0.0.0.0");
    expect(cfg.sharedKey).toBe("secret-key-32-bytes-min-length-padding-more");
    expect(cfg.classifier.url).toBe("http://localhost:1234");
    expect(cfg.classifier.model).toBe("gemma-4-26b");
    expect(cfg.classifier.timeoutMs).toBe(30000);
    expect(cfg.telegram).toBeUndefined();
  });

  it("includes telegram when both env vars set", () => {
    const cfg = loadConfig({
      DPO_SHARED_KEY: "secret-key-32-bytes-min-length-padding-more",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
      DPO_TELEGRAM_BOT_TOKEN: "bot-token",
      DPO_TELEGRAM_CHAT_ID: "12345",
    });
    expect(cfg.telegram).toEqual({ botToken: "bot-token", chatId: "12345" });
  });

  it("rejects short shared key", () => {
    expect(() => loadConfig({
      DPO_SHARED_KEY: "short",
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    })).toThrow(/DPO_SHARED_KEY/);
  });

  it("rejects missing shared key", () => {
    expect(() => loadConfig({
      DPO_MAPPING_DB: "/tmp/m.db",
      DPO_AUDIT_DIR: "/tmp/audit",
    })).toThrow();
  });
});
