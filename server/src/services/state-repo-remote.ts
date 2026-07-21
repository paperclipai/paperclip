import type { Db } from "@paperclipai/db";
import { companyStateRepoRemotes } from "@paperclipai/db";
import { eq } from "drizzle-orm";

export type StateRepoRemoteConfig = {
  companyId: string;
  remoteUrl: string;
  secretId: string | null;
  secretVersion: string | null;
  updatedAt: string;
};

export type SetStateRepoRemoteInput = {
  remoteUrl: string;
  secretId?: string | null;
  secretVersion?: string | null;
};

/**
 * Persisted per-company "connect your repo" configuration for the managed
 * state-repo mirror (PAP-14639 P3). The push token itself is never stored
 * here — only the URL and a reference to the company secret that holds it.
 */
export function stateRepoRemoteService(db: Db) {
  return {
    async get(companyId: string): Promise<StateRepoRemoteConfig | null> {
      const [row] = await db
        .select()
        .from(companyStateRepoRemotes)
        .where(eq(companyStateRepoRemotes.companyId, companyId))
        .limit(1);
      if (!row) return null;
      return {
        companyId: row.companyId,
        remoteUrl: row.remoteUrl,
        secretId: row.secretId ?? null,
        secretVersion: row.secretVersion ?? null,
        updatedAt: (row.updatedAt instanceof Date ? row.updatedAt : new Date(row.updatedAt)).toISOString(),
      };
    },
    async set(companyId: string, input: SetStateRepoRemoteInput): Promise<StateRepoRemoteConfig> {
      const values = {
        companyId,
        remoteUrl: input.remoteUrl,
        secretId: input.secretId ?? null,
        secretVersion: input.secretVersion ?? null,
        updatedAt: new Date(),
      };
      await db
        .insert(companyStateRepoRemotes)
        .values(values)
        .onConflictDoUpdate({
          target: companyStateRepoRemotes.companyId,
          set: {
            remoteUrl: values.remoteUrl,
            secretId: values.secretId,
            secretVersion: values.secretVersion,
            updatedAt: values.updatedAt,
          },
        });
      return (await this.get(companyId))!;
    },
    async clear(companyId: string): Promise<void> {
      await db.delete(companyStateRepoRemotes).where(eq(companyStateRepoRemotes.companyId, companyId));
    },
  };
}

export type StateRepoRemoteService = ReturnType<typeof stateRepoRemoteService>;
