import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  ensureLocalOperatorKey,
  localOperatorBrowserToken,
  parseLocalOperatorCredentialMode,
  localOperatorReadCookieValue,
  resolveLocalOperatorKeyPathForConfig,
  verifyLocalOperatorReadCookieValue,
  LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS,
} from "@paperclipai/shared/local-operator-credential";

describe("the local operator credential setting", () => {
  it("requires the credential for every value except an explicit off, so a typo keeps the protection", () => {
    for (const value of ["required", "1", "yes", "true", "on", "requird", "", "  "]) {
      expect(parseLocalOperatorCredentialMode(value)?.mode).toBe("required");
    }
    expect(parseLocalOperatorCredentialMode("requird")?.recognized).toBe(false);
    for (const value of ["off", "0", "no", "false"]) {
      expect(parseLocalOperatorCredentialMode(value)?.mode).toBe("off");
    }
    expect(parseLocalOperatorCredentialMode(undefined)).toBeNull();
  });
});

describe("the read cookie", () => {
  it("stops working within two rotation windows, so a copied cookie expires", () => {
    const key = Buffer.alloc(32, 3);
    const issued = 1_000 * LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS + 1;
    const value = localOperatorReadCookieValue(key, issued);
    expect(verifyLocalOperatorReadCookieValue(key, value, issued)).toBe(true);
    expect(verifyLocalOperatorReadCookieValue(key, value, issued + LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS)).toBe(true);
    expect(verifyLocalOperatorReadCookieValue(key, value, issued + 2 * LOCAL_OPERATOR_READ_COOKIE_WINDOW_MS)).toBe(false);
  });
});

describe.skipIf(process.platform === "win32")("an existing operator key file", () => {
  it("is made readable by its owner only", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-operator-key-"));
    try {
      const keyPath = path.join(dir, "local-operator.key");
      writeFileSync(keyPath, `${Buffer.alloc(32, 7).toString("base64url")}\n`);
      chmodSync(keyPath, 0o644);
      ensureLocalOperatorKey(keyPath);
      expect(statSync(keyPath).mode & 0o777).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
  "a local board that requires the operator credential",
  () => {
    let home: string;
    let token: string;
    const saved = {
      home: process.env.PAPERCLIP_HOME,
      instance: process.env.PAPERCLIP_INSTANCE_ID,
      mode: process.env.PAPERCLIP_LOCAL_OPERATOR_CREDENTIAL,
      config: process.env.PAPERCLIP_CONFIG,
    };

    beforeAll(() => {
      home = mkdtempSync(path.join(os.tmpdir(), "paperclip-operator-home-"));
      process.env.PAPERCLIP_HOME = home;
      process.env.PAPERCLIP_INSTANCE_ID = "default";
      process.env.PAPERCLIP_LOCAL_OPERATOR_CREDENTIAL = "required";
      // The server keeps the key next to the config file it runs from.
      process.env.PAPERCLIP_CONFIG = path.join(home, "instances", "default", "config.json");
      const keyPath = resolveLocalOperatorKeyPathForConfig(process.env.PAPERCLIP_CONFIG);
      mkdirSync(path.dirname(keyPath), { recursive: true });
      token = localOperatorBrowserToken(ensureLocalOperatorKey(keyPath));
      vi.resetModules();
    });

    afterAll(() => {
      for (const [key, value] of [
        ["PAPERCLIP_HOME", saved.home],
        ["PAPERCLIP_INSTANCE_ID", saved.instance],
        ["PAPERCLIP_LOCAL_OPERATOR_CREDENTIAL", saved.mode],
        ["PAPERCLIP_CONFIG", saved.config],
      ] as const) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(home, { recursive: true, force: true });
    });

    it("tells a browser that has not signed in how to open the board", async () => {
      const { healthRoutes } = await import("../routes/health.js");
      const app = express();
      app.use((req, _res, next) => {
        req.actor = { type: "none", source: "none" };
        next();
      });
      app.use("/api/health", healthRoutes(undefined, {
        deploymentMode: "local_trusted",
        deploymentExposure: "private",
        authReady: true,
        companyDeletionEnabled: true,
      }));
      const response = await request(app).get("/api/health");
      expect(response.body.localOperatorSignInRequired).toBe(true);
    }, 90_000);

    it("opens the live-events socket only for the board page that holds the operator token", async () => {
      const { authorizeUpgrade } = await import("../realtime/live-events-ws.js");
      const server = net.createServer();
      const accepted = new Promise<net.Socket>((resolve) => server.once("connection", resolve));
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      const client = net.connect((server.address() as net.AddressInfo).port, "127.0.0.1");
      const socket = await accepted;
      try {
        const upgrade = (query: string) => authorizeUpgrade(
          {} as Db,
          { headers: {}, socket } as never,
          "company-1",
          new URL(`http://127.0.0.1/api/companies/company-1/events/ws${query}`),
          { deploymentMode: "local_trusted" },
        );
        expect(await upgrade("")).toBeNull();
        expect(await upgrade("?operator=v1.forged")).toBeNull();
        expect(await upgrade(`?operator=${encodeURIComponent(token)}`)).toMatchObject({ actorType: "board" });
      } finally {
        client.destroy();
        socket.destroy();
        server.close();
      }
    }, 90_000);
  },
);
