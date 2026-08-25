import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";

const { dnsLookupMock, httpRequestMock } = vi.hoisted(() => ({
  dnsLookupMock: vi.fn(),
  httpRequestMock: vi.fn(),
}));

vi.mock("node:dns/promises", () => ({ lookup: dnsLookupMock }));
vi.mock("node:http", async () => {
  const actual = await vi.importActual<typeof import("node:http")>("node:http");
  return { ...actual, request: httpRequestMock };
});

import { buildHostServices } from "../services/plugin-host-services.js";

function createEventBusStub() {
  return {
    forPlugin() {
      return { emit: vi.fn(), subscribe: vi.fn(), clear: vi.fn() };
    },
  } as never;
}

describe("plugin host HTTP fetch timeout", () => {
  afterEach(() => {
    dnsLookupMock.mockReset();
    httpRequestMock.mockReset();
  });

  it("stops buffering a stalled response body at the requested timeout", async () => {
    dnsLookupMock.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    httpRequestMock.mockImplementation((options: { signal?: AbortSignal }, callback: (response: EventEmitter) => void) => {
      const request = new EventEmitter() as EventEmitter & {
        write: ReturnType<typeof vi.fn>;
        end: ReturnType<typeof vi.fn>;
      };
      request.write = vi.fn();
      request.end = vi.fn();

      const response = new EventEmitter() as EventEmitter & {
        statusCode: number;
        statusMessage: string;
        headers: Record<string, string>;
      };
      response.statusCode = 200;
      response.statusMessage = "OK";
      response.headers = {};

      options.signal?.addEventListener("abort", () => {
        // The real Node request destroys the response stream when its signal
        // aborts. Reproduce that boundary while leaving the body unfinished.
        response.emit("error", new Error("response body aborted"));
        request.emit("error", new Error("request aborted"));
      }, { once: true });
      callback(response);
      return request;
    });

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "paperclip.plugin-weknora",
      createEventBusStub(),
    );

    try {
      await expect(services.http.fetch({
        url: "http://weknora.example/api/v1/knowledge-bases",
        timeoutMs: 25,
      })).rejects.toThrow("response body aborted");
      expect(httpRequestMock).toHaveBeenCalledWith(
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
        expect.any(Function),
      );
    } finally {
      services.dispose();
    }
  });

  it("applies the requested timeout while DNS resolution is pending", async () => {
    dnsLookupMock.mockImplementation(() => new Promise(() => undefined));

    const services = buildHostServices(
      {} as never,
      "plugin-record-id",
      "paperclip.plugin-weknora",
      createEventBusStub(),
    );

    try {
      await expect(services.http.fetch({
        url: "https://weknora.example/api/v1/knowledge-bases",
        timeoutMs: 25,
      })).rejects.toThrow("Plugin fetch timed out after 25ms");
      expect(httpRequestMock).not.toHaveBeenCalled();
    } finally {
      services.dispose();
    }
  });
});
