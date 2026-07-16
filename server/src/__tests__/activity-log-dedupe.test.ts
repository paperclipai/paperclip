import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock instance-settings before importing the module under test so the
// async getGeneral() lookup in logActivity does not touch the database.
vi.mock("../services/instance-settings.js", () => ({
  instanceSettingsService: () => ({
    getGeneral: async () => ({ censorUsernameInLogs: false }),
  }),
}));

// Mock live events: we only care that the DB insert side was skipped.
vi.mock("../services/live-events.js", () => ({
  publishLiveEvent: vi.fn(),
}));

import {
  logActivity,
  __resetActivityLogDedupeForTests,
} from "../services/activity-log.js";

describe("activity-log dedupe", () => {
  let inserts: Array<Record<string, unknown>>;
  let db: { insert: (table: unknown) => { values: (row: Record<string, unknown>) => Promise<void> } };

  beforeEach(() => {
    __resetActivityLogDedupeForTests();
    inserts = [];
    db = {
      insert: () => ({
        values: async (row) => {
          inserts.push(row);
        },
      }),
    };
  });

  afterEach(() => {
    __resetActivityLogDedupeForTests();
  });

  it("writes the first occurrence and suppresses identical repeats within the window", async () => {
    const input = {
      companyId: "company-1",
      actorType: "system" as const,
      actorId: "local-board",
      action: "agent.env.read",
      entityType: "agent",
      entityId: "agent-1",
      details: { envKeys: ["OPENAI_API_KEY"], envKeyCount: 1 },
    };

    for (let i = 0; i < 50; i++) {
      await logActivity(db as never, input);
    }

    expect(inserts).toHaveLength(1);
  });

  it("does not collapse writes with different payload hashes", async () => {
    const base = {
      companyId: "company-1",
      actorType: "system" as const,
      actorId: "local-board",
      action: "agent.env.read",
      entityType: "agent",
      entityId: "agent-1",
    };

    await logActivity(db as never, { ...base, details: { envKeys: ["A"] } });
    await logActivity(db as never, { ...base, details: { envKeys: ["B"] } });
    await logActivity(db as never, { ...base, entityId: "agent-2", details: { envKeys: ["A"] } });
    await logActivity(db as never, {
      ...base,
      actorId: "different-actor",
      details: { envKeys: ["A"] },
    });

    expect(inserts).toHaveLength(4);
  });

  it("re-admits a write after the dedupe window expires", async () => {
    vi.useFakeTimers();
    try {
      const input = {
        companyId: "company-1",
        actorType: "system" as const,
        actorId: "local-board",
        action: "agent.env.read",
        entityType: "agent",
        entityId: "agent-1",
        details: { envKeys: ["OPENAI_API_KEY"] },
      };

      await logActivity(db as never, input);
      await logActivity(db as never, input);
      expect(inserts).toHaveLength(1);

      vi.setSystemTime(Date.now() + 6 * 60 * 1000);
      await logActivity(db as never, input);
      expect(inserts).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
