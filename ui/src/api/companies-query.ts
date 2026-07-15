import type { Company } from "@paperclipai/shared";
import { companiesApi } from "./companies";
import { ApiError } from "./client";
import { queryKeys } from "../lib/queryKeys";

export type CompanyListResult = { companies: Company[]; unauthorized: boolean };

// Single source of truth for the `["companies"]` query. Both CompanyProvider and
// the invite landing page read this cache entry, so they must agree on the shape —
// returning a bare `Company[]` from one and this wrapped object from the other
// silently corrupts the shared cache and crashes whichever reads the other's shape.
export const companiesListQueryOptions = {
  queryKey: queryKeys.companies.all,
  queryFn: async (): Promise<CompanyListResult> => {
    try {
      return { companies: await companiesApi.list(), unauthorized: false };
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
        return { companies: [], unauthorized: true };
      }
      throw err;
    }
  },
  retry: false,
} as const;
