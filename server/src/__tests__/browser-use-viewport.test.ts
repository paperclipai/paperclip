import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import {
  browserUseCdpUrl,
  createBrowserUseViewportManager,
} from "../services/browser-use-viewport.js";
import { browserUseViewportSchema } from "@paperclipai/shared";

function fixture(allowResize = true, now?: () => number) {
  const id = randomUUID();
  let metrics = { width: 1280, height: 720 };
  const commands: Array<{ method: string; params: any; sessionId?: string }> =
    [];
  const socket = new EventEmitter() as EventEmitter & {
    readyState: number;
    send: (raw: string) => void;
    terminate: () => void;
  };
  socket.readyState = WebSocket.OPEN;
  socket.terminate = () => {
    socket.readyState = WebSocket.CLOSED;
    socket.emit("close");
  };
  socket.send = (raw) => {
    const msg = JSON.parse(raw);
    commands.push(msg);
    let result: unknown = {};
    if (msg.method === "Target.getTargets")
      result = { targetInfos: [{ targetId: "page-1", type: "page" }] };
    if (msg.method === "Target.attachToTarget")
      result = { sessionId: msg.params.targetId };
    if (msg.method === "Emulation.setDeviceMetricsOverride" && allowResize)
      metrics = { width: msg.params.width, height: msg.params.height };
    if (msg.method === "Emulation.clearDeviceMetricsOverride")
      metrics = { width: 1280, height: 720 };
    if (msg.method === "Runtime.evaluate")
      result = { result: { value: metrics } };
    queueMicrotask(() =>
      socket.emit("message", JSON.stringify({ id: msg.id, result })),
    );
  };
  const connect = vi.fn(async () => socket as unknown as WebSocket);
  const manager = createBrowserUseViewportManager({
    connect,
    now,
    request: async () =>
      Response.json({
        webSocketDebuggerUrl: `wss://${id}.cdp.browser-use.com/devtools/browser/test`,
      }),
  });
  return {
    id,
    manager,
    commands,
    connect,
    socket,
    address: `https://${id}.cdp.browser-use.com`,
  };
}

describe("Browser Use fixed viewport", () => {
  it("serializes presets, keeps emulation attached, sizes new tabs, and restores the default", async () => {
    const f = fixture();
    try {
      await Promise.all([
        f.manager.resize(f.id, f.address, "phone"),
        f.manager.resize(f.id, f.address, "desktop"),
      ]);
      expect(f.connect).toHaveBeenCalledTimes(1);
      expect(await f.manager.current(f.id)).toMatchObject({
        preset: "desktop",
      });
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
      f.socket.emit(
        "message",
        JSON.stringify({
          method: "Target.targetCreated",
          params: { targetInfo: { targetId: "page-2", type: "page" } },
        }),
      );
      await vi.waitFor(() =>
        expect(f.commands).toContainEqual(
          expect.objectContaining({
            method: "Emulation.setDeviceMetricsOverride",
            sessionId: "page-2",
            params: expect.objectContaining({ width: 1440, height: 900 }),
          }),
        ),
      );
      await f.manager.resize(f.id, f.address, "default");
      expect(await f.manager.current(f.id)).toMatchObject({
        preset: "default",
      });
      expect(f.socket.readyState).toBe(WebSocket.OPEN);
    } finally {
      await f.manager.release(f.id);
    }
  });
  it("rejects a silently ignored resize without reporting the preset as applied", async () => {
    const f = fixture(false);
    try {
      await expect(
        f.manager.resize(f.id, f.address, "phone"),
      ).rejects.toMatchObject({ status: 409 });
      expect(await f.manager.current(f.id)).toMatchObject({ preset: "fit" });
    } finally {
      await f.manager.release(f.id);
    }
  });
  it("clears state when the provider disconnects", async () => {
    const f = fixture();
    await f.manager.resize(f.id, f.address, "tablet");
    f.socket.terminate();
    expect(await f.manager.current(f.id)).toMatchObject({ preset: "fit" });
  });
  it("accepts only reviewed presets and the owned provider browser's secure CDP host", () => {
    const id = randomUUID();
    expect(browserUseViewportSchema.parse({ preset: "phone" })).toEqual({
      preset: "phone",
    });
    expect(
      browserUseViewportSchema.safeParse({
        preset: "phone",
        url: "https://evil.test",
      }).success,
    ).toBe(false);
    expect(
      browserUseCdpUrl(`https://${id}.cdp.browser-use.com`, id, "https:")
        .hostname,
    ).toBe(`${id}.cdp.browser-use.com`);
    for (const address of [
      "http://127.0.0.1",
      `https://${randomUUID()}.cdp.browser-use.com`,
      `https://${id}.cdp.browser-use.com.evil.test`,
      `https://secret@${id}.cdp.browser-use.com`,
      `https://${id}.cdp.browser-use.com:123`,
    ]) {
      expect(() => browserUseCdpUrl(address, id, "https:")).toThrow(
        "Browser size could not be changed",
      );
    }
  });
  it("redacts provider discovery failures", async () => {
    const f = fixture();
    const manager = createBrowserUseViewportManager({
      request: async () => {
        throw Error("https://private-token.example bu_secret");
      },
    });
    await expect(manager.resize(f.id, f.address, "phone")).rejects.toThrow(
      "Browser size could not be changed",
    );
  });
});

describe("Browser Use pane ownership", () => {
  const fit = (viewerId: string, width = 500) => ({
    preset: "fit" as const,
    viewerId,
    width,
    height: 700,
  });
  it("uses a renewable lease, supports explicit takeover, and ignores stale automatic requests after a fixed selection", async () => {
    let time = 0;
    const f = fixture(true, () => time);
    const first = randomUUID(),
      second = randomUUID();
    try {
      expect(
        await f.manager.resize(f.id, f.address, fit(first), undefined, first),
      ).toMatchObject({
        preset: "fit",
        width: 500,
        applied: true,
        controlledElsewhere: false,
      });
      const commands = f.commands.length;
      expect(
        await f.manager.resize(
          f.id,
          f.address,
          fit(second, 900),
          undefined,
          second,
        ),
      ).toMatchObject({
        width: 500,
        applied: false,
        controlledElsewhere: true,
      });
      expect(f.commands).toHaveLength(commands);
      time = 15000;
      await f.manager.resize(f.id, f.address, fit(first), undefined, first);
      time = 25000;
      expect(
        await f.manager.resize(f.id, f.address, fit(second), undefined, second),
      ).toMatchObject({ controlledElsewhere: true });
      expect(
        await f.manager.resize(
          f.id,
          f.address,
          { ...fit(second, 900), takeControl: true },
          undefined,
          second,
        ),
      ).toMatchObject({ width: 900, applied: true });
      expect(
        await f.manager.resize(f.id, f.address, fit(first), undefined, first),
      ).toMatchObject({ width: 900, controlledElsewhere: true });
      await f.manager.resize(f.id, f.address, "phone");
      expect(
        await f.manager.resize(f.id, f.address, fit(second), undefined, second),
      ).toMatchObject({ preset: "phone", applied: false });
      expect(
        await f.manager.resize(
          f.id,
          f.address,
          { ...fit(first), takeControl: true },
          undefined,
          first,
        ),
      ).toMatchObject({ preset: "fit", width: 500 });
    } finally {
      await f.manager.release(f.id);
    }
  });
  it("releases only the owner's lease and allows expiry after a viewer disappears", async () => {
    let time = 0;
    const f = fixture(true, () => time);
    const first = randomUUID(),
      second = randomUUID();
    try {
      await f.manager.resize(f.id, f.address, fit(first), undefined, first);
      await f.manager.releaseLease(f.id, second);
      expect(await f.manager.current(f.id, second)).toMatchObject({
        controlledElsewhere: true,
      });
      await f.manager.releaseLease(f.id, first);
      expect(
        await f.manager.resize(
          f.id,
          f.address,
          fit(second, 600),
          undefined,
          second,
        ),
      ).toMatchObject({ width: 600, controlledElsewhere: false });
      time = 21000;
      expect(
        await f.manager.resize(
          f.id,
          f.address,
          fit(first, 550),
          undefined,
          first,
        ),
      ).toMatchObject({ width: 550, controlledElsewhere: false });
    } finally {
      await f.manager.release(f.id);
    }
  });
  it("bounds dimensions and accepts no arbitrary CDP inputs", () => {
    const input = fit(randomUUID());
    expect(browserUseViewportSchema.safeParse(input).success).toBe(true);
    for (const invalid of [
      { ...input, width: 0 },
      { ...input, width: 6145 },
      { ...input, height: 3457 },
      { ...input, width: 3.5 },
      { ...input, viewerId: "other" },
      { ...input, method: "Runtime.evaluate" },
    ])
      expect(browserUseViewportSchema.safeParse(invalid).success).toBe(false);
  });
});
