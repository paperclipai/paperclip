import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import { Readable } from "node:stream";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import sharp from "sharp";
import { AGENT_PALETTE_IDS, appearanceForPalette, PAPERCLIP_DARK_AVATAR_BACKGROUND } from "@paperclipai/shared";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { createAgentAvatarService, avatarCacheKey, type AgentAvatarRequest } from "../services/agent-avatars.js";
import { createAgentAvatarPool } from "../services/agent-avatar-pool.js";
import { agentAvatarRoutes } from "../routes/agent-avatars.js";

const request: AgentAvatarRequest = { appearance: appearanceForPalette("arctic-blue"), size: 24, scale: 2, pose: "rest", muted: false };
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { await Promise.all(cleanups.splice(0).map(fn => fn())); });
async function consume(stream: Readable) {
  for await (const _ of stream) { /* Finish reads before deleting their cache files. */ }
}
async function storage() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-avatar-test-"));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return createLocalDiskStorageProvider(dir);
}
async function serve(service: ReturnType<typeof createAgentAvatarService>) {
  const app = express(); app.use("/api", agentAvatarRoutes(service).router);
  const server = await new Promise<Server>(resolve => { const running = app.listen(0, "127.0.0.1", () => resolve(running)); });
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/api/agent-avatars/cap-v1/arctic-blue/rest.png`;
}
describe("on-demand agent avatars", () => {
  it("coalesces cold requests, survives restarts and regenerates deleted cache entries", async () => {
    const provider = await storage();
    const render = vi.fn(async () => Buffer.from("png-bytes"));
    const service = createAgentAvatarService(provider, render);
    const results = await Promise.all(Array.from({ length: 10 }, () => service.get(request)));
    expect(render).toHaveBeenCalledTimes(1);
    expect(new Set(results.map(result => result.etag)).size).toBe(1);
    await Promise.all(results.map(async result => { for await (const _ of result.stream) { /* consume */ } }));
    await consume((await createAgentAvatarService(provider, render).get(request)).stream);
    expect(render).toHaveBeenCalledTimes(1);
    await provider.deleteObject({ objectKey: avatarCacheKey(request) });
    await consume((await service.get(request)).stream);
    expect(render).toHaveBeenCalledTimes(2);
  });
  it("limits cold keys per client while admitting warm hits, joiners and other clients", async () => {
    let release!: () => void;
    const blocked = new Promise<void>(resolve => { release = resolve; });
    const render = vi.fn(async () => { await blocked; return Buffer.from("png"); });
    const provider = await storage();
    const service = createAgentAvatarService(provider, render);
    const keys = AGENT_PALETTE_IDS.flatMap(palette => ([16, 20, 24] as const).map(size => ({ ...request, appearance: appearanceForPalette(palette), size })));
    const pending = keys.slice(0, 32).map(key => service.get(key, "one"));
    try {
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(32));
      await expect(service.get(keys[32], "one")).rejects.toThrow("Too many cold avatar requests");
      pending.push(service.get(keys[0], "one")); // Same cold key is free.
      pending.push(service.get(keys[32], "two")); // Another client still has room.
      await vi.waitFor(() => expect(render).toHaveBeenCalledTimes(33));
    } finally { release(); }
    for (const result of await Promise.all(pending)) await consume(result.stream);
    await consume((await service.get(keys[0], "one")).stream);
    expect(render).toHaveBeenCalledTimes(33);
    await consume((await service.get(keys[33], "one")).stream); // Completed renders release slots.
    expect(render).toHaveBeenCalledTimes(34);
  });
  it("returns retryable admission errors without caching them", async () => {
    const service = createAgentAvatarService(await storage(), async () => Buffer.from("png"));
    const { AvatarAdmissionError } = await import("../services/agent-avatars.js");
    vi.spyOn(service, "get").mockRejectedValueOnce(new AvatarAdmissionError(12));
    const url = await serve(service);
    const denied = await fetch(url);
    expect(denied.status).toBe(429);
    expect(denied.headers.get("retry-after")).toBe("12");
    expect(denied.headers.get("cache-control")).toBe("no-store");
    await denied.text();
    const retry = await fetch(url); expect(retry.status).toBe(200); await retry.arrayBuffer();
  });
  it("uses the configured S3 prefix and reuses bytes across service instances", async () => {
    const objects = new Map<string, Buffer>();
    const send = vi.spyOn(S3Client.prototype, "send").mockImplementation(async (command: any) => {
      const key = command.input.Key as string;
      expect(command.input.Bucket).toBe("avatar-test");
      expect(key).toMatch(/^paperclip\/generated-agent-avatars\/cap-v1\//);
      if (command instanceof PutObjectCommand) { objects.set(key, Buffer.from(command.input.Body as Uint8Array)); return {}; }
      if (command instanceof DeleteObjectCommand) { objects.delete(key); return {}; }
      const bytes = objects.get(key);
      if (!bytes) throw Object.assign(new Error("missing"), { name: "NoSuchKey" });
      if (command instanceof HeadObjectCommand) return { ContentLength: bytes.length };
      if (command instanceof GetObjectCommand) return { Body: Readable.from(bytes), ContentLength: bytes.length };
      throw new Error("Unexpected S3 command");
    });
    try {
      const provider = createS3StorageProvider({ bucket: "avatar-test", region: "us-east-1", prefix: "paperclip" });
      const render = vi.fn(async () => Buffer.from("s3-avatar"));
      const first = await createAgentAvatarService(provider, render).get(request);
      const second = await createAgentAvatarService(provider, render).get(request);
      expect(second.etag).toEqual(first.etag);
      const firstBytes: Buffer[] = [], secondBytes: Buffer[] = [];
      for await (const chunk of first.stream) firstBytes.push(Buffer.from(chunk));
      for await (const chunk of second.stream) secondBytes.push(Buffer.from(chunk));
      expect(Buffer.concat(secondBytes)).toEqual(Buffer.concat(firstBytes));
      expect(render).toHaveBeenCalledTimes(1);
      await provider.deleteObject({ objectKey: avatarCacheKey(request) });
      await consume((await createAgentAvatarService(provider, render).get(request)).stream);
      expect(render).toHaveBeenCalledTimes(2);
    } finally { send.mockRestore(); }
  });
  it("renders a PNG in an isolated worker without DOM or WebGL", async () => {
    const pool = createAgentAvatarPool(1); cleanups.push(() => pool.close());
    const png = await pool.render(request);
    expect(await sharp(png).metadata()).toMatchObject({ width: 48, height: 48, format: "png", hasAlpha: true });
  }, 20_000);
  it("preserves transparent background pixels in ordinary 512px avatars", async () => {
    const pool = createAgentAvatarPool(1); cleanups.push(() => pool.close());
    const png = await pool.render({ ...request, size: 512, scale: 1 });
    const { data, info } = await sharp(png).raw().toBuffer({ resolveWithObject: true });
    expect(info).toMatchObject({ width: 512, height: 512, channels: 4 });
    for (const [x, y] of [[0, 0], [511, 0], [0, 511], [511, 511]]) {
      expect(data[(y * info.width + x) * info.channels + 3]).toBe(0);
    }
    expect(data[(256 * info.width + 256) * info.channels + 3]).toBe(255);
  }, 20_000);
  it("serves Slack exports on the Paperclip dark-mode color in a separate cache", async () => {
    const css = await readFile(new URL("../../../ui/src/index.css", import.meta.url), "utf8");
    const lightness = Number(css.match(/\.dark\s*\{\s*--background:\s*oklch\(([\d.]+) 0 0\)/)?.[1]);
    // Neutral OKLCH converts to equal sRGB channels; PNG rounds to 8-bit color.
    const linear = lightness ** 3;
    const channel = Math.round((linear <= 0.0031308 ? 12.92 * linear : 1.055 * linear ** (1 / 2.4) - 0.055) * 255);
    expect(PAPERCLIP_DARK_AVATAR_BACKGROUND).toBe(`#${channel.toString(16).padStart(2, "0").repeat(3)}`);
    const service = createAgentAvatarService(await storage()); cleanups.push(() => service.close());
    const url = await serve(service);
    const clear = await fetch(url + "?size=512&scale=1");
    const dark = await fetch(url + "?size=512&scale=1&background=paperclip-dark");
    expect(dark.status).toBe(200);
    expect(dark.headers.get("etag")).not.toBe(clear.headers.get("etag"));
    const clearPixels = await sharp(Buffer.from(await clear.arrayBuffer())).ensureAlpha().raw().toBuffer();
    const darkPixels = await sharp(Buffer.from(await dark.arrayBuffer())).ensureAlpha().raw().toBuffer();
    expect(Array.from(clearPixels.subarray(0, 4))).toEqual([0, 0, 0, 0]);
    expect(Array.from(darkPixels.subarray(0, 4))).toEqual([channel, channel, channel, 255]);
    expect(avatarCacheKey({ ...request, background: "paperclip-dark" })).not.toBe(avatarCacheKey(request));
    const invalid = await fetch(url + "?background=white");
    expect(invalid.status).toBe(400); await invalid.text();
  }, 20_000);
  it("serves public images with content ETags and validates the finite request space", async () => {
    const render = vi.fn(async () => Buffer.from("png-bytes"));
    const url = await serve(createAgentAvatarService(await storage(), render));
    const first = await fetch(url + "?size=24&scale=2");
    expect(first.status).toBe(200);
    expect(first.headers.get("content-type")).toContain("image/png");
    expect(first.headers.get("cache-control")).toContain("immutable");
    await first.arrayBuffer();
    const second = await fetch(url + "?size=24&scale=2", { headers: { "If-None-Match": first.headers.get("etag")! } });
    expect(second.status).toBe(304);
    for (const suffix of ["?size=99999", "?scale=3", "?color=red", "?size=24&size=32"]) {
      const invalid = await fetch(url + suffix); expect(invalid.status).toBe(400); await invalid.text();
    }
    expect(render).toHaveBeenCalledTimes(1);
  });
  it("settles stream disposal on a 304 even if the cached file disappears during open", async () => {
    const service = createAgentAvatarService(await storage(), async () => Buffer.from("png"));
    const stream = new Readable({
      read() {},
      destroy(_error, callback) { setImmediate(() => callback(new Error("cached file removed during open"))); },
    });
    vi.spyOn(service, "get").mockResolvedValueOnce({ stream, byteSize: 3, etag: '"cached"' });
    const url = await serve(service);
    const response = await fetch(url, { headers: { "If-None-Match": '"cached"' } });
    expect(response.status).toBe(304);
    expect(stream.closed).toBe(true);
  });
  it("does not cache rendering failures and permits retry", async () => {
    const render = vi.fn().mockRejectedValueOnce(new Error("unavailable")).mockResolvedValue(Buffer.from("png"));
    const url = await serve(createAgentAvatarService(await storage(), render));
    const first = await fetch(url); expect(first.status).toBe(503); expect(first.headers.get("cache-control")).toBe("no-store"); await first.text();
    const retry = await fetch(url); expect(retry.status).toBe(200); await retry.arrayBuffer();
  });
});
