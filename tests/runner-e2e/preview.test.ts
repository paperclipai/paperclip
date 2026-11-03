import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRunnerReportPreview } from "./preview.js";

const directories: string[] = [];
const servers: Server[] = [];
const campaignId = "preview-test";
const campaignRoot = `campaigns/${campaignId}`;
const screenshotPath = `${campaignRoot}/evidence/screenshot.png`;
const missingPath = `${campaignRoot}/evidence/missing.png`;
const screenshot = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6nAAAAABJRU5ErkJggg==", "base64");
const files = new Map([
  ["history.json", Buffer.from(JSON.stringify({
    schema: "paperclip.runner-e2e.history/v1", campaigns: [{ campaignId }],
  }))],
  [`${campaignRoot}/bundle-manifest.json`, Buffer.from(JSON.stringify({
    campaignId,
    files: ["evidence/screenshot.png", "evidence/missing.png"].map((file) => ({ path: file, bytes: screenshot.length, sha256: "fixture" })),
  }))],
  [screenshotPath, screenshot],
]);

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  vi.restoreAllMocks();
});

async function cacheDirectory() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "runner-report-preview-"));
  directories.push(directory);
  return path.join(directory, "cache");
}

async function listen(options: Parameters<typeof createRunnerReportPreview>[0]) {
  const { server } = await createRunnerReportPreview(options);
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No preview port");
  return `http://127.0.0.1:${address.port}/runner-e2e/`;
}

describe("local report preview boundaries", () => {
  it("serves and caches listed evidence while rejecting unlisted and encoded traversal paths", async () => {
    const cacheRoot = await cacheDirectory();
    const privateBytes = Buffer.from("outside the public cache");
    await writeFile(path.join(cacheRoot, "../private.png"), privateBytes);
    const download = vi.fn(async (relative: string) => {
      const bytes = files.get(relative);
      if (!bytes) throw new Error(`Unexpected download: ${relative}`);
      return bytes;
    });
    const origin = await listen({ cacheRoot, download });
    const response = await fetch(`${origin}${screenshotPath}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(Buffer.from(await response.arrayBuffer())).toEqual(screenshot);
    expect(await readFile(path.join(cacheRoot, screenshotPath))).toEqual(screenshot);
    await fetch(`${origin}${screenshotPath}`).then((response) => response.arrayBuffer());
    expect(download.mock.calls.filter(([relative]) => relative === screenshotPath)).toHaveLength(1);
    await writeFile(path.join(cacheRoot, campaignRoot, "private.png"), privateBytes);

    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const relative of [
      `${campaignRoot}/private.png`,
      `${campaignRoot}/%2e%2e%2f%2e%2e%2f%2e%2e%2fprivate.png`,
      `${campaignRoot}/evidence/%2fprivate.png`,
    ]) {
      const blocked = await fetch(`${origin}${relative}`);
      expect(blocked.status).not.toBe(200);
      expect(await blocked.text()).not.toContain(privateBytes.toString());
    }
    expect(download.mock.calls.map(([relative]) => relative)).toEqual([
      "history.json", `${campaignRoot}/bundle-manifest.json`, screenshotPath,
    ]);
  });

  it("serves cached evidence offline and never downloads a missing listed file", async () => {
    const cacheRoot = await cacheDirectory();
    for (const [relative, bytes] of files) {
      const filename = path.join(cacheRoot, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, bytes);
    }
    const download = vi.fn(async () => { throw new Error("Offline previews must not download"); });
    const origin = await listen({ cacheRoot, offline: true, refresh: true, download });
    const cached = await fetch(`${origin}${screenshotPath}`);
    expect(cached.status).toBe(200);
    expect(Buffer.from(await cached.arrayBuffer())).toEqual(screenshot);
    vi.spyOn(console, "error").mockImplementation(() => {});
    const missing = await fetch(`${origin}${missingPath}`);
    expect(missing.status).toBe(502);
    expect(await missing.text()).toContain(`Not cached: ${missingPath}`);
    expect(download).not.toHaveBeenCalled();
  });
});
