import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Database as DB } from "better-sqlite3";
import type { MappingEntry, FindingType } from "./types.js";

interface Row {
  mapping_id: string;
  tenant_id: string;
  pseudonym: string;
  plaintext_enc: Buffer;
  plaintext_iv: Buffer;
  plaintext_tag: Buffer;
  type: string;
  created_at: number;
  ttl_seconds: number;
}

export interface MappingStoreOptions {
  path: string;
  key: Buffer;
}

export class MappingStore {
  private db: DB;
  private key: Buffer;

  constructor(opts: MappingStoreOptions) {
    if (opts.key.length !== 32) {
      throw new Error("Mapping store key must be 32 bytes");
    }
    this.db = new Database(opts.path);
    this.key = opts.key;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mappings (
        mapping_id     TEXT NOT NULL,
        tenant_id      TEXT NOT NULL DEFAULT 'whitestag-internal',
        pseudonym      TEXT NOT NULL,
        plaintext_enc  BLOB NOT NULL,
        plaintext_iv   BLOB NOT NULL,
        plaintext_tag  BLOB NOT NULL,
        type           TEXT NOT NULL,
        created_at     INTEGER NOT NULL,
        ttl_seconds    INTEGER NOT NULL DEFAULT 86400,
        PRIMARY KEY (mapping_id, pseudonym)
      );
      CREATE INDEX IF NOT EXISTS idx_mappings_tenant ON mappings(tenant_id);
      CREATE INDEX IF NOT EXISTS idx_mappings_cleanup ON mappings(created_at, ttl_seconds);
    `);
  }

  write(
    mappingId: string,
    tenantId: string,
    mappings: MappingEntry[],
    ttlSeconds: number,
  ): void {
    const stmt = this.db.prepare<unknown[], Row>(`
      INSERT OR REPLACE INTO mappings
        (mapping_id, tenant_id, pseudonym, plaintext_enc, plaintext_iv, plaintext_tag, type, created_at, ttl_seconds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const now = Math.floor(Date.now() / 1000);
    const tx = this.db.transaction((entries: MappingEntry[]) => {
      for (const m of entries) {
        const { ciphertext, iv, tag } = this.encrypt(m.plaintext);
        stmt.run(mappingId, tenantId, m.pseudonym, ciphertext, iv, tag, m.type, now, ttlSeconds);
      }
    });
    tx(mappings);
  }

  read(mappingId: string): MappingEntry[] {
    const rows = this.db.prepare<[string], Row>(`
      SELECT * FROM mappings WHERE mapping_id = ?
    `).all(mappingId);
    return rows.map((r) => ({
      pseudonym: r.pseudonym,
      plaintext: this.decrypt(r.plaintext_enc, r.plaintext_iv, r.plaintext_tag),
      type: r.type as FindingType,
    }));
  }

  readByTenant(tenantId: string): MappingEntry[] {
    const rows = this.db.prepare<[string], Row>(`
      SELECT * FROM mappings WHERE tenant_id = ?
    `).all(tenantId);
    return rows.map((r) => ({
      pseudonym: r.pseudonym,
      plaintext: this.decrypt(r.plaintext_enc, r.plaintext_iv, r.plaintext_tag),
      type: r.type as FindingType,
    }));
  }

  cleanup(): number {
    const now = Math.floor(Date.now() / 1000);
    const result = this.db.prepare(`
      DELETE FROM mappings WHERE (created_at + ttl_seconds) <= ?
    `).run(now);
    return result.changes;
  }

  close(): void {
    this.db.close();
  }

  private encrypt(plaintext: string): { ciphertext: Buffer; iv: Buffer; tag: Buffer } {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return { ciphertext, iv, tag };
  }

  private decrypt(ciphertext: Buffer, iv: Buffer, tag: Buffer): string {
    const decipher = createDecipheriv("aes-256-gcm", this.key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  }
}
