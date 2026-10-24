import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  canonicalJson,
  managedDatabaseReceiptSchema,
  type ManagedDatabaseReceipt,
  type UnsignedManagedDatabaseReceipt,
} from "./managed-database.js";

/**
 * HMAC helpers for the managed embedded database contract. Node-only; keep
 * browser bundles on `managed-database.ts`.
 */

export type ManagedDatabaseSignaturePurpose = "command" | "receipt";

const MIN_CONTROL_KEY_BYTES = 32;

/** Decode PAPERCLIP_MANAGED_DATABASE_CONTROL_KEY (base64, ≥ 32 bytes). */
export function parseManagedDatabaseControlKey(raw: string | undefined): Buffer {
  if (!raw || raw.trim().length === 0) {
    throw new Error("managed database control key is missing");
  }
  const trimmed = raw.trim();
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(trimmed)) {
    throw new Error("managed database control key must be base64");
  }
  const key = Buffer.from(trimmed.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (key.length < MIN_CONTROL_KEY_BYTES) {
    throw new Error(`managed database control key must decode to at least ${MIN_CONTROL_KEY_BYTES} bytes`);
  }
  return key;
}

function signingInput(purpose: ManagedDatabaseSignaturePurpose, payload: string): string {
  return `paperclip-managed-database:${purpose}:${payload}`;
}

/** `v1=<hex>` over canonicalJson(body). */
export function signManagedDatabasePayload(
  key: Buffer,
  purpose: ManagedDatabaseSignaturePurpose,
  body: unknown,
): string {
  const mac = createHmac("sha256", key).update(signingInput(purpose, canonicalJson(body))).digest("hex");
  return `v1=${mac}`;
}

export function verifyManagedDatabaseSignature(
  key: Buffer,
  purpose: ManagedDatabaseSignaturePurpose,
  body: unknown,
  signature: string | undefined | null,
): boolean {
  if (typeof signature !== "string" || !/^v1=[0-9a-f]{64}$/.test(signature)) return false;
  let expected: string;
  try {
    expected = signManagedDatabasePayload(key, purpose, body);
  } catch {
    return false;
  }
  const left = Buffer.from(expected, "utf8");
  const right = Buffer.from(signature, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sha256HexOf(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function signManagedDatabaseReceipt(
  key: Buffer,
  receipt: UnsignedManagedDatabaseReceipt,
): ManagedDatabaseReceipt {
  return { ...receipt, signature: signManagedDatabasePayload(key, "receipt", receipt) };
}

/** Parse and authenticate a receipt. Returns null when either check fails. */
export function verifyManagedDatabaseReceipt(key: Buffer, value: unknown): ManagedDatabaseReceipt | null {
  const parsed = managedDatabaseReceiptSchema.safeParse(value);
  if (!parsed.success) return null;
  const { signature, ...unsigned } = parsed.data;
  return verifyManagedDatabaseSignature(key, "receipt", unsigned, signature) ? parsed.data : null;
}
