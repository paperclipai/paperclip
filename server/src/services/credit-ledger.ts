import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { creditBurnRates, creditLedger } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";

export type CreditActionType =
  | "heartbeat_light"
  | "heartbeat_complex"
  | "multi_agent_orchestration"
  | "approval_workflow"
  | "external_api_call";

export interface CreditGrantInput {
  accountId: string;
  amount: number;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  idempotencyKey: string;
  metadata?: {
    stripeInvoiceId?: string;
    stripeSubscriptionId?: string;
    [key: string]: unknown;
  };
}

export interface CreditBurnInput {
  accountId: string;
  actionType: CreditActionType;
  runId: string;
  agentId?: string;
  billingPeriodStart: Date;
  billingPeriodEnd: Date;
  // override default credits for this action (e.g. complex tool use)
  creditsOverride?: number;
}

export interface PreflightResult {
  allowed: boolean;
  balance: number;
  isOverage: boolean;
  reason?: string;
}

export interface AccountOveragePolicy {
  /** true when the account is on a paid plan and may incur overage charges */
  overageAllowed: boolean;
  overageLimitCredits?: number;
}

function currentUtcMonthWindow(now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  return {
    start: new Date(Date.UTC(year, month, 1, 0, 0, 0, 0)),
    end: new Date(Date.UTC(year, month + 1, 1, 0, 0, 0, 0)),
  };
}

export function creditLedgerService(db: Db) {
  async function getBalance(accountId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    const [row] = await db
      .select({ balance: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int` })
      .from(creditLedger)
      .where(
        and(
          eq(creditLedger.accountId, accountId),
          gte(creditLedger.createdAt, periodStart),
          lt(creditLedger.createdAt, periodEnd),
        ),
      );
    return Number(row?.balance ?? 0);
  }

  async function getBurnRate(actionType: CreditActionType): Promise<{ min: number; max: number; default: number }> {
    const row = await db
      .select()
      .from(creditBurnRates)
      .where(eq(creditBurnRates.actionType, actionType))
      .then((rows) => rows[0] ?? null);

    if (!row) {
      // Unknown action types default to 1 credit
      return { min: 1, max: 1, default: 1 };
    }
    return { min: row.creditsMin, max: row.creditsMax, default: row.creditsDefault };
  }

  /**
   * Pre-flight check: called before an agent action to decide if it can proceed.
   * Non-blocking — does not write to the ledger.
   */
  async function preflight(
    accountId: string,
    actionType: CreditActionType,
    policy: AccountOveragePolicy,
  ): Promise<PreflightResult> {
    const { start, end } = currentUtcMonthWindow();
    const balance = await getBalance(accountId, start, end);
    const rate = await getBurnRate(actionType);

    if (balance >= rate.default) {
      return { allowed: true, balance, isOverage: false };
    }

    if (policy.overageAllowed) {
      const overageUsed = Math.abs(Math.min(balance, 0));
      const overageLimit = policy.overageLimitCredits ?? Infinity;
      if (overageUsed < overageLimit) {
        return { allowed: true, balance, isOverage: true };
      }
      return {
        allowed: false,
        balance,
        isOverage: true,
        reason: "Overage limit reached",
      };
    }

    return {
      allowed: false,
      balance,
      isOverage: false,
      reason: "Insufficient credits",
    };
  }

  /**
   * Async (fire-and-forget) burn — deducts credits after a successful agent action.
   * Uses idempotency key to prevent double-burns.
   */
  async function burn(input: CreditBurnInput): Promise<void> {
    const { min, max, default: defaultCredits } = await getBurnRate(input.actionType);
    const credits = input.creditsOverride
      ? Math.max(min, Math.min(max, input.creditsOverride))
      : defaultCredits;

    try {
      await db
        .insert(creditLedger)
        .values({
          accountId: input.accountId,
          eventType: "burn",
          amount: -credits,
          billingPeriodStart: input.billingPeriodStart,
          billingPeriodEnd: input.billingPeriodEnd,
          idempotencyKey: `burn:${input.runId}:${input.actionType}`,
          metadata: {
            runId: input.runId,
            agentId: input.agentId,
            actionType: input.actionType,
          },
        })
        .onConflictDoNothing();
    } catch (err) {
      logger.error({ err, runId: input.runId, actionType: input.actionType }, "credit burn failed");
    }
  }

  /**
   * Grant credits to an account — called on Stripe `invoice.paid` webhook.
   * Idempotent: re-entrant calls with the same key are no-ops.
   */
  async function grant(input: CreditGrantInput): Promise<void> {
    await db
      .insert(creditLedger)
      .values({
        accountId: input.accountId,
        eventType: "subscription_grant",
        amount: input.amount,
        billingPeriodStart: input.billingPeriodStart,
        billingPeriodEnd: input.billingPeriodEnd,
        idempotencyKey: input.idempotencyKey,
        metadata: input.metadata ?? null,
      })
      .onConflictDoNothing();
  }

  /**
   * Returns credits consumed beyond the granted balance in the current billing period.
   * Used by the daily Stripe overage batch job.
   */
  async function getOverageCredits(accountId: string, periodStart: Date, periodEnd: Date): Promise<number> {
    const balance = await getBalance(accountId, periodStart, periodEnd);
    return balance < 0 ? Math.abs(balance) : 0;
  }

  /**
   * Collects all accounts with overage in the given period.
   * Returns { accountId, overageCredits } pairs for Stripe metered usage reporting.
   */
  async function collectOverageReport(periodStart: Date, periodEnd: Date) {
    const rows = await db
      .select({
        accountId: creditLedger.accountId,
        balance: sql<number>`coalesce(sum(${creditLedger.amount}), 0)::int`,
      })
      .from(creditLedger)
      .where(
        and(
          gte(creditLedger.createdAt, periodStart),
          lt(creditLedger.createdAt, periodEnd),
        ),
      )
      .groupBy(creditLedger.accountId)
      .having(sql`sum(${creditLedger.amount}) < 0`);

    return rows.map((r) => ({
      accountId: r.accountId,
      overageCredits: Math.abs(Number(r.balance)),
    }));
  }

  return { preflight, burn, grant, getBalance, getOverageCredits, collectOverageReport, getBurnRate };
}

export type CreditLedgerService = ReturnType<typeof creditLedgerService>;
