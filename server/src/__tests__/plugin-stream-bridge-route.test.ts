import express from "express";
import { createServer, request as httpRequest, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createPluginStreamBus,
  type PluginStreamBus,
} from "../services/plugin-stream-bus.js";

const mockAccess = vi.hoisted(() => ({
  decide: vi.fn().mockResolvedValue({ allowed: true }),
}));
vi.mock("../services/authorization.js", () => ({
  authorizationService: () => mockAccess,
}));

const mockRegistry = vi.hoisted(() => ({
  getById: vi.fn(),
  getByKey: vi.fn(),
}));
vi.mock("../services/plugin-registry.js", () => ({
  pluginRegistryService: () => mockRegistry,
}));

vi.mock("../services/plugin-lifecycle.js", () => ({
  pluginLifecycleManager: () => ({ load: vi.fn(), upgrade: vi.fn() }),
}));
vi.mock("../services/activity-log.js", () => ({ logActivity: vi.fn() }));
vi.mock("../services/live-events.js", () => ({
  publishGlobalLiveEvent: vi.fn(),
}));

const PLUGIN_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "22222222-2222-4222-8222-222222222222";
const CHANNEL = "chat:thread";

let server: Server | null = null;

async function listen(streamBus?: PluginStreamBus): Promise<string> {
  const [{ pluginRoutes }, { errorHandler }] = await Promise.all([
    import("../routes/plugins.js"),
    import("../middleware/index.js"),
  ]);

  mockRegistry.getById.mockResolvedValue({
    id: PLUGIN_ID,
    pluginKey: "paperclip.stream-test",
    status: "ready",
    manifestJson: { id: "paperclip.stream-test" },
  });

  const app = express();
  app.use((req, _res, next) => {
    req.actor = {
      type: "board",
      userId: "user-1",
      source: "local_implicit",
      isInstanceAdmin: true,
    } as typeof req.actor;
    next();
  });
  app.use(
    "/api",
    pluginRoutes(
      {} as never,
      { installPlugin: vi.fn() } as never,
      undefined,
      undefined,
      undefined,
      { workerManager: {}, streamBus } as never,
    ),
  );
  app.use(errorHandler);

  server = createServer(app);
  await new Promise<void>((resolve) => server!.listen(0, resolve));
  const { port } = server!.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function openStream(base: string): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: () => string;
  next: (marker: string) => Promise<string>;
  close: () => void;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      `${base}/api/plugins/${PLUGIN_ID}/bridge/stream/${encodeURIComponent(CHANNEL)}?companyId=${COMPANY_ID}`,
      (res) => {
        let buffer = "";
        const waiters: Array<{ marker: string; resolve: (value: string) => void }> = [];
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          for (let index = waiters.length - 1; index >= 0; index -= 1) {
            if (buffer.includes(waiters[index]!.marker)) {
              waiters[index]!.resolve(buffer);
              waiters.splice(index, 1);
            }
          }
        });
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: () => buffer,
          next: (marker) =>
            new Promise<string>((resolveNext, rejectNext) => {
              if (buffer.includes(marker)) {
                resolveNext(buffer);
                return;
              }
              const timer = setTimeout(
                () => rejectNext(new Error(`timed out waiting for "${marker}"; saw: ${buffer}`)),
                5000,
              );
              waiters.push({
                marker,
                resolve: (value) => {
                  clearTimeout(timer);
                  resolveNext(value);
                },
              });
            }),
          close: () => {
            req.destroy();
            res.destroy();
          },
        });
      },
    );
    req.on("error", reject);
    req.end();
  });
}

async function readJson(base: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(
    `${base}/api/plugins/${PLUGIN_ID}/bridge/stream/${encodeURIComponent(CHANNEL)}?companyId=${COMPANY_ID}`,
  );
  return { status: response.status, body: await response.json() };
}

describe("GET /plugins/:pluginId/bridge/stream/:channel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAccess.decide.mockResolvedValue({ allowed: true });
  });

  afterEach(async () => {
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = null;
    }
  });

  it("answers 501 when no stream bus is wired", async () => {
    const base = await listen(undefined);

    const response = await readJson(base);

    expect(response.status).toBe(501);
    expect(response.body).toEqual({ error: "Plugin stream bridge is not enabled" });
  });

  it("opens the stream and fans a worker emit out to the client", async () => {
    const bus = createPluginStreamBus();
    const base = await listen(bus);

    const stream = await openStream(base);
    expect(stream.status).toBe(200);
    expect(stream.headers["content-type"]).toBe("text/event-stream");
    await stream.next(":ok");

    bus.publish(PLUGIN_ID, CHANNEL, COMPANY_ID, { type: "text", text: "token" });

    const body = await stream.next('{"type":"text","text":"token"}');
    expect(body).toContain('data: {"type":"text","text":"token"}');
    stream.close();
  });

  it("names the close event so a client stops instead of reconnecting", async () => {
    const bus = createPluginStreamBus();
    const base = await listen(bus);

    const stream = await openStream(base);
    await stream.next(":ok");

    bus.publish(PLUGIN_ID, CHANNEL, COMPANY_ID, null, "close");

    const body = await stream.next("event: close");
    expect(body).toContain("event: close");
    stream.close();
  });

  it("does not deliver another company's event to this subscriber", async () => {
    const bus = createPluginStreamBus();
    const base = await listen(bus);

    const stream = await openStream(base);
    await stream.next(":ok");

    bus.publish(PLUGIN_ID, CHANNEL, "33333333-3333-4333-8333-333333333333", {
      type: "text",
      text: "other tenant",
    });
    bus.publish(PLUGIN_ID, CHANNEL, COMPANY_ID, { type: "text", text: "mine" });

    const body = await stream.next("mine");
    expect(body).not.toContain("other tenant");
    stream.close();
  });

  it("does not deliver another channel's event to this subscriber", async () => {
    const bus = createPluginStreamBus();
    const base = await listen(bus);

    const stream = await openStream(base);
    await stream.next(":ok");

    bus.publish(PLUGIN_ID, "some-other-stream", COMPANY_ID, {
      type: "text",
      text: "other channel",
    });
    bus.publish(PLUGIN_ID, CHANNEL, COMPANY_ID, { type: "text", text: "mine" });

    const body = await stream.next("mine");
    expect(body).not.toContain("other channel");
    stream.close();
  });
});
