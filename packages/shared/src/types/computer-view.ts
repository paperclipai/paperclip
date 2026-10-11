/** Browser credentials are ephemeral: never persist this object in task state. */
export interface ComputerViewer {
  viewerUrl: string;
  expiresAt: string;
  owner: { computerId: string; ownerId: string; generation: number };
}

export interface TaskComputer {
  environmentId: string;
  name: string;
}
