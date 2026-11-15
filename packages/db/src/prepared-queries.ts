type Method = (this: unknown, ...args: unknown[]) => unknown;

export const PREPARED_QUERY_TEXT_LIMIT = 1_000;
export const PREPARED_QUERY_TEXT_MAX_LENGTH = 8_192;

export type PreparedQueryStats = {
  texts: number;
  unprepared: number;
  demoted: number;
  retried: number;
  retriedTransactions: number;
};

export type PreparedQueryState = {
  limit: number;
  maxLength: number;
  texts: Set<string>;
  demoted: Set<string>;
  stats: Omit<PreparedQueryStats, "texts">;
};

type Scope = { retry: "statement" | "first" | "none"; statements: number; firstFailure?: unknown };

type PendingQuery = {
  options: Record<string, unknown>;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  isRaw?: unknown;
  cursorFn?: unknown;
  forEachFn?: unknown;
  onlyDescribe?: unknown;
  then(onFulfilled: (value: unknown) => void, onRejected: (error: unknown) => void): unknown;
};

export function createPreparedQueryState(options: { limit?: number; maxLength?: number } = {}): PreparedQueryState {
  return {
    limit: options.limit ?? PREPARED_QUERY_TEXT_LIMIT,
    maxLength: options.maxLength ?? PREPARED_QUERY_TEXT_MAX_LENGTH,
    texts: new Set(),
    demoted: new Set(),
    stats: { unprepared: 0, demoted: 0, retried: 0, retriedTransactions: 0 },
  };
}

export function preparedQueryStats(state: PreparedQueryState): PreparedQueryStats {
  return { texts: state.texts.size, ...state.stats };
}

export function isPreparedStatementFailure(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const { code, routine, message } = error as { code?: unknown; routine?: unknown; message?: unknown };
  if (code === "26000" || code === "42P05") return true;
  return code === "0A000" && (routine === "RevalidateCachedQuery"
    || (typeof message === "string" && message.includes("cached plan must not change result type")));
}

function shouldPrepare(state: PreparedQueryState, text: string): boolean {
  if (state.texts.has(text)) return true;
  if (state.demoted.has(text) || text.length > state.maxLength || state.texts.size >= state.limit) {
    state.stats.unprepared++;
    return false;
  }
  state.texts.add(text);
  return true;
}

function demote(state: PreparedQueryState, text: string): void {
  if (state.demoted.has(text)) return;
  state.texts.delete(text);
  state.demoted.add(text);
  state.stats.demoted++;
}

export function installPreparedQueries(client: unknown, state: PreparedQueryState = createPreparedQueryState()): void {
  const visited = new WeakSet<object>();

  function visit(value: unknown, scope: Scope): void {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return;
    if (visited.has(value)) return;
    visited.add(value);
    const target = value as Record<string, unknown>;
    const unsafe = target.unsafe;
    if (typeof unsafe === "function") {
      target.unsafe = function (this: unknown, ...args: unknown[]) {
        const index = args.length === 2 && !Array.isArray(args[1]) ? 1 : 2;
        const options = args[index] as Record<string, unknown> | undefined;
        if (options !== undefined && (options === null || typeof options !== "object")) {
          return Reflect.apply(unsafe, this, args);
        }
        if (index === 2 && args.length < 2) args[1] = [];
        const position = ++scope.statements;
        const text = args[0];
        if (typeof text !== "string" || (options !== undefined && "prepare" in options)) {
          args[index] = { prepare: true, ...options };
          return Reflect.apply(unsafe, this, args);
        }
        args[index] = { ...options };
        const query = Reflect.apply(unsafe, this, args) as PendingQuery;
        if (query.options.simple) {
          query.options.prepare = true;
          return query;
        }
        let explicit: unknown;
        Object.defineProperty(query.options, "prepare", {
          enumerable: true,
          configurable: true,
          get: () => explicit ?? shouldPrepare(state, text),
          set: (value: unknown) => { explicit = value; },
        });
        const reject = query.reject;
        query.reject = (error: unknown) => {
          if (explicit !== undefined || !isPreparedStatementFailure(error)) return reject(error);
          demote(state, text);
          if (scope.retry === "first" && position === 1) scope.firstFailure = error;
          if (scope.retry !== "statement" || query.cursorFn || query.forEachFn || query.onlyDescribe || options?.onexecute) {
            return reject(error);
          }
          state.stats.retried++;
          const retry = Reflect.apply(unsafe, this, [text, index === 2 ? args[1] : [], { ...options, prepare: false }]) as PendingQuery;
          retry.isRaw = query.isRaw;
          retry.then(query.resolve, reject);
        };
        return query;
      } satisfies Method;
    }
    for (const method of ["begin", "savepoint"]) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        const attempt = (retried: boolean): Promise<unknown> => {
          const inner: Scope = { retry: "first", statements: 0 };
          const wrapped = args.map(arg => typeof arg !== "function" ? arg : function (this: unknown, ...params: unknown[]) {
            visit(params[0], inner);
            return Reflect.apply(arg, this, params);
          });
          return Promise.resolve(Reflect.apply(original, this, wrapped)).catch((error: unknown) => {
            const failure = inner.firstFailure;
            if (retried || failure === undefined
              || (error !== failure && (error as { cause?: unknown } | null)?.cause !== failure)) throw error;
            state.stats.retriedTransactions++;
            return attempt(true);
          });
        };
        return attempt(false);
      } satisfies Method;
    }
    const reserve = target.reserve;
    if (typeof reserve === "function") {
      target.reserve = function (this: unknown, ...args: unknown[]) {
        return Promise.resolve(Reflect.apply(reserve, this, args)).then(reserved => {
          visit(reserved, { retry: "none", statements: 0 });
          return reserved;
        });
      } satisfies Method;
    }
  }

  visit(client, { retry: "statement", statements: 0 });
}
