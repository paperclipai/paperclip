import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/sandbox", () => ({
  getSandbox: vi.fn(),
}));

vi.mock("./sandboxes.js", async () => {
  const actual = await vi.importActual<typeof import("./sandboxes.js")>("./sandboxes.js");
  return {
    ...actual,
    resolveSandbox: vi.fn(),
  };
});

import { validateSandboxFilePath } from "./files.js";
import { handleBridgeRequest } from "./routes.js";
import { resolveSandbox } from "./sandboxes.js";

const env = { BRIDGE_AUTH_TOKEN: "secret-token", Sandbox: {} as never };

function fileRequest(method: string, query: Record<string, string>, body?: BodyInit): Request {
  const url = new URL("https://bridge.example.test/api/paperclip-sandbox/v1/files");
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return new Request(url, {
    method,
    headers: { Authorization: "Bearer secret-token" },
    ...(body !== undefined ? { body, duplex: "half" } : {}),
  } as RequestInit);
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

describe("bridge file transfer route", () => {
  beforeEach(() => {
    vi.mocked(resolveSandbox).mockReset();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
  });

  it("streams a sandbox file back as raw bytes", async () => {
    const bytes = new Uint8Array([0, 1, 2, 255, 0, 10]);
    const readFile = vi.fn().mockResolvedValue({ success: true, content: streamOf(bytes), size: bytes.length });
    vi.mocked(resolveSandbox).mockResolvedValue({ readFile } as never);

    const response = await handleBridgeRequest(
      fileRequest("GET", { providerLeaseId: "pc-run-1-abcd1234", path: "/workspace/paperclip/out.tar" }),
      env,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("x-file-size")).toBe("6");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(readFile).toHaveBeenCalledWith("/workspace/paperclip/out.tar", { encoding: "none" });
    expect(vi.mocked(resolveSandbox)).toHaveBeenCalledWith(expect.anything(), "pc-run-1-abcd1234", { normalizeId: true });
  });

  it("returns 404 when the sandbox file is missing", async () => {
    const missing = Object.assign(new Error("File not found: /tmp/nope"), { name: "FileNotFoundError" });
    vi.mocked(resolveSandbox).mockResolvedValue({ readFile: vi.fn().mockRejectedValue(missing) } as never);

    const response = await handleBridgeRequest(
      fileRequest("GET", { providerLeaseId: "pc-run-1-abcd1234", path: "/tmp/nope" }),
      env,
    );

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "file_not_found" });
  });

  it("writes the request body stream into the sandbox after creating its parent", async () => {
    const mkdir = vi.fn().mockResolvedValue(undefined);
    const writeFile = vi.fn().mockImplementation(async (_path: string, body: ReadableStream<Uint8Array>) => {
      const reader = body.getReader();
      const chunks: number[] = [];
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(...value);
      }
      expect(chunks).toEqual([7, 0, 9]);
    });
    vi.mocked(resolveSandbox).mockResolvedValue({ mkdir, writeFile } as never);

    const response = await handleBridgeRequest(
      fileRequest("PUT", { providerLeaseId: "pc-run-1-abcd1234", path: "/workspace/.paperclip-runtime/in.tar" }, new Uint8Array([7, 0, 9])),
      env,
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true, path: "/workspace/.paperclip-runtime/in.tar" });
    expect(mkdir).toHaveBeenCalledWith("/workspace/.paperclip-runtime", { recursive: true });
    expect(writeFile).toHaveBeenCalledTimes(1);
  });

  it("rejects relative or traversing paths and unsupported methods before touching the sandbox", async () => {
    for (const path of ["relative/file", "/workspace/../etc/passwd", ""]) {
      const response = await handleBridgeRequest(fileRequest("GET", { providerLeaseId: "pc-1", path }), env);
      expect(response.status).toBe(400);
    }
    const missingLease = await handleBridgeRequest(fileRequest("GET", { path: "/tmp/a" }), env);
    expect(missingLease.status).toBe(400);
    const post = await handleBridgeRequest(fileRequest("POST", { providerLeaseId: "pc-1", path: "/tmp/a" }, "x"), env);
    expect(post.status).toBe(405);
    expect(vi.mocked(resolveSandbox)).not.toHaveBeenCalled();
  });

  it("requires the bridge bearer token", async () => {
    const response = await handleBridgeRequest(
      new Request("https://bridge.example.test/api/paperclip-sandbox/v1/files?providerLeaseId=pc-1&path=/tmp/a"),
      env,
    );
    expect(response.status).toBe(401);
    expect(vi.mocked(resolveSandbox)).not.toHaveBeenCalled();
  });

  it("validates sandbox paths", () => {
    expect(validateSandboxFilePath("/workspace/a.tar")).toBe("/workspace/a.tar");
    expect(validateSandboxFilePath("/workspace/..hidden")).toBe("/workspace/..hidden");
    expect(validateSandboxFilePath("/workspace/../a")).toBeNull();
    expect(validateSandboxFilePath("/a\0b")).toBeNull();
    expect(validateSandboxFilePath(null)).toBeNull();
  });
});
