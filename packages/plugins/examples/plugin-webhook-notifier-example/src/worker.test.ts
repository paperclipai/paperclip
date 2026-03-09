import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";

describe("webhook-notifier plugin", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({
      manifest,
      config: {
        webhookSecretRef: "webhook-url-ref",
        signingSecretRef: "signing-key-ref",
      },
    });

    // Mock ctx.http.fetch to avoid real HTTP calls
    vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response("ok", { status: 200 })
    );

    await plugin.definition.setup(harness.ctx);
  });

  it("sends a webhook on agent.run.finished", async () => {
    await harness.emit("agent.run.finished", {}, { entityId: "run-123", companyId: "co-1" });

    expect(harness.ctx.http.fetch).toHaveBeenCalledOnce();
    const [url, init] = (harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

    // URL is the resolved secret ref
    expect(url).toBe("resolved:webhook-url-ref");

    // Body is structured JSON
    const body = JSON.parse(init.body as string);
    expect(body.event).toBe("agent.run.finished");
    expect(body.companyId).toBe("co-1");
    expect(body.data.entityId).toBe("run-123");

    // Headers include signing and user-agent
    expect(init.headers["User-Agent"]).toBe("Paperclip-Webhooks/1.0");
    expect(init.headers["X-Paperclip-Signature"]).toMatch(/^sha256=[a-f0-9]{64}$/);
  });

  it("logs activity after agent.run.finished", async () => {
    await harness.emit("agent.run.finished", {}, { entityId: "run-456", companyId: "co-1" });

    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0].message).toContain("run-456");
    expect(harness.activity[0].entityType).toBe("run");
  });

  it("increments sent metric on success", async () => {
    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const sentMetrics = harness.metrics.filter((m) => m.name === "webhook_notifications_sent");
    expect(sentMetrics).toHaveLength(1);
    expect(sentMetrics[0].value).toBe(1);
  });

  it("increments failure metric on HTTP error", async () => {
    vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response("Internal Server Error", { status: 500 })
    );

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const failMetrics = harness.metrics.filter((m) => m.name === "webhook_notification_failures");
    expect(failMetrics).toHaveLength(1);
  });

  it("skips events not in allowlist", async () => {
    harness.setConfig({
      webhookSecretRef: "webhook-url-ref",
      eventAllowlist: ["agent.run.failed"],
    });

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    expect(harness.ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("sends all events when allowlist is empty", async () => {
    harness.setConfig({
      webhookSecretRef: "webhook-url-ref",
      eventAllowlist: [],
    });

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });
    await harness.emit("issue.created", {}, { entityId: "issue-1" });

    expect(harness.ctx.http.fetch).toHaveBeenCalledTimes(2);
  });

  it("sends without signature when signingSecretRef is empty", async () => {
    harness.setConfig({
      webhookSecretRef: "webhook-url-ref",
    });

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const [, init] = (harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(init.headers["X-Paperclip-Signature"]).toBeUndefined();
  });

  it("skips delivery when webhookSecretRef is missing", async () => {
    harness.setConfig({});

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    expect(harness.ctx.http.fetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("persists state on issue.comment.created", async () => {
    const now = new Date().toISOString();
    await harness.emit("issue.comment.created", {}, { entityId: "issue-99", occurredAt: now });

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "issue-99",
      stateKey: "last_webhook_event",
    });
    expect(state).toBe(now);
  });

  it("validates config requires webhookSecretRef", async () => {
    const invalid = await plugin.definition.onValidateConfig!({});
    expect(invalid.ok).toBe(false);
    expect(invalid.errors).toContain("webhookSecretRef is required");

    const valid = await plugin.definition.onValidateConfig!({ webhookSecretRef: "ref" });
    expect(valid.ok).toBe(true);
  });

  it("reports healthy", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});
