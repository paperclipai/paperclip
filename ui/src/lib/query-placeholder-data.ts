import type { PlaceholderDataFunction, QueryKey } from "@tanstack/react-query";

export function keepPreviousDataForSameQueryTail<TQueryData, TQueryKey extends QueryKey = QueryKey>(
  tail: unknown,
): PlaceholderDataFunction<TQueryData, Error, TQueryData, TQueryKey> {
  return (previousData, previousQuery) => {
    const previousKey = Array.isArray(previousQuery?.queryKey) ? previousQuery.queryKey : [];
    return previousKey.at(-1) === tail ? previousData : undefined;
  };
}
