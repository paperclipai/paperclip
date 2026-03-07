/**
 * Candid IDL Factory for MemoryRepo canister (Hardened)
 *
 * This file provides the IDL factory function used to create canister actors.
 * Manually generated based on memory-repo.did to avoid build-time dependencies.
 */

const CommitRecord = (IDL: any) => IDL.Record({
  id: IDL.Text,
  timestamp: IDL.Int,
  message: IDL.Text,
  diff: IDL.Text,
  tags: IDL.Vec(IDL.Text),
  parent: IDL.Opt(IDL.Text),
  branch: IDL.Text,
});

const RepoStatusRecord = (IDL: any) => IDL.Record({
  initialized: IDL.Bool,
  currentBranch: IDL.Text,
  totalCommits: IDL.Nat,
  totalBranches: IDL.Nat,
  owner: IDL.Text,
});

const SecurityStatusRecord = (IDL: any) => IDL.Record({
  owner: IDL.Text,
  frozenMode: IDL.Bool,
  canisterKilled: IDL.Bool,
  authorizedCount: IDL.Nat,
  heapBytes: IDL.Nat,
});

const ConflictEntryRecord = (IDL: any) => IDL.Record({
  commitId: IDL.Text,
  message: IDL.Text,
  tags: IDL.Vec(IDL.Text),
  diff: IDL.Text,
});

const MergeStrategyVariant = (IDL: any) => IDL.Variant({
  auto: IDL.Null,
  manual: IDL.Null,
});

const OperationResultVariant = (IDL: any) => IDL.Variant({
  ok: IDL.Text,
  err: IDL.Text,
});

const RebaseResultVariant = (IDL: any) => IDL.Variant({
  ok: IDL.Record({ newBranch: IDL.Text, commitsReplayed: IDL.Nat }),
  err: IDL.Text,
});

const MergeResultVariant = (IDL: any) => IDL.Variant({
  ok: IDL.Record({ merged: IDL.Nat, message: IDL.Text }),
  conflicts: IDL.Vec(ConflictEntryRecord(IDL)),
  err: IDL.Text,
});

const ThoughtFormStoreRecord = (IDL: any) => IDL.Record({
  json: IDL.Text,
  timestamp: IDL.Nat64,
  hash: IDL.Text,
});

export const idlFactory = ({ IDL }: any) => IDL.Service({
  // ── Owner & Security Management ───────────────────────────────────────
  freeze: IDL.Func([], [OperationResultVariant(IDL)], []),
  manualUnlock: IDL.Func([], [OperationResultVariant(IDL)], []),
  killCanister: IDL.Func([], [OperationResultVariant(IDL)], []),
  reviveCanister: IDL.Func([], [OperationResultVariant(IDL)], []),
  addAuthorizedPrincipal: IDL.Func([IDL.Principal], [OperationResultVariant(IDL)], []),
  removeAuthorizedPrincipal: IDL.Func([IDL.Principal], [OperationResultVariant(IDL)], []),
  getSecurityStatus: IDL.Func([], [SecurityStatusRecord(IDL)], ['query']),

  // ── Repository Lifecycle ──────────────────────────────────────────────
  initRepo: IDL.Func([IDL.Text], [OperationResultVariant(IDL)], []),

  // ── Commit Operations ─────────────────────────────────────────────────
  commit: IDL.Func(
    [IDL.Text, IDL.Text, IDL.Vec(IDL.Text)],
    [OperationResultVariant(IDL)],
    [],
  ),

  getCommit: IDL.Func([IDL.Text], [IDL.Opt(CommitRecord(IDL))], ['query']),

  // ── Log & State Queries ───────────────────────────────────────────────
  log: IDL.Func([IDL.Opt(IDL.Text)], [IDL.Vec(CommitRecord(IDL))], ['query']),

  getCurrentState: IDL.Func([], [IDL.Opt(IDL.Text)], ['query']),

  getRepoStatus: IDL.Func([], [RepoStatusRecord(IDL)], ['query']),

  // ── Branch Operations ─────────────────────────────────────────────────
  getBranches: IDL.Func(
    [],
    [IDL.Vec(IDL.Tuple(IDL.Text, IDL.Text))],
    ['query'],
  ),

  createBranch: IDL.Func([IDL.Text], [OperationResultVariant(IDL)], []),

  switchBranch: IDL.Func([IDL.Text], [OperationResultVariant(IDL)], []),

  // ── Rebase (PRD 3) ────────────────────────────────────────────────────
  rebase: IDL.Func(
    [IDL.Text, IDL.Opt(IDL.Text)],
    [RebaseResultVariant(IDL)],
    [],
  ),

  // ── Merge & Cherry-Pick (PRD 4) ───────────────────────────────────────
  merge: IDL.Func(
    [IDL.Text, MergeStrategyVariant(IDL)],
    [MergeResultVariant(IDL)],
    [],
  ),

  cherryPick: IDL.Func([IDL.Text], [OperationResultVariant(IDL)], []),

  // ── ThoughtForm Memory (PRD 5) ───────────────────────────────────────
  storeThoughtForm: IDL.Func(
    [IDL.Text, IDL.Nat64, IDL.Text],
    [OperationResultVariant(IDL)],
    [],
  ),
  getThoughtForms: IDL.Func([], [IDL.Vec(ThoughtFormStoreRecord(IDL))], ['query']),
  getThoughtFormByHash: IDL.Func([IDL.Text], [IDL.Opt(ThoughtFormStoreRecord(IDL))], ['query']),
});
