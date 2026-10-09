/** Controller-authorized content. Never fetch a URL or discover a host file. */
export type NativeUserAttachment = { schema: "paperclip.user_attachment.v1"; name: string } & (
  { kind: "image"; mediaType: "image/png" | "image/jpeg" | "image/webp" | "image/gif"; data: string }
  | { kind: "text"; mediaType: "text/plain" | "text/markdown"; text: string });
export const MAX_NATIVE_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const MAX_NATIVE_ATTACHMENTS_TOTAL_BYTES = 4 * 1024 * 1024;
// turn.start fits in the 16 MiB secure frame after ciphertext hex encoding.
// Reserve 1 MiB of its plaintext allowance for command/session framing. Count
// JSON bytes, since escapes can multiply otherwise valid text content.
export const MAX_NATIVE_USER_MESSAGE_JSON_BYTES = 7 * 1024 * 1024;
export function validateNativeUserMessageSize(text: string, attachments: NativeUserAttachment[]): void {
  if (attachments.length && Buffer.byteLength(JSON.stringify({ text, attachments })) > MAX_NATIVE_USER_MESSAGE_JSON_BYTES) {
    throw new Error("Message and attachments exceed the encoded content limit; shorten the message or remove an attachment");
  }
}
export function parseNativeUserAttachments(value: unknown): NativeUserAttachment[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 8) throw new Error("At most eight native attachments are supported");
  let total = 0;
  const attachments = value.map(raw => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Invalid native attachment");
    const a = raw as Record<string, unknown>;
    const keys = a.kind === "image" ? ["schema", "name", "kind", "mediaType", "data"] : ["schema", "name", "kind", "mediaType", "text"];
    if (Object.keys(a).some(key => !keys.includes(key)) || a.schema !== "paperclip.user_attachment.v1" || typeof a.name !== "string" || !a.name || a.name.length > 240 || /[\u0000-\u001f]/.test(a.name)) throw new Error("Invalid native attachment metadata");
    let bytes: number;
    if (a.kind === "image") {
      if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(String(a.mediaType)) || typeof a.data !== "string" || a.data.length > Math.ceil(MAX_NATIVE_ATTACHMENT_BYTES / 3) * 4 || a.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(a.data)) throw new Error("Unsupported or invalid native image attachment");
      const data = Buffer.from(a.data, "base64");
      if (data.toString("base64") !== a.data) throw new Error("Native image must use canonical base64");
      const signature = a.mediaType === "image/png" ? data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        : a.mediaType === "image/jpeg" ? data[0] === 255 && data[1] === 216 && data[2] === 255
        : a.mediaType === "image/gif" ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString("ascii"))
        : data.subarray(0, 4).toString("ascii") === "RIFF" && data.subarray(8, 12).toString("ascii") === "WEBP";
      if (!signature) throw new Error("Native image content does not match its media type");
      bytes = data.length;
    } else if (a.kind === "text" && ["text/plain", "text/markdown"].includes(String(a.mediaType)) && typeof a.text === "string" && !a.text.includes("\0")) bytes = Buffer.byteLength(a.text);
    else throw new Error("This document type is not supported as native prompt content");
    total += bytes;
    if (!bytes || bytes > MAX_NATIVE_ATTACHMENT_BYTES || total > MAX_NATIVE_ATTACHMENTS_TOTAL_BYTES) throw new Error("Native attachments exceed the per-file or total content limit");
    return structuredClone(a) as NativeUserAttachment;
  });
  validateNativeUserMessageSize("", attachments);
  return attachments;
}
export function acpxAttachmentInput(text: string, value: unknown) {
  const attachments = parseNativeUserAttachments(value);
  validateNativeUserMessageSize(text, attachments);
  const images = attachments.flatMap(a => a.kind === "image" ? [{ mediaType: a.mediaType, data: a.data }] : []);
  return {
    text: text + attachments.map(a => a.kind === "text" ? `\n\nAttached document (${JSON.stringify(a.name)}):\n${a.text}` : "").join(""),
    ...(images.length ? { attachments: images } : {}),
  };
}
