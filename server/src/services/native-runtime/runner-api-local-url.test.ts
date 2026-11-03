import { describe, expect, it } from "vitest";
import { localRunnerApiUrl } from "./runner-api-client.js";

describe("localRunnerApiUrl", () => {
  const env = { PAPERCLIP_LISTEN_PORT: "3100", PAPERCLIP_API_URL: "https://10.0.1.100" } as NodeJS.ProcessEnv;
  it("sends calls to this server over loopback", () => {
    expect(localRunnerApiUrl(new URL("https://10.0.1.100/api/issues/1/comments?x=1"), env).href).toBe("http://127.0.0.1:3100/api/issues/1/comments?x=1");
  });
  it("leaves other origins and loopback URLs alone", () => {
    const other = new URL("https://example.test/api/x");
    expect(localRunnerApiUrl(other, env)).toBe(other);
    const loop = new URL("http://127.0.0.1:3100/api/x");
    expect(localRunnerApiUrl(loop, env)).toBe(loop);
    expect(localRunnerApiUrl(new URL("https://10.0.1.100/api/x"), {} as NodeJS.ProcessEnv).href).toBe("https://10.0.1.100/api/x");
  });
});
