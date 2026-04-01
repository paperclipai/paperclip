import { and, eq } from "drizzle-orm";
import type { Db } from "@ironworksai/db";
import { messagingBridges } from "@ironworksai/db";
import { notFound, conflict } from "../errors.js";

export type MessagingPlatform = "telegram" | "email" | "slack" | "discord";
export type BridgeStatus = "connected" | "disconnected" | "error";

export interface MessagingBridge {
  id: string;
  companyId: string;
  platform: MessagingPlatform;
  status: BridgeStatus;
  lastError: string | null;
  config: Record<string, unknown>;
  secretId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const SUPPORTED_PLATFORMS: MessagingPlatform[] = ["telegram", "email"];
const COMING_SOON_PLATFORMS: MessagingPlatform[] = ["slack", "discord"];

export function messagingBridgeService(db: Db) {
  async function list(companyId: string): Promise<MessagingBridge[]> {
    const rows = await db
      .select()
      .from(messagingBridges)
      .where(eq(messagingBridges.companyId, companyId));
    return rows as MessagingBridge[];
  }

  async function getByPlatform(
    companyId: string,
    platform: MessagingPlatform,
  ): Promise<MessagingBridge | null> {
    const rows = await db
      .select()
      .from(messagingBridges)
      .where(
        and(
          eq(messagingBridges.companyId, companyId),
          eq(messagingBridges.platform, platform),
        ),
      );
    return (rows[0] as MessagingBridge) ?? null;
  }

  async function upsert(
    companyId: string,
    platform: MessagingPlatform,
    data: {
      status?: BridgeStatus;
      lastError?: string | null;
      config?: Record<string, unknown>;
      secretId?: string | null;
    },
  ): Promise<MessagingBridge> {
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      throw conflict(`Platform "${platform}" is not yet supported`);
    }

    const existing = await getByPlatform(companyId, platform);
    const now = new Date();

    if (existing) {
      const [updated] = await db
        .update(messagingBridges)
        .set({
          status: data.status ?? existing.status,
          lastError: data.lastError !== undefined ? data.lastError : existing.lastError,
          config: data.config ?? existing.config,
          secretId: data.secretId !== undefined ? data.secretId : existing.secretId,
          updatedAt: now,
        })
        .where(eq(messagingBridges.id, existing.id))
        .returning();
      return updated as MessagingBridge;
    }

    const [created] = await db
      .insert(messagingBridges)
      .values({
        companyId,
        platform,
        status: data.status ?? "disconnected",
        lastError: data.lastError ?? null,
        config: data.config ?? {},
        secretId: data.secretId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return created as MessagingBridge;
  }

  async function remove(companyId: string, platform: MessagingPlatform): Promise<void> {
    const existing = await getByPlatform(companyId, platform);
    if (!existing) throw notFound(`No ${platform} bridge configured`);
    await db
      .delete(messagingBridges)
      .where(eq(messagingBridges.id, existing.id));
  }

  async function updateStatus(
    companyId: string,
    platform: MessagingPlatform,
    status: BridgeStatus,
    lastError?: string | null,
  ): Promise<void> {
    const existing = await getByPlatform(companyId, platform);
    if (!existing) return;
    await db
      .update(messagingBridges)
      .set({
        status,
        lastError: lastError ?? null,
        updatedAt: new Date(),
      })
      .where(eq(messagingBridges.id, existing.id));
  }

  function getSupportedPlatforms() {
    return {
      supported: SUPPORTED_PLATFORMS,
      comingSoon: COMING_SOON_PLATFORMS,
    };
  }

  return {
    list,
    getByPlatform,
    upsert,
    remove,
    updateStatus,
    getSupportedPlatforms,
  };
}
