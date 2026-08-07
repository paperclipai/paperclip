import { describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { BudgetAlertPayload } from "./budgets.js";
import type { MailerService } from "./mailer.js";
import {
  createGuardrailAlertHandler,
  guardrailLevelForAlert,
  isAllowedGuardrailNotifyRecipient,
} from "./guardrail-notify.js";

// These tests exercise the REAL `createGuardrailAlertHandler` production code
// (the same factory wired into heartbeatService and costRoutes), with a
// mocked `MailerService` and a mocked `Db`. No real SMTP socket is ever
// opened here — `sendMail` is a `vi.fn()` double, never nodemailer's real
// transporter. This also matters for the outbound-mail-guard policy: this
// suite must never attempt a real `net.connect`/`tls.connect` to an SMTP
// port, since that would throw under the agent-run mail guard.
function createMockMailer(): MailerService & { sendMail: ReturnType<typeof vi.fn> } {
  return {
    sendMail: vi.fn().mockResolvedValue(undefined),
    isConfigured: () => true,
  };
}

function createMockDb(): Db & { insert: ReturnType<typeof vi.fn> } {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return { insert } as unknown as Db & { insert: ReturnType<typeof vi.fn> };
}

function makeAlert(overrides: Partial<BudgetAlertPayload> = {}): BudgetAlertPayload {
  return {
    companyId: "company-1",
    scopeType: "company",
    scopeId: "company-1",
    scopeName: "RENDE",
    thresholdType: "soft",
    observedCents: 6100,
    limitCents: 10000,
    utilizationPercent: 61,
    windowKind: "calendar_month_utc",
    ...overrides,
  };
}

describe("guardrailLevelForAlert", () => {
  it("maps soft thresholds below 85% to level 1 (WARN)", () => {
    expect(guardrailLevelForAlert(makeAlert({ thresholdType: "soft", utilizationPercent: 61 }))).toBe(1);
  });

  it("maps soft thresholds at/above 85% to level 2 (HIGH)", () => {
    expect(guardrailLevelForAlert(makeAlert({ thresholdType: "soft", utilizationPercent: 90 }))).toBe(2);
  });

  it("maps hard thresholds to level 3 (HARD STOP) regardless of percent", () => {
    expect(guardrailLevelForAlert(makeAlert({ thresholdType: "hard", utilizationPercent: 100 }))).toBe(3);
  });
});

describe("isAllowedGuardrailNotifyRecipient (outbound mail policy)", () => {
  it("allows internal rende.lu addresses", () => {
    expect(isAllowedGuardrailNotifyRecipient("ops@rende.lu")).toBe(true);
  });

  it("rejects external / non-rende.lu addresses", () => {
    expect(isAllowedGuardrailNotifyRecipient("owner@gmail.com")).toBe(false);
    expect(isAllowedGuardrailNotifyRecipient("ops@rende.lu.evil.com")).toBe(false);
    expect(isAllowedGuardrailNotifyRecipient("")).toBe(false);
  });
});

describe("createGuardrailAlertHandler — BudgetPolicy notifyEnabled guardrail notification", () => {
  it("calls the mailer mock with the WARN subject/body when notifyEnabled=true triggers a soft alert", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "guardrail@rende.lu" });

    await handler(makeAlert({ thresholdType: "soft", utilizationPercent: 61 }));

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const [opts] = mailer.sendMail.mock.calls[0]!;
    expect(opts.to).toBe("guardrail@rende.lu");
    expect(opts.subject).toContain("WARN");
    expect(opts.subject).toContain("61.0 %");
    expect(opts.text).toContain("Guardrail-Stufe 1");
  });

  it("calls the mailer mock with the HIGH subject at soft-threshold utilization >= 85%", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "guardrail@rende.lu" });

    await handler(makeAlert({ thresholdType: "soft", utilizationPercent: 90 }));

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const [opts] = mailer.sendMail.mock.calls[0]!;
    expect(opts.subject).toContain("HIGH");
  });

  it("calls the mailer mock with the HARD STOP subject at a hard threshold", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "guardrail@rende.lu" });

    await handler(makeAlert({ thresholdType: "hard", observedCents: 10000, utilizationPercent: 100 }));

    expect(mailer.sendMail).toHaveBeenCalledTimes(1);
    const [opts] = mailer.sendMail.mock.calls[0]!;
    expect(opts.subject).toContain("HARD STOP");
  });

  it("does not call the mailer when no notifyEmail is configured", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: null });

    await handler(makeAlert());

    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("posts an issue comment via db.insert(issueComments) when notifyIssueId is configured", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyIssueId: "issue-dashboard-1" });

    await handler(makeAlert({ thresholdType: "hard", utilizationPercent: 100 }));

    expect(db.insert).toHaveBeenCalledTimes(1);
  });

  it("never opens a real SMTP connection — mailer.sendMail is a mock double, not nodemailer", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "guardrail@rende.lu" });

    await handler(makeAlert());

    // The mailer passed in is a plain test double (vi.fn), never nodemailer's
    // real transporter — verifying the call went through our mock, not any
    // network-touching implementation.
    expect(vi.isMockFunction(mailer.sendMail)).toBe(true);
    expect(mailer.sendMail).toHaveBeenCalled();
  });

  it("outbound mail policy: rejects a misconfigured non-rende.lu recipient without throwing and without sending", async () => {
    const mailer = createMockMailer();
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "someone@external-domain.com" });

    await expect(handler(makeAlert())).resolves.toBeUndefined();
    expect(mailer.sendMail).not.toHaveBeenCalled();
  });

  it("never throws even if the mailer rejects (notification failures must not break budget enforcement)", async () => {
    const mailer = createMockMailer();
    mailer.sendMail.mockRejectedValueOnce(new Error("smtp unreachable"));
    const db = createMockDb();
    const handler = createGuardrailAlertHandler({ db, mailer, notifyEmail: "guardrail@rende.lu" });

    await expect(handler(makeAlert())).resolves.toBeUndefined();
  });
});
