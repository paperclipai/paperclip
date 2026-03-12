import type { NodeStatus } from "../constants.js";

export interface Node {
  id: string;
  companyId: string;
  name: string;
  status: NodeStatus;
  capabilities: Record<string, unknown>;
  lastSeenAt: string | null;
  registeredByActorType: string | null;
  registeredByActorId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface NodeKeyCreated {
  id: string;
  nodeId: string;
  name: string;
  key: string;
  createdAt: string;
}
