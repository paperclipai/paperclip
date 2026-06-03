import { afterEach, describe, expect, it, vi } from "vitest";
import { createCouchHttp } from "./couch-http.js";

describe("createCouchHttp", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("omits Authorization when no user given; returns body:null when json() throws", async () => {
    const mockResponse = {
      status: 200,
      json: vi.fn().mockRejectedValue(new SyntaxError("not json")),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const http = createCouchHttp({ baseUrl: "http://127.0.0.1:5984" });

    const result = await http.request("GET", "/str_ops/some-doc");

    const callArgs = (fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    expect((callArgs[1] as RequestInit).headers).not.toHaveProperty("Authorization");
    expect(result).toEqual({ status: 200, body: null });
  });

  it("calls global fetch with correct URL, method, auth, content-type, and body; returns parsed JSON", async () => {
    const mockResponse = {
      status: 201,
      json: vi.fn().mockResolvedValue({ ok: true }),
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockResponse));

    const http = createCouchHttp({
      baseUrl: "http://127.0.0.1:5984/",
      user: "admin",
      password: "p",
    });

    const result = await http.request("PUT", "/str_ops/owner%3A1", { type: "owner" });

    const expectedAuth = `Basic ${Buffer.from("admin:p").toString("base64")}`;
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:5984/str_ops/owner%3A1", {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        Authorization: expectedAuth,
      },
      body: JSON.stringify({ type: "owner" }),
    });
    expect(result).toEqual({ status: 201, body: { ok: true } });
  });
});
