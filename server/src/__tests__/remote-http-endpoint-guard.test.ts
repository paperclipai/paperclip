import { describe, expect, it } from "vitest";
import { assertPublicRemoteHttpEndpoint } from "../services/remote-http-endpoint-guard.js";

const errorFactory = (message: string, code: string) => Object.assign(new Error(message), { code });

describe("assertPublicRemoteHttpEndpoint", () => {
  it.each([
    "http://[2001::1]/mcp",
    "http://[2001:20::1]/mcp",
    "http://[2001:2f::1]/mcp",
    "http://[64:ff9b:1::1]/mcp",
  ])("rejects reserved IPv6 endpoint %s", async (url) => {
    await expect(
      assertPublicRemoteHttpEndpoint(new URL(url), {}, errorFactory),
    ).rejects.toMatchObject({ code: "remote_http_private_endpoint" });
  });
});
