import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestHarness, type TestHarness } from "@paperclipai/plugin-sdk";
import manifest from "./manifest.js";
import plugin from "./worker.js";

describe("discord-notifier plugin", () => {
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness({
      manifest,
      config: {
        webhookSecretRef: "discord-webhook-ref",
        username: "TestBot",
      },
    });

    vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response(null, { status: 204 })
    );

    await plugin.definition.setup(harness.ctx);
  });

  it("sends a Discord embed on agent.run.finished", async () => {
    await harness.emit("agent.run.finished", {}, { entityId: "run-123", companyId: "co-1" });

    expect(harness.ctx.http.fetch).toHaveBeenCalledOnce();
    const [url, init] = (harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls[0];

    expect(url).toBe("resolved:discord-webhook-ref");

    const body = JSON.parse(init.body as string);
    expect(body.username).toBe("TestBot");
    expect(body.embeds).toHaveLength(1);
    expect(body.embeds[0].title).toBe("Agent Run Finished");
    expect(body.embeds[0].color).toBe(0x2ecc71); // green
    expect(body.embeds[0].footer.text).toBe("Paperclip");
  });

  it("uses correct colors for different event types", async () => {
    const fetchSpy = harness.ctx.http.fetch as ReturnType<typeof vi.fn>;

    await harness.emit("agent.run.failed", {}, { entityId: "run-1" });
    const failBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(failBody.embeds[0].color).toBe(0xe74c3c); // red

    fetchSpy.mockClear();
    await harness.emit("approval.created", {}, {});
    const approvalBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(approvalBody.embeds[0].color).toBe(0xf1c40f); // yellow

    fetchSpy.mockClear();
    await harness.emit("agent.run.cancelled", {}, { entityId: "run-2" });
    const cancelBody = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(cancelBody.embeds[0].color).toBe(0x95a5a6); // gray
  });

  it("logs activity after agent.run.finished", async () => {
    await harness.emit("agent.run.finished", {}, { entityId: "run-456", companyId: "co-1" });

    expect(harness.activity).toHaveLength(1);
    expect(harness.activity[0].message).toContain("run-456");
    expect(harness.activity[0].message).toContain("Discord");
  });

  it("increments sent metric on success", async () => {
    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const sentMetrics = harness.metrics.filter((m) => m.name === "discord_notifications_sent");
    expect(sentMetrics).toHaveLength(1);
  });

  it("increments failure metric on HTTP error", async () => {
    vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response("Bad Request", { status: 400 })
    );

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const failMetrics = harness.metrics.filter((m) => m.name === "discord_notification_failures");
    expect(failMetrics).toHaveLength(1);
  });

  it("skips events not in allowlist", async () => {
    harness.setConfig({
      webhookSecretRef: "discord-webhook-ref",
      eventAllowlist: ["agent.run.failed"],
    });

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    expect(harness.ctx.http.fetch).not.toHaveBeenCalled();
  });

  it("skips delivery when webhookSecretRef is missing", async () => {
    harness.setConfig({});

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    expect(harness.ctx.http.fetch).not.toHaveBeenCalled();
    expect(harness.logs.some((l) => l.level === "warn")).toBe(true);
  });

  it("includes avatar_url when configured", async () => {
    harness.setConfig({
      webhookSecretRef: "discord-webhook-ref",
      avatarUrl: "https://example.com/avatar.png",
    });

    await harness.emit("agent.run.started", {}, { entityId: "run-1" });

    const body = JSON.parse(
      ((harness.ctx.http.fetch as ReturnType<typeof vi.fn>).mock.calls[0][1].body) as string
    );
    expect(body.avatar_url).toBe("https://example.com/avatar.png");
  });

  it("persists state on issue.comment.created", async () => {
    const now = new Date().toISOString();
    await harness.emit("issue.comment.created", {}, { entityId: "issue-42", occurredAt: now });

    const state = harness.getState({
      scopeKind: "issue",
      scopeId: "issue-42",
      stateKey: "last_discord_event",
    });
    expect(state).toBe(now);
  });

  it("validates config requires webhookSecretRef", async () => {
    const invalid = await plugin.definition.onValidateConfig!({});
    expect(invalid.ok).toBe(false);

    const valid = await plugin.definition.onValidateConfig!({ webhookSecretRef: "ref" });
    expect(valid.ok).toBe(true);
  });

  it("reports healthy", async () => {
    const health = await plugin.definition.onHealth!();
    expect(health.status).toBe("ok");
  });
});
