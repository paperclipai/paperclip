import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildPaperclipEnv } from "../adapters/utils.js";

const ORIGINAL_PAPERCLIP_RUNTIME_API_URL = process.env.PAPERCLIP_RUNTIME_API_URL;
const ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
const ORIGINAL_PAPERCLIP_API_URL = process.env.PAPERCLIP_API_URL;
const ORIGINAL_PAPERCLIP_LISTEN_HOST = process.env.PAPERCLIP_LISTEN_HOST;
const ORIGINAL_PAPERCLIP_LISTEN_PORT = process.env.PAPERCLIP_LISTEN_PORT;
const ORIGINAL_HOST = process.env.HOST;
const ORIGINAL_PORT = process.env.PORT;

afterEach(() => {
  if (ORIGINAL_PAPERCLIP_RUNTIME_API_URL === undefined) delete process.env.PAPERCLIP_RUNTIME_API_URL;
  else process.env.PAPERCLIP_RUNTIME_API_URL = ORIGINAL_PAPERCLIP_RUNTIME_API_URL;

  if (ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON === undefined) {
    delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  } else {
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = ORIGINAL_PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
  }

  if (ORIGINAL_PAPERCLIP_API_URL === undefined) delete process.env.PAPERCLIP_API_URL;
  else process.env.PAPERCLIP_API_URL = ORIGINAL_PAPERCLIP_API_URL;

  if (ORIGINAL_PAPERCLIP_LISTEN_HOST === undefined) delete process.env.PAPERCLIP_LISTEN_HOST;
  else process.env.PAPERCLIP_LISTEN_HOST = ORIGINAL_PAPERCLIP_LISTEN_HOST;

  if (ORIGINAL_PAPERCLIP_LISTEN_PORT === undefined) delete process.env.PAPERCLIP_LISTEN_PORT;
  else process.env.PAPERCLIP_LISTEN_PORT = ORIGINAL_PAPERCLIP_LISTEN_PORT;

  if (ORIGINAL_HOST === undefined) delete process.env.HOST;
  else process.env.HOST = ORIGINAL_HOST;

  if (ORIGINAL_PORT === undefined) delete process.env.PORT;
  else process.env.PORT = ORIGINAL_PORT;
});

beforeEach(() => {
  delete process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON;
});

describe("buildPaperclipEnv", () => {
  it("prefers an explicit PAPERCLIP_API_URL override over the derived runtime URL", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://203.0.113.42:3102";
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("falls back to PAPERCLIP_RUNTIME_API_URL when no explicit override is set", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://203.0.113.42:3102";
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://203.0.113.42:3102");
  });

  it("falls back to PAPERCLIP_API_URL when no runtime URL is configured", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    process.env.PAPERCLIP_API_URL = "http://localhost:4100";
    process.env.PAPERCLIP_LISTEN_HOST = "127.0.0.1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:4100");
  });

  it("removes discovered interface candidates from direct launches", () => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://localhost:3100";
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = JSON.stringify([
      "http://localhost:3100",
      "http://192.0.2.10:3100",
    ]);

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3100");
    expect(env.PAPERCLIP_RUNTIME_API_URL).toBe("http://localhost:3100");
    expect(env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON).toBe("[]");
  });

  it.each([
    ["localhost", JSON.stringify(["http://localhost:3100"])],
    ["IPv4 loopback lower bound", JSON.stringify(["http://127.0.0.1:3100"])],
    ["IPv4 loopback interior", JSON.stringify(["http://127.42.0.9:3100"])],
    ["IPv4 loopback upper bound", JSON.stringify(["http://127.255.255.255:3100"])],
    ["bracketed IPv6 loopback", JSON.stringify(["http://[::1]:3100"])],
    ["unbracketed IPv6 loopback", JSON.stringify(["::1"])],
    ["IPv4 wildcard", JSON.stringify(["http://0.0.0.0:3100"])],
    ["bracketed IPv6 wildcard", JSON.stringify(["http://[::]:3100"])],
    ["unbracketed IPv6 wildcard", JSON.stringify(["::"])],
    ["malformed URL", JSON.stringify(["not a URL"])],
    ["malformed JSON", "not JSON"],
    ["non-array JSON", JSON.stringify({ candidate: "http://127.0.0.1:3100" })],
  ])("does not pass %s runtime candidates to a direct child", (_description, candidateHint) => {
    process.env.PAPERCLIP_RUNTIME_API_URL = "http://localhost:3100";
    process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON = candidateHint;

    const env = {
      ...process.env,
      ...buildPaperclipEnv({ id: "agent-1", companyId: "company-1" }),
    };
    const child = spawnSync(
      process.execPath,
      ["-e", "process.stdout.write(process.env.PAPERCLIP_RUNTIME_API_CANDIDATES_JSON ?? '<missing>')"],
      { env, encoding: "utf8" },
    );

    expect(child.error).toBeUndefined();
    expect(child.status).toBe(0);
    expect(child.stdout).toBe("[]");
  });

  it("uses runtime listen host/port when explicit URL is not set", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "0.0.0.0";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";
    process.env.PORT = "3100";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://localhost:3101");
  });

  it("formats IPv6 hosts safely in fallback URL generation", () => {
    delete process.env.PAPERCLIP_RUNTIME_API_URL;
    delete process.env.PAPERCLIP_API_URL;
    process.env.PAPERCLIP_LISTEN_HOST = "::1";
    process.env.PAPERCLIP_LISTEN_PORT = "3101";

    const env = buildPaperclipEnv({ id: "agent-1", companyId: "company-1" });

    expect(env.PAPERCLIP_API_URL).toBe("http://[::1]:3101");
  });
});
