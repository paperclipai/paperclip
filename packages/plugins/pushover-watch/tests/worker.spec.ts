import { describe, it, expect, vi, afterEach } from "vitest";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import plugin from "../src/worker.js";
import manifest from "../src/manifest.js";
import type { PluginConfig } from "../src/config-schema.js";

const CEO = "506c873e-3a40-4483-9a45-0eb0fa1554bb";
const WALTER = "18r34Ghx5N0LHRptMCT6Fp1WaoGqhvc9";
const WHI = "9cebf3cf-efe8-4597-a400-f06488900a87";

function baseConfig(): PluginConfig {
  return {
    pushoverUserKeyRef: "key-uuid",
    pushoverAppTokenRef: "token-uuid",
    boardUserId: WALTER,
    clickbackBaseUrl: "https://company.whitestag.ai",
    dryRun: false,
    companies: [
      { companyId: WHI, issuePrefix: "WHI", topAgentIds: [CEO], enabled: true },
    ],
  };
}

describe("pushover-watch worker integration", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("fires T1 on a real issue.updated event after bootstrap seeded the prev state", async () => {
    const harness = createTestHarness({
      manifest,
      config: baseConfig() as unknown as Record<string, unknown>,
    });

    // Seed iss-1 as in_progress so bootstrap stores it as previous state.
    // The Issue type requires many fields; cast to satisfy the harness seed.
    harness.seed({
      issues: [
        {
          id: "iss-1",
          companyId: WHI,
          status: "in_progress",
          assigneeAgentId: CEO,
          assigneeUserId: null,
          identifier: "WHI-42",
          title: "Cleanup",
          updatedAt: new Date("2026-05-11T09:00:00.000Z"),
          // Required Issue fields filled with nulls/defaults
          projectId: null,
          projectWorkspaceId: null,
          goalId: null,
          parentId: null,
          description: null,
          workMode: "auto",
          priority: "medium",
          checkoutRunId: null,
          executionRunId: null,
          executionAgentNameKey: null,
          executionLockedAt: null,
          createdByAgentId: null,
          createdByUserId: null,
          issueNumber: 42,
          requestDepth: 0,
          billingCode: null,
          assigneeAdapterOverrides: null,
          executionWorkspaceId: null,
          executionWorkspacePreference: null,
          executionWorkspaceSettings: null,
          startedAt: null,
          completedAt: null,
          cancelledAt: null,
          hiddenAt: null,
        } as any,
      ],
    });

    // Mock ctx.http.fetch to intercept Pushover calls.
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: 1 }), { status: 200 }),
    );

    // Run setup — this bootstraps the company (seeds iss-1 prev state via
    // ctx.issues.list) and registers event listeners.
    await plugin.definition.setup(harness.ctx);

    // After bootstrap, the event handler calls ctx.issues.get to fetch the
    // current issue state. Stub it to return the post-transition state (done).
    vi.spyOn(harness.ctx.issues, "get").mockResolvedValue({
      id: "iss-1",
      companyId: WHI,
      status: "done",
      assigneeAgentId: CEO,
      assigneeUserId: null,
      identifier: "WHI-42",
      title: "Cleanup",
      updatedAt: new Date(),
    } as any);

    // Emit issue.updated: status transitions from in_progress → done (T1).
    await harness.emit(
      "issue.updated",
      { status: "done" }, // delta payload only — handler trusts ctx.issues.get
      {
        companyId: WHI,
        entityId: "iss-1",
        entityType: "issue",
      },
    );

    // T1 should have triggered both a Pushover message POST and a Glance update.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const messagesCall = fetchSpy.mock.calls.find(
      (c) => c[0] === "https://api.pushover.net/1/messages.json",
    );
    const glanceCall = fetchSpy.mock.calls.find(
      (c) => c[0] === "https://api.pushover.net/1/glances.json",
    );
    expect(messagesCall).toBeDefined();
    expect(glanceCall).toBeDefined();

    const messagesBody = new URLSearchParams(messagesCall![1]?.body as string);
    expect(messagesBody.get("title")).toMatch(/^\[WHI\] CEO erledigt:/);

    const glanceBody = new URLSearchParams(glanceCall![1]?.body as string);
    expect(glanceBody.get("title")).toBe("[WHI] CEO erledigt");
  });

  it("does not send a notification during bootstrap", async () => {
    const harness = createTestHarness({
      manifest,
      config: baseConfig() as unknown as Record<string, unknown>,
    });

    // No issues seeded — bootstrap will store no state.
    const fetchSpy = vi.spyOn(harness.ctx.http, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ status: 1 }), { status: 200 }),
    );

    await plugin.definition.setup(harness.ctx);

    // Bootstrap should not have triggered any Pushover calls.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
