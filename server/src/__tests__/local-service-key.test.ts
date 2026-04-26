import { describe, it, expect } from "vitest";
import { createLocalServiceKey } from "../services/local-service-supervisor.js";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_INPUT = {
  profileKind: "codex",
  serviceName: "web",
  cwd: "/home/user/projects/app",
  command: "npm start",
  envFingerprint: "abc123",
  port: 3000,
  scope: null,
};

// ---------------------------------------------------------------------------
// createLocalServiceKey
// ---------------------------------------------------------------------------

describe("createLocalServiceKey", () => {
  it("returns a non-empty string", () => {
    const key = createLocalServiceKey(BASE_INPUT);
    expect(key).toBeTruthy();
    expect(typeof key).toBe("string");
  });

  it("returns the same key for identical inputs", () => {
    const key1 = createLocalServiceKey(BASE_INPUT);
    const key2 = createLocalServiceKey(BASE_INPUT);
    expect(key1).toBe(key2);
  });

  it("returns different keys for different cwds", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, cwd: "/home/user/projects/app-a" });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, cwd: "/home/user/projects/app-b" });
    expect(key1).not.toBe(key2);
  });

  it("returns different keys for different commands", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, command: "npm start" });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, command: "pnpm dev" });
    expect(key1).not.toBe(key2);
  });

  it("returns different keys for different profileKinds", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, profileKind: "codex" });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, profileKind: "cursor" });
    expect(key1).not.toBe(key2);
  });

  it("returns different keys for different serviceNames", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, serviceName: "web" });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, serviceName: "api" });
    expect(key1).not.toBe(key2);
  });

  it("returns different keys for different ports", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, port: 3000 });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, port: 4000 });
    expect(key1).not.toBe(key2);
  });

  it("returns different keys for different envFingerprints", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, envFingerprint: "abc" });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, envFingerprint: "def" });
    expect(key1).not.toBe(key2);
  });

  it("starts with the sanitized profileKind", () => {
    const key = createLocalServiceKey({ ...BASE_INPUT, profileKind: "codex-local" });
    expect(key.startsWith("codex-local-")).toBe(true);
  });

  it("sanitizes uppercase profileKind to lowercase", () => {
    const key = createLocalServiceKey({ ...BASE_INPUT, profileKind: "Codex" });
    expect(key.startsWith("codex-")).toBe(true);
  });

  it("sanitizes special characters in profileKind to dashes", () => {
    const key = createLocalServiceKey({ ...BASE_INPUT, profileKind: "my@adapter!" });
    expect(key.startsWith("my-adapter-")).toBe(true);
  });

  it("uses 'service' fallback when profileKind is empty after sanitization", () => {
    const key = createLocalServiceKey({ ...BASE_INPUT, profileKind: "---" });
    expect(key.startsWith("service-")).toBe(true);
  });

  it("includes sanitized serviceName after the profileKind prefix", () => {
    const key = createLocalServiceKey({ ...BASE_INPUT, profileKind: "codex", serviceName: "my-web-server" });
    expect(key.startsWith("codex-my-web-server-")).toBe(true);
  });

  it("key format is profileKind-serviceName-{24hexchars}", () => {
    const key = createLocalServiceKey(BASE_INPUT);
    // Should end with 24 lowercase hex characters
    const parts = key.split("-");
    const hexSuffix = parts[parts.length - 1];
    expect(hexSuffix).toMatch(/^[0-9a-f]{24}$/);
  });

  it("handles null port consistently", () => {
    const keyNull = createLocalServiceKey({ ...BASE_INPUT, port: null });
    const keyWithPort = createLocalServiceKey({ ...BASE_INPUT, port: 8080 });
    expect(keyNull).not.toBe(keyWithPort);
  });

  it("handles scope object consistently", () => {
    const keyNullScope = createLocalServiceKey({ ...BASE_INPUT, scope: null });
    const keyWithScope = createLocalServiceKey({ ...BASE_INPUT, scope: { projectId: "proj-123" } });
    expect(keyNullScope).not.toBe(keyWithScope);
  });

  it("returns same key regardless of scope object property order", () => {
    const key1 = createLocalServiceKey({ ...BASE_INPUT, scope: { a: 1, b: 2 } });
    const key2 = createLocalServiceKey({ ...BASE_INPUT, scope: { b: 2, a: 1 } });
    expect(key1).toBe(key2);
  });
});
