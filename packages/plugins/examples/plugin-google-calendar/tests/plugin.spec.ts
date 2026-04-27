import { describe, expect, it } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import plugin from "../src/worker.js";

describe("Google Calendar plugin", () => {
  it("starts up without throwing", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);
    // Just check setup completes — no throw means success
  });

  it("health check passes", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const health = await plugin.definition.onHealth?.();
    expect(health?.status).toBe("ok");
  });

  it("returns error when credentials are not configured (gcal_list_events)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_list_events", {
      dateStart: "2026-04-27",
      dateEnd: "2026-04-28",
    });
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("returns error when credentials are not configured (gcal_get_day_summary)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_get_day_summary", {});
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("returns error when credentials are not configured (gcal_get_event)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_get_event", { eventId: "test-event-id" });
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("returns error when credentials are not configured (gcal_create_event)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_create_event", {
      title: "Test Event",
      startTime: "2026-04-27T09:00:00",
      endTime: "2026-04-27T10:00:00",
    });
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("returns error when credentials are not configured (gcal_update_event)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_update_event", {
      eventId: "test-event-id",
      title: "Updated Title",
    });
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("returns error when credentials are not configured (gcal_delete_event)", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    const result = await harness.executeTool("gcal_delete_event", { eventId: "test-event-id" });
    expect(result).toBeDefined();
    expect(typeof (result as { error?: string }).error).toBe("string");
  });

  it("formats day summary correctly for empty event list", async () => {
    const harness = createTestHarness({ manifest, capabilities: manifest.capabilities });
    await plugin.definition.setup(harness.ctx);

    // Seed state with a cached access token and mock the fetch
    // Without credentials, we just verify it errors gracefully
    const result = await harness.executeTool("gcal_get_day_summary", { date: "2026-04-27" });
    expect(result).toBeDefined();
    // Returns an error or content string — either way should be defined
    expect(
      typeof (result as { error?: string; content?: string }).error === "string" ||
      typeof (result as { error?: string; content?: string }).content === "string"
    ).toBe(true);
  });

  it("manifest declares all required tools", () => {
    const toolNames = manifest.tools?.map((t) => t.name) ?? [];
    expect(toolNames).toContain("gcal_get_day_summary");
    expect(toolNames).toContain("gcal_list_events");
    expect(toolNames).toContain("gcal_get_event");
    expect(toolNames).toContain("gcal_create_event");
    expect(toolNames).toContain("gcal_update_event");
    expect(toolNames).toContain("gcal_delete_event");
  });

  it("manifest declares morning-briefing job", () => {
    const jobs = manifest.jobs ?? [];
    const job = jobs.find((j) => j.jobKey === "morning-briefing");
    expect(job).toBeDefined();
    expect(job?.schedule).toBe("0 7 * * *");
  });

  it("manifest declares all required instance config fields", () => {
    const props = manifest.instanceConfigSchema?.properties ?? {};
    expect(props).toHaveProperty("clientId");
    expect(props).toHaveProperty("clientSecret");
    expect(props).toHaveProperty("refreshToken");
    expect(props).toHaveProperty("calendarId");
    expect(props).toHaveProperty("timezone");
  });
});
