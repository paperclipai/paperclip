import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  buildEconomicsDigest,
  renderEconomicsDigestSlack,
  renderEconomicsDigestOutlook,
  saveOutlookDraft,
  executeEconomicsDigest,
} from "../services/economics-digest.js";
import {
  createEconomicsDigestScheduler,
  nextWeeklyFireAt,
  economicsDigestSchedulerConfigFromEnv,
} from "../services/economics-digest-scheduler.js";
import fs from "node:fs";
import path from "node:path";

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("Economics Digest Scheduler & Core Services", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Clean up created drafts from the local filesystem
    const vaultDir = path.resolve(process.cwd(), "vault", "outlook");
    if (fs.existsSync(vaultDir)) {
      const files = fs.readdirSync(vaultDir);
      for (const f of files) {
        if (f.startsWith("draft_") && f.endsWith(".json")) {
          try {
            fs.unlinkSync(path.join(vaultDir, f));
          } catch {}
        }
      }
    }
  });

  describe("nextWeeklyFireAt", () => {
    it("picks the correct next Monday 09:00 AM New York time", () => {
      // 2026-05-24 is Sunday.
      const now = new Date("2026-05-24T12:00:00Z");
      const next = nextWeeklyFireAt({
        now,
        dayOfWeek: 1, // Monday
        hour: 9,
        minute: 0,
        timezone: "America/New_York",
      });

      // Next Monday is 2026-05-25. 09:00 AM EDT is 13:00 UTC.
      expect(next.toISOString()).toBe("2026-05-25T13:00:00.000Z");
    });

    it("rolls forward to next week if today's Monday target has passed", () => {
      // 2026-05-25 is Monday, target time is 09:00 EDT (13:00 UTC). Let's start past it:
      const now = new Date("2026-05-25T15:00:00Z");
      const next = nextWeeklyFireAt({
        now,
        dayOfWeek: 1, // Monday
        hour: 9,
        minute: 0,
        timezone: "America/New_York",
      });

      // Next Monday is 2026-06-01. 09:00 AM EDT is 13:00 UTC.
      expect(next.toISOString()).toBe("2026-06-01T13:00:00.000Z");
    });
  });

  describe("economicsDigestSchedulerConfigFromEnv", () => {
    it("parses configuration from env correctly", () => {
      const parsed = economicsDigestSchedulerConfigFromEnv({
        PAPERCLIP_ECONOMICS_DIGEST_SCHEDULER_ENABLED: "false",
        PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_DAY_OF_WEEK: "2",
        PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_HOUR: "11",
        PAPERCLIP_ECONOMICS_DIGEST_SCHEDULE_MINUTE: "30",
        PAPERCLIP_ECONOMICS_DIGEST_TIMEZONE: "UTC",
      });

      expect(parsed).toEqual({
        enabled: false,
        dayOfWeek: 2,
        hour: 11,
        minute: 30,
        timezone: "UTC",
      });
    });
  });

  describe("Core digest builders & formatters", () => {
    const mockCompanyId = "5c2551e8-cb65-4ab4-9fee-8e0001be2e41";
    const mockAgents = [
      { id: "agent-1", name: "Lead Operations", budgetMonthlyCents: 5000, companyId: mockCompanyId },
      { id: "agent-2", name: "Unlimited Steward", budgetMonthlyCents: 0, companyId: mockCompanyId },
    ];
    const mockCostEvents = [
      { agentId: "agent-1", costCents: 1000 },
      { agentId: "agent-1", costCents: 250 },
    ];

    it("builds clean digest and formatters outputs", async () => {
      // Mock Drizzle DB using the elegant thenableChain pattern
      const selectChain = {
        from: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        groupBy: vi.fn().mockReturnThis(),
        then: vi.fn().mockImplementation((onResolve) => {
          const lastCall = selectChain.from.mock.calls[selectChain.from.mock.calls.length - 1];
          const tableName = lastCall ? lastCall[0][Symbol.for("drizzle:Name")] : "";
          let result: any = [];
          if (tableName === "companies") {
            result = [{ id: mockCompanyId, name: "Mock Company" }];
          } else if (tableName === "agents") {
            result = mockAgents;
          } else {
            result = [{ agentId: "agent-1", totalCents: 1250 }];
          }
          return Promise.resolve(result).then(onResolve);
        }),
      };

      const mockDb: any = {
        select: vi.fn().mockReturnValue(selectChain),
      };

      const now = new Date("2026-05-28T12:00:00Z");
      const digest = await buildEconomicsDigest(mockDb, mockCompanyId, now);

      expect(digest.agents.length).toBe(2);
      expect(digest.agents[0].agentName).toBe("Lead Operations");
      expect(digest.agents[0].spentMonthlyCents).toBe(1250);
      expect(digest.agents[0].budgetMonthlyCents).toBe(5000);
      expect(digest.agents[1].agentName).toBe("Unlimited Steward");
      expect(digest.agents[1].spentMonthlyCents).toBe(0);
      expect(digest.agents[1].budgetMonthlyCents).toBe(0);

      // Verify formatting functions
      const slackText = renderEconomicsDigestSlack(digest);
      expect(slackText).toContain("Lead Operations");
      expect(slackText).toContain("Monthly Cap: $50.00");
      expect(slackText).toContain("MTD Spend: $12.50");
      expect(slackText).toContain("Unlimited Steward");
      expect(slackText).toContain("Monthly Cap: Unlimited");

      const outlookDraft = renderEconomicsDigestOutlook(digest);
      expect(outlookDraft.subject).toContain("Weekly Economics Digest");
      expect(outlookDraft.body).toContain("Lead Operations");
      expect(outlookDraft.body).toContain("Unlimited Steward");
    });
  });

  describe("saveOutlookDraft", () => {
    it("writes draft file to the filesystem correctly", () => {
      const generatedAt = "2026-05-28T12:00:00.000Z";
      const subject = "Test Subject";
      const body = "<h1>Test Body</h1>";

      const draftPath = saveOutlookDraft(subject, body, generatedAt);
      expect(fs.existsSync(draftPath)).toBe(true);

      const savedData = JSON.parse(fs.readFileSync(draftPath, "utf-8"));
      expect(savedData.subject).toBe(subject);
      expect(savedData.body).toBe(body);
      expect(savedData.to).toBe("ivan@example.com");
      expect(savedData.status).toBe("drafted");
    });
  });
});
