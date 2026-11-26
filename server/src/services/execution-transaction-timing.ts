import type { Db } from "@paperclipai/db";
import { beginRunPhase, measureRunPhase } from "./execution-preparation-timing.js";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];

export function measureRunTransaction<T>(db: Db, scope: "workspace" | "runtime_selection" | "response" | "connectors.slack.authority" | "connectors.slack.catalog", work: (tx: Transaction) => Promise<T>): Promise<T> {
  return measureRunPhase(`${scope}.transaction`, async () => {
    const entry = beginRunPhase(`${scope}.transaction.entry`);
    let settle: ((failed?: boolean) => void) | undefined;
    let failed = false;
    try {
      return await db.transaction(async tx => {
        entry();
        try {
          const value = await work(tx);
          settle = beginRunPhase(`${scope}.transaction.commit`);
          return value;
        } catch (error) {
          settle = beginRunPhase(`${scope}.transaction.rollback`);
          throw error;
        }
      });
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      entry(failed);
      settle?.(failed);
    }
  });
}
