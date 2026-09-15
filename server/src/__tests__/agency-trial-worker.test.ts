import { describe, it, expect, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import { AgencyTrialWorker } from "../services/agency-trial-worker.js";
import type { AgencyEmailClient } from "../services/agency-email.js";

function makeEmailClient(): AgencyEmailClient {
  return {
    sendWelcome: vi.fn().mockResolvedValue(undefined),
    sendDay7: vi.fn().mockResolvedValue(undefined),
    sendDay25: vi.fn().mockResolvedValue(undefined),
    sendUpgradeConfirmation: vi.fn().mockResolvedValue(undefined),
  };
}

const TRIAL_ROW = {
  trialId: "trial-1",
  contactEmail: "ops@sffd.gov",
  contactName: "Fire Captain",
  incidentCount: 42,
  incidentCap: 1000,
  trialEndsAt: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000),
  agencyName: "SFFD",
  agencyCode: "SFFD",
};

function makeDb(day7Rows: unknown[] = [], day25Rows: unknown[] = []): Db {
  let selectCallCount = 0;
  return {
    select: vi.fn().mockImplementation(() => {
      selectCallCount++;
      const idx = selectCallCount - 1;
      return {
        from: vi.fn().mockReturnThis(),
        innerJoin: vi.fn().mockReturnThis(),
        where: vi.fn().mockReturnThis(),
        limit: vi.fn().mockResolvedValue(idx === 0 ? day7Rows : day25Rows),
      };
    }),
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnThis(),
      onConflictDoNothing: vi.fn().mockResolvedValue([]),
    }),
    update: vi.fn().mockReturnValue({
      set: vi.fn().mockReturnThis(),
      where: vi.fn().mockResolvedValue(undefined),
    }),
  } as unknown as Db;
}

describe("AgencyTrialWorker", () => {
  it("sends day7 email for eligible trials", async () => {
    const emailClient = makeEmailClient();
    const db = makeDb([TRIAL_ROW], []);
    const worker = new AgencyTrialWorker(db, emailClient, "http://localhost:3000", 9999999);
    await worker.tick();
    expect(emailClient.sendDay7).toHaveBeenCalledOnce();
    expect(emailClient.sendDay7).toHaveBeenCalledWith(
      expect.objectContaining({ trialId: "trial-1", contactEmail: "ops@sffd.gov" }),
    );
  });

  it("sends day25 email for trials ending within 5 days", async () => {
    const emailClient = makeEmailClient();
    const db = makeDb([], [TRIAL_ROW]);
    const worker = new AgencyTrialWorker(db, emailClient, "http://localhost:3000", 9999999);
    await worker.tick();
    expect(emailClient.sendDay25).toHaveBeenCalledOnce();
    expect(emailClient.sendDay7).not.toHaveBeenCalled();
  });

  it("does not throw if email client fails", async () => {
    const emailClient = makeEmailClient();
    (emailClient.sendDay7 as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("SMTP down"));
    const db = makeDb([TRIAL_ROW], []);
    const worker = new AgencyTrialWorker(db, emailClient, "http://localhost:3000", 9999999);
    await expect(worker.tick()).resolves.not.toThrow();
  });

  it("expires active trials past their end date", async () => {
    const db = makeDb([], []);
    const emailClient = makeEmailClient();
    const worker = new AgencyTrialWorker(db, emailClient, "http://localhost:3000", 9999999);
    await worker.tick();
    expect(db.update).toHaveBeenCalled();
  });
});
