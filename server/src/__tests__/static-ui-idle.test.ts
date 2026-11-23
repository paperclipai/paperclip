import express, { type Response } from "express";
import request from "supertest";
import { request as httpRequest, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { idleAdmissionMiddleware, trackIdleRequestHandlers } from "../middleware/idle-admission.js";
import { staticUiFiles } from "../middleware/static-ui.js";
import { idleWorkSnapshot, startTaskDrain, stopTaskDrain } from "../services/task-admission.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function files() {
  const root = await mkdtemp(path.join(os.tmpdir(), "paperclip-static-ui-"));
  const handle = await open(path.join(root, "large.bin"), "w");
  await handle.truncate(32 * 1024 * 1024);
  await handle.close();
  await writeFile(path.join(root, "hello.txt"), "hello");
  return root;
}

async function listen(app: express.Application) {
  const listener = app.listen(0, "127.0.0.1");
  await once(listener, "listening");
  return listener;
}

async function close(listener: Server) {
  listener.closeAllConnections();
  await new Promise<void>(resolve => listener.close(() => resolve()));
}

async function abortDownload(listener: Server, url: string) {
  const address = listener.address() as { port: number };
  await new Promise<void>((resolve, reject) => {
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: url }, res => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`Unexpected static response: ${res.statusCode}`));
        return;
      }
      res.on("error", () => undefined);
      res.once("data", () => { res.destroy(); client.destroy(); resolve(); });
    });
    client.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "ECONNRESET") reject(error); });
    client.setTimeout(5000, () => { client.destroy(); reject(new Error("Static response timed out")); });
    client.end();
  });
}

afterEach(() => stopTaskDrain());

describe("static UI idle completion", () => {
  it("releases an aborted file in a nested router", async () => {
    const root = await files(), before = idleWorkSnapshot().active, ended = deferred();
    const app = express(), nested = express.Router();
    app.use(idleAdmissionMiddleware);
    app.use((_req, res, next) => { res.once("close", ended.resolve); next(); });
    nested.use(staticUiFiles(root));
    app.use("/ui", nested);
    trackIdleRequestHandlers(app);
    const listener = await listen(app);
    try {
      await abortDownload(listener, "/ui/large.bin");
      await ended.promise;
      expect(idleWorkSnapshot().active).toBe(before);
      startTaskDrain({ purpose: "idle", ttlMs: 60_000 });
      await request(app).get("/ui/hello.txt").expect(503);
    } finally {
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("releases a matched file after the client closes before lookup", async () => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), entered = deferred(), ended = deferred(), proceed = deferred(), matched = deferred();
    app.use(idleAdmissionMiddleware);
    app.use(async (_req, res, next) => {
      res.once("close", ended.resolve);
      entered.resolve();
      await proceed.promise;
      next();
    });
    app.use(staticUiFiles(root, { setHeaders: () => matched.resolve() }));
    trackIdleRequestHandlers(app);
    const listener = await listen(app), address = listener.address() as { port: number };
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/large.bin" });
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await ended.promise;
      expect(idleWorkSnapshot().active).toBe(before + 1);
      proceed.resolve();
      await matched.promise;
      await new Promise(resolve => setImmediate(resolve));
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      proceed.resolve();
      client.destroy();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps a late missing-file fallback tracked after the client closes", async () => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), entered = deferred(), ended = deferred(), proceed = deferred(), writing = deferred(), done = deferred();
    let committed = false;
    app.use(idleAdmissionMiddleware);
    app.use(async (_req, res, next) => {
      res.once("close", ended.resolve);
      entered.resolve();
      await proceed.promise;
      next();
    });
    app.use(staticUiFiles(root));
    app.get("/missing", async () => { writing.resolve(); await done.promise; committed = true; });
    trackIdleRequestHandlers(app);
    const listener = await listen(app), address = listener.address() as { port: number };
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/missing" });
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await ended.promise;
      proceed.resolve();
      await writing.promise;
      expect(idleWorkSnapshot().active).toBe(before + 1);
      expect(committed).toBe(false);
      done.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(committed).toBe(true);
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      proceed.resolve();
      done.resolve();
      client.destroy();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(["mounted application", "untracked root"])("does not release a hidden parent write in a %s", async scope => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), nested = scope === "mounted application" ? express() : app, ended = deferred(), done = deferred();
    let committed = false, response!: Response;
    app.use(idleAdmissionMiddleware);
    nested.use(async (_req, res, next) => {
      response = res;
      res.once("close", ended.resolve);
      next();
      await done.promise;
      committed = true;
    });
    nested.use(staticUiFiles(root));
    if (scope === "mounted application") {
      app.use("/ui", nested);
      trackIdleRequestHandlers(app);
    }
    const listener = await listen(app);
    try {
      await abortDownload(listener, scope === "mounted application" ? "/ui/large.bin" : "/large.bin");
      await ended.promise;
      expect(committed).toBe(false);
      expect(idleWorkSnapshot().active).toBe(before + 1);
      done.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(committed).toBe(true);
      expect(idleWorkSnapshot().active).toBe(before + 1);
      response.end();
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      done.resolve();
      response?.end();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("preserves file contents, HEAD, conditional responses, and caller headers", async () => {
    const root = await files(), app = express(), before = idleWorkSnapshot().active;
    app.use(idleAdmissionMiddleware);
    app.use(staticUiFiles(root, { maxAge: "1h", setHeaders: res => { res.setHeader("X-Static-Test", "kept"); } }));
    trackIdleRequestHandlers(app);
    try {
      const first = await request(app).get("/hello.txt").expect(200).expect("X-Static-Test", "kept");
      expect(first.text).toBe("hello");
      await request(app).head("/hello.txt").expect(200).expect("X-Static-Test", "kept");
      await request(app).get("/hello.txt").set("If-None-Match", first.headers.etag).expect(304);
      expect(idleWorkSnapshot().active).toBe(before);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it("keeps a parent write tracked after a static client leaves", async () => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), ended = deferred(), done = deferred();
    let committed = false;
    app.use(idleAdmissionMiddleware);
    app.use(async (_req, res, next) => {
      res.once("close", ended.resolve);
      next();
      await done.promise;
      committed = true;
    });
    app.use(staticUiFiles(root));
    trackIdleRequestHandlers(app);
    const listener = await listen(app);
    try {
      await abortDownload(listener, "/large.bin");
      await ended.promise;
      expect(committed).toBe(false);
      expect(idleWorkSnapshot().active).toBe(before + 1);
      done.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(committed).toBe(true);
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      done.resolve();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an unmatched mutating GET tracked after disconnect", async () => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), entered = deferred(), ended = deferred(), done = deferred();
    let committed = false;
    app.use(idleAdmissionMiddleware);
    app.use(staticUiFiles(root));
    app.get("/callback", async (_req, res) => {
      res.once("close", ended.resolve);
      entered.resolve();
      await done.promise;
      committed = true;
    });
    trackIdleRequestHandlers(app);
    const listener = await listen(app), address = listener.address() as { port: number };
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/callback" });
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await ended.promise;
      expect(idleWorkSnapshot().active).toBe(before + 1);
      expect(committed).toBe(false);
      done.resolve();
      await new Promise(resolve => setImmediate(resolve));
      expect(committed).toBe(true);
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      done.resolve();
      client.destroy();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retains an unmatched callback handler until the application ends it", async () => {
    const root = await files(), before = idleWorkSnapshot().active;
    const app = express(), entered = deferred(), ended = deferred();
    let response!: Response;
    app.use(idleAdmissionMiddleware);
    app.use(staticUiFiles(root));
    app.get("/callback", (_req, res) => { response = res; res.once("close", ended.resolve); entered.resolve(); });
    trackIdleRequestHandlers(app);
    const listener = await listen(app), address = listener.address() as { port: number };
    const client = httpRequest({ host: "127.0.0.1", port: address.port, path: "/callback" });
    client.on("error", () => undefined);
    client.end();
    try {
      await entered.promise;
      client.destroy();
      await ended.promise;
      expect(idleWorkSnapshot().active).toBe(before + 1);
      response.end();
      expect(idleWorkSnapshot().active).toBe(before);
    } finally {
      response?.end();
      client.destroy();
      await close(listener);
      await rm(root, { recursive: true, force: true });
    }
  });
});
