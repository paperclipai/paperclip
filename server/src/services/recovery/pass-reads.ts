export type RecoveryPassReads = { issueIds: ReadonlySet<string>; reads: Map<string, Promise<unknown>> };

export function createRecoveryPassReads(issueIds: Iterable<string> = []): RecoveryPassReads {
  return { issueIds: new Set(issueIds), reads: new Map() };
}
