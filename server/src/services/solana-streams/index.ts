import type { SolanaStreamFilter } from "./types.js";
import { SolanaRpcSource, SolanaMockSource } from "./source.js";
import { createSolanaStreamManager } from "./manager.js";
import { solanaStreamConfigSchema, solanaStreamFilterSchema } from "./types.js";
import { createCombinedFilter, matchesTransaction, matchesAccountUpdate, matchesBlock } from "./filters.js";

export type {
  SolanaStreamConfig,
  SolanaStreamFilter,
  SolanaStreamAccount,
  SolanaStreamAccountUpdate,
  SolanaStreamInstruction,
  SolanaStreamTransaction,
  SolanaStreamBlock,
  SolanaStreamEvent,
  SolanaStreamSubscriber,
  SolanaStreamSource,
  SolanaStream,
  SolanaStreamManager,
  Commitment,
} from "./types.js";

export {
  SolanaRpcSource,
  SolanaMockSource,
  createSolanaStreamManager,
  solanaStreamConfigSchema,
  solanaStreamFilterSchema,
  createCombinedFilter,
  matchesTransaction,
  matchesAccountUpdate,
  matchesBlock,
};

export function createSolanaRpcStream(config: {
  id: string;
  name: string;
  rpcUrl: string;
  wsUrl?: string;
  commitment?: "processed" | "confirmed" | "finalized";
  filters?: SolanaStreamFilter[];
  enabled?: boolean;
  maxReconnectDelayMs?: number;
  initialReconnectDelayMs?: number;
}) {
  const validated = solanaStreamConfigSchema.parse({
    ...config,
    commitment: config.commitment ?? "confirmed",
    filters: config.filters ?? [],
  });
  const source = new SolanaRpcSource({
    rpcUrl: validated.rpcUrl,
    wsUrl: validated.wsUrl,
    commitment: validated.commitment,
    maxReconnectDelayMs: validated.maxReconnectDelayMs,
    initialReconnectDelayMs: validated.initialReconnectDelayMs,
  });
  return { config: validated, source };
}
