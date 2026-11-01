import type { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryKeys";
import { authApi } from "@/api/auth";
import { classifySendFailure } from "./pending-send";

type AccountGeneration = { owner: string | undefined; generation: number };
const accounts = new WeakMap<QueryClient, AccountGeneration>();

function currentOwner(client: QueryClient): string | undefined {
  const session = client.getQueryData<{ user?: { id?: string }; session?: { userId?: string } } | null>(queryKeys.auth.session);
  return session === undefined ? undefined : session?.user?.id ?? session?.session?.userId ?? "signed-out";
}

/** A successful sign-out ends pending work even if the first session never loaded. */
export function invalidateAccountScope(client: QueryClient) {
  const account = accounts.get(client);
  if (account) account.generation += 1;
}

export function bindAccount(client: QueryClient) {
  let account = accounts.get(client);
  if (!account) {
    account = { owner: currentOwner(client), generation: 0 };
    accounts.set(client, account);
    const tracked = account;
    client.getQueryCache().subscribe(event => {
      const owner = currentOwner(client);
      const removed = event.type === "removed" && JSON.stringify(event.query.queryKey) === JSON.stringify(queryKeys.auth.session);
      if (owner !== tracked.owner || removed) {
        if (removed || tracked.owner !== undefined || tracked.generation !== 0) tracked.generation += 1;
        tracked.owner = owner;
      }
    });
  }
  const { owner, generation } = account;
  const isCurrentScope = () => account.generation === generation && (owner === undefined ? generation === 0 : account.owner === owner);
  const isCurrentAccount = () => account.owner !== undefined && isCurrentScope();
  const whenAccountReady = async () => {
    if (account.owner !== undefined || !isCurrentScope()) return;
    let stopped = false;
    let unsubscribe = () => {};
    const ready = new Promise<void>(resolve => {
      unsubscribe = client.getQueryCache().subscribe(() => {
        if (account.owner !== undefined || !isCurrentScope()) resolve();
      });
    });
    const lookup = async () => {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        if (stopped || account.owner !== undefined || !isCurrentScope()) return;
        try {
          await client.fetchQuery({ queryKey: queryKeys.auth.session, queryFn: () => authApi.getSession(), retry: false });
          return;
        } catch (error) {
          if (stopped || account.owner !== undefined || !isCurrentScope()) return;
          if (attempt === 2 || classifySendFailure(error) !== "pending") throw error;
          await new Promise(resolve => setTimeout(resolve, 250 * 2 ** attempt));
        }
      }
    };
    try { await Promise.race([ready, lookup()]); }
    finally { stopped = true; unsubscribe(); }
  };
  return { isCurrentAccount, isCurrentScope, whenAccountReady };
}

