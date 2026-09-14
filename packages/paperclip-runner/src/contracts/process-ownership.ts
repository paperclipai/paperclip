/** Host-side process metadata. Provider protocol messages are not ownership receipts. */
export interface RunnerProcessOwnershipMetadata {
  pid: number;
  processGroupId: number | null;
  startedAt: string;
  processLocation?: "local" | "remote";
  remoteProcessIdentity?: {
    version: 1;
    pid: number;
    uid: number;
    processGroupId: number;
    bootId: string;
    startTicks: string;
  };
}
