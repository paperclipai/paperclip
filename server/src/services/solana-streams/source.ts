import {
  Connection,
  PublicKey,
  type Commitment,
  type Finality,
  type VersionedBlockResponse,
} from "@solana/web3.js";
import type {
  SolanaStreamSource,
  SolanaStreamSubscriber,
  SolanaStreamAccount,
  SolanaStreamAccountUpdate,
  SolanaStreamBlock,
  SolanaStreamTransaction,
  SolanaStreamInstruction,
  SolanaStreamEvent,
} from "./types.js";

function normalizeCommitment(level: string): Commitment {
  switch (level) {
    case "processed":
    case "confirmed":
    case "finalized":
      return level;
    default:
      return "confirmed";
  }
}

function normalizeFinality(level: string): Finality {
  switch (level) {
    case "finalized":
      return "finalized";
    case "processed":
    case "confirmed":
    default:
      return "confirmed";
  }
}

function publicKeyToString(key: PublicKey | string): string {
  return typeof key === "string" ? key : key.toBase58();
}

function asUint8Array(input: Buffer | Uint8Array | number[]): Uint8Array {
  if (Array.isArray(input)) return new Uint8Array(input);
  if (Buffer.isBuffer(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return input;
}

export function mapVersionedTransaction(
  raw: VersionedBlockResponse["transactions"][number],
  slot: bigint,
  blockTime: number | null,
): SolanaStreamTransaction | null {
  const tx = "transaction" in raw ? raw.transaction : null;
  const meta = "meta" in raw ? raw.meta : null;
  if (!tx) return null;
  const message = tx.message;
  // v0 transactions can load extra accounts via address lookup tables; those
  // addresses live in meta.loadedAddresses, not in message.staticAccountKeys.
  // Include both so compiled instruction indexes resolve to the right keys.
  const loadedAddresses = meta?.loadedAddresses ?? { writable: [], readonly: [] };
  const accountKeys = [
    ...message.staticAccountKeys.map((k) => publicKeyToString(k)),
    ...loadedAddresses.writable.map((k) => publicKeyToString(k)),
    ...loadedAddresses.readonly.map((k) => publicKeyToString(k)),
  ];
  const instructions: SolanaStreamInstruction[] = message.compiledInstructions.map((ix) => {
    const programId = accountKeys[ix.programIdIndex] ?? "";
    const accounts = ix.accountKeyIndexes
      .map((idx) => accountKeys[idx])
      .filter((k): k is string => !!k);
    return { programId, accounts, data: asUint8Array(ix.data) };
  });

  return {
    signature: tx.signatures[0] ?? "",
    slot,
    blockTime: blockTime ? new Date(blockTime * 1000) : null,
    err: meta?.err ?? null,
    feePayer: accountKeys[0] ?? null,
    instructions,
    accountKeys,
    logMessages: meta?.logMessages ?? [],
    preBalances: (meta?.preBalances ?? []).map(BigInt),
    postBalances: (meta?.postBalances ?? []).map(BigInt),
  };
}

export interface SolanaRpcSourceConfig {
  rpcUrl: string;
  wsUrl?: string;
  commitment: Commitment | "processed" | "confirmed" | "finalized";
  maxReconnectDelayMs?: number;
  initialReconnectDelayMs?: number;
}

export class SolanaRpcSource implements SolanaStreamSource {
  private connection: Connection;
  private listeners = new Set<SolanaStreamSubscriber>();
  private subs: number[] = [];
  private running = false;
  private healthy = false;
  private reconnectDelayMs: number;
  private maxReconnectDelayMs: number;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private slotSub: number | null = null;

  constructor(private readonly config: SolanaRpcSourceConfig) {
    this.connection = new Connection(config.rpcUrl, {
      wsEndpoint: config.wsUrl,
      commitment: normalizeCommitment(config.commitment),
    });
    this.reconnectDelayMs = config.initialReconnectDelayMs ?? 1000;
    this.maxReconnectDelayMs = config.maxReconnectDelayMs ?? 30000;
  }

  private emit(event: SolanaStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  private setHealthy(value: boolean): void {
    if (this.healthy === value) return;
    this.healthy = value;
    this.emit(value ? { type: "connected" } : { type: "disconnected" });
  }

  private async subscribe(): Promise<void> {
    try {
      this.slotSub = this.connection.onSlotChange((slotInfo) => {
        this.setHealthy(true);
        this.fetchBlock(slotInfo.slot).catch((error: Error) => {
          this.emit({ type: "error", error });
        });
      });
      if (this.slotSub !== null) {
        this.subs.push(this.slotSub);
      }

      this.setHealthy(true);
      this.reconnectDelayMs = this.config.initialReconnectDelayMs ?? 1000;
    } catch (error) {
      this.setHealthy(false);
      this.emit({ type: "error", error: error as Error });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.running) return;
      this.reconnectDelayMs = Math.min(
        this.reconnectDelayMs * 2,
        this.maxReconnectDelayMs,
      );
      this.subscribe().catch((error: Error) => {
        this.emit({ type: "error", error });
      });
    }, this.reconnectDelayMs);
  }

  private async fetchBlock(slot: number): Promise<void> {
    const block = await this.connection.getBlock(slot, {
      maxSupportedTransactionVersion: 0,
      commitment: normalizeFinality(this.connection.commitment as string),
    });
    if (!block || !this.running) return;
    this.emit({ type: "block", data: this.mapBlock(block, BigInt(slot)) });
    for (const tx of block.transactions) {
      const parsed = this.mapTransaction(tx, BigInt(slot), block.blockTime ?? null);
      if (parsed) this.emit({ type: "transaction", data: parsed });
    }
  }

  private mapAccountUpdate(
    pubkey: PublicKey,
    account: { lamports: number; owner: PublicKey | string; executable: boolean; rentEpoch?: number; data: Buffer | Uint8Array | number[] },
    slot: number,
  ): SolanaStreamAccountUpdate {
    return {
      pubkey: publicKeyToString(pubkey),
      slot: BigInt(slot),
      account: this.mapAccount(account),
    };
  }

  private mapAccount(account: {
    lamports: number;
    owner: PublicKey | string;
    executable: boolean;
    rentEpoch?: number;
    data: Buffer | Uint8Array | number[];
  }): SolanaStreamAccount {
    return {
      lamports: BigInt(account.lamports),
      owner: typeof account.owner === "string" ? account.owner : publicKeyToString(account.owner),
      executable: account.executable,
      rentEpoch: BigInt(account.rentEpoch ?? 0),
      data: asUint8Array(account.data),
    };
  }

  private mapBlock(block: VersionedBlockResponse, slot: bigint): SolanaStreamBlock {
    return {
      slot,
      blockhash: block.blockhash,
      blockTime: block.blockTime ? new Date(block.blockTime * 1000) : null,
      parentSlot: BigInt(block.parentSlot ?? 0),
      transactions: block.transactions
        .map((tx) => this.mapTransaction(tx, slot, block.blockTime ?? null))
        .filter((tx): tx is SolanaStreamTransaction => tx !== null),
    };
  }

  private mapTransaction(
    raw: VersionedBlockResponse["transactions"][number],
    slot: bigint,
    blockTime: number | null,
  ): SolanaStreamTransaction | null {
    return mapVersionedTransaction(raw, slot, blockTime);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.subscribe();
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    for (const sub of this.subs) {
      try {
        await this.connection.removeSlotChangeListener(sub);
      } catch {
        // not a slot-change sub — try account-change
        try {
          await this.connection.removeAccountChangeListener(sub);
        } catch {
          // ignore
        }
      }
    }
    this.subs = [];
    this.setHealthy(false);
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  onEvent(listener: SolanaStreamSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Subscribe to account updates for a specific pubkey. The account subscription
   * is in addition to the default slot-change subscription. Returns an
   * unsubscribe function.
   */
  subscribeAccount(pubkey: PublicKey | string): () => void {
    const pk = typeof pubkey === "string" ? new PublicKey(pubkey) : pubkey;
    const id = this.connection.onAccountChange(
      pk,
      (account, context) => {
        this.setHealthy(true);
        this.emit({
          type: "account",
          data: this.mapAccountUpdate(pk, account, context.slot),
        });
      },
      this.connection.commitment,
    );
    this.subs.push(id);
    return () => {
      this.connection.removeAccountChangeListener(id).catch(() => {});
    };
  }
}

export class SolanaMockSource implements SolanaStreamSource {
  private listeners = new Set<SolanaStreamSubscriber>();
  private running = false;
  private healthy = false;

  emit(event: SolanaStreamEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore
      }
    }
  }

  async start(): Promise<void> {
    this.running = true;
    this.healthy = true;
    this.emit({ type: "connected" });
  }

  async stop(): Promise<void> {
    this.running = false;
    this.healthy = false;
    this.emit({ type: "disconnected" });
  }

  isHealthy(): boolean {
    return this.healthy;
  }

  onEvent(listener: SolanaStreamSubscriber): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
