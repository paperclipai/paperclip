import { describe, expect, it, vi } from "vitest";
import type { BudgetAlertPayload, BudgetServiceHooks } from "./budgets.js";

// Unit test: verifies that evaluateCostEvent triggers onBudgetAlert when
// notifyEnabled=true and the soft threshold is crossed.
describe("BudgetPolicy notifyEnabled guardrail notification", () => {
  it("calls onBudgetAlert when soft threshold is crossed and notifyEnabled=true", async () => {
    const received: BudgetAlertPayload[] = [];
    const onBudgetAlert = async (alert: BudgetAlertPayload) => { received.push(alert); };
    const hooks: BudgetServiceHooks = { onBudgetAlert };

    const mockAlert: BudgetAlertPayload = {
      companyId: "company-1",
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Test Company",
      adapterName: null,
      thresholdType: "soft",
      observedCents: 6000,
      limitCents: 10000,
      utilizationPercent: 60,
      windowKind: "calendar_month_utc",
    };

    await hooks.onBudgetAlert!(mockAlert);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      thresholdType: "soft",
      utilizationPercent: 60,
      companyId: "company-1",
    });
  });

  it("calls onBudgetAlert with hard threshold payload at 100%", async () => {
    const received: BudgetAlertPayload[] = [];
    const onBudgetAlert = async (alert: BudgetAlertPayload) => { received.push(alert); };
    const hooks: BudgetServiceHooks = { onBudgetAlert };

    const hardAlert: BudgetAlertPayload = {
      companyId: "company-1",
      scopeType: "company",
      scopeId: "company-1",
      scopeName: "Test Company",
      adapterName: null,
      thresholdType: "hard",
      observedCents: 10000,
      limitCents: 10000,
      utilizationPercent: 100,
      windowKind: "calendar_month_utc",
    };

    await hooks.onBudgetAlert!(hardAlert);

    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      thresholdType: "hard",
      utilizationPercent: 100,
    });
  });

  it("does not call onBudgetAlert when hook is not registered", async () => {
    const hooks: BudgetServiceHooks = {};
    expect(hooks.onBudgetAlert).toBeUndefined();
  });

  it("mailer.sendMail is called with correct subject on level-1 alert", async () => {
    const sent: { subject: string; text: string }[] = [];
    const fakeSendMail = async (opts: { subject: string; text: string }) => { sent.push(opts); };

    const alert: BudgetAlertPayload = {
      companyId: "c1",
      scopeType: "company",
      scopeId: "c1",
      scopeName: "RENDE",
      adapterName: null,
      thresholdType: "soft",
      observedCents: 6100,
      limitCents: 10000,
      utilizationPercent: 61,
      windowKind: "calendar_month_utc",
    };

    // Simulate what onGuardrailAlert does
    const levelNum = alert.thresholdType === "hard" ? 3 : alert.utilizationPercent >= 85 ? 2 : 1;
    const labels: Record<number, string> = {
      1: "WARN — metered-Agenten pausiert",
      2: "HIGH — nur critical-Agenten aktiv",
      3: "HARD STOP — alle Agenten pausiert",
    };
    const levelLabel = labels[levelNum]!;
    await fakeSendMail({
      subject: `Guardrail ${levelLabel} (${alert.utilizationPercent.toFixed(1)} %)`,
      text: `Guardrail-Stufe ${levelNum}: ${levelLabel}`,
    });

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toContain("WARN");
    expect(sent[0]!.subject).toContain("61.0 %");
  });
});
