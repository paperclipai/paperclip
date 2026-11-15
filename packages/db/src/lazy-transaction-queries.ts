import { PgDialect, type PgSession, type PgTable } from "drizzle-orm/pg-core";
import { RelationalQueryBuilder } from "drizzle-orm/pg-core/query-builders/query";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import type { TableRelationalConfig } from "drizzle-orm";
import type postgres from "postgres";

type Callback = (tx: Transaction) => unknown;
type Transaction = {
  _: { schema: unknown; fullSchema: unknown; tableNamesMap: unknown; session: PgSession };
  query: unknown;
  transaction(callback: Callback, ...rest: unknown[]): unknown;
};

/**
 * `drizzle(client, { schema })` whose transactions build `tx.query` on first
 * read instead of at `BEGIN`.
 *
 * Drizzle constructs one relational query builder per schema table for every
 * database object it creates, and it creates one for each transaction and each
 * savepoint. With the Paperclip schema that is about 100 KB per transaction,
 * for an API that almost no transaction reads.
 *
 * Transactions are therefore opened through a second Drizzle client on the same
 * postgres.js client, created without the schema. `BEGIN`, `SAVEPOINT`, commit,
 * rollback and connection handling stay Drizzle's and the driver's own. A
 * transaction that does read `tx.query` gets the builders Drizzle would have
 * built, bound to that transaction's session, and `tx._` still describes the
 * schema.
 *
 * Both clients and the builders' dialect take Drizzle's defaults. A Drizzle
 * option added here (`casing`, `logger`, `cache`) must go to all three.
 */
export function drizzleWithLazyTransactionQueries<TSchema extends Record<string, unknown>, TClient extends postgres.Sql<any>>(
  client: TClient,
  schema: TSchema,
): PostgresJsDatabase<TSchema> & { $client: TClient } {
  const db = drizzle(client, { schema });
  const tables = db._.schema;
  if (!tables) return db;
  const { fullSchema, tableNamesMap } = db._;
  const transactions = drizzle(client) as unknown as Transaction;
  const dialect = new PgDialect();
  const resolved = (value: unknown): PropertyDescriptor => ({ value, writable: true, enumerable: true, configurable: true });
  const lazyQuery: PropertyDescriptor = {
    enumerable: true,
    configurable: true,
    get(this: Transaction) {
      const query: Record<string, unknown> = {};
      for (const [name, table] of Object.entries(tables as Record<string, TableRelationalConfig>)) {
        query[name] = new RelationalQueryBuilder(
          fullSchema, tables, tableNamesMap, fullSchema[name] as PgTable, table, dialect, this._.session,
        );
      }
      Object.defineProperty(this, "query", resolved(query));
      return query;
    },
    set(this: Transaction, value: unknown) {
      Object.defineProperty(this, "query", resolved(value));
    },
  };
  const within = (callback: Callback): Callback => (tx) => {
    tx._.schema = tables;
    tx._.fullSchema = fullSchema;
    tx._.tableNamesMap = tableNamesMap;
    Object.defineProperty(tx, "query", lazyQuery);
    const savepoint = tx.transaction;
    tx.transaction = function (this: Transaction, nested, ...rest) {
      return Reflect.apply(savepoint, this, [within(nested), ...rest]);
    };
    return callback(tx);
  };
  (db as unknown as Transaction).transaction = (callback, ...rest) => transactions.transaction(within(callback), ...rest);
  return db;
}
