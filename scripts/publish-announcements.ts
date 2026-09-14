#!/usr/bin/env -S node --import tsx
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ANNOUNCEMENT_IMAGE_MAX_BYTES, ANNOUNCEMENT_MANIFEST_MAX_BYTES, announcementManifestSchema } from "../packages/shared/src/announcements.js";

const PREFIX = "announcements/v1";
export async function prepareAnnouncementPublish(sourceDirectory: string) {
  const source = path.resolve(sourceDirectory);
  if (!(await lstat(source)).isDirectory()) throw new Error("Source must be a real directory");
  const manifestPath = path.join(source, "current.json");
  const stat = await lstat(manifestPath);
  if (!stat.isFile() || stat.size > ANNOUNCEMENT_MANIFEST_MAX_BYTES) throw new Error("Invalid or oversized current.json");
  const manifest = announcementManifestSchema.parse(JSON.parse(await readFile(manifestPath, "utf8")));
  const files: Array<{ file: string; key: string; contentType: string; cacheControl: string }> = [];
  if (manifest.announcement?.image) {
    if (!(await lstat(path.join(source, "assets"))).isDirectory()) throw new Error("Assets must be a real directory");
    const assetPath = manifest.announcement.image.path;
    const file = path.join(source, assetPath);
    const assetStat = await lstat(file);
    if (!assetStat.isFile() || assetStat.size > ANNOUNCEMENT_IMAGE_MAX_BYTES) throw new Error("Invalid or oversized image");
    const digest = createHash("sha256").update(await readFile(file)).digest("hex");
    if (!assetPath.startsWith(`assets/${digest}.`)) throw new Error("Image filename must match its SHA-256 digest");
    files.push({ file, key: `${PREFIX}/${assetPath}`, contentType: assetPath.endsWith(".png") ? "image/png" : assetPath.endsWith(".jpg") ? "image/jpeg" : "image/webp", cacheControl: "public,max-age=31536000,immutable" });
  }
  files.push({ file: manifestPath, key: `${PREFIX}/current.json`, contentType: "application/json", cacheControl: "public,max-age=300" });
  return { manifest, files };
}

export function announcementUploadArgs(bucket: string, file: Awaited<ReturnType<typeof prepareAnnouncementPublish>>["files"][number]) {
  return ["s3api", "put-object", "--bucket", bucket, "--key", file.key, "--body", file.file,
    "--content-type", file.contentType, "--cache-control", file.cacheControl];
}

async function main() {
  const args = process.argv.slice(2);
  const publish = args.includes("--publish");
  const source = args.find((arg) => !arg.startsWith("--")) ?? "announcements";
  if (args.some((arg) => arg.startsWith("--") && !["--publish", "--dry-run"].includes(arg)) || (publish && args.includes("--dry-run"))) {
    throw new Error("Usage: publish-announcements.ts [directory] [--dry-run | --publish]");
  }
  const prepared = await prepareAnnouncementPublish(source);
  const bucket = process.env.PAPERCLIP_PAGE_BUCKET;
  const baseUrl = process.env.PAPERCLIP_PAGE_BASE_URL?.replace(/\/+$/, "") ?? "https://pages.paperclip.ing";
  const url = `${baseUrl}/${PREFIX}/current.json`;
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Invalid public base URL");
  console.log(JSON.stringify({ mode: publish ? "publish" : "dry-run", bucket: bucket ?? "(unset)", url, announcementId: prepared.manifest.announcement?.id ?? null, files: prepared.files }, null, 2));
  if (!publish) return;
  if (!bucket) throw new Error("Set PAPERCLIP_PAGE_BUCKET before publishing");
  const env = { ...process.env };
  const key = env.PAPERCLIP_PAGE_AWS_ACCESS_KEY_ID;
  const secret = env.PAPERCLIP_PAGE_AWS_SECRET_ACCESS_KEY;
  if (Boolean(key) !== Boolean(secret)) throw new Error("Set both namespaced page uploader credential variables");
  if (key && secret) {
    env.AWS_ACCESS_KEY_ID = key;
    env.AWS_SECRET_ACCESS_KEY = secret;
    delete env.AWS_SESSION_TOKEN;
    if (env.PAPERCLIP_PAGE_AWS_SESSION_TOKEN) env.AWS_SESSION_TOKEN = env.PAPERCLIP_PAGE_AWS_SESSION_TOKEN;
  } else if (env.PAPERCLIP_PAGE_AWS_PROFILE) {
    delete env.AWS_ACCESS_KEY_ID;
    delete env.AWS_SECRET_ACCESS_KEY;
    delete env.AWS_SESSION_TOKEN;
    env.AWS_PROFILE = env.PAPERCLIP_PAGE_AWS_PROFILE;
  }
  // Only validated files, assets before manifest; credentials are scoped to AWS.
  for (const file of prepared.files) execFileSync("aws", announcementUploadArgs(bucket, file), { env, stdio: "pipe" });
  console.log("Uploaded. Checking the public manifest (CDN propagation can take five minutes)…");
  for (let attempt = 0; attempt < 23; attempt++) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000), credentials: "omit", redirect: "error" });
      const body = announcementManifestSchema.parse(await response.json());
      if (response.ok && JSON.stringify(body) === JSON.stringify(prepared.manifest)
        && /(?:^|,)\s*max-age=300(?:\s*,|$)/i.test(response.headers.get("cache-control") ?? "")) {
        for (const asset of prepared.files.slice(0, -1)) {
          const image = await fetch(`${baseUrl}/${asset.key}`, { method: "HEAD", signal: AbortSignal.timeout(10_000), credentials: "omit", redirect: "error" });
          const caching = image.headers.get("cache-control") ?? "";
          if (!image.ok || image.headers.get("content-type") !== asset.contentType
            || !/(?:^|,)\s*max-age=31536000(?:\s*,|$)/i.test(caching)
            || !/(?:^|,)\s*immutable(?:\s*,|$)/i.test(caching)) {
            throw new Error("Public announcement asset headers are not ready");
          }
        }
        console.log(`Published and verified: ${url}`);
        return;
      }
    } catch { /* Retry edge propagation; uploads have already completed. */ }
    if (attempt < 22) await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
  throw new Error(`Uploaded, but public verification did not finish. Check ${url} and the CloudFront cache policy (minimum TTL must not exceed 300 seconds).`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Announcement publish failed");
    process.exitCode = 1;
  });
}
