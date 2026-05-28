import type { Sql } from "postgres";
import { randomUUID } from "node:crypto";
import type { IdentityBinding } from "./types.js";

export interface IdentityStore {
  findBinding(platform: string, platformUserId: string): Promise<IdentityBinding | null>;
  createBinding(params: {
    platform: string;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
    displayName: string | null;
  }): Promise<IdentityBinding>;
  revokeBinding(platform: string, platformUserId: string): Promise<boolean>;
}

export class PostgresIdentityStore implements IdentityStore {
  constructor(private readonly sql: Sql) {}

  async ensureTable(): Promise<void> {
    await this.sql`
      CREATE TABLE IF NOT EXISTS identity_bindings (
        id UUID PRIMARY KEY,
        platform TEXT NOT NULL,
        platform_user_id TEXT NOT NULL,
        paperclip_user_id UUID NOT NULL,
        paperclip_company_id UUID NOT NULL,
        display_name TEXT,
        bound_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        revoked_at TIMESTAMPTZ,
        UNIQUE(platform, platform_user_id) WHERE (revoked_at IS NULL)
      )
    `;
    await this.sql`
      CREATE INDEX IF NOT EXISTS idx_identity_bindings_lookup
        ON identity_bindings(platform, platform_user_id)
        WHERE revoked_at IS NULL
    `;
  }

  async findBinding(platform: string, platformUserId: string): Promise<IdentityBinding | null> {
    const rows = await this.sql<IdentityBinding[]>`
      SELECT id, platform, platform_user_id AS "platformUserId",
             paperclip_user_id AS "paperclipUserId",
             paperclip_company_id AS "paperclipCompanyId",
             display_name AS "displayName",
             bound_at AS "boundAt",
             revoked_at AS "revokedAt"
      FROM identity_bindings
      WHERE platform = ${platform}
        AND platform_user_id = ${platformUserId}
        AND revoked_at IS NULL
      LIMIT 1
    `;
    return rows[0] ?? null;
  }

  async createBinding(params: {
    platform: string;
    platformUserId: string;
    paperclipUserId: string;
    paperclipCompanyId: string;
    displayName: string | null;
  }): Promise<IdentityBinding> {
    const id = randomUUID();
    const rows = await this.sql<IdentityBinding[]>`
      INSERT INTO identity_bindings (id, platform, platform_user_id, paperclip_user_id, paperclip_company_id, display_name)
      VALUES (${id}, ${params.platform}, ${params.platformUserId}, ${params.paperclipUserId}, ${params.paperclipCompanyId}, ${params.displayName})
      RETURNING id, platform, platform_user_id AS "platformUserId",
                paperclip_user_id AS "paperclipUserId",
                paperclip_company_id AS "paperclipCompanyId",
                display_name AS "displayName",
                bound_at AS "boundAt",
                revoked_at AS "revokedAt"
    `;
    return rows[0]!;
  }

  async revokeBinding(platform: string, platformUserId: string): Promise<boolean> {
    const result = await this.sql`
      UPDATE identity_bindings
      SET revoked_at = NOW()
      WHERE platform = ${platform}
        AND platform_user_id = ${platformUserId}
        AND revoked_at IS NULL
    `;
    return result.count > 0;
  }
}
