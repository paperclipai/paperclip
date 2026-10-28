import { updateAgentConfigurationInTransaction } from "./agent-configuration-transaction.js";
import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import sharp from "sharp";
import { agents, assets, companies, type Db } from "@paperclipai/db";
import { MAX_AGENT_AVATAR_BYTES, resolveAgentAppearance, agentAvatarUrl, setAgentAvatarSchema, type SetAgentAvatarInput } from "@paperclipai/shared";
import { conflict, notFound, unprocessable } from "../errors.js";
import type { StorageService } from "../storage/types.js";
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from "./activity-log.js";

/** Decode and re-encode: exclude SVG, animation, metadata and unbounded pixel counts. No URL fetching. */
export async function normalizeAgentAvatar(input: string) {
  const bytes = Buffer.from(input, "base64");
  if (!bytes.length || bytes.length > MAX_AGENT_AVATAR_BYTES || bytes.toString("base64") !== input) {
    throw unprocessable("Avatar must contain at most 512 KiB of base64-encoded image bytes");
  }
  const rasterSignature = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    || (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255)
    || (bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP");
  if (!rasterSignature) throw unprocessable("Use a PNG, JPEG, or WebP image");
  try {
    const image = sharp(bytes, { limitInputPixels: 16_777_216, failOn: "warning" });
    const metadata = await image.metadata();
    if (!["png", "jpeg", "webp"].includes(metadata.format ?? "") || (metadata.pages ?? 1) !== 1) throw new Error("Unsupported image");
    return await image.rotate().resize(512, 512, { fit: "inside", withoutEnlargement: true }).png().toBuffer();
  } catch {
    throw unprocessable("Use a valid static PNG, JPEG, or WebP image with at most 16 megapixels");
  }
}

type AvatarActor = Pick<LogActivityInput, "actorType" | "actorId" | "agentId" | "runId" | "agentApiKeyId">;
export async function setAgentProfileAvatar(db: Db, storage: StorageService, companyId: string, agentId: string, input: SetAgentAvatarInput, actor: AvatarActor) {
  const parsed = setAgentAvatarSchema.parse(input);
  // Authorization belongs to the REST/MCP boundary. Validate scope and eligibility before decoding.
  const [target] = await db.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId)));
  if (!target) throw notFound("Agent not found");
  if (["terminated", "pending_approval"].includes(target.status)) throw conflict("Agent avatar cannot be updated in its current state");
  const png = parsed.imageBase64 === null ? null : await normalizeAgentAvatar(parsed.imageBase64);
  const digest = png ? createHash("sha256").update(png).digest("hex") : null;
  let newObjectKey: string | undefined;
  const publications: ActivityPublication[] = [];
  try {
    const result = await db.transaction(async tx => {
      const txDb = tx as unknown as Db;
      const [agent] = await tx.select().from(agents).where(and(eq(agents.id, agentId), eq(agents.companyId, companyId))).for("update");
      const [company] = await tx.select().from(companies).where(eq(companies.id, companyId));
      if (!agent || company?.status !== "active" || ["terminated", "pending_approval"].includes(agent.status)) throw conflict("Agent avatar cannot be updated in its current state");
      const appearance = resolveAgentAppearance(agent.appearance, agent.id);
      const current = appearance.customAvatarAssetId
        ? (await tx.select().from(assets).where(and(eq(assets.id, appearance.customAvatarAssetId), eq(assets.companyId, companyId))))[0]
        : null;
      if ((png && current?.sha256 === digest) || (!png && !appearance.customAvatarAssetId)) {
        return { agentId, appearance, avatarUrl: agentAvatarUrl(appearance) };
      }
      delete appearance.customAvatarAssetId;
      if (png) {
        const stored = await storage.putFile({ companyId, namespace: `agent-avatars/${agentId}`, originalFilename: "avatar.png", contentType: "image/png", body: png });
        newObjectKey = stored.objectKey;
        const [asset] = await tx.insert(assets).values({ ...stored, companyId, createdByAgentId: agentId,
          createdByUserId: actor.actorType === "user" ? actor.actorId : null }).returning();
        appearance.customAvatarAssetId = asset!.id;
      }
      await updateAgentConfigurationInTransaction(txDb, agentId, { appearance }, { recordRevision: {
        createdByAgentId: actor.agentId, createdByUserId: actor.actorType === "user" ? actor.actorId : null, source: "avatar-upload",
      } });
      await logActivity(txDb, { ...actor, companyId, action: "agent.avatar_updated", entityType: "agent", entityId: agentId,
        details: { assetId: appearance.customAvatarAssetId ?? null, byteSize: png?.length ?? 0 } }, publications);
      return { agentId, appearance, avatarUrl: agentAvatarUrl(appearance) };
    });
    publications.forEach(publishActivity);
    return result;
  } catch (error) {
    if (newObjectKey) await storage.deleteObject(companyId, newObjectKey).catch(() => {});
    throw error;
  }
}
