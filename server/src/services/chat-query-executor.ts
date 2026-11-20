interface PreparedQuery<Result> {
  execute(parameters?: Record<string, unknown>): Promise<Result>;
}

interface CompilableQuery<Result> extends PreparedQuery<Result> {
  prepare(name: string): PreparedQuery<Result>;
}

/** Reuse query compilation only; every execution reads the database. */
export function createChatQueryExecutor(reuseCompilation: boolean) {
  const clearPreparedQueries: Array<() => void> = [];

  return {
    query<Result>(name: string, build: () => CompilableQuery<Result>) {
      let prepared: PreparedQuery<Result> | undefined;
      if (reuseCompilation) {
        clearPreparedQueries.push(() => { prepared = undefined; });
      }
      return (parameters?: Record<string, unknown>): Promise<Result> => {
        if (!reuseCompilation) return build().execute(parameters);
        prepared ??= build().prepare(name);
        return prepared.execute(parameters);
      };
    },
    clear() {
      for (const clear of clearPreparedQueries) clear();
    },
  };
}
