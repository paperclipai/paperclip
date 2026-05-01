import { and, desc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  companies,
  issueWorkProducts,
  issues,
  rt2CoinLedger,
  rt2PayrollRunEntries,
  rt2PayrollRuns,
  rt2PaymentReceipts,
  rt2PersonalPnL,
  rt2QualityScores,
  rt2SettlementGovernance,
  rt2SettlementReconciliation,
  rt2V33TaskParticipants,
} from "@paperclipai/db";

// Platform fee: 10%, operational fee: 5% (deducted from gross)
const PLATFORM_FEE_RATE = 0.10;
const OPERATIONAL_FEE_RATE = 0.05;

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function computeFees(grossGold: number): {
  platformFeeGold: number;
  operationalFeeGold: number;
  totalDeductionsGold: number;
  netGold: number;
} {
  const platformFeeGold = Math.round(grossGold * PLATFORM_FEE_RATE);
  const operationalFeeGold = Math.round(grossGold * OPERATIONAL_FEE_RATE);
  const totalDeductionsGold = platformFeeGold + operationalFeeGold;
  const netGold = grossGold - totalDeductionsGold;
  return { platformFeeGold, operationalFeeGold, totalDeductionsGold, netGold };
}

export type PayrollRun = {
  id: string;
  companyId: string;
  period: string;
  status: "pending" | "processing" | "completed" | "failed";
  totalGrossGold: number;
  totalNetGold: number;
  totalDeductionsGold: number;
  actorCount: number;
  completedAt: Date | null;
  errorMessage: string | null;
  createdAt: Date;
};

export type PayrollRunEntry = {
  id: string;
  payrollRunId: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  grossGold: number;
  platformFeeGold: number;
  operationalFeeGold: number;
  totalDeductionsGold: number;
  netGold: number;
  ledgerEntryId: string | null;
  status: "pending" | "paid" | "failed";
  createdAt: Date;
};

export type PaymentReceipt = {
  id: string;
  companyId: string;
  payrollRunId: string | null;
  settlementId: string | null;
  providerReference: string;
  providerName: string;
  amount: number;
  currency: string;
  status: "pending" | "confirmed" | "failed" | "reconciled";
  paidAt: Date | null;
  reconciledAt: Date | null;
  reconciliationNotes: string | null;
  metadata: Record<string, unknown>;
  createdAt: Date;
};

export type ReconciliationRecord = {
  id: string;
  companyId: string;
  settlementId: string;
  paymentReceiptId: string;
  ledgerEntryId: string | null;
  amountMatched: number;
  discrepancyGold: number;
  reconciliationStatus: "matched" | "discrepancy" | "unresolved";
  reconciledAt: Date;
  notes: string | null;
  createdAt: Date;
};

export type ReconciliationReport = {
  companyId: string;
  period: string;
  totalSettlements: number;
  matched: number;
  discrepancies: number;
  unresolved: number;
  totalDiscrepancyGold: number;
  records: ReconciliationRecord[];
};

export function rt2PayrollSettlementService(db: Db) {
  // ===== Payroll Run Methods =====

  /**
   * Process monthly payroll for a company
   * BILL-02: Monthly payroll deduction/credit loop
   * 1. Lock company scope
   * 2. Check if already run for period
   * 3. For each agent with positive income: compute fees, create ledger entries
   * 4. Record payroll run with totals
   */
  async function processMonthlyPayroll(
    companyId: string,
    period?: string,
  ): Promise<PayrollRun> {
    const p = period || getCurrentPeriod();

    // Check if already run
    const existing = await db
      .select({ id: rt2PayrollRuns.id, status: rt2PayrollRuns.status })
      .from(rt2PayrollRuns)
      .where(
        and(
          eq(rt2PayrollRuns.companyId, companyId),
          eq(rt2PayrollRuns.period, p),
        ),
      )
      .limit(1);

    if (existing.length > 0) {
      const run = await db
        .select()
        .from(rt2PayrollRuns)
        .where(eq(rt2PayrollRuns.id, existing[0].id))
        .then((rows) => rows[0]);
      return run as unknown as PayrollRun;
    }

    // Create payroll run record
    const [run] = await db
      .insert(rt2PayrollRuns)
      .values({
        companyId,
        period: p,
        status: "processing",
      })
      .returning();

    try {
      // Get all actors with positive income in this period
      const actors = await db
        .select({
          actorId: rt2PersonalPnL.actorId,
          actorType: rt2PersonalPnL.actorType,
          income: rt2PersonalPnL.income,
        })
        .from(rt2PersonalPnL)
        .where(
          and(
            eq(rt2PersonalPnL.companyId, companyId),
            eq(rt2PersonalPnL.period, p),
            sql`${rt2PersonalPnL.income} > 0`,
          ),
        );

      let totalGross = 0;
      let totalNet = 0;
      let totalDeductions = 0;

      for (const actor of actors) {
        const grossGold = Number(actor.income) || 0;
        if (grossGold <= 0) continue;

        const { platformFeeGold, operationalFeeGold, totalDeductionsGold, netGold } = computeFees(grossGold);

        // Create ledger entry for net payment (company → actor)
        let ledgerEntryId: string | null = null;
        if (netGold > 0) {
          const [ledgerEntry] = await db
            .insert(rt2CoinLedger)
            .values({
              companyId,
              fromActorId: "company",
              fromActorType: "company",
              toActorId: actor.actorId,
              toActorType: actor.actorType,
              amount: netGold,
              balanceAfter: sql<number>`(
                SELECT COALESCE(SUM(${rt2CoinLedger.amount}), 0) + ${netGold}
                FROM ${rt2CoinLedger}
                WHERE ${rt2CoinLedger.companyId} = ${companyId}
                  AND ${rt2CoinLedger.toActorId} = ${actor.actorId}
                  AND ${rt2CoinLedger.toActorType} = ${actor.actorType}
              )`,
              transactionType: "earned",
              description: `Monthly payroll ${p}: net payment after ${Math.round((PLATFORM_FEE_RATE + OPERATIONAL_FEE_RATE) * 100)}% fees`,
              referenceId: run.id,
              referenceType: "payroll_run",
              period: p,
              leg: "credit",
            })
            .returning();
          ledgerEntryId = ledgerEntry?.id ?? null;
        }

        // Create payroll run entry
        await db.insert(rt2PayrollRunEntries).values({
          payrollRunId: run.id,
          companyId,
          actorId: actor.actorId,
          actorType: actor.actorType,
          grossGold,
          platformFeeGold,
          operationalFeeGold,
          totalDeductionsGold,
          netGold,
          ledgerEntryId,
          status: netGold > 0 ? "paid" : "pending",
        });

        totalGross += grossGold;
        totalNet += netGold;
        totalDeductions += totalDeductionsGold;
      }

      // Update payroll run with totals
      await db
        .update(rt2PayrollRuns)
        .set({
          status: "completed",
          totalGrossGold: totalGross,
          totalNetGold: totalNet,
          totalDeductions: totalDeductions,
          actorCount: actors.filter((a) => Number(a.income) > 0).length,
          completedAt: new Date(),
        })
        .where(eq(rt2PayrollRuns.id, run.id));

      const updated = await db
        .select()
        .from(rt2PayrollRuns)
        .where(eq(rt2PayrollRuns.id, run.id))
        .then((rows) => rows[0]);

      return updated as unknown as PayrollRun;
    } catch (err) {
      // Mark run as failed
      await db
        .update(rt2PayrollRuns)
        .set({
          status: "failed",
          errorMessage: err instanceof Error ? err.message : String(err),
        })
        .where(eq(rt2PayrollRuns.id, run.id));
      throw err;
    }
  }

  /**
   * Get payroll run by period
   */
  async function getPayrollRun(companyId: string, period: string): Promise<PayrollRun | null> {
    const [run] = await db
      .select()
      .from(rt2PayrollRuns)
      .where(
        and(
          eq(rt2PayrollRuns.companyId, companyId),
          eq(rt2PayrollRuns.period, period),
        ),
      )
      .limit(1);

    if (!run) return null;

    const entries = await db
      .select()
      .from(rt2PayrollRunEntries)
      .where(eq(rt2PayrollRunEntries.payrollRunId, run.id))
      .orderBy(desc(rt2PayrollRunEntries.netGold));

    return { ...run, entries } as unknown as PayrollRun;
  }

  /**
   * List recent payroll runs for a company
   */
  async function listPayrollRuns(
    companyId: string,
    limit: number = 12,
  ): Promise<PayrollRun[]> {
    const runs = await db
      .select()
      .from(rt2PayrollRuns)
      .where(eq(rt2PayrollRuns.companyId, companyId))
      .orderBy(desc(rt2PayrollRuns.createdAt))
      .limit(limit);

    return runs as unknown as PayrollRun[];
  }

  // ===== Payment Receipt Methods =====

  /**
   * Add an external payment receipt (BILL-03)
   */
  async function addPaymentReceipt(
    companyId: string,
    data: {
      providerReference: string;
      providerName?: string;
      amount: number;
      currency?: string;
      status?: string;
      paidAt?: Date;
      settlementId?: string;
      payrollRunId?: string;
      metadata?: Record<string, unknown>;
    },
  ): Promise<PaymentReceipt> {
    const [receipt] = await db
      .insert(rt2PaymentReceipts)
      .values({
        companyId,
        settlementId: data.settlementId ?? null,
        payrollRunId: data.payrollRunId ?? null,
        providerReference: data.providerReference,
        providerName: data.providerName ?? "internal",
        amount: data.amount,
        currency: data.currency ?? "GOLD",
        status: data.status ?? "pending",
        paidAt: data.paidAt ?? null,
        metadata: data.metadata ?? {},
      })
      .returning();

    return receipt as unknown as PaymentReceipt;
  }

  /**
   * Confirm a payment receipt
   */
  async function confirmPaymentReceipt(
    receiptId: string,
    companyId: string,
  ): Promise<PaymentReceipt> {
    const [updated] = await db
      .update(rt2PaymentReceipts)
      .set({
        status: "confirmed",
        paidAt: new Date(),
      })
      .where(
        and(
          eq(rt2PaymentReceipts.id, receiptId),
          eq(rt2PaymentReceipts.companyId, companyId),
        ),
      )
      .returning();

    return updated as unknown as PaymentReceipt;
  }

  /**
   * Get payment receipts for a company/period
   */
  async function getPaymentReceipts(
    companyId: string,
    options?: {
      period?: string;
      status?: string;
      settlementId?: string;
    },
  ): Promise<PaymentReceipt[]> {
    const conditions = [eq(rt2PaymentReceipts.companyId, companyId)];
    if (options?.status) {
      conditions.push(eq(rt2PaymentReceipts.status, options.status));
    }
    if (options?.settlementId) {
      conditions.push(eq(rt2PaymentReceipts.settlementId, options.settlementId));
    }

    const receipts = await db
      .select()
      .from(rt2PaymentReceipts)
      .where(and(...conditions))
      .orderBy(desc(rt2PaymentReceipts.createdAt));

    return receipts as unknown as PaymentReceipt[];
  }

  // ===== Reconciliation Methods (BILL-03) =====

  /**
   * Reconcile a settlement with a payment receipt (BILL-03)
   * Links the settlement's ledger entry to the external receipt
   * and computes discrepancy
   */
  async function reconcileSettlementWithReceipt(
    companyId: string,
    settlementId: string,
    receiptId: string,
  ): Promise<ReconciliationRecord> {
    // Get settlement and its ledger entry
    const [settlement] = await db
      .select()
      .from(rt2SettlementGovernance)
      .where(
        and(
          eq(rt2SettlementGovernance.id, settlementId),
          eq(rt2SettlementGovernance.companyId, companyId),
        ),
      )
      .limit(1);

    if (!settlement) throw new Error("Settlement not found");

    const [receipt] = await db
      .select()
      .from(rt2PaymentReceipts)
      .where(
        and(
          eq(rt2PaymentReceipts.id, receiptId),
          eq(rt2PaymentReceipts.companyId, companyId),
        ),
      )
      .limit(1);

    if (!receipt) throw new Error("Payment receipt not found");

    const ledgerEntryId = settlement.ledgerEntryId;

    // Get ledger entry amount for comparison
    let ledgerAmount = 0;
    if (ledgerEntryId) {
      const [ledgerEntry] = await db
        .select({ amount: rt2CoinLedger.amount })
        .from(rt2CoinLedger)
        .where(eq(rt2CoinLedger.id, ledgerEntryId))
        .limit(1);
      ledgerAmount = Number(ledgerEntry?.amount ?? 0);
    }

    const receiptAmount = Number(receipt.amount);
    const discrepancy = Math.abs(ledgerAmount - receiptAmount);
    const status: ReconciliationRecord["reconciliationStatus"] =
      discrepancy === 0 ? "matched" : discrepancy > 0 ? "discrepancy" : "unresolved";

    const [record] = await db
      .insert(rt2SettlementReconciliation)
      .values({
        companyId,
        settlementId,
        paymentReceiptId: receiptId,
        ledgerEntryId: ledgerEntryId ?? null,
        amountMatched: Math.min(ledgerAmount, receiptAmount),
        discrepancyGold: discrepancy,
        reconciliationStatus: status,
        reconciledAt: new Date(),
      })
      .returning();

    // Mark receipt as reconciled
    await db
      .update(rt2PaymentReceipts)
      .set({
        status: "reconciled",
        reconciledAt: new Date(),
        settlementId: settlementId,
      })
      .where(eq(rt2PaymentReceipts.id, receiptId));

    return record as unknown as ReconciliationRecord;
  }

  /**
   * Get reconciliation report for a company/period
   */
  async function getReconciliationReport(
    companyId: string,
    period?: string,
  ): Promise<ReconciliationReport> {
    const p = period || getCurrentPeriod();

    const records = await db
      .select()
      .from(rt2SettlementReconciliation)
      .where(eq(rt2SettlementReconciliation.companyId, companyId))
      .orderBy(desc(rt2SettlementReconciliation.reconciledAt));

    const typedRecords = records as unknown as ReconciliationRecord[];

    const matched = typedRecords.filter((r) => r.reconciliationStatus === "matched").length;
    const discrepancies = typedRecords.filter((r) => r.reconciliationStatus === "discrepancy").length;
    const unresolved = typedRecords.filter((r) => r.reconciliationStatus === "unresolved").length;
    const totalDiscrepancy = typedRecords.reduce((sum, r) => sum + Number(r.discrepancyGold), 0);

    return {
      companyId,
      period: p,
      totalSettlements: typedRecords.length,
      matched,
      discrepancies,
      unresolved,
      totalDiscrepancyGold: totalDiscrepancy,
      records: typedRecords,
    };
  }

  return {
    processMonthlyPayroll,
    getPayrollRun,
    listPayrollRuns,
    addPaymentReceipt,
    confirmPaymentReceipt,
    getPaymentReceipts,
    reconcileSettlementWithReceipt,
    getReconciliationReport,
  };
}
