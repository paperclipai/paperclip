import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import { Readable } from "node:stream";
import { S3Client, PutObjectCommand, HeadObjectCommand, GetObjectCommand, DeleteObjectCommand } from "@aws-sdk/client-s3";
import { createS3StorageProvider } from "../storage/s3-provider.js";
import path from "node:path";
import express from "express";
import type { Server } from "node:http";
import sharp from "sharp";
import { AGENT_PALETTE_IDS, appearanceForPalette } from "@paperclipai/shared";
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
  const app = express(); app.use("/api", agentAvatarRoutes(service));
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
