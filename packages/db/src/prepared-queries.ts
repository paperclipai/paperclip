type Method = (this: unknown, ...args: unknown[]) => unknown;

export const PREPARED_QUERY_TEXT_LIMIT = 1_000;
export const PREPARED_QUERY_TEXT_MAX_LENGTH = 8_192;

export type PreparedQueryStats = {
  texts: number;
  unprepared: number;
  demoted: number;
  retried: number;
  restartedTransactions: number;
};

export type PreparedQueryState = {
  limit: number;
  maxLength: number;
  texts: Set<string>;
  demoted: Set<string>;
  stats: Omit<PreparedQueryStats, "texts">;
};

type Counts = { created: number; executed: number; setup: string[] };
type Scope = { retry: "statement" | "restart" | "none"; begin?: string; counts: Counts };

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
    stats: { unprepared: 0, demoted: 0, retried: 0, restartedTransactions: 0 },
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

const TRANSACTION_SETUP = /^\s*set\s+transaction\b/i;

function scope(retry: Scope["retry"], begin?: string, counts: Counts = { created: 0, executed: 0, setup: [] }): Scope {
  return { retry, begin, counts };
}

function track(query: PendingQuery, current: Counts, text: string | undefined, decide: () => unknown) {
  current.created++;
  let explicit: unknown = "prepare" in query.options ? query.options.prepare : undefined;
  const execution = { started: false, first: false };
  Object.defineProperty(query.options, "prepare", {
    enumerable: true,
    configurable: true,
    get: () => {
      if (!execution.started) {
        execution.started = true;
        execution.first = current.executed === current.setup.length;
        current.executed++;
        if (execution.first && text !== undefined && query.options.simple && TRANSACTION_SETUP.test(text)) current.setup.push(text);
      }
      return explicit ?? decide();
    },
    set: (value: unknown) => { explicit = value; },
  });
  return { execution, explicit: () => explicit };
}

export function installPreparedQueries(client: unknown, state: PreparedQueryState = createPreparedQueryState()): void {
  const visited = new WeakSet<object>();

  function visit(value: unknown, current: Scope): void {
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
        const text = args[0];
        args[index] = { prepare: true, ...options };
        if (typeof text !== "string") return Reflect.apply(unsafe, this, args);
        const query = Reflect.apply(unsafe, this, args) as PendingQuery;
        const caller = (options !== undefined && "prepare" in options) || query.options.simple;
        if (!caller) delete query.options.prepare;
        const tracked = track(query, current.counts, text, () => shouldPrepare(state, text));
        const reject = query.reject;
        query.reject = (error: unknown) => {
          if (tracked.explicit() !== undefined || !isPreparedStatementFailure(error)) return reject(error);
          demote(state, text);
          if (query.cursorFn || query.forEachFn || query.onlyDescribe || options?.onexecute) return reject(error);
          const params = index === 2 ? args[1] : [];
          const unprepared = { ...options, prepare: false };
          if (current.retry === "statement") {
            state.stats.retried++;
            const retry = Reflect.apply(unsafe, this, [text, params, unprepared]) as PendingQuery;
            retry.isRaw = query.isRaw;
            retry.then(query.resolve, reject);
            return;
          }
          if (current.retry !== "restart" || !tracked.execution.first || current.counts.created !== current.counts.executed) return reject(error);
          state.stats.restartedTransactions++;
          const run = (sql: string, ...rest: unknown[]) => Reflect.apply(unsafe, this, [sql, ...rest]) as PendingQuery;
          const steps = [run("rollback"), run(`begin ${current.begin ?? ""}`.trim()), ...current.counts.setup.map(setup => run(setup))];
          const retry = run(text, params, unprepared);
          retry.isRaw = query.isRaw;
          Promise.all([...steps, retry]).then(results => query.resolve(results[results.length - 1]), reject);
        };
        return query;
      } satisfies Method;
    }
    for (const method of ["begin", "savepoint"] as const) {
      const original = target[method];
      if (typeof original !== "function") continue;
      target[method] = function (this: unknown, ...args: unknown[]) {
        const begin = method === "begin" && typeof args[0] === "string" ? args[0].replace(/[^a-z ]/ig, "") : undefined;
        const inner = method === "begin" ? scope("restart", begin) : scope("none", undefined, current.counts);
        const wrapped = args.map(arg => typeof arg !== "function" ? arg : function (this: unknown, ...params: unknown[]) {
          visit(params[0], inner);
          return Reflect.apply(arg, this, [counted(params[0], inner), ...params.slice(1)]);
        });
        return Reflect.apply(original, this, wrapped);
      } satisfies Method;
    }
    const reserve = target.reserve;
    if (typeof reserve === "function") {
      target.reserve = function (this: unknown, ...args: unknown[]) {
        return Promise.resolve(Reflect.apply(reserve, this, args)).then(reserved => {
          visit(reserved, scope("none"));
          return reserved;
        });
      } satisfies Method;
    }
  }

  function counted(sql: unknown, current: Scope): unknown {
    if (typeof sql !== "function") return sql;
    return new Proxy(sql, {
      apply(target, self, args) {
        const result = Reflect.apply(target, self, args) as unknown;
        const strings = args[0] as { raw?: unknown } | undefined;
        if (Array.isArray(strings?.raw) && result instanceof Promise && "options" in result) {
          track(result as unknown as PendingQuery, current.counts, undefined, () => true);
        }
        return result;
      },
    });
  }

  visit(client, scope("statement"));
}
