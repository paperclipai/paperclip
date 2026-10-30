import { randomBytes } from "node:crypto";
import path from "node:path";
import type {
  ManagedDatabaseHold,
  ManagedDatabaseLeaseRef,
  ManagedDatabaseReceipt,
} from "@paperclipai/shared/managed-database";
import { readJsonIfExists, writeJsonAtomic, type ManagedDatabaseLayout } from "./layout.js";
import { rmSync } from "node:fs";

export type LeaseRecord = {
  id: string;
  epoch: number;
  holder: string;
  grantedAt: string;
  expiresAt: string;
};

type LeaseFile = { v: 1; epoch: number; lease: LeaseRecord | null };

export type LeaseCheck = { ok: true; lease: LeaseRecord } | { ok: false; code: "lease_stale" };

/**
 * Persisted lease with a monotonically increasing epoch. The epoch survives
 * restarts, so an executor holding an old grant can never match again.
 */
export class LeaseStore {
  constructor(private readonly layout: ManagedDatabaseLayout, private readonly now: () => number = Date.now) {}

  private read(): LeaseFile {
    return readJsonIfExists<LeaseFile>(this.layout.leaseFile) ?? { v: 1, epoch: 0, lease: null };
  }

  current(): LeaseRecord | null {
    const lease = this.read().lease;
    if (!lease) return null;
    return Date.parse(lease.expiresAt) > this.now() ? lease : null;
  }

  acquire(holder: string, ttlSeconds: number): { ok: true; lease: LeaseRecord } | { ok: false; code: "lease_conflict"; lease: LeaseRecord } {
    const state = this.read();
    const live = this.current();
    if (live) return { ok: false, code: "lease_conflict", lease: live };
    const epoch = state.epoch + 1;
    const now = this.now();
    const lease: LeaseRecord = {
      id: `lease_${randomBytes(12).toString("hex")}`,
      epoch,
      holder,
      grantedAt: new Date(now).toISOString(),
      expiresAt: new Date(now + ttlSeconds * 1000).toISOString(),
    };
    writeJsonAtomic(this.layout.leaseFile, { v: 1, epoch, lease } satisfies LeaseFile);
    return { ok: true, lease };
  }

  check(ref: ManagedDatabaseLeaseRef): LeaseCheck {
    const live = this.current();
    if (!live || live.id !== ref.id || live.epoch !== ref.epoch) return { ok: false, code: "lease_stale" };
    return { ok: true, lease: live };
  }

  renew(ref: ManagedDatabaseLeaseRef, ttlSeconds: number): LeaseCheck {
    const checked = this.check(ref);
    if (!checked.ok) return checked;
    const lease = { ...checked.lease, expiresAt: new Date(this.now() + ttlSeconds * 1000).toISOString() };
    writeJsonAtomic(this.layout.leaseFile, { v: 1, epoch: this.read().epoch, lease } satisfies LeaseFile);
    return { ok: true, lease };
  }

  release(ref: ManagedDatabaseLeaseRef): LeaseCheck {
    const checked = this.check(ref);
    if (!checked.ok) return checked;
    writeJsonAtomic(this.layout.leaseFile, { v: 1, epoch: this.read().epoch, lease: null } satisfies LeaseFile);
    return checked;
  }
}

/** Signed receipts keyed by commandId; a replay returns the stored receipt. */
export class ReceiptStore {
  constructor(private readonly layout: ManagedDatabaseLayout) {}

  private file(commandId: string): string {
    return path.join(this.layout.receiptsDir, `${commandId.replace(/[^A-Za-z0-9_.-]/g, "_")}.json`);
  }

  get(commandId: string): ManagedDatabaseReceipt | null {
    return readJsonIfExists<ManagedDatabaseReceipt>(this.file(commandId));
  }

  put(receipt: ManagedDatabaseReceipt): void {
    writeJsonAtomic(this.file(receipt.commandId), receipt);
  }
}

export class HoldStore {
  constructor(private readonly layout: ManagedDatabaseLayout) {}

  get(): ManagedDatabaseHold | null {
    return readJsonIfExists<ManagedDatabaseHold>(this.layout.holdFile);
  }

  set(hold: Omit<ManagedDatabaseHold, "since">): ManagedDatabaseHold {
    const value: ManagedDatabaseHold = { ...hold, since: new Date().toISOString() };
    writeJsonAtomic(this.layout.holdFile, value);
    return value;
  }

  clear(): void {
    rmSync(this.layout.holdFile, { force: true });
  }
}
