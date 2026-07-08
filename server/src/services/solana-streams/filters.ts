import type {
  SolanaStreamFilter,
  SolanaStreamAccountUpdate,
  SolanaStreamTransaction,
  SolanaStreamBlock,
} from "./types.js";

export function matchesTransaction(
  filter: SolanaStreamFilter,
  tx: SolanaStreamTransaction,
): boolean {
  if (filter.minSlot !== undefined && tx.slot < filter.minSlot) return false;
  if (filter.maxSlot !== undefined && tx.slot > filter.maxSlot) return false;

  if (filter.signatureIncludes?.length) {
    const hasMatch = filter.signatureIncludes.some((fragment) =>
      tx.signature.includes(fragment),
    );
    if (!hasMatch) return false;
  }

  if (filter.excludePrograms?.length) {
    const excluded = tx.instructions.some((ix) =>
      filter.excludePrograms!.includes(ix.programId),
    );
    if (excluded) return false;
  }

  if (filter.includePrograms?.length) {
    const included = tx.instructions.some((ix) =>
      filter.includePrograms!.includes(ix.programId),
    );
    if (!included) return false;
  }

  if (filter.excludeAccounts?.length) {
    const excluded = tx.accountKeys.some((key) =>
      filter.excludeAccounts!.includes(key),
    );
    if (excluded) return false;
  }

  if (filter.includeAccounts?.length) {
    const included = tx.accountKeys.some((key) =>
      filter.includeAccounts!.includes(key),
    );
    if (!included) return false;
  }

  return true;
}

export function matchesAccountUpdate(
  filter: SolanaStreamFilter,
  update: SolanaStreamAccountUpdate,
): boolean {
  if (filter.minSlot !== undefined && update.slot < filter.minSlot) return false;
  if (filter.maxSlot !== undefined && update.slot > filter.maxSlot) return false;

  if (filter.excludeAccounts?.length) {
    if (filter.excludeAccounts.includes(update.pubkey)) return false;
  }

  if (filter.includeAccounts?.length) {
    if (!filter.includeAccounts.includes(update.pubkey)) return false;
  }

  if (filter.includePrograms?.length) {
    if (!filter.includePrograms.includes(update.account.owner)) return false;
  }

  if (filter.excludePrograms?.length) {
    if (filter.excludePrograms.includes(update.account.owner)) return false;
  }

  return true;
}

export function matchesBlock(
  filter: SolanaStreamFilter,
  block: SolanaStreamBlock,
): boolean {
  if (filter.minSlot !== undefined && block.slot < filter.minSlot) return false;
  if (filter.maxSlot !== undefined && block.slot > filter.maxSlot) return false;
  return true;
}

export function createCombinedFilter(filters: SolanaStreamFilter[]) {
  return {
    transaction: (tx: SolanaStreamTransaction) =>
      filters.length === 0 || filters.some((f) => matchesTransaction(f, tx)),
    account: (update: SolanaStreamAccountUpdate) =>
      filters.length === 0 || filters.some((f) => matchesAccountUpdate(f, update)),
    block: (block: SolanaStreamBlock) =>
      filters.length === 0 || filters.some((f) => matchesBlock(f, block)),
  };
}
