import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import sharp from "sharp";
import { MAX_ATTACHMENT_BYTES } from "../../attachment-types.js";

const require = createRequire(import.meta.url);
const MAX_PIXELS = 50_000_000;
export const HEIF_CONTENT_TYPES = new Set([
  "image/heic",
  "image/heif",
  "image/heic-sequence",
  "image/heif-sequence",
]);

/** Validate bounded ISO-BMFF structure before invoking any native decoder. */
export function validateHeifDimensions(body: Buffer): void {
  let boxes = 0;
  let dimensions = 0;
  let totalPixels = 0;
  let branded = false;
  const visit = (start: number, end: number, depth: number) => {
    if (depth > 8) throw new Error("HEIF metadata nesting is too deep");
    for (let at = start; at < end; ) {
      if (++boxes > 4096 || end - at < 8)
        throw new Error("Invalid HEIF box structure");
      let size = body.readUInt32BE(at);
      const type = body.toString("ascii", at + 4, at + 8);
      let header = 8;
      if (size === 1) {
        if (end - at < 16) throw new Error("Invalid HEIF box length");
        const extended = body.readBigUInt64BE(at + 8);
        if (extended > BigInt(body.length))
          throw new Error("HEIF box exceeds file bounds");
        size = Number(extended);
        header = 16;
      } else if (size === 0) size = end - at;
      if (size < header || at + size > end)
        throw new Error("HEIF box exceeds file bounds");
      const content = at + header;
      if (type === "ftyp") {
        if (size < header + 8) throw new Error("HEIF file type is missing");
        const brands = body.toString("ascii", content, at + size);
        branded = /heic|heix|hevc|hevx|mif1|msf1/.test(brands);
      } else if (type === "ispe") {
        if (size !== header + 12)
          throw new Error("Invalid HEIF image dimensions");
        const width = body.readUInt32BE(content + 4);
        const height = body.readUInt32BE(content + 8);
        if (
          !width ||
          !height ||
          width > 16_384 ||
          height > 16_384 ||
          width * height > MAX_PIXELS
        )
          throw new Error("HEIF decoded image exceeds the pixel limit");
        totalPixels += width * height;
        if (totalPixels > MAX_PIXELS * 3 || ++dimensions > 512)
          throw new Error("HEIF image collection exceeds the pixel limit");
      } else if (["meta", "iprp", "ipco"].includes(type)) {
        visit(content + (type === "meta" ? 4 : 0), at + size, depth + 1);
      }
      at += size;
    }
  };
  if (!body.length || body.length > MAX_ATTACHMENT_BYTES)
    throw new Error("HEIF exceeds the attachment byte limit");
  visit(0, body.length, 0);
  if (!branded || !dimensions)
    throw new Error("HEIF dimensions could not be verified");
}

export async function validatePhotonImage(
  body: Buffer,
  contentType: string,
): Promise<void> {
  if (!contentType.startsWith("image/")) return;
  if (HEIF_CONTENT_TYPES.has(contentType)) return validateHeifDimensions(body);
  const metadata = await sharp(body, {
    limitInputPixels: MAX_PIXELS,
    failOn: "error",
  }).metadata();
  if (
    !metadata.width ||
    !metadata.height ||
    metadata.width * metadata.height * (metadata.pages ?? 1) > MAX_PIXELS
  )
    throw new Error("Decoded image exceeds the pixel limit");
  const formats: Record<string, string[]> = {
    "image/jpeg": ["jpeg"],
    "image/jpg": ["jpeg"],
    "image/png": ["png"],
    "image/webp": ["webp"],
    "image/gif": ["gif"],
  };
  if (!formats[contentType]?.includes(metadata.format ?? ""))
    throw new Error("Image bytes do not match the declared content type");
}

/** Isolate the native converter with a deadline and bounded input/output.
 * Native packages exist for macOS, Windows and Linux glibc x64/arm64.
 * Unsupported hosts retain the original and report an unavailable preview. */
export async function photonHeifPreview(body: Buffer): Promise<Buffer> {
  validateHeifDimensions(body);
  const modulePath = require.resolve("heif2jpeg");
  const script = `const {heifToJpeg}=require(process.argv[1]);const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',async()=>{try{const jpeg=await heifToJpeg(Buffer.concat(chunks),{quality:80});process.stdout.end(jpeg);}catch{process.exitCode=1;}});`;
  const jpeg = await new Promise<Buffer>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--max-old-space-size=256", "--eval", script, modulePath],
      { stdio: ["pipe", "pipe", "ignore"], windowsHide: true },
    );
    let length = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("HEIF preview conversion timed out"));
    }, 10_000);
    child.stdout.on("data", (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_ATTACHMENT_BYTES) {
        child.kill("SIGKILL");
        reject(new Error("HEIF preview exceeds the attachment byte limit"));
      } else chunks.push(chunk);
    });
    child.on("error", () => {
      clearTimeout(timer);
      reject(new Error("HEIF preview converter is unavailable"));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0 && length > 0) resolve(Buffer.concat(chunks));
      else reject(new Error("HEIF preview conversion failed on this host"));
    });
    child.stdin.on("error", () => {});
    child.stdin.end(body);
  });
  await validatePhotonImage(jpeg, "image/jpeg");
  return jpeg;
}
