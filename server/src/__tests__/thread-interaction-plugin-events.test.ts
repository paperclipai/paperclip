import type { Db } from "@paperclipai/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { logActivity, setPluginEventBus } from "../services/activity-log.js";
import { createPluginEventBus } from "../services/plugin-event-bus.js";

vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));
vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
vi.mock("../middleware/logger.js", () => ({ logger: { warn: vi.fn() } }));
vi.mock("../services/execution-preparation-timing.js", () => ({
  beginRunPhase: () => () => {},
}));
vi.mock("../services/live-run-recovery-notifications.js", () => ({
  notifyActiveRunSilence: vi.fn(),
}));
vi.mock("../services/delivery-work-notifications.js", () => ({
  DELIVERY_QUEUES: { mcpEvents: "mcp-events" },
  notifyDeliveryWork: vi.fn(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe("thread interaction plugin events", () => {
  it.each([
    "issue.thread_interaction_created",
    "issue.thread_interaction_answered",
    "issue.thread_interaction_accepted",
    "issue.thread_interaction_rejected",
    "issue.thread_interaction_expired",
  ] as const)("delivers %s from the activity log to the matching company", async (action) => {
    const companyId = "company-1";
    const handler = vi.fn(async () => {});
    const otherCompanyHandler = vi.fn(async () => {});
    const bus = createPluginEventBus();
    bus.forPlugin("decision-notifier").subscribe(action, { companyId }, handler);
    bus.forPlugin("other-company").subscribe(action, { companyId: "company-2" }, otherCompanyHandler);
    setPluginEventBus(bus);

    const values = vi.fn(() => ({ returning: async () => [{ id: "activity-1" }] }));
    const db = {
      insert: () => ({ values }),
      transaction: async (work: (tx: Db) => Promise<unknown>) => work(db),
    } as unknown as Db;
    const details = { interactionId: "interaction-1" };

    await logActivity(db, {
      companyId,
      actorType: "user",
      actorId: "board-user",
      action,
      entityType: "issue",
      entityId: "issue-1",
      details,
    });

    await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
    expect(handler).toHaveBeenCalledWith({
      eventId: expect.any(String),
      eventType: action,
      occurredAt: expect.any(String),
      actorType: "user",
      actorId: "board-user",
      entityType: "issue",
      entityId: "issue-1",
      companyId,
      payload: {
        interactionId: "interaction-1",
        agentId: null,
        runId: null,
        responsibleUserId: "board-user",
      },
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ action, companyId, details }));
    expect(otherCompanyHandler).not.toHaveBeenCalled();
    bus.clearPlugin("decision-notifier");
    bus.clearPlugin("other-company");
  });
});
