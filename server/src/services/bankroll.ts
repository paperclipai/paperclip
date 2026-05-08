import type { Db } from "@paperclipai/db";
import { bettingBankrollSnapshots, bettingPlacedBets, bettingPredictions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { logger } from "../middleware/logger.js";

const DRAWDOWN_ALERT_THRESHOLD = 0.20;

export async function resolveBet(
  db: Db,
  betId: string,
  outcome: "won" | "lost" | "void",
): Promise<void> {
  const [bet] = await db
    .select()
    .from(bettingPlacedBets)
    .where(eq(bettingPlacedBets.id, betId));
  if (!bet) return;

  const profitLoss =
    outcome === "won" ? bet.stake * (bet.odds - 1) :
    outcome === "lost" ? -bet.stake : 0;

  await db
    .update(bettingPlacedBets)
    .set({ status: outcome, profitLoss, resolvedAt: new Date(), updatedAt: new Date() })
    .where(eq(bettingPlacedBets.id, betId));

  if (outcome !== "void" && bet.predictionId) {
    await db
      .update(bettingPredictions)
      .set({ status: outcome, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(bettingPredictions.id, bet.predictionId));
  }

  logger.info({ betId, outcome, profitLoss: profitLoss.toFixed(2) }, "bankroll: bet resolved");
}

export async function snapshotBankroll(
  db: Db,
  companyId: string,
  currentBalance: number,
  currency = "RON",
): Promise<{ drawdownAlert: boolean; roi: number | null }> {
  const allBets = await db
    .select({ status: bettingPlacedBets.status, stake: bettingPlacedBets.stake, profitLoss: bettingPlacedBets.profitLoss })
    .from(bettingPlacedBets)
    .where(eq(bettingPlacedBets.companyId, companyId));

  const totalBets = allBets.length;
  const wonBets = allBets.filter((b) => b.status === "won").length;
  const lostBets = allBets.filter((b) => b.status === "lost").length;
  const voidBets = allBets.filter((b) => b.status === "void").length;
  const totalStaked = allBets.reduce((s, b) => s + (b.stake ?? 0), 0);
  const netPnl = allBets.reduce((s, b) => s + (b.profitLoss ?? 0), 0);
  const totalReturn = totalStaked + netPnl;
  const roi = totalStaked > 0 ? ((totalReturn - totalStaked) / totalStaked) * 100 : null;

  await db.insert(bettingBankrollSnapshots).values({
    companyId,
    balance: currentBalance,
    currency,
    totalBets,
    wonBets,
    lostBets,
    voidBets,
    totalStaked,
    totalReturn,
    roi: roi ?? undefined,
  });

  // Check drawdown: compare last two snapshots
  const recent = await db
    .select({ balance: bettingBankrollSnapshots.balance })
    .from(bettingBankrollSnapshots)
    .where(eq(bettingBankrollSnapshots.companyId, companyId))
    .orderBy(bettingBankrollSnapshots.snapshotAt)
    .limit(20);

  let drawdownAlert = false;
  if (recent.length >= 2) {
    const peak = Math.max(...recent.map((r) => r.balance));
    const drawdown = peak > 0 ? (peak - currentBalance) / peak : 0;
    if (drawdown >= DRAWDOWN_ALERT_THRESHOLD) {
      drawdownAlert = true;
      logger.warn(
        { companyId, peak, currentBalance, drawdownPct: (drawdown * 100).toFixed(1) },
        "bankroll: drawdown threshold exceeded",
      );
    }
  }

  logger.info(
    { companyId, balance: currentBalance, roi: roi?.toFixed(2), totalBets, wonBets, lostBets },
    "bankroll: snapshot stored",
  );

  return { drawdownAlert, roi };
}
