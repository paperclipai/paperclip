import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createDb,
  authUsers,
  oauthAuthorizationStates,
  oauthConnections,
  companies,
  companySecretBindings,
  companySecretVersions,
  companySecrets,
  companySecretProviderConfigs,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../helpers/embedded-postgres.js";
import { secretService } from "../../services/secrets.js";
import type { ProviderRegistry } from "../../oauth/registry.js";
import { refreshConnection } from "../../oauth/refresh.js";

export type Db = ReturnType<typeof createDb>;

export interface OAuthTestEnv {
  db: Db;
  /** Connection string suitable for creating ephemeral postgres-js handles. */
  connectionString: string;
  cleanup: () => Promise<void>;
  /** Reset all OAuth-touched tables; safe to call between tests. */
  reset: () => Promise<void>;
  secretsTmpDir: string;
  previousKeyFile: string | undefined;
}

/**
 * Boots an embedded Postgres database with all schema migrations applied and
 * configures the secrets master-key file the way `secrets-service.test.ts`
 * does. Returns an object with the live Drizzle handle and a cleanup hook
 * (call from `afterAll`). Returns `null` if embedded-postgres is unsupported
 * on this host (callers should `describe.skip`).
 */
export async function setupOAuthTestEnv(label: string): Promise<OAuthTestEnv> {
  const previousKeyFile = process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
  const secretsTmpDir = path.join(
    os.tmpdir(),
    `paperclip-oauth-${label}-${randomUUID()}`,
  );
  mkdirSync(secretsTmpDir, { recursive: true });
  process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = path.join(
    secretsTmpDir,
    "master.key",
  );

  const started = await startEmbeddedPostgresTestDatabase(label);
  const db = createDb(started.connectionString);

  return {
    db,
    connectionString: started.connectionString,
    secretsTmpDir,
    previousKeyFile,
    reset: async () => {
      // Order matters: child rows first to satisfy FK constraints.
      await db.delete(oauthConnections);
      await db.delete(oauthAuthorizationStates);
      await db.delete(companySecretBindings);
      await db.delete(companySecretVersions);
      await db.delete(companySecrets);
      await db.delete(companySecretProviderConfigs);
      await db.delete(companies);
      await db.delete(authUsers);
    },
    cleanup: async () => {
      await started.cleanup();
      if (previousKeyFile === undefined) {
        delete process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE;
      } else {
        process.env.PAPERCLIP_SECRETS_MASTER_KEY_FILE = previousKeyFile;
      }
      rmSync(secretsTmpDir, { recursive: true, force: true });
    },
  };
}

/** Cheap probe that mirrors `secrets-service.test.ts` so the suite can `describe.skip` cleanly. */
export const oauthEmbeddedPostgresSupport =
  await getEmbeddedPostgresTestSupport();

export async function seedTestCompany(
  db: Db,
  opts: { id?: string; name?: string } = {},
): Promise<string> {
  const companyId = opts.id ?? randomUUID();
  const name = opts.name ?? "TestCo";
  await db.insert(companies).values({
    id: companyId,
    name,
    issuePrefix: `T${companyId.slice(0, 7)}`.toUpperCase(),
    status: "active",
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return companyId;
}

/**
 * Seed an auth_users row so the OAuth state-row insert can satisfy its FK
 * (`initiated_by_user_id` references `user.id`). Idempotent across tests.
 */
export async function seedTestUser(
  db: Db,
  opts: { id?: string; email?: string; name?: string } = {},
): Promise<string> {
  const userId = opts.id ?? `user-${randomUUID()}`;
  await db
    .insert(authUsers)
    .values({
      id: userId,
      email: opts.email ?? `${userId}@example.test`,
      name: opts.name ?? "Test User",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  return userId;
}

/**
 * Construct a real secretService bound to the test DB and the supplied
 * registry. Mirrors how production wires it (refreshFn injected to break the
 * circular import). The integration tests need this for OAuth-token resolution
 * to exercise the lazy-refresh path.
 */
export function createTestSecretService(db: Db, registry: ProviderRegistry) {
  return secretService(db, {
    registry,
    refreshFn: refreshConnection,
  });
}

/**
 * Wraps a Drizzle handle so the OAuth refresh-worker's advisory-lock pings
 * never reach Postgres: any `pg_try_advisory_lock` /
 * `pg_try_advisory_xact_lock` / `pg_advisory_unlock` query is short-circuited
 * to a synthetic success result. The shim is permissive on purpose: the
 * worker's lock implementation has migrated from session-scoped
 * (`pg_try_advisory_lock` + explicit unlock) to transaction-scoped
 * (`pg_try_advisory_xact_lock` inside a `db.transaction(...)`); we keep the
 * `pg_try_advisory_lock` and `pg_advisory_unlock` matchers so older worker
 * variants and any future mid-migration paths stay covered. The shim is
 * documented as a follow-up in the Phase-7 report; production code is
 * deliberately left untouched.
 */
export function withSyntheticAdvisoryLock<
  T extends { execute: (...args: any[]) => any },
>(db: T): T {
  function shouldShimSql(sqlText: string): boolean {
    // `includes("pg_try_advisory_lock")` matches `pg_try_advisory_xact_lock`
    // too because of the shared prefix, but we list each form explicitly so
    // future readers can grep for the intent.
    return (
      sqlText.includes("pg_try_advisory_xact_lock") ||
      sqlText.includes("pg_try_advisory_lock") ||
      sqlText.includes("pg_advisory_unlock")
    );
  }
  function syntheticOk() {
    return Object.assign([{ result: true }], {
      rows: [{ result: true }],
    });
  }
  function wrapExecute(originalExecute: (...args: any[]) => any) {
    return async (query: any, ...rest: any[]) => {
      const sqlText = serializeSqlForMatch(query);
      if (shouldShimSql(sqlText)) return syntheticOk();
      return await originalExecute(query, ...rest);
    };
  }
  function wrapTx<TX extends { execute?: (...args: any[]) => any }>(tx: TX): TX {
    if (typeof tx?.execute !== "function") return tx;
    const originalExecute = tx.execute.bind(tx);
    return new Proxy(tx, {
      get(target, prop, receiver) {
        if (prop === "execute") return wrapExecute(originalExecute);
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  const originalExecute = db.execute.bind(db);
  const dbWithTx = db as T & {
    transaction?: (cb: (tx: unknown) => unknown) => unknown;
  };
  const originalTransaction = dbWithTx.transaction?.bind(dbWithTx);
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === "execute") return wrapExecute(originalExecute);
      if (prop === "transaction" && originalTransaction) {
        // The worker now takes the advisory lock inside a tx via `tx.execute`.
        // Wrap the inner tx so its `execute` answers the same synthetic
        // result for advisory-lock probes.
        return (cb: (tx: unknown) => unknown, ...rest: unknown[]) => {
          return originalTransaction(
            (tx: unknown) => cb(wrapTx(tx as { execute?: any })),
            ...(rest as []),
          );
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as T;
}

function serializeSqlForMatch(query: unknown): string {
  if (!query || typeof query !== "object") return "";
  // Drizzle SQL objects expose `.queryChunks` — `StringChunk` chunks have a
  // `.value: string[]` field, parameter chunks are bigint/number/string.
  // We just need a coarse text view to spot the advisory-lock query, so we
  // walk both shapes and join. Avoids `JSON.stringify` which throws on
  // BigInt parameters like the worker's lock-key constant.
  const chunks = (query as { queryChunks?: unknown[] }).queryChunks;
  if (!Array.isArray(chunks)) return "";
  const out: string[] = [];
  for (const chunk of chunks) {
    if (typeof chunk === "string") {
      out.push(chunk);
      continue;
    }
    if (chunk && typeof chunk === "object" && "value" in chunk) {
      const v = (chunk as { value: unknown }).value;
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) {
        for (const part of v) {
          if (typeof part === "string") out.push(part);
        }
      }
    }
  }
  return out.join(" ");
}

