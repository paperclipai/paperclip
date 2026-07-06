import { afterEach, describe, expect, it } from "vitest";
import { validateAndResolveFetchUrl } from "../services/plugin-host-services.js";

const ORIGINAL_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;

afterEach(() => {
  if (ORIGINAL_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_LISTEN_PORT;
});

describe("validateAndResolveFetchUrl SSRF guard", () => {
  it("still rejects loopback URLs when no listen port is known", async () => {
    delete process.env.PAPERCLIP_LISTEN_PORT;
    await expect(validateAndResolveFetchUrl("http://localhost:3100/api/health")).rejects.toThrow(
      /private\/reserved ranges/,
    );
  });

  it("still rejects loopback URLs targeting a different port than the host is listening on", async () => {
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    await expect(validateAndResolveFetchUrl("http://localhost:9999/api/health")).rejects.toThrow(
      /private\/reserved ranges/,
    );
  });

  it("allows a plugin's default paperclipBaseUrl to reach the host's own listening port", async () => {
    process.env.PAPERCLIP_LISTEN_PORT = "3100";
    const target = await validateAndResolveFetchUrl("http://localhost:3100/api/issues/123");
    expect(["127.0.0.1", "::1"]).toContain(target.resolvedAddress);
  });
});
