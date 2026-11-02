import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const COPILOT_APP_SHA256 = "7b48282a19b5b0814a0c96ad5e3a125173d792cc55f9525b2effea962f6063c0";
export const COPILOT_INNER_DISTRIBUTIONS = Object.freeze({
  "darwin-arm64": Object.freeze({ offset: 92954063, size: 55323492, sha256: "49f5caa0582945a04c5619f8ea81680b1c8c2765888290cf8acf903e2985315b", entries: 230 }),
  "darwin-x64": Object.freeze({ offset: 95169991, size: 64572726, sha256: "a4c41f1f480a259db2e4da952d5d2e92d19ae54ae1d6af97143341b6c4918aea", entries: 231 }),
  "linux-x64": Object.freeze({ offset: 108781435, size: 60742828, sha256: "c386269ee1bf44bac514da2bb0c6b2a47546631f02e294fc5a8c20d1b1b990ff", entries: 216 }),
});
export const COPILOT_MESSAGE_MAPPING_ANCHOR = 'case"assistant.message_start":return null;case"assistant.message_delta":return{sessionUpdate:"agent_message_chunk",content:{type:"text",text:e.data.deltaContent}};case"assistant.message":return null;';
export const COPILOT_MESSAGE_MAPPING_REPLACEMENT = 'case"assistant.message_start":return{sessionUpdate:"agent_message_chunk",messageId:e.data.messageId,content:{type:"text",text:""}};case"assistant.message_delta":return{sessionUpdate:"agent_message_chunk",messageId:e.data.messageId,content:{type:"text",text:e.data.deltaContent}};case"assistant.message":return null;';
export const COPILOT_REPLAY_MAPPING_ANCHOR = 'case"assistant.message":return t.data.content?{sessionUpdate:"agent_message_chunk",content:{type:"text",text:t.data.content}}:null;';
export const COPILOT_REPLAY_MAPPING_REPLACEMENT = 'case"assistant.message":return{sessionUpdate:"agent_message_chunk",messageId:t.data.messageId,content:{type:"text",text:t.data.content??""}};';
const hash = bytes => createHash("sha256").update(bytes).digest("hex");
const MAX_TAR_BYTES = 256 * 1024 * 1024;

/** Only called after the complete native executable's independent pin matches. */
export function readPinnedCopilotInnerDistribution(binary, target) {
  const pin = COPILOT_INNER_DISTRIBUTIONS[target];
  if (!pin || !Buffer.isBuffer(binary) || binary.length < pin.offset + pin.size) throw new Error("Copilot inner distribution target or framing is invalid");
  const archive = binary.subarray(pin.offset, pin.offset + pin.size);
  if (hash(archive) !== pin.sha256) throw new Error("Copilot embedded archive digest mismatch");
  const entries = readCopilotInnerTar(gunzipSync(archive, { maxOutputLength: MAX_TAR_BYTES }));
  if (entries.size !== pin.entries) throw new Error("Copilot embedded archive entry count changed");
  const metadata = JSON.parse(entries.get("package.json")?.bytes.toString("utf8") ?? "null");
  if (metadata?.name !== "@github/copilot" || metadata.version !== "1.0.88"
    || !entries.has("index.js") || !entries.has(`prebuilds/${target}/runtime.node`)) throw new Error("Copilot inner distribution identity is invalid");
  const app = entries.get("app.js");
  if (!app) throw new Error("Copilot inner app is missing");
  return new Map([...entries].map(([path, entry]) => [path, path === "app.js" ? { ...entry, bytes: patchPinnedCopilotMessageIdentity(app.bytes) } : entry]));
}

/** Keep native message identity on the already serialized standard ACP stream. */
export function patchPinnedCopilotMessageIdentity(bytes) {
  if (!Buffer.isBuffer(bytes) || hash(bytes) !== COPILOT_APP_SHA256) throw new Error("Copilot message mapping source digest mismatch");
  let source = bytes.toString("utf8");
  for (const [anchor, replacement] of [[COPILOT_MESSAGE_MAPPING_ANCHOR, COPILOT_MESSAGE_MAPPING_REPLACEMENT], [COPILOT_REPLAY_MAPPING_ANCHOR, COPILOT_REPLAY_MAPPING_REPLACEMENT]]) {
    if (source.indexOf(anchor) < 0 || source.indexOf(anchor) !== source.lastIndexOf(anchor)) throw new Error("Copilot message mapping patch anchor is not unique");
    source = source.replace(anchor, replacement);
  }
  return Buffer.from(source);
}

/** Closed ustar subset: all pinned inner assets are regular files, with no links. */
export function readCopilotInnerTar(tar) {
  if (!Buffer.isBuffer(tar) || tar.length < 1024 || tar.length > MAX_TAR_BYTES || tar.length % 512) throw new Error("Copilot inner tar framing is invalid");
  const entries = new Map(); let offset = 0; let ended = false;
  const field = (header, start, end) => {
    const bytes = header.subarray(start, end); const nul = bytes.indexOf(0);
    if (nul >= 0 && bytes.subarray(nul).some(byte => byte !== 0)) throw new Error("Copilot inner tar field contains hidden bytes");
    const value = bytes.subarray(0, nul < 0 ? undefined : nul);
    if (value.some(byte => byte < 32 || byte > 126)) throw new Error("Copilot inner tar field is not ASCII");
    return value.toString("ascii");
  };
  const octal = (header, start, end) => {
    const raw = header.subarray(start, end).toString("ascii");
    if (!/^[0-7]+[\0 ]*$/.test(raw)) throw new Error("Copilot inner tar numeric field is invalid");
    const value = raw.replace(/[\0 ]+$/, "");
    const parsed = Number.parseInt(value, 8);
    if (!Number.isSafeInteger(parsed)) throw new Error("Copilot inner tar numeric field exceeds its bound");
    return parsed;
  };
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512); offset += 512;
    if (header.every(byte => byte === 0)) {
      if (offset + 512 > tar.length || tar.subarray(offset).some(byte => byte !== 0)) throw new Error("Copilot inner tar trailer is invalid");
      ended = true; break;
    }
    if (header.reduce((sum, byte, index) => sum + (index >= 148 && index < 156 ? 32 : byte), 0) !== octal(header, 148, 156)) throw new Error("Copilot inner tar checksum mismatch");
    const prefix = field(header, 345, 500); const leaf = field(header, 0, 100);
    const name = prefix ? `${prefix}/${leaf}` : leaf;
    if (!name.startsWith("package/") || name.length > 4096 || name.includes("\\") || name.split("/").some(part => !part || part === "." || part === "..")
      || header[156] !== 48 || field(header, 157, 257) || field(header, 257, 263) !== "ustar" || header.subarray(263, 265).toString("ascii") !== "00") throw new Error("Copilot inner tar entry is unsafe or unsupported");
    const path = name.slice(8); const size = octal(header, 124, 136); const mode = octal(header, 100, 108);
    if (entries.has(path) || entries.size >= 1000 || size > MAX_TAR_BYTES || mode & ~0o777 || mode & 0o022) throw new Error("Copilot inner tar entry metadata is invalid");
    const padded = Math.ceil(size / 512) * 512;
    if (offset + padded > tar.length || tar.subarray(offset + size, offset + padded).some(byte => byte !== 0)) throw new Error("Copilot inner tar entry padding is invalid");
    entries.set(path, { bytes: tar.subarray(offset, offset + size), executable: Boolean(mode & 0o111) }); offset += padded;
  }
  if (!ended || !entries.size) throw new Error("Copilot inner tar is incomplete");
  // Refuse a file that is also another entry's parent before any write begins.
  for (const path of entries.keys()) for (let i = path.indexOf("/"); i >= 0; i = path.indexOf("/", i + 1)) {
    if (entries.has(path.slice(0, i))) throw new Error("Copilot inner tar file conflicts with a directory");
  }
  return entries;
}
