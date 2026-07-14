import { z } from "zod";
import type { Commitment } from "@solana/web3.js";

export const solanaStreamFilterSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  includeAccounts: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)).optional(),
  excludeAccounts: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)).optional(),
  includePrograms: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)).optional(),
  excludePrograms: z.array(z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/)).optional(),
  signatureIncludes: z.array(z.string()).optional(),
  minSlot: z.bigint().optional(),
  maxSlot: z.bigint().optional(),
});

export type SolanaStreamFilter = z.infer<typeof solanaStreamFilterSchema>;

export const solanaStreamConfigSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  rpcUrl: z.string().url(),
  wsUrl: z.string().url().optional(),
  commitment: z.enum(["processed", "confirmed", "finalized"]).default("confirmed"),
  filters: z.array(solanaStreamFilterSchema).default([]),
  enabled: z.boolean().default(true),
  maxReconnectDelayMs: z.number().int().min(100).default(30000),
  initialReconnectDelayMs: z.number().int().min(100).default(1000),
});

export type SolanaStreamConfig = z.infer<typeof solanaStreamConfigSchema>;

export interface SolanaStreamAccount {
  lamports: bigint;
  owner: string;
  executable: boolean;
  rentEpoch: bigint;
  data: Uint8Array;
}

export interface SolanaStreamInstruction {
  programId: string;
  accounts: string[];
  data: Uint8Array;
}

export interface SolanaStreamTransaction {
  signature: string;
  slot: bigint;
  blockTime: Date | null;
  err: unknown | null;
  feePayer: string | null;
  instructions: SolanaStreamInstruction[];
  accountKeys: string[];
  logMessages: string[];
  preBalances: bigint[];
  postBalances: bigint[];
}

export interface SolanaStreamBlock {
  slot: bigint;
  blockhash: string;
  blockTime: Date | null;
  parentSlot: bigint;
  transactions: SolanaStreamTransaction[];
}

export interface SolanaStreamAccountUpdate {
  pubkey: string;
  slot: bigint;
  account: SolanaStreamAccount;
}

export type SolanaStreamEvent =
  | { type: "block"; data: SolanaStreamBlock }
  | { type: "transaction"; data: SolanaStreamTransaction }
  | { type: "account"; data: SolanaStreamAccountUpdate }
  | { type: "error"; error: Error }
  | { type: "connected" }
  | { type: "disconnected" };

export type SolanaStreamSubscriber = (event: SolanaStreamEvent) => void;

export interface SolanaStreamSource {
  start(): Promise<void>;
  stop(): Promise<void>;
  isHealthy(): boolean;
  onEvent(listener: SolanaStreamSubscriber): () => void;
}

export interface SolanaStream {
  config: SolanaStreamConfig;
  source: SolanaStreamSource;
  subscribers: Set<SolanaStreamSubscriber>;
  unsubscribe?: () => void;
}

export interface SolanaStreamManager {
  createStream(config: SolanaStreamConfig, source?: SolanaStreamSource): SolanaStream;
  deleteStream(streamId: string): Promise<void>;
  getStream(streamId: string): SolanaStream | undefined;
  listStreams(): SolanaStream[];
  subscribe(streamId: string, listener: SolanaStreamSubscriber): () => void;
  startStream(streamId: string): Promise<void>;
  stopStream(streamId: string): Promise<void>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
}

export type { Commitment };
