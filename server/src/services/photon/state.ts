import { createHash } from "node:crypto";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateScope,
} from "../chat-sdk-state.js";

/** Typed provider records share the existing company/endpoint scoped CAS store. */
export class PhotonState {
  constructor(
    readonly scope: ChatSdkStateScope,
    private readonly persistence: ChatSdkStatePersistence,
  ) {}
  private key(key: string): string {
    return `photon:${createHash("sha256").update(key).digest("hex")}`;
  }
  async read<T>(key: string): Promise<T | null> {
    const row = await this.persistence.read(this.scope, this.key(key));
    return row ? (row.value as T) : null;
  }
  async update<T>(key: string, update: (current: T | null) => T): Promise<T> {
    for (let attempt = 0; attempt < 32; attempt++) {
      const row = await this.persistence.read(this.scope, this.key(key));
      const value = update(row ? (row.value as T) : null);
      if (Buffer.byteLength(JSON.stringify(value)) > 512 * 1024)
        throw new Error("Photon state record is too large");
      if (
        await this.persistence.compareAndSet({
          ...this.scope,
          key: this.key(key),
          expectedVersion: row?.version ?? null,
          expiresAt: null,
          value,
        })
      )
        return value;
    }
    throw new Error("Photon state changed concurrently; retry");
  }
}
