import type { Attachment, Message as ChatMessage } from "chat";
import type {
  GrpcAdvancedIMessage,
  CompanionInfo,
  Message as PhotonMessage,
} from "@photon-ai/advanced-imessage";
import { z } from "zod";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";
import { PhotonError, photonFailure } from "./cloud.js";
const guid = z.string().min(1).max(512);
export const photonAttachmentLocatorSchema = z
  .object({
    kind: z.literal("photon_attachment"),
    lineId: guid,
    chatGuid: guid,
    messageGuid: guid,
    attachmentGuid: guid,
    partIndex: z.number().int().nonnegative().max(100).optional(),
  })
  .strict();
export type PhotonAttachmentLocator = z.infer<
  typeof photonAttachmentLocatorSchema
>;

type PhotonCompanion =
  | { unavailable: true }
  | { unavailable: false; data: Buffer; fileName: string; mimeType: string };
const companions = new WeakMap<Buffer, PhotonCompanion>();
/** Bytes are ephemeral. Recovery downloads the source-bound primary and companion again. */
export function takePhotonCompanion(body: Buffer): PhotonCompanion | undefined {
  const companion = companions.get(body);
  companions.delete(body);
  return companion;
}

export function photonAttachmentLocator(
  attachment: Attachment,
  lineId: string,
  chatGuid: string,
  message: ChatMessage,
): PhotonAttachmentLocator | null {
  const parsed = photonAttachmentLocatorSchema.safeParse(
    attachment.fetchMetadata
      ? {
          kind: attachment.fetchMetadata.kind,
          lineId: attachment.fetchMetadata.lineId,
          chatGuid: attachment.fetchMetadata.chatGuid,
          messageGuid: attachment.fetchMetadata.messageGuid,
          attachmentGuid: attachment.fetchMetadata.attachmentGuid,
        }
      : null,
  );
  if (
    !parsed.success ||
    parsed.data.lineId !== lineId ||
    parsed.data.chatGuid !== chatGuid ||
    parsed.data.messageGuid !== message.id
  )
    return null;
  const raw = message.raw as PhotonMessage;
  if (
    !raw.chatGuids?.includes(chatGuid) ||
    !raw.content?.attachments.some(
      (candidate) => candidate.guid === parsed.data.attachmentGuid,
    )
  )
    return null;
  return parsed.data;
}
export async function downloadPhotonAttachment(
  client: GrpcAdvancedIMessage,
  lineId: string,
  locator: PhotonAttachmentLocator,
  allocation: "dedicated" | "shared" = "dedicated",
): Promise<Buffer> {
  photonAttachmentLocatorSchema.parse(locator);
  if (locator.lineId !== lineId)
    throw new Error("Photon attachment belongs to another line");
  const source = await client.messages
    .get(locator.messageGuid)
    .catch((error) => {
      throw photonFailure(error);
    });
  const attachment = source.content.attachments.find(
    (candidate) => candidate.guid === locator.attachmentGuid,
  );
  if (
    source.guid !== locator.messageGuid ||
    !source.chatGuids.includes(locator.chatGuid) ||
    !attachment ||
    attachment.isSticker ||
    attachment.isHidden
  )
    throw new Error(
      "Photon attachment does not belong to this message and chat",
    );
  if (
    !Number.isSafeInteger(attachment.totalBytes) ||
    attachment.totalBytes < 0 ||
    attachment.totalBytes > MAX_ATTACHMENT_BYTES
  )
    throw new Error("Attachment exceeds the configured size limit");
  const stream = client.attachments.downloadStream(locator.attachmentGuid);
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void stream.close();
  }, 30_000);
  timer.unref();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let header = false;
  let companionInfo: CompanionInfo | undefined;
  let companionUnavailable = false;
  let companionStarted = false;
  let companionLength = 0;
  const companionChunks: Uint8Array[] = [];
  try {
    for await (const part of stream) {
      if (part.type === "header") {
        // The shared gateway rewrites message/metadata attachment IDs to opaque
        // project aliases, but streams the native UUID in download headers.
        // Ownership comes from the authenticated source-message lookup above
        // and this exact alias-addressed RPC, never from matching filenames.
        const sharedAlias = allocation === "shared" &&
          /^spc-att-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(locator.attachmentGuid);
        const matchingSharedHeader = sharedAlias &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(part.info.guid) &&
          part.info.totalBytes === attachment.totalBytes &&
          part.info.mimeType === attachment.mimeType &&
          part.info.fileName === attachment.fileName;
        if (
          header ||
          (part.info.guid !== locator.attachmentGuid && !matchingSharedHeader) ||
          part.info.isHidden || part.info.isSticker ||
          !Number.isSafeInteger(part.info.totalBytes) || part.info.totalBytes < 0 ||
          part.info.totalBytes > MAX_ATTACHMENT_BYTES
        )
          throw new Error("Photon attachment metadata changed");
        header = true;
        companionInfo = part.companionInfo;
        companionUnavailable = Boolean(
          companionInfo &&
            (companionInfo.kind !== "live-photo-video" ||
              !["video/quicktime", "video/mp4"].includes(
                companionInfo.mimeType,
              ) ||
              !Number.isSafeInteger(companionInfo.totalBytes) ||
              companionInfo.totalBytes <= 0 ||
              companionInfo.totalBytes > MAX_ATTACHMENT_BYTES),
        );
      } else if (part.type === "primaryChunk") {
        if (companionStarted)
          throw new Error("Photon attachment chunks arrived out of order");
        if (!header) throw new Error("Photon attachment header is missing");
        length += part.data.length;
        if (length > MAX_ATTACHMENT_BYTES)
          throw new Error("Attachment exceeds the configured size limit");
        chunks.push(part.data);
      } else if (part.type === "companionChunk") {
        if (!header || !companionInfo)
          throw new Error("Photon companion metadata is missing");
        companionStarted = true;
        companionLength += part.data.length;
        if (companionUnavailable || companionLength > MAX_ATTACHMENT_BYTES) {
          companionUnavailable = true;
          break;
        }
        companionChunks.push(part.data);
      }
    }
    if (timedOut || !header || !length)
      throw new PhotonError(
        "attachment_not_ready",
        "Photon attachment is still being prepared; retry download",
      );
    if (attachment.totalBytes > 0 && length !== attachment.totalBytes)
      throw new PhotonError(
        "attachment_not_ready",
        "Photon attachment transfer is incomplete",
      );
    if (
      companionInfo &&
      !companionUnavailable &&
      companionLength !== companionInfo.totalBytes
    )
      throw new PhotonError(
        "attachment_not_ready",
        "Photon Live Photo companion is still being prepared",
      );
    const body = Buffer.concat(chunks);
    if (companionUnavailable) companions.set(body, { unavailable: true });
    else if (companionInfo)
      companions.set(body, {
        unavailable: false,
        data: Buffer.concat(companionChunks),
        fileName: companionInfo.fileName,
        mimeType: companionInfo.mimeType,
      });
    return body;
  } catch (error) {
    if (error instanceof Error && !("code" in error)) throw error;
    throw photonFailure(error);
  } finally {
    clearTimeout(timer);
    await stream.close();
  }
}
