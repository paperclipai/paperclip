export type MemoryPageFilter = "needs_review" | "verified" | "all";

export interface MemoryPageParams {
  filter: MemoryPageFilter;
  query: string;
  page: number;
  pageSize: number;
  offset: number;
}

export function normalizeMemoryPageParams(
  params: Record<string, unknown> | null | undefined,
): MemoryPageParams {
  const input = params ?? {};
  const requestedFilter = String(input.filter ?? "needs_review");
  const filter: MemoryPageFilter =
    requestedFilter === "verified" || requestedFilter === "all"
      ? requestedFilter
      : "needs_review";
  const query = String(input.query ?? "").trim().slice(0, 120);
  const pageSize = Math.min(Math.max(Number(input.pageSize) || 25, 10), 50);
  const page = Math.max(Number(input.page) || 1, 1);

  return {
    filter,
    query,
    page,
    pageSize,
    offset: (page - 1) * pageSize,
  };
}
