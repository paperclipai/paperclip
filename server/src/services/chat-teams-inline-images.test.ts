import { crc32 } from "node:zlib";
import sharp from "sharp";
import type { FileUpload } from "chat";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  isTeamsInlineImageContentType,
  prepareTeamsInlineImage,
  TEAMS_INLINE_IMAGE_MAX_BYTES,
} from "./chat-teams-inline-images.js";
import {
  createChatSdkEndpointRuntime,
  type ChatSdkEndpointRuntime,
} from "./chat-sdk-runtime.js";
import type {
  ChatSdkStatePersistence,
  ChatSdkStateRecord,
  ChatSdkStateScope,
} from "./chat-sdk-state.js";

let png: Buffer;
let jpeg: Buffer;
// Complete one-pixel transparent GIF89a with one frame and no looping extension.
const gif = Buffer.from(
  "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7",
  "base64",
);
beforeAll(async () => {
  const input = {
    create: {
      width: 20,
      height: 10,
      channels: 3 as const,
      background: "#e08040",
    },
  };
  png = await sharp(input).png().toBuffer();
  jpeg = await sharp(input).jpeg().toBuffer();
  // Test-only decoder proves our positive GIF is real, not merely shaped bytes.
  await expect(sharp(gif).raw().toBuffer()).resolves.toBeInstanceOf(Buffer);
});
function file(
  data: FileUpload["data"],
  mimeType = "image/png",
  filename = "picture.png",
): FileUpload {
  return { data, mimeType, filename };
}
function chunk(type: string, data: Buffer): Buffer {
  const result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.write(type, 4, "latin1");
  data.copy(result, 8);
  result.writeUInt32BE(crc32(result.subarray(4, -4)), result.length - 4);
  return result;
}
function withPngSize(width: number, height: number) {
  const ihdr = Buffer.from(png.subarray(16, 29));
  ihdr.writeUInt32BE(width);
  ihdr.writeUInt32BE(height, 4);
  return Buffer.concat([
    png.subarray(0, 8),
    chunk("IHDR", ihdr),
    png.subarray(33),
  ]);
}

describe("bounded Teams inline picture preparation", () => {
  it.each(["png", "jpeg", "gif"] as const)(
    "preserves original %s bytes and emits only the closed upload fields",
    async (format) => {
      const bytes = { png, jpeg, gif }[format];
      const input = {
        ...file(bytes, `image/${format}`, `original.${format}`),
        url: "https://private.invalid/?token=CANARY",
      };
      const result = await prepareTeamsInlineImage(input);
      expect(result).toEqual({
        data: bytes,
        filename: `original.${format}`,
        mimeType: `image/${format}`,
      });
      expect(result!.data).not.toBe(bytes);
      expect(Object.keys(result!).sort()).toEqual([
        "data",
        "filename",
        "mimeType",
      ]);
      expect(JSON.stringify(result)).not.toContain("CANARY");
    },
  );

  it.each(["Buffer", "ArrayBuffer", "Blob"] as const)(
    "snapshots exact %s bytes before returning",
    async (kind) => {
      const source = Buffer.from(png);
      const array = new Uint8Array(source);
      const input =
        kind === "Buffer"
          ? source
          : kind === "ArrayBuffer"
            ? array.buffer
            : new Blob([array]);
      const result = await prepareTeamsInlineImage(
        file(input, "IMAGE/PNG; charset=binary"),
      );
      source.fill(0);
      array.fill(0);
      expect(result).toEqual({
        data: png,
        filename: "picture.png",
        mimeType: "image/png",
      });
    },
  );

  it("accepts boundary geometry, including thin pictures without Telegram's aspect-ratio constraint", async () => {
    for (const [width, height] of [
      [1024, 1024],
      [1024, 1],
      [1, 1024],
    ]) {
      const bytes = await sharp({
        create: {
          width: width!,
          height: height!,
          channels: 3,
          background: "#e08040",
        },
      })
        .png()
        .toBuffer();
      expect(await prepareTeamsInlineImage(file(bytes))).not.toBeNull();
    }
    for (const [width, height] of [
      [0, 1],
      [1, 0],
      [1025, 1],
      [1, 1025],
      [0xffffffff, 1],
    ])
      expect(
        await prepareTeamsInlineImage(file(withPngSize(width!, height!))),
      ).toBeNull();
  });

  it("enforces the decimal byte boundary before materializing a Blob", async () => {
    const body = Buffer.alloc(TEAMS_INLINE_IMAGE_MAX_BYTES - png.length - 12);
    const boundary = Buffer.concat([
      png.subarray(0, 33),
      chunk("tEXt", body),
      png.subarray(33),
    ]);
    expect(boundary.length).toBe(TEAMS_INLINE_IMAGE_MAX_BYTES);
    expect(await prepareTeamsInlineImage(file(boundary))).not.toBeNull();
    const blob = new Blob([Buffer.alloc(TEAMS_INLINE_IMAGE_MAX_BYTES + 1)]);
    const read = vi.spyOn(blob, "arrayBuffer");
    expect(await prepareTeamsInlineImage(file(blob))).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "application/pdf",
    "application/octet-stream",
    "image/svg+xml",
    "image/webp",
    "image/avif",
    "image/jpg",
    "",
  ])("refuses unsupported MIME %s without touching the data", async (mime) => {
    const blob = new Blob([new Uint8Array(png)]);
    const read = vi.spyOn(blob, "arrayBuffer");
    expect(isTeamsInlineImageContentType(mime)).toBe(false);
    expect(await prepareTeamsInlineImage(file(blob, mime))).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    "",
    "../image.png",
    "bad\nname.png",
    "https:picture.png",
    " picture.png",
    "image.",
  ])("refuses unsafe filenames (%j)", async (filename) => {
    expect(
      await prepareTeamsInlineImage(file(png, "image/png", filename)),
    ).toBeNull();
  });

  it("refuses format mismatch, detached inputs, and every truncated image prefix without throwing", async () => {
    for (const [bytes, mime] of [
      [png, "image/png"],
      [jpeg, "image/jpeg"],
      [gif, "image/gif"],
    ] as const) {
      for (let size = 0; size < bytes.length; size++)
        expect(
          await prepareTeamsInlineImage(file(bytes.subarray(0, size), mime)),
        ).toBeNull();
      expect(
        await prepareTeamsInlineImage(
          file(bytes, mime === "image/png" ? "image/jpeg" : "image/png"),
        ),
      ).toBeNull();
    }
    const data = new Uint8Array(png).buffer;
    structuredClone(data, { transfer: [data] });
    expect(await prepareTeamsInlineImage(file(data))).toBeNull();
  });

  it("rejects PNG corrupt CRC, duplicate/animated/unknown critical chunks, and unbounded part counts", async () => {
    const badCrc = Buffer.from(png);
    badCrc[29] ^= 1;
    const oversized = Buffer.from(png);
    oversized.writeUInt32BE(0xffffffff, 8);
    for (const bytes of [
      badCrc,
      oversized,
      Buffer.concat([
        png.subarray(0, 33),
        chunk("IHDR", png.subarray(16, 29)),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 33),
        chunk("acTL", Buffer.alloc(8)),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 33),
        chunk("FROB", Buffer.alloc(0)),
        png.subarray(33),
      ]),
      Buffer.concat([
        png.subarray(0, 33),
        ...Array.from({ length: 4096 }, () =>
          chunk("tEXt", Buffer.from("a\0b")),
        ),
        png.subarray(33),
      ]),
      Buffer.concat([png, Buffer.from("trailing")]),
    ])
      expect(await prepareTeamsInlineImage(file(bytes))).toBeNull();
  });

  it("rejects JPEG dimensions, malformed frame/scan descriptors and oversized headers", async () => {
    const frame = jpeg.indexOf(Buffer.from([0xff, 0xc0]));
    const scan = jpeg.indexOf(Buffer.from([0xff, 0xda]));
    expect(frame).toBeGreaterThan(0);
    expect(scan).toBeGreaterThan(frame);
    const variants: Buffer[] = [];
    for (const modify of [
      (bytes: Buffer) => bytes.writeUInt16BE(1025, frame + 7),
      (bytes: Buffer) => {
        bytes[frame + 11] = 0;
      },
      (bytes: Buffer) => {
        bytes[frame + 13] = bytes[frame + 10]!;
      },
      (bytes: Buffer) => {
        bytes[scan + 5] = 99;
      },
    ]) {
      const bytes = Buffer.from(jpeg);
      modify(bytes);
      variants.push(bytes);
    }
    const app = Buffer.alloc(65_537);
    app.writeUInt16BE(0xffe1);
    app.writeUInt16BE(65_535, 2);
    variants.push(
      Buffer.concat([
        jpeg.subarray(0, 2),
        app,
        app,
        app,
        app,
        jpeg.subarray(2),
      ]),
    );
    for (const bytes of variants)
      expect(
        await prepareTeamsInlineImage(file(bytes, "image/jpeg")),
      ).toBeNull();
  });

  it("rejects animated/looping GIF, absent palettes, bad descriptors, empty image data and trailing bytes", async () => {
    const image = gif.indexOf(0x2c);
    const second = Buffer.concat([
      gif.subarray(0, -1),
      gif.subarray(image, -1),
      Buffer.from([0x3b]),
    ]);
    const loop = Buffer.from([
      0x21,
      0xff,
      11,
      ...Buffer.from("NETSCAPE2.0"),
      3,
      1,
      0,
      0,
      0,
    ]);
    const noPalette = Buffer.from(gif);
    noPalette[10] = 0;
    const badFrame = Buffer.from(gif);
    badFrame.writeUInt16LE(2, image + 1);
    const badLzw = Buffer.from(gif);
    badLzw[image + 10] = 1;
    const empty = Buffer.concat([
      gif.subarray(0, image + 11),
      Buffer.from([0, 0x3b]),
    ]);
    const large = Buffer.from(gif);
    large.writeUInt16LE(1025, 6);
    const highBit = Buffer.from(gif);
    highBit[0] |= 0x80;
    for (const bytes of [
      second,
      Buffer.concat([gif.subarray(0, 19), loop, gif.subarray(19)]),
      noPalette,
      badFrame,
      badLzw,
      empty,
      large,
      highBit,
      Buffer.concat([gif, Buffer.from([0])]),
    ])
      expect(
        await prepareTeamsInlineImage(file(bytes, "image/gif")),
      ).toBeNull();
  });
});

function persistence(): ChatSdkStatePersistence {
  const rows = new Map<string, ChatSdkStateRecord>();
  const key = (scope: ChatSdkStateScope, name: string) =>
    JSON.stringify([scope.companyId, scope.endpointId, name]);
  return {
    async read(scope, name) {
      return rows.get(key(scope, name)) ?? null;
    },
    async compareAndSet(input) {
      const k = key(input, input.key);
      const previous = rows.get(k);
      if ((previous?.version ?? null) !== input.expectedVersion) return false;
      rows.set(k, {
        value: input.value,
        expiresAt: input.expiresAt,
        version: (previous?.version ?? 0) + 1,
      });
      return true;
    },
    async deleteIfVersion(input) {
      const k = key(input, input.key);
      return rows.get(k)?.version === input.expectedVersion && rows.delete(k);
    },
  };
}

// Actual installed adapter, App.send, ActivitySender and API serialization.
// Only final outbound HTTP is mocked. No inbound JWT/tenant/live UI proof and
// no service source authority is inferred from these transport-only fixtures.
describe("Teams inline images through pinned runtime/App HTTP", () => {
  const runtimes: ChatSdkEndpointRuntime[] = [];
  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.shutdown()));
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });
  async function harness() {
    const network = vi.fn(async () => {
      throw new Error("Unexpected network");
    });
    vi.stubGlobal("fetch", network);
    const runtime = createChatSdkEndpointRuntime({
      companyId: "33333333-3333-4333-8333-333333333333",
      endpointId: "44444444-4444-4444-8444-444444444444",
      persistence: persistence(),
      logger: "silent",
      callbacks: { onMessage: vi.fn() },
      providerConfig: {
        provider: "microsoft-teams",
        userName: "maya",
        credentials: {
          appId: "22222222-2222-4222-8222-222222222222",
          appPassword: "synthetic-password",
          appTenantId: "11111111-1111-4111-8111-111111111111",
          appType: "SingleTenant",
        },
      },
    });
    runtimes.push(runtime);
    await runtime.initialize();
    const app = (
      runtime.getProviderAdapter() as unknown as {
        app: {
          api: { serviceUrl: string };
          activitySender: {
            client: {
              post(url: string, data: unknown): Promise<{ data: unknown }>;
            };
          };
        };
      }
    ).app;
    const post = vi
      .spyOn(app.activitySender.client, "post")
      .mockResolvedValue({ data: { id: "image-receipt-1" } });
    return { runtime, app, post, network };
  }
  const destination = (
    scope: "channel" | "groupChat",
    route = "https://smba.trafficmanager.net/amer/",
  ) => {
    const conversation =
      scope === "channel"
        ? "19:image-channel@thread.tacv2;messageid=1740"
        : "19:image-group@thread.v2";
    return {
      conversation,
      thread: `teams:${Buffer.from(conversation).toString("base64url")}:${Buffer.from(route).toString("base64url")}:${scope}`,
    };
  };
  it.each(["channel", "groupChat"] as const)(
    "sends PNG/JPEG/static GIF as exact inline pictures in %s with one real receipt each",
    async (scope) => {
      const h = await harness();
      const d = destination(scope);
      for (const [bytes, mime, name] of [
        [png, "image/png", "original.png"],
        [jpeg, "image/jpeg", "original.jpg"],
        [gif, "image/gif", "original.gif"],
      ] as const) {
        const prepared = await prepareTeamsInlineImage(file(bytes, mime, name));
        expect(prepared).not.toBeNull();
        const result = await h.runtime.thread(d.thread).post({
          markdown: "Picture on the Paperclip task.",
          files: [prepared!],
        });
        expect(result.id).toBe("image-receipt-1");
        const [url, wire] = h.post.mock.calls.at(-1)!;
        expect(url).toBe(
          `https://smba.trafficmanager.net/amer/v3/conversations/${d.conversation}/activities`,
        );
        expect(wire).toMatchObject({
          type: "message",
          attachments: [
            {
              name,
              contentType: mime,
              contentUrl: `data:${mime};base64,${bytes.toString("base64")}`,
            },
          ],
        });
        expect(JSON.stringify(wire)).not.toContain("file.consent");
        expect(JSON.stringify(wire)).not.toContain("synthetic-password");
      }
      expect(h.post).toHaveBeenCalledTimes(3);
      expect(h.network).not.toHaveBeenCalled();
    },
  );
  it("keeps concurrent regional image sends on their exact scoped routes", async () => {
    const h = await harness();
    const original = h.app.api;
    const first = destination("channel");
    const second = destination(
      "groupChat",
      "https://smba.trafficmanager.net/emea/",
    );
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    h.post.mockImplementationOnce(async () => {
      await held;
      return { data: { id: "first-image" } };
    });
    const prepared = (await prepareTeamsInlineImage(file(png)))!;
    const firstPost = h.runtime
      .thread(first.thread)
      .post({ files: [prepared], markdown: "" });
    try {
      await vi.waitFor(() => expect(h.post).toHaveBeenCalledTimes(1));
      await h.runtime
        .thread(second.thread)
        .post({ files: [prepared], markdown: "" });
      expect(h.post.mock.calls.map(([url]) => url)).toEqual([
        `https://smba.trafficmanager.net/amer/v3/conversations/${first.conversation}/activities`,
        `https://smba.trafficmanager.net/emea/v3/conversations/${second.conversation}/activities`,
      ]);
      expect(h.app.api).toBe(original);
    } finally {
      release();
      await firstPost;
    }
  });
  it.each(["lost_receipt", "rejected"])(
    "propagates %s without a second send or fallback",
    async (mode) => {
      const h = await harness();
      const d = destination("channel");
      h.post.mockRejectedValueOnce(
        mode === "lost_receipt"
          ? new Error("connection lost")
          : Object.assign(new Error("bad request"), {
              response: {
                status: 400,
                data: { error: { code: "BadArgument" } },
              },
            }),
      );
      const prepared = (await prepareTeamsInlineImage(file(png)))!;
      await expect(
        h.runtime.thread(d.thread).post({ files: [prepared], markdown: "" }),
      ).rejects.toThrow();
      expect(h.post).toHaveBeenCalledTimes(1);
      expect(h.network).not.toHaveBeenCalled();
    },
  );
  it("does not invent a receipt ID when the provider's successful response omits it", async () => {
    const h = await harness();
    const d = destination("channel");
    h.post.mockResolvedValueOnce({ data: {} });
    const prepared = (await prepareTeamsInlineImage(file(png)))!;
    const result = await h.runtime
      .thread(d.thread)
      .post({ files: [prepared], markdown: "" });
    // The pinned adapter leaves this unproven. Service composition MUST require
    // a nonempty ID and retain delivery_unknown, never mark the file published.
    expect(result.id).toBe("");
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.network).not.toHaveBeenCalled();
  });
  it("returns no native candidate for malformed/unsupported input and never contacts HTTP", async () => {
    const h = await harness();
    for (const input of [
      file(Buffer.from("not an image")),
      file(png, "application/pdf"),
      file(withPngSize(1025, 1)),
    ])
      expect(await prepareTeamsInlineImage(input)).toBeNull();
    expect(h.post).not.toHaveBeenCalled();
    expect(h.network).not.toHaveBeenCalled();
  });
});
