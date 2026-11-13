import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/config.js";
import { BASE_CONFIG } from "./fixtures.js";

describe("config validation", () => {
  it("accepts a minimal config and applies defaults", () => {
    const result = parseConfig(BASE_CONFIG);
    expect(result).toEqual({
      ok: true,
      config: {
        ntfyBaseUrl: "https://ntfy.example.test",
        topic: "decisions",
        tokenSecretRef: BASE_CONFIG.tokenSecretRef,
        paperclipBaseUrl: "https://paperclip.example.test",
        priority: null,
        allowInsecureHttp: false,
        triggers: { approvals: true, interactions: true, blockerAttention: true, decisions: true },
      },
    });
  });

  it("normalises trailing slashes", () => {
    const result = parseConfig({ ...BASE_CONFIG, ntfyBaseUrl: "https://ntfy.example.test/", paperclipBaseUrl: "https://paperclip.example.test/app/" });
    expect(result.ok && result.config.ntfyBaseUrl).toBe("https://ntfy.example.test");
    expect(result.ok && result.config.paperclipBaseUrl).toBe("https://paperclip.example.test/app");
  });

  it.each([
    [{ ...BASE_CONFIG, ntfyBaseUrl: undefined }, "ntfyBaseUrl is required"],
    [{ ...BASE_CONFIG, ntfyBaseUrl: "ntfy.example.test" }, "absolute URL"],
    [{ ...BASE_CONFIG, ntfyBaseUrl: "http://ntfy.example.test" }, "must use https"],
    [{ ...BASE_CONFIG, ntfyBaseUrl: "ftp://ntfy.example.test" }, "must use https"],
    [{ ...BASE_CONFIG, ntfyBaseUrl: "https://u:p@ntfy.example.test" }, "credentials"],
    [{ ...BASE_CONFIG, ntfyBaseUrl: "https://ntfy.example.test/?auth=x" }, "query or fragment"],
    [{ ...BASE_CONFIG, paperclipBaseUrl: "" }, "paperclipBaseUrl is required"],
    [{ ...BASE_CONFIG, topic: "" }, "topic is required"],
    [{ ...BASE_CONFIG, topic: "a/b" }, "topic is required"],
    [{ ...BASE_CONFIG, topic: "x".repeat(65) }, "topic is required"],
    [{ ...BASE_CONFIG, tokenSecretRef: "plain-token-value" }, "secret reference"],
    [{ ...BASE_CONFIG, tokenSecretRef: { type: "secret_ref" } }, "secret reference"],
    [{ ...BASE_CONFIG, tokenSecretRef: { type: "secret_ref", secretId: "x", extra: 1 } }, 'unknown key "extra"'],
    [{ ...BASE_CONFIG, priority: 0 }, "priority"],
    [{ ...BASE_CONFIG, priority: 6 }, "priority"],
    [{ ...BASE_CONFIG, priority: "high" }, "priority"],
    [{ ...BASE_CONFIG, priority: 2.5 }, "priority"],
    [{ ...BASE_CONFIG, topik: "decisions" }, 'unknown config key "topik"'],
    [{ ...BASE_CONFIG, triggers: { approval: true } }, 'triggers has unknown key "approval"'],
    [{ ...BASE_CONFIG, triggers: { approvals: "yes" } }, "triggers.approvals must be a boolean"],
    [{ ...BASE_CONFIG, triggers: [] }, "triggers must be an object"],
    [{ ...BASE_CONFIG, allowInsecureHttp: "true" }, "allowInsecureHttp must be a boolean"],
  ])("rejects %j", (config, message) => {
    const result = parseConfig(config);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.join("\n")).toContain(message);
  });

  it("rejects non-object config", () => {
    expect(parseConfig(null).ok).toBe(false);
    expect(parseConfig([]).ok).toBe(false);
  });

  it("allows http only with the explicit local-testing flag", () => {
    const result = parseConfig({ ...BASE_CONFIG, ntfyBaseUrl: "http://127.0.0.1:8080", allowInsecureHttp: true });
    expect(result.ok && result.config.ntfyBaseUrl).toBe("http://127.0.0.1:8080");
  });

  it("treats an empty token ref as an open topic", () => {
    const result = parseConfig({ ...BASE_CONFIG, tokenSecretRef: null });
    expect(result.ok && result.config.tokenSecretRef).toBeNull();
  });
});
