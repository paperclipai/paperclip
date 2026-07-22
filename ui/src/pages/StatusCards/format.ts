import type { StatusCardUpdate } from "@paperclipai/shared";

/** "1.1k tok" / "940 tok" — compact token count for footers and chips. */
export function formatTokens(tokens: number | null | undefined): string | null {
  if (tokens === null || tokens === undefined) return null;
  if (tokens < 1000) return `${tokens} tok`;
  return `${(tokens / 1000).toFixed(1)}k tok`;
}

/**
 * Dollar cost from integer cents. Uses more precision for sub-cent amounts so a
 * $0.006 incremental update does not collapse to $0.01.
 */
export function formatCents(cents: number | null | undefined): string | null {
  if (cents === null || cents === undefined) return null;
  const dollars = cents / 100;
  if (dollars === 0) return "$0.00";
  if (dollars < 0.1) return `$${dollars.toFixed(3)}`;
  return `$${dollars.toFixed(2)}`;
}

/** Roll up an update ledger into today's token + cost totals and a count. */
export function rollupUpdates(updates: StatusCardUpdate[]): {
  updateCount: number;
  totalTokens: number;
  totalCostCents: number;
} {
  return updates.reduce(
    (acc, update) => ({
      updateCount: acc.updateCount + 1,
      totalTokens: acc.totalTokens + update.inputTokens + update.outputTokens,
      totalCostCents: acc.totalCostCents + update.costCents,
    }),
    { updateCount: 0, totalTokens: 0, totalCostCents: 0 },
  );
}

/** "0.4k in / 0.2k out" — the per-update token split shown in history rows. */
export function formatTokenSplit(inputTokens: number, outputTokens: number): string {
  const fmt = (n: number) => (n < 1000 ? `${n}` : `${(n / 1000).toFixed(1)}k`);
  return `${fmt(inputTokens)} in / ${fmt(outputTokens)} out`;
}

/** Human label for an update's kind. */
export function updateKindLabel(kind: StatusCardUpdate["kind"]): string {
  switch (kind) {
    case "compile":
      return "compile";
    case "full":
      return "full rebuild";
    case "incremental":
      return "incremental";
    default:
      return kind;
  }
}
