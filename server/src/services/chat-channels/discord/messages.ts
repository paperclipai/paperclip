import type { RuntimeContext } from "../runtime-types.js";
import type { FileUpload } from "chat";
import { createHash } from "node:crypto";


export function discordLifecycleFilesDigest(raw: unknown): string {
  const attachments =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>).attachments
      : undefined;
  // Match the pinned Gateway adapter's flattened, ordered file projection.
  // Rotating CDN URLs are transport authority, never source revision identity.
  const projection = Array.isArray(attachments)
    ? attachments.map((attachment) => {
        const row =
          attachment &&
          typeof attachment === "object" &&
          !Array.isArray(attachment)
            ? (attachment as Record<string, unknown>)
            : {};
        return [
          ...["id", "filename", "content_type"].map((key) =>
            typeof row[key] === "string" ? row[key] : null,
          ),
          typeof row.size === "number" && Number.isFinite(row.size)
            ? row.size
            : null,
        ];
      })
    : [];
  return createHash("sha256").update(JSON.stringify(projection)).digest("hex");
}

export function discordMarkdownAttachment(text: string): FileUpload {
    return {
      data: Buffer.from(text, "utf8"),
      filename: "paperclip-response.md",
      mimeType: "text/markdown; charset=utf-8",
    };
  }

export async function admitDiscordSdkMessage(
  endpointId: string,
  runtimeContext: RuntimeContext | undefined,
  options: {
    ensureRuntimeIsCurrent: (endpointId: string, context: RuntimeContext) => Promise<boolean>;
    messageAdmissionBarrier: () => Promise<void> | void;
  },
): Promise<boolean> {
  if (!runtimeContext || !(await options.ensureRuntimeIsCurrent(endpointId, runtimeContext))) return false;
  await options.messageAdmissionBarrier();
  return true;
}
