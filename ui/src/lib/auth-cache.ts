import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

const COMPANY_PATH_MEMORY_KEY = "paperclip.companyPaths";

export async function clearAuthenticatedCache(queryClient: QueryClient) {
  await queryClient.cancelQueries();
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.auth.session[0],
  });
  queryClient.setQueryData(queryKeys.auth.session, null);
  try {
    localStorage.removeItem(COMPANY_PATH_MEMORY_KEY);
  } catch {
    // Best-effort cleanup for browsers that block localStorage.
  }
}
