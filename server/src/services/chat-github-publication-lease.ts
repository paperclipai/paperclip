import { randomUUID } from "node:crypto";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { chatEndpointLeases, type Db } from "@paperclipai/db";

type Transaction = Parameters<Parameters<Db["transaction"]>[0]>[0];
const TTL_SECONDS = 90;

export class GitHubPublicationLeaseLost extends Error {
  constructor() {
    super("GitHub publication ownership was lost");
  }
}

/** Serialize provider writes for one PR without holding a database connection
 * during network I/O. A crashed worker leaves the existing outbox retryable.
 * The token fences receipt commits; losing renewal aborts in-flight requests.
 * Provider markers still recover a write whose response was lost. */
export async function withGitHubPublicationLease<T>(
  db: Db,
  scope: {
    companyId: string;
    endpointId: string;
    repositoryId: string;
    number: number;
  },
  fetchImpl: typeof fetch,
  operation: (lease: {
    fetch: typeof fetch;
    commit<R>(write: (tx: Transaction) => Promise<R>): Promise<R>;
  }) => Promise<T>,
): Promise<T | undefined> {
  const token = randomUUID();
  const leaseKey = `github-publication:${scope.repositoryId}:${scope.number}`;
  const expiresAt = sql`now() + interval '90 seconds'`;
  const [claimed] = await db
    .insert(chatEndpointLeases)
    .values({
      companyId: scope.companyId,
      endpointId: scope.endpointId,
      leaseKey,
      token,
      expiresAt,
    })
    .onConflictDoUpdate({
      target: [chatEndpointLeases.endpointId, chatEndpointLeases.leaseKey],
      set: { token, expiresAt, updatedAt: sql`now()` },
      setWhere: and(
        eq(chatEndpointLeases.companyId, scope.companyId),
        lte(chatEndpointLeases.expiresAt, sql`now()`),
      ),
    })
    .returning({ id: chatEndpointLeases.id });
  if (!claimed) return;

  const controller = new AbortController();
  let lost = false;
  const ownership = and(
    eq(chatEndpointLeases.id, claimed.id),
    eq(chatEndpointLeases.companyId, scope.companyId),
    eq(chatEndpointLeases.token, token),
    gt(chatEndpointLeases.expiresAt, sql`now()`),
  );
  const renew = async (writer: Db | Transaction = db) => {
    if (lost) throw new GitHubPublicationLeaseLost();
    try {
      const rows = await writer
        .update(chatEndpointLeases)
        .set({ expiresAt, updatedAt: sql`now()` })
        .where(ownership)
        .returning({ id: chatEndpointLeases.id });
      if (!rows.length) throw new GitHubPublicationLeaseLost();
    } catch {
      lost = true;
      controller.abort();
      throw new GitHubPublicationLeaseLost();
    }
  };
  let renewal: Promise<void> | undefined;
  const timer = setInterval(
    () => {
      if (renewal) return;
      renewal = renew()
        .catch(() => {})
        .finally(() => {
          renewal = undefined;
        });
    },
    (TTL_SECONDS * 1000) / 3,
  );
  timer.unref?.();
  try {
    return await operation({
      fetch: (async (input, init) => {
        await renew();
        const signal =
          init?.signal ?? (input instanceof Request ? input.signal : undefined);
        const response = await fetchImpl(input, {
          ...init,
          signal: signal
            ? AbortSignal.any([signal, controller.signal])
            : controller.signal,
        });
        await renew();
        return response;
      }) as typeof fetch,
      commit: (write) =>
        db.transaction(async (tx) => {
          // Updating the lease locks it until the short receipt transaction ends.
          await renew(tx);
          return write(tx);
        }),
    });
  } finally {
    clearInterval(timer);
    await renewal;
    await db
      .delete(chatEndpointLeases)
      .where(
        and(
          eq(chatEndpointLeases.id, claimed.id),
          eq(chatEndpointLeases.token, token),
        ),
      );
  }
}
