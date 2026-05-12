import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";

export async function clearAuthenticatedCache(queryClient: QueryClient) {
  await queryClient.cancelQueries();
  queryClient.removeQueries({
    predicate: (query) => query.queryKey[0] !== queryKeys.auth.session[0],
  });
  queryClient.setQueryData(queryKeys.auth.session, null);
}
