import { describe, expect, it } from "vitest";
import { validateDeclaredAdapterConfig } from "./adapter-config.js";

describe("native declaration adapter contracts", () => {
  it("accepts structured process arguments and environment credential bindings", () => {
    expect(() => validateDeclaredAdapterConfig("process", {
      command: "/run/current-system/sw/bin/worker", args: ["--once"], env: { MODE: "test" },
    }, { "env.WORKER_TOKEN": "worker" })).not.toThrow();
  });

  it("accepts structured HTTP and Hermes payloads without using form field types", () => {
    expect(() => validateDeclaredAdapterConfig("http", {
      url: "https://worker.example.test/invoke", headers: { Accept: "application/json" },
      payloadTemplate: { task: { labels: ["test"] } }, timeoutMs: 1000,
    }, {})).not.toThrow();
    expect(() => validateDeclaredAdapterConfig("hermes_gateway", {
      apiBaseUrl: "https://worker.example.test", headers: { "X-Worker": "test" },
      payloadTemplate: { instructions: "Follow the task" }, pollIntervalMs: 500,
    }, { apiKey: "gateway" })).not.toThrow();
  });

  it.each([
    ["process", { command: "worker", args: "--once" }, {}],
    ["process", { command: "worker", timeoutSec: -1 }, {}],
    ["http", { url: "file:///etc/passwd" }, {}],
    ["http", { url: "https://worker.test", timeoutSec: 10 }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test", apiKey: "inline-secret" }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test" }, {}],
    ["hermes_gateway", { apiBaseUrl: "https://worker.test" }, { instructions: "secret" }],
    ["process", { command: "worker", env: { WORKER_TOKEN: "inline" } }, { "env.WORKER_TOKEN": "worker" }],
    ["process", { command: "worker" }, { "env.NODE_OPTIONS": "worker" }],
    ["process", { command: "worker" }, { "env.PAPERCLIP_API_KEY": "worker" }],
    ["invented_remote", {}, {}],
  ] as const)("rejects unsupported, malformed, inline-secret or conflicting %s configuration", (type, config, credentials) => {
    expect(() => validateDeclaredAdapterConfig(type, config, credentials)).toThrow();
  });
});
