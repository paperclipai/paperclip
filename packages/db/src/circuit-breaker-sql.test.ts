import postgres from "postgres";
import { describe, expect, it } from "vitest";
import { withConnectionCircuitBreaker } from "./circuit-breaker-sql.js";
import { ConnectionCircuitBreaker, DatabaseUnavailableError } from "./connection-circuit-breaker.js";

type Outcome = { ok: true; value: unknown } | { ok: false; error: unknown };

function connectionError(code = "CONNECT_TIMEOUT"): Error {
  return Object.assign(new Error(`write ${code} db:5432`), { code, errno: code });
}

/**
 * A stand-in for postgres.js with the two properties that matter here: queries
 * are lazy (nothing runs until the caller subscribes) and the configuration
 * methods return the query itself.
 */
function createFakeSql(outcomes: Outcome[]) {
  const dialled: string[] = [];
  const created: string[] = [];

  const makeQuery = (label: string) => {
    let run: Promise<unknown> | undefined;
    const start = () => {
      run ??= (() => {
        dialled.push(label);
        const outcome = outcomes.shift() ?? { ok: true, value: [] };
        return outcome.ok ? Promise.resolve(outcome.value) : Promise.reject(outcome.error);
      })();
      return run;
    };
    const query: Record<string, unknown> = {
      label,
      then: (...args: unknown[]) => (start().then as (...a: unknown[]) => unknown)(...args),
      catch: (...args: unknown[]) => (start().catch as (...a: unknown[]) => unknown)(...args),
      finally: (...args: unknown[]) => (start().finally as (...a: unknown[]) => unknown)(...args),
      execute: () => {
        void start();
        return query;
      },
    };
    for (const method of ["values", "raw", "simple", "describe", "cursor", "forEach"]) {
      query[method] = () => query;
    }
    return query;
  };

  const sql = ((...args: unknown[]) => {
    const strings = args[0] as { raw?: unknown } | undefined;
    if (!Array.isArray(strings?.raw)) return { fragment: args[0] };
    created.push("tagged");
    return makeQuery("tagged");
  }) as unknown as Record<string, unknown> & ((...args: unknown[]) => unknown);

  sql.unsafe = (text: string) => {
    created.push(`unsafe:${text}`);
    return makeQuery(`unsafe:${text}`);
  };
  sql.begin = (_fn: unknown) => {
    created.push("begin");
    return makeQuery("begin");
  };
  let ended = 0;
  sql.end = () => {
    ended += 1;
    return Promise.resolve();
  };
  sql.options = { parsers: {}, serializers: {} };

  return { sql, dialled, created, endCount: () => ended };
}

function wrap(outcomes: Outcome[], failureThreshold = 2, resetTimeoutMs = 5_000) {
  const clock = { now: 0 };
  const fake = createFakeSql(outcomes);
  const breaker = new ConnectionCircuitBreaker({ failureThreshold, resetTimeoutMs, now: () => clock.now });
  const sql = withConnectionCircuitBreaker(fake.sql as any, breaker) as any;
  return { ...fake, breaker, clock, sql };
}

describe("withConnectionCircuitBreaker", () => {
  it("returns the client untouched when no breaker is configured", () => {
    const fake = createFakeSql([]);
    expect(withConnectionCircuitBreaker(fake.sql as any, null)).toBe(fake.sql);
  });

  it("passes results through while the breaker is closed", async () => {
    const { sql } = wrap([{ ok: true, value: [{ one: 1 }] }]);
    await expect(sql`select 1`).resolves.toEqual([{ one: 1 }]);
  });

  it("keeps queries lazy — nothing dials until the caller subscribes", async () => {
    const { sql, dialled } = wrap([{ ok: true, value: [] }]);
    const pending = sql.unsafe("select 1");
    expect(dialled).toEqual([]);
    await pending;
    expect(dialled).toEqual(["unsafe:select 1"]);
  });

  it("preserves the self-returning configuration chain", async () => {
    const { sql } = wrap([{ ok: true, value: [[1]] }]);
    // drizzle's own call shape: `client.unsafe(query, params).values()`.
    await expect(sql.unsafe("select 1", []).values()).resolves.toEqual([[1]]);
  });

  it("opens after consecutive connection failures and then rejects without dialling", async () => {
    const { sql, breaker, dialled } = wrap(
      [
        { ok: false, error: connectionError() },
        { ok: false, error: connectionError() },
      ],
      2,
    );

    await expect(sql.unsafe("a")).rejects.toThrow(/CONNECT_TIMEOUT/);
    await expect(sql.unsafe("b")).rejects.toThrow(/CONNECT_TIMEOUT/);
    expect(breaker.state).toBe("open");

    const before = dialled.length;
    await expect(sql.unsafe("c")).rejects.toBeInstanceOf(DatabaseUnavailableError);
    await expect(sql`select 1`).rejects.toBeInstanceOf(DatabaseUnavailableError);
    expect(dialled.length).toBe(before);
  });

  it("rejects the whole configuration chain while open", async () => {
    const { sql } = wrap(
      [
        { ok: false, error: connectionError() },
        { ok: false, error: connectionError() },
      ],
      2,
    );
    await expect(sql.unsafe("a")).rejects.toThrow();
    await expect(sql.unsafe("b")).rejects.toThrow();

    await expect(sql.unsafe("c", []).values()).rejects.toBeInstanceOf(DatabaseUnavailableError);
  });

  it("does not open on errors the server itself returned", async () => {
    const failures: Outcome[] = Array.from({ length: 5 }, () => ({
      ok: false as const,
      error: connectionError("23505"),
    }));
    const { sql, breaker } = wrap(failures, 2);
    for (let i = 0; i < 5; i += 1) {
      await expect(sql.unsafe(`q${i}`)).rejects.toThrow();
    }
    expect(breaker.state).toBe("closed");
  });

  it("recovers through a half-open probe", async () => {
    const { sql, breaker, clock } = wrap(
      [
        { ok: false, error: connectionError() },
        { ok: false, error: connectionError() },
        { ok: true, value: [{ ok: true }] },
        { ok: true, value: [{ ok: true }] },
      ],
      2,
      5_000,
    );
    await expect(sql.unsafe("a")).rejects.toThrow();
    await expect(sql.unsafe("b")).rejects.toThrow();
    expect(breaker.state).toBe("open");

    clock.now = 5_000;
    await expect(sql.unsafe("probe")).resolves.toEqual([{ ok: true }]);
    expect(breaker.state).toBe("closed");
    await expect(sql.unsafe("after")).resolves.toEqual([{ ok: true }]);
  });

  it("lets non-query surfaces through even while open", async () => {
    const { sql, breaker, endCount } = wrap(
      [
        { ok: false, error: connectionError() },
        { ok: false, error: connectionError() },
      ],
      2,
    );
    await expect(sql.unsafe("a")).rejects.toThrow();
    await expect(sql.unsafe("b")).rejects.toThrow();
    expect(breaker.state).toBe("open");

    // Shutting the pool down, and building SQL fragments, must not depend on
    // the database being reachable.
    await sql.end();
    expect(endCount()).toBe(1);
    expect(sql({ id: 1 })).toEqual({ fragment: { id: 1 } });
    // drizzle mutates these during driver setup.
    expect(sql.options.parsers).toEqual({});
  });

  it("exposes the breaker for health reporting", () => {
    const { sql, breaker } = wrap([]);
    expect(sql.circuitBreaker).toBe(breaker);
  });
});

describe("withConnectionCircuitBreaker against the real driver", () => {
  it("classifies a genuinely unreachable server and stops dialling it", async () => {
    // Port 1 on loopback is closed, so the driver fails at connect time — the
    // same class of failure as a database that has gone away.
    const client = postgres("postgres://nobody:nobody@127.0.0.1:1/nothing", {
      max: 1,
      connect_timeout: 1,
      onnotice: () => {},
    });
    const breaker = new ConnectionCircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    const sql = withConnectionCircuitBreaker(client, breaker);

    try {
      await expect(sql`select 1`).rejects.toThrow();
      await expect(sql`select 1`).rejects.toThrow();
      expect(breaker.state).toBe("open");

      const started = Date.now();
      await expect(sql`select 1`).rejects.toBeInstanceOf(DatabaseUnavailableError);
      // Fail-fast means "no connect attempt", which is what bounds the
      // in-flight handler count during an outage.
      expect(Date.now() - started).toBeLessThan(200);
    } finally {
      await client.end({ timeout: 1 });
    }
  }, 20_000);
});
