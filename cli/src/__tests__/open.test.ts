import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { readLocalOperatorKey, verifyLocalOperatorSignInLink } from "@paperclipai/shared/local-operator-credential";
import { buildLocalBoardSignInUrl } from "../commands/open.js";

describe("paperclipai open", () => {
  it("builds a sign-in link the local server accepts", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-open-"));
    try {
      const keyPath = path.join(dir, "local-operator.key");
      const url = new URL(buildLocalBoardSignInUrl("http://localhost:3100", keyPath));
      expect(url.origin).toBe("http://localhost:3100");
      expect(url.pathname).toBe("/api/local-operator/sign-in");
      const link = { nonce: url.searchParams.get("n"), expiresAt: url.searchParams.get("e"), signature: url.searchParams.get("s") };
      expect(verifyLocalOperatorSignInLink(readLocalOperatorKey(keyPath)!, link)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to sign in to a Paperclip that is not on this computer", () => {
    expect(() => buildLocalBoardSignInUrl("https://paperclip.example.com", "/nonexistent/key")).toThrow(/not local/);
    expect(() => buildLocalBoardSignInUrl("http://127.attacker.example:3100", "/nonexistent/key")).toThrow(/not local/);
    expect(() => buildLocalBoardSignInUrl("http://localhost.attacker.example:3100", "/nonexistent/key")).toThrow(/not local/);
  });
});

describe("paperclipai open instance selection", () => {
  it("uses the instance that a config file belongs to", async () => {
    const { instanceIdForConfigPath } = await import("../commands/open.js");
    expect(instanceIdForConfigPath("/home/me/.paperclip/instances/foo/config.json", "/home/me/.paperclip")).toBe("foo");
    expect(instanceIdForConfigPath("/elsewhere/config.json", "/home/me/.paperclip")).toBeNull();
  });

  it("prefers the running server's address to the configured port", async () => {
    const { resolveOpenApiBase } = await import("../commands/open.js");
    const home = mkdtempSync(path.join(os.tmpdir(), "paperclip-open-home-"));
    const previous = process.env.PAPERCLIP_HOME;
    process.env.PAPERCLIP_HOME = home;
    try {
      const { writeRuntimeInfo } = await import("../runtime-info.js");
      writeRuntimeInfo({
        schemaVersion: 1, instanceId: "foo", pid: process.pid, host: "127.0.0.1", port: 3191,
        dashboardUrl: "http://127.0.0.1:3191", startedAt: new Date().toISOString(),
      });
      expect(resolveOpenApiBase({}, "foo")).toBe("http://127.0.0.1:3191");
      expect(resolveOpenApiBase({ apiBase: "http://localhost:4000/" }, "foo")).toBe("http://localhost:4000");
    } finally {
      if (previous === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previous;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("paperclipai open on a board with accounts", () => {
  it("reads the board's mode from its config", async () => {
    const { configDeploymentMode } = await import("../commands/open.js");
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-open-config-"));
    try {
      expect(configDeploymentMode(path.join(dir, "missing.json"))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
