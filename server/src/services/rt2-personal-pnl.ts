import { and, desc, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  issueWorkProducts,
  issues,
  rt2AntiGamingSignals,
  rt2CoinLedger,
  rt2PersonalPnL,
  rt2QualityScores,
  rt2SettlementGovernance,
  rt2SettlementThresholds,
  rt2V33TaskParticipants,
} from "@paperclipai/db";

export type PersonalPnL = {
  id: string;
  companyId: string;
  actorId: string;
  actorType: "user" | "agent";
  period: string;
  income: number;
  expenses: number;
  netPnL: number;
  budgetAllocated: number;
  budgetUsed: number;
};

export type CoinLedgerEntry = {
  id: string;
  companyId: string;
  fromActorId: string;
  fromActorType: string;
  toActorId: string;
  toActorType: string;
  amount: number;
  balanceAfter: number;
  leg: "credit" | "debit";
  transactionType: "earned" | "spent" | "transferred" | "reward" | "penalty";
  description: string | null;
  referenceId: string | null;
  referenceType: string | null;
  period: string;
  createdAt: Date;
};

export type ApprovedDeliverablePnlEntry = {
  workProductId: string;
  taskIssueId: string;
  projectId: string | null;
  title: string;
  type: string;
  ownerActorId: string;
  ownerActorType: "user" | "agent";
  revenue: number;
  qualityScore: number;
  qualityScoreId: string;
  approvalMode: string | null;
  approvedAt: Date;
};

export type PnLCalculationEvidence = {
  settlementStatus: "ready" | "partial" | "missing";
  period: string;
  approvedDeliverableCount: number;
  approvedDeliverableRevenue: number;
  ledgerEntryCount: number;
  ledgerByType: Record<string, number>;
  sourceTables: string[];
  warnings: string[];
};

export type ActorPnLDrilldown = PersonalPnL & {
  approvedDeliverables: ApprovedDeliverablePnlEntry[];
  ledgerEntries: CoinLedgerEntry[];
  revenueFromApprovedDeliverables: number;
};

export type SettlementNegotiationComment = {
  actorId: string;
  actorType: "user" | "agent" | "system";
  comment: string;
  createdAt: string;
};

export type SettlementAntiGamingSignal = {
  key: string;
  label: string;
  severity: "info" | "warning" | "critical";
  evidence: string;
  thresholdBasis?: string;
};

export type SettlementLedgerEvidence = {
  id: string;
  amount: number;
  balanceAfter: number;
  transactionType: CoinLedgerEntry["transactionType"];
  period: string;
  createdAt: Date;
};

export type SettlementThresholdSettings = {
  highValueGold: number;
  selfReviewCriticalCount: number;
  goldFarmingEarnedCount: number;
  goldFarmingWarningGold: number;
  goldFarmingWarningMultiplier: number;
  goldFarmingCriticalGold: number;
  goldFarmingCriticalMultiplier: number;
  qualityBiasAutoScore: number;
  evaluationWindowDays: number;
};

export type SettlementFlow = {
  id: string;
  companyId: string;
  workProductId: string;
  taskIssueId: string;
  ownerActorId: string;
  ownerActorType: "user" | "agent";
  proposedPriceGold: number;
  finalPriceGold: number | null;
  rationale: string;
  negotiationComments: SettlementNegotiationComment[];
  status: "proposed" | "approval_required" | "approved" | "rejected";
  approvalRequired: boolean;
  approvalGateReason: string | null;
  riskLevel: "low" | "medium" | "high";
  antiGamingSignals: SettlementAntiGamingSignal[];
  approverId: string | null;
  decisionReason: string | null;
  ledgerEntryId: string | null;
  ledgerEvidence: SettlementLedgerEvidence | null;
  pnlPeriod: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

export type SettlementOverview = {
  companyId: string;
  period: string;
  settlements: SettlementFlow[];
  summary: {
    total: number;
    proposed: number;
    approvalRequired: number;
    approved: number;
    rejected: number;
    highRisk: number;
  };
  thresholds: SettlementThresholdSettings;
};

type TransactionClient = Parameters<Parameters<Db["transaction"]>[0]>[0];
type LedgerWriteClient = Db | TransactionClient;

function getCurrentPeriod(): string {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

function getNumberMetadata(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  const value = metadata?.[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

const DEFAULT_SETTLEMENT_THRESHOLDS: SettlementThresholdSettings = {
  highValueGold: 1_000,
  selfReviewCriticalCount: 2,
  goldFarmingEarnedCount: 5,
  goldFarmingWarningGold: 1_500,
  goldFarmingWarningMultiplier: 3,
  goldFarmingCriticalGold: 2_500,
  goldFarmingCriticalMultiplier: 5,
  qualityBiasAutoScore: 98,
  evaluationWindowDays: 30,
};

function normalizeThresholdSettings(input: Partial<SettlementThresholdSettings> | null | undefined): SettlementThresholdSettings {
  const next = { ...DEFAULT_SETTLEMENT_THRESHOLDS, ...(input ?? {}) };
  return {
    highValueGold: Math.max(1, Math.round(Number(next.highValueGold) || DEFAULT_SETTLEMENT_THRESHOLDS.highValueGold)),
    selfReviewCriticalCount: Math.max(1, Math.round(Number(next.selfReviewCriticalCount) || DEFAULT_SETTLEMENT_THRESHOLDS.selfReviewCriticalCount)),
    goldFarmingEarnedCount: Math.max(1, Math.round(Number(next.goldFarmingEarnedCount) || DEFAULT_SETTLEMENT_THRESHOLDS.goldFarmingEarnedCount)),
    goldFarmingWarningGold: Math.max(1, Math.round(Number(next.goldFarmingWarningGold) || DEFAULT_SETTLEMENT_THRESHOLDS.goldFarmingWarningGold)),
    goldFarmingWarningMultiplier: Math.max(1, Math.round(Number(next.goldFarmingWarningMultiplier) || DEFAULT_SETTLEMENT_THRESHOLDS.goldFarmingWarningMultiplier)),
    goldFarmingCriticalGold: Math.max(1, Math.round(Number(next.goldFarmingCriticalGold) || DEFAULT_SETTLEMENT_THRESHOLDS.goldFarmingCriticalGold)),
    goldFarmingCriticalMultiplier: Math.max(1, Math.round(Number(next.goldFarmingCriticalMultiplier) || DEFAULT_SETTLEMENT_THRESHOLDS.goldFarmingCriticalMultiplier)),
    qualityBiasAutoScore: Math.min(100, Math.max(1, Math.round(Number(next.qualityBiasAutoScore) || DEFAULT_SETTLEMENT_THRESHOLDS.qualityBiasAutoScore))),
    evaluationWindowDays: Math.max(1, Math.round(Number(next.evaluationWindowDays) || DEFAULT_SETTLEMENT_THRESHOLDS.evaluationWindowDays)),
  };
}

function toThresholdSettings(row: typeof rt2SettlementThresholds.$inferSelect | null | undefined): SettlementThresholdSettings {
  return normalizeThresholdSettings(row ? {
    highValueGold: row.highValueGold,
    selfReviewCriticalCount: row.selfReviewCriticalCount,
    goldFarmingEarnedCount: row.goldFarmingEarnedCount,
    goldFarmingWarningGold: row.goldFarmingWarningGold,
    goldFarmingWarningMultiplier: row.goldFarmingWarningMultiplier,
    goldFarmingCriticalGold: row.goldFarmingCriticalGold,
    goldFarmingCriticalMultiplier: row.goldFarmingCriticalMultiplier,
    qualityBiasAutoScore: row.qualityBiasAutoScore,
    evaluationWindowDays: row.evaluationWindowDays,
  } : null);
}

function toSettlementFlow(
  row: typeof rt2SettlementGovernance.$inferSelect,
  ledgerEvidence: SettlementLedgerEvidence | null = null,
): SettlementFlow {
  return {
    ...row,
    ownerActorType: row.ownerActorType as "user" | "agent",
    negotiationComments: row.negotiationComments ?? [],
    status: row.status as SettlementFlow["status"],
    approvalRequired: row.approvalRequired === 1,
    riskLevel: row.riskLevel as SettlementFlow["riskLevel"],
    antiGamingSignals: row.antiGamingSignals ?? [],
    ledgerEvidence,
  };
}

function settlementSummary(settlements: SettlementFlow[]): SettlementOverview["summary"] {
  return {
    total: settlements.length,
    proposed: settlements.filter((item) => item.status === "proposed").length,
    approvalRequired: settlements.filter((item) =>
      item.approvalRequired && item.status !== "approved" && item.status !== "rejected"
    ).length,
    approved: settlements.filter((item) => item.status === "approved").length,
    rejected: settlements.filter((item) => item.status === "rejected").length,
    highRisk: settlements.filter((item) => item.riskLevel === "high").length,
  };
}

function deriveSettlementGate(
  entry: ApprovedDeliverablePnlEntry,
  signals: SettlementAntiGamingSignal[],
  thresholds: SettlementThresholdSettings,
) {
  const critical = signals.some((signal) => signal.severity === "critical");
  const warning = signals.some((signal) => signal.severity === "warning");
  const highValue = entry.revenue >= thresholds.highValueGold;
  const approvalRequired = critical || warning || highValue;
  const reasons = [
    highValue ? "High-value deliverable settlement." : null,
    warning || critical ? "Anti-gaming signal requires operator review." : null,
  ].filter(Boolean);
  return {
    approvalRequired,
    approvalGateReason: reasons.join(" ") || null,
    riskLevel: critical || highValue ? "high" : warning ? "medium" : "low",
    status: approvalRequired ? "approval_required" : "proposed",
  } as const;
}

export function rt2PersonalPnLService(db: Db) {
  async function getSettlementThresholds(companyId: string): Promise<SettlementThresholdSettings> {
    const row = await db
      .select()
      .from(rt2SettlementThresholds)
      .where(eq(rt2SettlementThresholds.companyId, companyId))
      .then((rows) => rows[0] ?? null);
    return toThresholdSettings(row);
  }

  async function updateSettlementThresholds(
    companyId: string,
    input: Partial<SettlementThresholdSettings>,
  ): Promise<SettlementThresholdSettings> {
    const thresholds = normalizeThresholdSettings(input);
    const [row] = await db
      .insert(rt2SettlementThresholds)
      .values({
        companyId,
        ...thresholds,
        updatedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [rt2SettlementThresholds.companyId],
        set: {
          ...thresholds,
          updatedAt: new Date(),
        },
      })
      .returning();
    return toThresholdSettings(row);
  }

  async function getSettlementLedgerEvidence(
    companyId: string,
    ledgerEntryId: string | null,
  ): Promise<SettlementLedgerEvidence | null> {
    if (!ledgerEntryId) return null;
    const row = await db
      .select({
        id: rt2CoinLedger.id,
        amount: rt2CoinLedger.amount,
        balanceAfter: rt2CoinLedger.balanceAfter,
        transactionType: rt2CoinLedger.transactionType,
        period: rt2CoinLedger.period,
        createdAt: rt2CoinLedger.createdAt,
      })
      .from(rt2CoinLedger)
      .where(and(eq(rt2CoinLedger.companyId, companyId), eq(rt2CoinLedger.id, ledgerEntryId)))
      .then((rows) => rows[0] ?? null);
    return row ? {
      ...row,
      transactionType: row.transactionType as CoinLedgerEntry["transactionType"],
    } : null;
  }

  async function enrichSettlementFlow(row: typeof rt2SettlementGovernance.$inferSelect): Promise<SettlementFlow> {
    return toSettlementFlow(row, await getSettlementLedgerEvidence(row.companyId, row.ledgerEntryId));
  }

  async function lockActorLedgerScope(
    client: LedgerWriteClient,
    companyId: string,
    actorId: string,
    actorType: string,
  ): Promise<void> {
    const scope = `rt2_coin_ledger:${companyId}:${actorType}:${actorId}`;
    await client.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${scope}, 0))`);
  }

  async function lockActorLedgerScopes(
    client: LedgerWriteClient,
    companyId: string,
    scopes: Array<{ actorId: string; actorType: string }>,
  ): Promise<void> {
    const uniqueScopes = new Map<string, { actorId: string; actorType: string }>();
    for (const scope of scopes) {
      uniqueScopes.set(`${scope.actorType}:${scope.actorId}`, scope);
    }
    const orderedScopes = Array.from(uniqueScopes.values()).sort((a, b) =>
      `${a.actorType}:${a.actorId}`.localeCompare(`${b.actorType}:${b.actorId}`),
    );
    for (const scope of orderedScopes) {
      await lockActorLedgerScope(client, companyId, scope.actorId, scope.actorType);
    }
  }


  /**
   * M2.7: Get or create P&L record for an actor
   */
  async function getOrCreatePnL(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    period?: string,
  ): Promise<PersonalPnL> {
    const p = period || getCurrentPeriod();

    const existing = await db
      .select()
      .from(rt2PersonalPnL)
      .where(
        and(
          eq(rt2PersonalPnL.companyId, companyId),
          eq(rt2PersonalPnL.actorId, actorId),
          eq(rt2PersonalPnL.actorType, actorType),
          eq(rt2PersonalPnL.period, p),
        ),
      )
      .then((rows) => rows[0] ?? null);

    if (existing) {
      return existing as PersonalPnL;
    }

    // Create new P&L record
    const [created] = await db
      .insert(rt2PersonalPnL)
      .values({
        companyId,
        actorId,
        actorType,
        period: p,
        income: 0,
        expenses: 0,
        netPnL: 0,
        budgetAllocated: 0,
        budgetUsed: 0,
      })
      .returning();

    return created as PersonalPnL;
  }

  /**
   * M2.7: Record income (gold earned)
   */
  async function recordIncomeWithLedger(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    amount: number,
    description: string,
    referenceId?: string,
    referenceType?: string,
    period?: string,
  ): Promise<{ pnl: PersonalPnL; ledger: CoinLedgerEntry }> {
    const p = period || getCurrentPeriod();

    // LEDGER-02: Atomic P&L update + ledger entry in single transaction
    const result = await db.transaction(async (tx) => {
      await lockActorLedgerScope(tx, companyId, actorId, actorType);

      // Get or create P&L within transaction
      const pnlRows = await tx
        .select()
        .from(rt2PersonalPnL)
        .where(
          and(
            eq(rt2PersonalPnL.companyId, companyId),
            eq(rt2PersonalPnL.actorId, actorId),
            eq(rt2PersonalPnL.actorType, actorType),
            eq(rt2PersonalPnL.period, p),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let pnl: PersonalPnL;
      if (pnlRows) {
        pnl = pnlRows as PersonalPnL;
      } else {
        const [created] = await tx
          .insert(rt2PersonalPnL)
          .values({
            companyId,
            actorId,
            actorType,
            period: p,
            income: 0,
            expenses: 0,
            netPnL: 0,
            budgetAllocated: 0,
            budgetUsed: 0,
          })
          .returning();
        pnl = created as PersonalPnL;
      }

      // Update P&L
      const newIncome = pnl.income + amount;
      const newNetPnL = newIncome - pnl.expenses;
      await tx
        .update(rt2PersonalPnL)
        .set({
          income: newIncome,
          netPnL: newNetPnL,
          updatedAt: new Date(),
        })
        .where(eq(rt2PersonalPnL.id, pnl.id));

      // Record in coin ledger (now atomic via Plan 01's SQL subquery)
      const leg: "credit" | "debit" = amount >= 0 ? "credit" : "debit";
      const [ledger] = await tx
        .insert(rt2CoinLedger)
        .values({
          companyId,
          fromActorId: actorId,
          fromActorType: actorType,
          toActorId: actorId,
          toActorType: actorType,
          amount,
          balanceAfter: sql<number>`(
            SELECT COALESCE(SUM(${rt2CoinLedger.amount}), 0) + ${amount}
            FROM ${rt2CoinLedger}
            WHERE ${rt2CoinLedger.companyId} = ${companyId}
              AND ${rt2CoinLedger.toActorId} = ${actorId}
              AND ${rt2CoinLedger.toActorType} = ${actorType}
          )`,
          transactionType: "earned",
          description,
          referenceId: referenceId ?? null,
          referenceType: referenceType ?? null,
          period: p,
          leg,
        })
        .returning();

      return {
        pnl: { ...pnl, income: newIncome, netPnL: newNetPnL } as PersonalPnL,
        ledger: ledger as CoinLedgerEntry,
      };
    });

    return result;
  }

  async function recordIncome(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    amount: number,
    description: string,
    referenceId?: string,
    referenceType?: string,
    period?: string,
  ): Promise<PersonalPnL> {
    const result = await recordIncomeWithLedger(
      companyId,
      actorId,
      actorType,
      amount,
      description,
      referenceId,
      referenceType,
      period,
    );
    return result.pnl;
  }

  /**
   * M2.7: Record expense (gold spent)
   * LEDGER-02: Atomic P&L update + ledger entry in single transaction
   */
  async function recordExpense(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    amount: number,
    description: string,
    referenceId?: string,
    referenceType?: string,
    period?: string,
  ): Promise<PersonalPnL> {
    const p = period || getCurrentPeriod();

    // LEDGER-02: Atomic P&L update + ledger entry in single transaction
    const result = await db.transaction(async (tx) => {
      await lockActorLedgerScope(tx, companyId, actorId, actorType);

      // Get or create P&L within transaction
      const pnlRows = await tx
        .select()
        .from(rt2PersonalPnL)
        .where(
          and(
            eq(rt2PersonalPnL.companyId, companyId),
            eq(rt2PersonalPnL.actorId, actorId),
            eq(rt2PersonalPnL.actorType, actorType),
            eq(rt2PersonalPnL.period, p),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let pnl: PersonalPnL;
      if (pnlRows) {
        pnl = pnlRows as PersonalPnL;
      } else {
        const [created] = await tx
          .insert(rt2PersonalPnL)
          .values({
            companyId,
            actorId,
            actorType,
            period: p,
            income: 0,
            expenses: 0,
            netPnL: 0,
            budgetAllocated: 0,
            budgetUsed: 0,
          })
          .returning();
        pnl = created as PersonalPnL;
      }

      // Update P&L
      const newExpenses = pnl.expenses + amount;
      const newNetPnL = pnl.income - newExpenses;
      await tx
        .update(rt2PersonalPnL)
        .set({
          expenses: newExpenses,
          netPnL: newNetPnL,
          budgetUsed: newExpenses,
          updatedAt: new Date(),
        })
        .where(eq(rt2PersonalPnL.id, pnl.id));

      // Record in coin ledger (now atomic via Plan 01's SQL subquery)
      const ledgerAmount = -amount;
      const leg: "credit" | "debit" = ledgerAmount >= 0 ? "credit" : "debit";
      await tx
        .insert(rt2CoinLedger)
        .values({
          companyId,
          fromActorId: "company",
          fromActorType: "company",
          toActorId: actorId,
          toActorType: actorType,
          amount: ledgerAmount, // expense is negative from company perspective
          balanceAfter: sql<number>`(
            SELECT COALESCE(SUM(${rt2CoinLedger.amount}), 0) + ${ledgerAmount}
            FROM ${rt2CoinLedger}
            WHERE ${rt2CoinLedger.companyId} = ${companyId}
              AND ${rt2CoinLedger.toActorId} = ${actorId}
              AND ${rt2CoinLedger.toActorType} = ${actorType}
          )`,
          transactionType: "spent",
          description,
          referenceId: referenceId ?? null,
          referenceType: referenceType ?? null,
          period: p,
          leg,
        })
        .returning();

      return { ...pnl, expenses: newExpenses, netPnL: newNetPnL, budgetUsed: newExpenses };
    });

    return result;
  }

  /**
   * M2.7: Record coin transaction in ledger
   * LEDGER-01: balanceAfter computed atomically via SQL subquery — no read-then-write race
   */
  async function recordCoinTransaction(
    companyId: string,
    fromActorId: string,
    fromActorType: string,
    toActorId: string,
    toActorType: string,
    amount: number,
    transactionType: CoinLedgerEntry["transactionType"],
    description: string,
    referenceId?: string,
    referenceType?: string,
    period?: string,
  ): Promise<CoinLedgerEntry> {
    const p = period || getCurrentPeriod();

    // Determine leg: positive amount = credit (balance increase), negative = debit (balance decrease)
    const leg: "credit" | "debit" = amount >= 0 ? "credit" : "debit";

    // LEDGER-01/T-27-02: serialize per-actor balance writes, then compute balanceAfter in INSERT.
    return db.transaction(async (tx) => {
      await lockActorLedgerScope(tx, companyId, toActorId, toActorType);
      const [entry] = await tx
        .insert(rt2CoinLedger)
        .values({
          companyId,
          fromActorId,
          fromActorType,
          toActorId,
          toActorType,
          amount,
          // Atomic SQL subquery: computes balance after this entry without application-level read
          balanceAfter: sql<number>`(
            SELECT COALESCE(SUM(${rt2CoinLedger.amount}), 0) + ${amount}
            FROM ${rt2CoinLedger}
            WHERE ${rt2CoinLedger.companyId} = ${companyId}
              AND ${rt2CoinLedger.toActorId} = ${toActorId}
              AND ${rt2CoinLedger.toActorType} = ${toActorType}
          )`,
          transactionType,
          description,
          referenceId: referenceId ?? null,
          referenceType: referenceType ?? null,
          period: p,
          leg,
        })
        .returning();

      return entry as CoinLedgerEntry;
    });
  }

  /**
   * M2.7: Get actor's current coin balance
   */
  async function getActorBalance(
    companyId: string,
    actorId: string,
    actorType: string,
  ): Promise<number> {
    // Sum up all transactions for this actor
    const result = await db
      .select({
        total: sql<number>`COALESCE(SUM(${rt2CoinLedger.amount}), 0)`,
      })
      .from(rt2CoinLedger)
      .where(
        and(
          eq(rt2CoinLedger.companyId, companyId),
          eq(rt2CoinLedger.toActorId, actorId),
          eq(rt2CoinLedger.toActorType, actorType),
        ),
      )
      .then((rows) => rows[0]?.total ?? 0);

    return result;
  }

  /**
   * LEDGER-03: Cross-table P&L reconciliation
   * Compares rt2PersonalPnL income/expenses with rt2CoinLedger sums
   * Returns discrepancies for auditing
   */
  async function reconcileActorPnL(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    period?: string,
  ): Promise<{
    isBalanced: boolean;
    pnlIncome: number;
    pnlExpenses: number;
    ledgerCredits: number;
    ledgerDebits: number;
    incomeDiscrepancy: number;
    expenseDiscrepancy: number;
    discrepancies: string[];
  }> {
    const p = period || getCurrentPeriod();

    // Get P&L values
    const pnlRows = await db
      .select()
      .from(rt2PersonalPnL)
      .where(
        and(
          eq(rt2PersonalPnL.companyId, companyId),
          eq(rt2PersonalPnL.actorId, actorId),
          eq(rt2PersonalPnL.actorType, actorType),
          eq(rt2PersonalPnL.period, p),
        ),
      )
      .then((rows) => rows[0] ?? null);

    const pnlIncome = pnlRows?.income ?? 0;
    const pnlExpenses = pnlRows?.expenses ?? 0;

    // Get ledger sums
    const ledgerCredits = await db
      .select({ sum: sql<number>`COALESCE(SUM(${rt2CoinLedger.amount}), 0)` })
      .from(rt2CoinLedger)
      .where(
        and(
          eq(rt2CoinLedger.companyId, companyId),
          eq(rt2CoinLedger.toActorId, actorId),
          eq(rt2CoinLedger.toActorType, actorType),
          eq(rt2CoinLedger.period, p),
          eq(rt2CoinLedger.leg, "credit"),
        ),
      )
      .then((rows) => Number(rows[0]?.sum ?? 0));

    const ledgerDebits = await db
      .select({ sum: sql<number>`COALESCE(SUM(${rt2CoinLedger.amount}), 0)` })
      .from(rt2CoinLedger)
      .where(
        and(
          eq(rt2CoinLedger.companyId, companyId),
          eq(rt2CoinLedger.toActorId, actorId),
          eq(rt2CoinLedger.toActorType, actorType),
          eq(rt2CoinLedger.period, p),
          eq(rt2CoinLedger.leg, "debit"),
        ),
      )
      .then((rows) => Number(rows[0]?.sum ?? 0));

    const incomeDiscrepancy = Math.abs(pnlIncome - ledgerCredits);
    const expenseDiscrepancy = Math.abs(pnlExpenses - ledgerDebits);
    const isBalanced = incomeDiscrepancy < 0.01 && expenseDiscrepancy < 0.01;

    const discrepancies: string[] = [];
    if (incomeDiscrepancy >= 0.01) {
      discrepancies.push(
        `Income mismatch: P&L reports ${pnlIncome}, ledger credits sum to ${ledgerCredits} (diff: ${incomeDiscrepancy})`,
      );
    }
    if (expenseDiscrepancy >= 0.01) {
      discrepancies.push(
        `Expense mismatch: P&L reports ${pnlExpenses}, ledger debits sum to ${ledgerDebits} (diff: ${expenseDiscrepancy})`,
      );
    }

    return {
      isBalanced,
      pnlIncome,
      pnlExpenses,
      ledgerCredits,
      ledgerDebits,
      incomeDiscrepancy,
      expenseDiscrepancy,
      discrepancies,
    };
  }

  /**
   * M2.7: Get P&L for all actors in a period
   */
  async function getCompanyPnLReport(
    companyId: string,
    period?: string,
  ): Promise<PersonalPnL[]> {
    const p = period || getCurrentPeriod();
    await materializeApprovedDeliverablePnL(companyId, p);

    const report = await db
      .select()
      .from(rt2PersonalPnL)
      .where(
        and(
          eq(rt2PersonalPnL.companyId, companyId),
          eq(rt2PersonalPnL.period, p),
        ),
      )
      .orderBy(desc(rt2PersonalPnL.netPnL));

    return report.map(r => ({
      ...r,
      actorType: r.actorType as "user" | "agent",
    }));
  }

  /**
   * M2.7: Get P&L for a specific actor
   */
  async function getActorPnLHistory(
    companyId: string,
    actorId: string,
    limit: number = 12,
  ): Promise<PersonalPnL[]> {
    await materializeApprovedDeliverablePnL(companyId);

    const history = await db
      .select()
      .from(rt2PersonalPnL)
      .where(
        and(
          eq(rt2PersonalPnL.companyId, companyId),
          eq(rt2PersonalPnL.actorId, actorId),
        ),
      )
      .orderBy(desc(rt2PersonalPnL.period))
      .limit(limit);

    return history.map(r => ({
      ...r,
      actorType: r.actorType as "user" | "agent",
    }));
  }

  /**
   * M2.7: Get coin ledger history for an actor
   */
  async function getActorCoinHistory(
    companyId: string,
    actorId: string,
    limit: number = 50,
  ): Promise<CoinLedgerEntry[]> {
    const entries = await db
      .select()
      .from(rt2CoinLedger)
      .where(
        and(
          eq(rt2CoinLedger.companyId, companyId),
          eq(rt2CoinLedger.toActorId, actorId),
        ),
      )
      .orderBy(desc(rt2CoinLedger.createdAt))
      .limit(limit);

    return entries.map(e => ({
      ...e,
      transactionType: e.transactionType as CoinLedgerEntry["transactionType"],
      leg: e.leg as "credit" | "debit",
    }));
  }

  async function listApprovedDeliverableEntries(
    companyId: string,
    period?: string,
  ): Promise<ApprovedDeliverablePnlEntry[]> {
    const p = period || getCurrentPeriod();
    const rows = await db
      .select({
        workProductId: issueWorkProducts.id,
        taskIssueId: issueWorkProducts.issueId,
        projectId: issueWorkProducts.projectId,
        title: issueWorkProducts.title,
        type: issueWorkProducts.type,
        metadata: issueWorkProducts.metadata,
        qualityScoreId: rt2QualityScores.id,
        qualityScore: rt2QualityScores.score,
        basePrice: rt2QualityScores.basePrice,
        approvalMode: rt2QualityScores.evaluationMode,
        approvedAt: rt2QualityScores.updatedAt,
        assigneeUserId: issues.assigneeUserId,
        assigneeAgentId: issues.assigneeAgentId,
      })
      .from(issueWorkProducts)
      .innerJoin(issues, eq(issueWorkProducts.issueId, issues.id))
      .innerJoin(
        rt2QualityScores,
        and(
          eq(rt2QualityScores.taskIssueId, issueWorkProducts.issueId),
          eq(rt2QualityScores.companyId, issueWorkProducts.companyId),
        ),
      )
      .where(
        and(
          eq(issueWorkProducts.companyId, companyId),
          eq(rt2QualityScores.managerDecision, "approved"),
          eq(rt2QualityScores.isFinalized, 1),
          eq(rt2QualityScores.isActive, 1),
          sql`${rt2QualityScores.updatedAt} >= to_timestamp(${`${p}-01`}, 'YYYY-MM-DD')`,
          sql`${rt2QualityScores.updatedAt} < (to_timestamp(${`${p}-01`}, 'YYYY-MM-DD') + interval '1 month')`,
        ),
      )
      .orderBy(desc(rt2QualityScores.updatedAt));

    const entries: ApprovedDeliverablePnlEntry[] = [];
    for (const row of rows) {
      const participants = await db
        .select({ userId: rt2V33TaskParticipants.userId })
        .from(rt2V33TaskParticipants)
        .where(
          and(
            eq(rt2V33TaskParticipants.companyId, companyId),
            eq(rt2V33TaskParticipants.taskIssueId, row.taskIssueId),
            eq(rt2V33TaskParticipants.state, "active"),
          ),
        );
      const ownerIds =
        participants.length > 0
          ? participants.map((pRow) => ({ actorId: pRow.userId, actorType: "user" as const }))
          : row.assigneeUserId
            ? [{ actorId: row.assigneeUserId, actorType: "user" as const }]
            : row.assigneeAgentId
              ? [{ actorId: row.assigneeAgentId, actorType: "agent" as const }]
              : [{ actorId: "company", actorType: "agent" as const }];

      const metadataPrice = getNumberMetadata(row.metadata, "rt2BasePrice");
      const totalRevenue = row.basePrice ?? metadataPrice ?? row.qualityScore;
      const splitRevenue = Math.max(0, Math.round(totalRevenue / Math.max(1, ownerIds.length)));

      for (const owner of ownerIds) {
        entries.push({
          workProductId: row.workProductId,
          taskIssueId: row.taskIssueId,
          projectId: row.projectId,
          title: row.title,
          type: row.type,
          ownerActorId: owner.actorId,
          ownerActorType: owner.actorType,
          revenue: splitRevenue,
          qualityScore: row.qualityScore,
          qualityScoreId: row.qualityScoreId,
          approvalMode: row.approvalMode,
          approvedAt: row.approvedAt,
        });
      }
    }

    return entries;
  }

  async function materializeApprovedDeliverablePnL(companyId: string, period?: string): Promise<void> {
    const p = period || getCurrentPeriod();
    const entries = await listApprovedDeliverableEntries(companyId, p);
    for (const entry of entries) {
      const existingLedger = await db
        .select({ id: rt2CoinLedger.id })
        .from(rt2CoinLedger)
        .where(
          and(
            eq(rt2CoinLedger.companyId, companyId),
            eq(rt2CoinLedger.toActorId, entry.ownerActorId),
            eq(rt2CoinLedger.toActorType, entry.ownerActorType),
            eq(rt2CoinLedger.referenceId, entry.workProductId),
            eq(rt2CoinLedger.referenceType, "approved_deliverable"),
          ),
        )
        .limit(1);

      if (existingLedger.length > 0) continue;

      await recordIncome(
        companyId,
        entry.ownerActorId,
        entry.ownerActorType,
        entry.revenue,
        `Approved deliverable: ${entry.title}`,
        entry.workProductId,
        "approved_deliverable",
        p,
      );
    }
  }

  async function getActorPnLDrilldown(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    period?: string,
  ): Promise<ActorPnLDrilldown> {
    const p = period || getCurrentPeriod();
    await materializeApprovedDeliverablePnL(companyId, p);
    const pnl = await getOrCreatePnL(companyId, actorId, actorType, p);
    const [approvedDeliverables, ledgerEntries] = await Promise.all([
      listApprovedDeliverableEntries(companyId, p).then((entries) =>
        entries.filter((entry) => entry.ownerActorId === actorId && entry.ownerActorType === actorType),
      ),
      getActorCoinHistory(companyId, actorId, 100),
    ]);

    return {
      ...pnl,
      approvedDeliverables,
      ledgerEntries: ledgerEntries.filter((entry) => entry.period === p),
      revenueFromApprovedDeliverables: approvedDeliverables.reduce((sum, entry) => sum + entry.revenue, 0),
    };
  }

  async function detectSettlementSignals(
    companyId: string,
    entry: ApprovedDeliverablePnlEntry,
    period: string,
    thresholds: SettlementThresholdSettings,
  ): Promise<SettlementAntiGamingSignal[]> {
    const qualityRows = await db
      .select({
        evaluator: rt2QualityScores.evaluator,
        score: rt2QualityScores.score,
        evaluationMode: rt2QualityScores.evaluationMode,
      })
      .from(rt2QualityScores)
      .where(
        and(
          eq(rt2QualityScores.companyId, companyId),
          eq(rt2QualityScores.taskIssueId, entry.taskIssueId),
          eq(rt2QualityScores.managerDecision, "approved"),
          eq(rt2QualityScores.isFinalized, 1),
        ),
      );
    const ledgerStats = await db
      .select({
        count: sql<number>`count(*)::int`,
        total: sql<number>`COALESCE(SUM(${rt2CoinLedger.amount}), 0)::int`,
      })
      .from(rt2CoinLedger)
      .where(
        and(
          eq(rt2CoinLedger.companyId, companyId),
          eq(rt2CoinLedger.toActorId, entry.ownerActorId),
          eq(rt2CoinLedger.toActorType, entry.ownerActorType),
          eq(rt2CoinLedger.period, period),
          eq(rt2CoinLedger.transactionType, "earned"),
        ),
      )
      .then((rows) => rows[0] ?? { count: 0, total: 0 });
    const signals: SettlementAntiGamingSignal[] = [];
    const selfReviews = qualityRows.filter((row) => row.evaluator === entry.ownerActorId).length;
    if (selfReviews > 0) {
      signals.push({
        key: "repeated_self_review",
        label: "Self-review 반복",
        severity: selfReviews >= thresholds.selfReviewCriticalCount ? "critical" : "warning",
        evidence: `${entry.ownerActorId} evaluated ${selfReviews} score(s) on their own settlement task.`,
        thresholdBasis: `critical at ${thresholds.selfReviewCriticalCount}+ self-review score(s) in ${thresholds.evaluationWindowDays}d window`,
      });
    }
    const earnedCount = Number(ledgerStats.count) || 0;
    const earnedTotal = Number(ledgerStats.total) || 0;
    const warningGold = Math.max(thresholds.goldFarmingWarningGold, entry.revenue * thresholds.goldFarmingWarningMultiplier);
    const criticalGold = Math.max(thresholds.goldFarmingCriticalGold, entry.revenue * thresholds.goldFarmingCriticalMultiplier);
    if (earnedCount >= thresholds.goldFarmingEarnedCount || earnedTotal >= warningGold) {
      signals.push({
        key: "abnormal_gold_farming",
        label: "Gold farming 이상치",
        severity: earnedTotal >= criticalGold ? "critical" : "warning",
        evidence: `${entry.ownerActorId} has ${earnedCount} earned ledger entries totaling ${earnedTotal}G in ${period}.`,
        thresholdBasis: `warning at ${thresholds.goldFarmingEarnedCount}+ earned entries or ${warningGold}G; critical at ${criticalGold}G`,
      });
    }
    const maxScore = Math.max(entry.qualityScore, ...qualityRows.map((row) => row.score));
    if (maxScore >= thresholds.qualityBiasAutoScore && qualityRows.some((row) => row.evaluationMode === "auto")) {
      signals.push({
        key: "quality_score_bias",
        label: "품질 점수 편향",
        severity: "warning",
        evidence: `Auto-approved quality score reached ${maxScore}; settlement reviewer should confirm the basis.`,
        thresholdBasis: `auto-evaluated score >= ${thresholds.qualityBiasAutoScore}`,
      });
    }
    return signals;
  }

  async function ensureSettlementRows(companyId: string, period?: string): Promise<SettlementFlow[]> {
    const p = period || getCurrentPeriod();
    const thresholds = await getSettlementThresholds(companyId);
    const entries = await listApprovedDeliverableEntries(companyId, p);
    for (const entry of entries) {
      const existing = await db
        .select({ id: rt2SettlementGovernance.id })
        .from(rt2SettlementGovernance)
        .where(
          and(
            eq(rt2SettlementGovernance.companyId, companyId),
            eq(rt2SettlementGovernance.workProductId, entry.workProductId),
          ),
        )
        .limit(1);
      if (existing.length > 0) continue;

      const signals = await detectSettlementSignals(companyId, entry, p, thresholds);
      const gate = deriveSettlementGate(entry, signals, thresholds);
      const [settlement] = await db
        .insert(rt2SettlementGovernance)
        .values({
          companyId,
          workProductId: entry.workProductId,
          taskIssueId: entry.taskIssueId,
          ownerActorId: entry.ownerActorId,
          ownerActorType: entry.ownerActorType,
          proposedPriceGold: entry.revenue,
          rationale: `Quality score ${entry.qualityScore}, approved deliverable ${entry.title}, and participant split produced ${entry.revenue}G.`,
          status: gate.status,
          approvalRequired: gate.approvalRequired ? 1 : 0,
          approvalGateReason: gate.approvalGateReason,
          riskLevel: gate.riskLevel,
          antiGamingSignals: signals,
          pnlPeriod: p,
        })
        .onConflictDoNothing({
          target: [rt2SettlementGovernance.companyId, rt2SettlementGovernance.workProductId],
        })
        .returning();
      if (!settlement) continue;

      for (const signal of signals) {
        await db.insert(rt2AntiGamingSignals).values({
          companyId,
          settlementId: settlement.id,
          actorId: entry.ownerActorId,
          actorType: entry.ownerActorType,
          signalType: signal.key,
          severity: signal.severity,
          evidence: signal.evidence,
          referenceId: entry.workProductId,
          referenceType: "settlement",
        });
      }
    }

    const rows = await db
      .select()
      .from(rt2SettlementGovernance)
      .where(and(eq(rt2SettlementGovernance.companyId, companyId), eq(rt2SettlementGovernance.pnlPeriod, p)))
      .orderBy(desc(rt2SettlementGovernance.updatedAt));
    return Promise.all(rows.map(enrichSettlementFlow));
  }

  async function getSettlementOverview(companyId: string, period?: string): Promise<SettlementOverview> {
    const p = period || getCurrentPeriod();
    const settlements = await ensureSettlementRows(companyId, p);
    return {
      companyId,
      period: p,
      settlements,
      summary: settlementSummary(settlements),
      thresholds: await getSettlementThresholds(companyId),
    };
  }

  async function addSettlementComment(
    companyId: string,
    settlementId: string,
    input: { actorId: string; actorType: "user" | "agent" | "system"; comment: string },
  ): Promise<SettlementFlow> {
    const row = await db
      .select()
      .from(rt2SettlementGovernance)
      .where(and(eq(rt2SettlementGovernance.companyId, companyId), eq(rt2SettlementGovernance.id, settlementId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("Settlement not found");
    const comments = row.negotiationComments ?? [];
    const [updated] = await db
      .update(rt2SettlementGovernance)
      .set({
        negotiationComments: [
          ...comments,
          {
            actorId: input.actorId,
            actorType: input.actorType,
            comment: input.comment,
            createdAt: new Date().toISOString(),
          },
        ],
        updatedAt: new Date(),
      })
      .where(eq(rt2SettlementGovernance.id, settlementId))
      .returning();
    return enrichSettlementFlow(updated);
  }

  async function approveSettlement(
    companyId: string,
    settlementId: string,
    input: { approverId: string; finalPriceGold?: number; decisionReason?: string },
  ): Promise<SettlementFlow> {
    const row = await db
      .select()
      .from(rt2SettlementGovernance)
      .where(and(eq(rt2SettlementGovernance.companyId, companyId), eq(rt2SettlementGovernance.id, settlementId)))
      .then((rows) => rows[0] ?? null);
    if (!row) throw new Error("Settlement not found");
    if (row.status === "approved") return enrichSettlementFlow(row);
    const finalPrice = input.finalPriceGold ?? row.finalPriceGold ?? row.proposedPriceGold;
    const { ledger } = await recordIncomeWithLedger(
      companyId,
      row.ownerActorId,
      row.ownerActorType as "user" | "agent",
      finalPrice,
      `Approved settlement: ${row.workProductId}`,
      row.id,
      "settlement",
      row.pnlPeriod ?? undefined,
    );
    const [updated] = await db
      .update(rt2SettlementGovernance)
      .set({
        finalPriceGold: finalPrice,
        status: "approved",
        approverId: input.approverId,
        decisionReason: input.decisionReason ?? null,
        ledgerEntryId: ledger.id,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(rt2SettlementGovernance.id, settlementId))
      .returning();
    await db
      .update(rt2AntiGamingSignals)
      .set({ usedInDecision: row.antiGamingSignals.length > 0 ? 1 : 0 })
      .where(eq(rt2AntiGamingSignals.settlementId, settlementId));
    return enrichSettlementFlow(updated);
  }

  async function rejectSettlement(
    companyId: string,
    settlementId: string,
    input: { approverId: string; decisionReason: string },
  ): Promise<SettlementFlow> {
    const [updated] = await db
      .update(rt2SettlementGovernance)
      .set({
        status: "rejected",
        approverId: input.approverId,
        decisionReason: input.decisionReason,
        decidedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(and(eq(rt2SettlementGovernance.companyId, companyId), eq(rt2SettlementGovernance.id, settlementId)))
      .returning();
    if (!updated) throw new Error("Settlement not found");
    await db
      .update(rt2AntiGamingSignals)
      .set({ usedInDecision: updated.antiGamingSignals.length > 0 ? 1 : 0 })
      .where(eq(rt2AntiGamingSignals.settlementId, settlementId));
    return enrichSettlementFlow(updated);
  }

  /**
   * M2.7: Transfer coins between actors
   * LEDGER-02: Atomic transaction wrapping all operations (rollback on any failure)
   */
  async function transferCoins(
    companyId: string,
    fromActorId: string,
    fromActorType: "user" | "agent",
    toActorId: string,
    toActorType: "user" | "agent",
    amount: number,
    description: string,
  ): Promise<{ from: PersonalPnL; to: PersonalPnL }> {
    const p = getCurrentPeriod();

    // LEDGER-02: Single atomic transaction for entire transfer
    const result = await db.transaction(async (tx) => {
      await lockActorLedgerScopes(tx, companyId, [
        { actorId: fromActorId, actorType: fromActorType },
        { actorId: toActorId, actorType: toActorType },
      ]);

      // 1. Deduct from sender (record as expense for sender)
      const senderPnlRows = await tx
        .select()
        .from(rt2PersonalPnL)
        .where(
          and(
            eq(rt2PersonalPnL.companyId, companyId),
            eq(rt2PersonalPnL.actorId, fromActorId),
            eq(rt2PersonalPnL.actorType, fromActorType),
            eq(rt2PersonalPnL.period, p),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let fromPnL: PersonalPnL;
      if (senderPnlRows) {
        fromPnL = senderPnlRows as PersonalPnL;
      } else {
        const [created] = await tx
          .insert(rt2PersonalPnL)
          .values({ companyId, actorId: fromActorId, actorType: fromActorType, period: p, income: 0, expenses: 0, netPnL: 0, budgetAllocated: 0, budgetUsed: 0 })
          .returning();
        fromPnL = created as PersonalPnL;
      }

      const newSenderExpenses = fromPnL.expenses + amount;
      const newSenderNetPnL = fromPnL.income - newSenderExpenses;
      await tx
        .update(rt2PersonalPnL)
        .set({ expenses: newSenderExpenses, netPnL: newSenderNetPnL, budgetUsed: newSenderExpenses, updatedAt: new Date() })
        .where(eq(rt2PersonalPnL.id, fromPnL.id));

      // 2. Add to receiver (record as income for receiver)
      const receiverPnlRows = await tx
        .select()
        .from(rt2PersonalPnL)
        .where(
          and(
            eq(rt2PersonalPnL.companyId, companyId),
            eq(rt2PersonalPnL.actorId, toActorId),
            eq(rt2PersonalPnL.actorType, toActorType),
            eq(rt2PersonalPnL.period, p),
          ),
        )
        .then((rows) => rows[0] ?? null);

      let toPnL: PersonalPnL;
      if (receiverPnlRows) {
        toPnL = receiverPnlRows as PersonalPnL;
      } else {
        const [created] = await tx
          .insert(rt2PersonalPnL)
          .values({ companyId, actorId: toActorId, actorType: toActorType, period: p, income: 0, expenses: 0, netPnL: 0, budgetAllocated: 0, budgetUsed: 0 })
          .returning();
        toPnL = created as PersonalPnL;
      }

      const newReceiverIncome = toPnL.income + amount;
      const newReceiverNetPnL = newReceiverIncome - toPnL.expenses;
      await tx
        .update(rt2PersonalPnL)
        .set({ income: newReceiverIncome, netPnL: newReceiverNetPnL, updatedAt: new Date() })
        .where(eq(rt2PersonalPnL.id, toPnL.id));

      // 3. Record transfer ledger entry (atomic balanceAfter via SQL subquery)
      const leg: "credit" | "debit" = amount >= 0 ? "credit" : "debit";
      await tx
        .insert(rt2CoinLedger)
        .values({
          companyId,
          fromActorId,
          fromActorType,
          toActorId,
          toActorType,
          amount,
          balanceAfter: sql<number>`(
            SELECT COALESCE(SUM(${rt2CoinLedger.amount}), 0) + ${amount}
            FROM ${rt2CoinLedger}
            WHERE ${rt2CoinLedger.companyId} = ${companyId}
              AND ${rt2CoinLedger.toActorId} = ${toActorId}
              AND ${rt2CoinLedger.toActorType} = ${toActorType}
          )`,
          transactionType: "transferred",
          description,
          referenceId: null,
          referenceType: null,
          period: p,
          leg,
        })
        .returning();

      return {
        from: { ...fromPnL, expenses: newSenderExpenses, netPnL: newSenderNetPnL, budgetUsed: newSenderExpenses },
        to: { ...toPnL, income: newReceiverIncome, netPnL: newReceiverNetPnL },
      };
    });

    return result;
  }

  /**
   * M2.7: Allocate budget to actor
   */
  async function allocateBudget(
    companyId: string,
    actorId: string,
    actorType: "user" | "agent",
    amount: number,
  ): Promise<PersonalPnL> {
    const period = getCurrentPeriod();
    const pnl = await getOrCreatePnL(companyId, actorId, actorType, period);

    await db
      .update(rt2PersonalPnL)
      .set({
        budgetAllocated: amount,
        updatedAt: new Date(),
      })
      .where(eq(rt2PersonalPnL.id, pnl.id));

    return {
      ...pnl,
      budgetAllocated: amount,
    };
  }

  /**
   * M2.7: Get company-wide P&L summary
   */
  async function getCompanyPnLSummary(companyId: string, period?: string): Promise<{
    totalIncome: number;
    totalExpenses: number;
    netPnL: number;
    activeActors: number;
    topEarners: { actorId: string; actorType: string; income: number }[];
    approvedDeliverableRevenue: number;
    approvedDeliverableCount: number;
    ledgerEntryCount: number;
    calculationEvidence: PnLCalculationEvidence;
  }> {
    const p = period || getCurrentPeriod();
    await materializeApprovedDeliverablePnL(companyId, p);

    const report = await getCompanyPnLReport(companyId, p);
    const approvedDeliverables = await listApprovedDeliverableEntries(companyId, p);
    const ledgerEntries = await db
      .select({
        transactionType: rt2CoinLedger.transactionType,
        count: sql<number>`count(*)::int`,
      })
      .from(rt2CoinLedger)
      .where(and(eq(rt2CoinLedger.companyId, companyId), eq(rt2CoinLedger.period, p)))
      .groupBy(rt2CoinLedger.transactionType);
    const ledgerEntryCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(rt2CoinLedger)
      .where(and(eq(rt2CoinLedger.companyId, companyId), eq(rt2CoinLedger.period, p)))
      .then((rows) => rows[0]?.count ?? 0);

    const totalIncome = report.reduce((sum, r) => sum + r.income, 0);
    const totalExpenses = report.reduce((sum, r) => sum + r.expenses, 0);
    const activeActors = report.filter(r => r.income > 0 || r.expenses > 0).length;

    const topEarners = [...report]
      .sort((a, b) => b.income - a.income)
      .slice(0, 5)
      .map(r => ({
        actorId: r.actorId,
        actorType: r.actorType,
        income: r.income,
      }));
    const approvedDeliverableRevenue = approvedDeliverables.reduce((sum, entry) => sum + entry.revenue, 0);
    const approvedDeliverableCount = new Set(approvedDeliverables.map((entry) => entry.workProductId)).size;
    const ledgerByType = Object.fromEntries(
      ledgerEntries.map((entry) => [entry.transactionType, Number(entry.count) || 0]),
    );
    const warnings: string[] = [];
    if (approvedDeliverableCount === 0) {
      warnings.push("No approved deliverable evidence has settled into P&L for this period.");
    }
    if (ledgerEntryCount === 0) {
      warnings.push("No coin ledger entries exist for this period.");
    }
    const settlementStatus =
      approvedDeliverableCount > 0 && ledgerEntryCount > 0
        ? "ready"
        : approvedDeliverableCount > 0 || ledgerEntryCount > 0
          ? "partial"
          : "missing";

    return {
      totalIncome,
      totalExpenses,
      netPnL: totalIncome - totalExpenses,
      activeActors,
      topEarners,
      approvedDeliverableRevenue,
      approvedDeliverableCount,
      ledgerEntryCount,
      calculationEvidence: {
        settlementStatus,
        period: p,
        approvedDeliverableCount,
        approvedDeliverableRevenue,
        ledgerEntryCount,
        ledgerByType,
        sourceTables: [
          "issue_work_products",
          "rt2_quality_scores",
          "rt2_coin_ledger",
          "rt2_personal_pnl",
          "rt2_v33_task_participants",
        ],
        warnings,
      },
    };
  }

  return {
    getOrCreatePnL,
    recordIncome,
    recordExpense,
    recordCoinTransaction,
    reconcileActorPnL,
    getActorBalance,
    getCompanyPnLReport,
    getActorPnLHistory,
    getActorCoinHistory,
    getActorPnLDrilldown,
    getSettlementOverview,
    getSettlementThresholds,
    updateSettlementThresholds,
    addSettlementComment,
    approveSettlement,
    rejectSettlement,
    listApprovedDeliverableEntries,
    materializeApprovedDeliverablePnL,
    transferCoins,
    allocateBudget,
    getCompanyPnLSummary,
  };
}
