import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
const manifest = JSON.parse(await readFile(new URL("./platforms.json", import.meta.url), "utf8"));
const platform = manifest.platforms[`${process.platform}-${process.arch}`];
if (!platform) throw new Error(`Unqualified Grok platform: ${process.platform}-${process.arch}`);
const destination = fileURLToPath(new URL("./bin/grok", import.meta.url));
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");
const installed = await readFile(destination).catch(() => null);
if (!installed || digest(installed) !== platform.sha256) {
  const url = `https://x.ai/cli/grok-${manifest.version}-${platform.artifact}.gz`;
  const response = await fetch(url, { signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Grok download failed: HTTP ${response.status}`);
  const bytes = gunzipSync(Buffer.from(await response.arrayBuffer()), { maxOutputLength: 384 * 1024 * 1024 });
  if (digest(bytes) !== platform.sha256) throw new Error("Grok binary digest mismatch");
  await mkdir(new URL("./bin/", import.meta.url), { recursive: true });
  const temporary = `${destination}.${process.pid}.tmp`;
  try {
    await writeFile(temporary, bytes, { flag: "wx", mode: 0o700 });
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
await chmod(destination, 0o700);
console.log(`Verified Grok ${manifest.version} (${process.platform}-${process.arch})`);
