export type WindowCount = { count: number; atLeast: boolean };

export function countSince<T extends { createdAt: string | Date }>(
  rows: readonly T[],
  since: number,
  limit: number,
  match: (row: T) => boolean = () => true,
): WindowCount {
  let count = 0;
  let oldest = Infinity;
  for (const row of rows) {
    const at = new Date(row.createdAt).getTime();
    oldest = Math.min(oldest, at);
    if (at >= since && match(row)) count += 1;
  }
  return { count, atLeast: rows.length >= limit && oldest >= since };
}

export function formatWindowCount({ count, atLeast }: WindowCount) {
  return atLeast ? `${count}+` : String(count);
}
