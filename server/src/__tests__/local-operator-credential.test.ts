import { spawn } from "node:child_process";
import http from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  LOCAL_OPERATOR_FRAGMENT_KEY,
  LOCAL_OPERATOR_HEADER,
  ensureLocalOperatorKey,
  localOperatorReadCookieName,
  readLocalOperatorKey,
} from "@paperclipai/shared/local-operator-credential";
import { actorMiddleware } from "../middleware/auth.js";
import { createLocalAgentProcessBoundary } from "../middleware/local-agent-process-boundary.js";
import {
  createLocalOperatorCredential,
  type LocalOperatorCredential,
} from "../middleware/local-operator-credential.js";

const supported = process.platform === "linux" || process.platform === "darwin";
const AGENT_MARKERS = ["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_AGENT_KEY_ID", "PAPERCLIP_RUNNER_INSTANCE_ID"];

function startServer(operator: LocalOperatorCredential): Promise<{ server: Server; base: string }> {
  const serverEnvironment = { ...process.env };
  for (const key of AGENT_MARKERS) delete serverEnvironment[key];
  const app = express();
  app.use("/api", operator.signInRoutes());
  app.use(actorMiddleware({} as Db, {
    deploymentMode: "local_trusted",
    localAgentProcessBoundary: createLocalAgentProcessBoundary({ serverEnvironment }),
    localOperatorCredential: operator,
  }));
  const whoami = (req: express.Request, res: express.Response) => {
    res.json({ type: req.actor.type, source: req.actor.source ?? null });
  };
  app.get("/api/whoami", whoami);
  app.post("/api/whoami", whoami);
  app.get("/api/attachments/:id/content", whoami);
  app.get("/api/issues/:id/file-resources/content", whoami);
  app.get("/api/assets/:id/content", whoami);
  app.get("/api/heartbeat-runs/:id/provider-trace/download", whoami);
  app.get("/api/companies/:id/audit/agent-actions.csv", whoami);
  app.get("/api/plugins/:id/bridge/stream/:channel", whoami);
  app.get("/api/plugins/:id/api/socket", whoami);
  app.post("/api/attachments/:id/content", whoami);
  return new Promise((resolve) => {
    const server = app.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Starts a process that looks like an agent run, then has it launch a fully
 * detached child (its own session, re-parented once the run exits) with an
 * empty environment. Only that detached child calls the server.
 */
function callFromDetachedEnvClearedAgentChild(url: string, outFile: string): Promise<{ type: string; source: string | null }> {
  const detachedChild = [
    "fetch(process.argv[1]).then(r => r.text())",
    ".then(t => require('fs').writeFileSync(process.argv[2], t))",
    ".catch(e => require('fs').writeFileSync(process.argv[2], JSON.stringify({ error: String(e) })))",
  ].join("");
  const agentRun = [
    "const { spawn } = require('child_process');",
    "const child = spawn(process.execPath, ['-e', process.argv[1], process.argv[2], process.argv[3]],",
    "  { detached: true, stdio: 'ignore', env: {} });",
    "child.unref();",
  ].join("\n");
  return new Promise((resolve, reject) => {
    const run = spawn(process.execPath, ["-e", agentRun, detachedChild, url, outFile], {
      env: { ...process.env, PAPERCLIP_RUN_ID: "run-1", PAPERCLIP_AGENT_ID: "agent-1" },
      stdio: "ignore",
    });
    run.on("error", reject);
    run.on("exit", () => {
      const deadline = Date.now() + 20_000;
      const poll = () => {
        if (existsSync(outFile)) {
          const text = readFileSync(outFile, "utf8");
          if (text) {
            resolve(JSON.parse(text));
            return;
          }
        }
        if (Date.now() > deadline) reject(new Error("detached child never answered"));
        else setTimeout(poll, 50);
      };
      poll();
    });
  });
}

describe.skipIf(!supported)("local board access for a detached agent child with a cleared environment", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-operator-"));
  });
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("is granted board access when only the process check guards the board (the gap)", async () => {
    const operator = createLocalOperatorCredential({ mode: "off", keyPath: path.join(dir, "off.key") });
    const { server, base } = await startServer(operator);
    try {
      const result = await callFromDetachedEnvClearedAgentChild(`${base}/api/whoami`, path.join(dir, "off.json"));
      expect(result).toEqual({ type: "board", source: "local_implicit" });
    } finally {
      server.close();
    }
  });

  it("is refused once the board requires the operator credential", async () => {
    const operator = createLocalOperatorCredential({ mode: "required", keyPath: path.join(dir, "required.key") });
    const { server, base } = await startServer(operator);
    try {
      const result = await callFromDetachedEnvClearedAgentChild(`${base}/api/whoami`, path.join(dir, "required.json"));
      expect(result).toEqual({ type: "none", source: "none" });
    } finally {
      server.close();
    }
  });
});

describe.skipIf(!supported)("operator browser sign-in", () => {
  let dir: string;
  let operator: LocalOperatorCredential;
  let server: Server;
  let base: string;

  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-operator-"));
    operator = createLocalOperatorCredential({ mode: "required", keyPath: path.join(dir, "secrets", "local-operator.key") });
    ({ server, base } = await startServer(operator));
  });
  afterAll(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function signIn(): Promise<{ token: string; cookie: string }> {
    const response = await fetch(operator.signInUrl(base), { redirect: "manual" });
    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location")!, base);
    expect(location.pathname).toBe("/");
    const token = new URLSearchParams(location.hash.slice(1)).get(LOCAL_OPERATOR_FRAGMENT_KEY);
    expect(token).toBeTruthy();
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    return { token: token!, cookie: setCookie.split(";")[0]! };
  }

  it("keeps the operator key private to the operator's account", () => {
    operator.signInUrl(base);
    expect(statSync(path.join(dir, "secrets", "local-operator.key")).mode & 0o077).toBe(0);
  });

  it("refuses a request that carries no operator credential", async () => {
    const response = await fetch(`${base}/api/whoami`);
    expect(await response.json()).toEqual({ type: "none", source: "none" });
  });

  it("grants board access to the board page of a browser that signed in through the operator's link", async () => {
    const { token } = await signIn();
    const read = await fetch(`${base}/api/whoami`, { headers: { [LOCAL_OPERATOR_HEADER]: token } });
    expect(await read.json()).toEqual({ type: "board", source: "local_implicit" });
    const change = await fetch(`${base}/api/whoami`, { method: "POST", headers: { [LOCAL_OPERATOR_HEADER]: token } });
    expect(await change.json()).toEqual({ type: "board", source: "local_implicit" });
  });

  it("gives the browser's cookie, which other local servers can receive, no board access", async () => {
    const { cookie } = await signIn();
    for (const init of [{ headers: { cookie } }, { method: "POST", headers: { cookie } }]) {
      const response = await fetch(`${base}/api/whoami`, init);
      expect(await response.json()).toEqual({ type: "none", source: "none" });
    }
    const change = await fetch(`${base}/api/attachments/a1/content`, { method: "POST", headers: { cookie } });
    expect(await change.json()).toEqual({ type: "none", source: "none" });
  });

  it("lets the browser load a file it was shown with the cookie alone", async () => {
    const { cookie } = await signIn();
    for (const file of [
      "/api/attachments/a1/content",
      "/api/assets/s1/content",
      "/api/issues/i1/file-resources/content?path=a.txt",
      "/api/plugins/p1/bridge/stream/updates?companyId=c1",
    ]) {
      const response = await fetch(`${base}${file}`, { headers: { cookie } });
      expect(await response.json()).toEqual({ type: "board", source: "local_implicit" });
    }
    // The page downloads these with `fetch`, so they need its header token.
    for (const file of ["/api/heartbeat-runs/r1/provider-trace/download", "/api/companies/c1/audit/agent-actions.csv"]) {
      const response = await fetch(`${base}${file}`, { headers: { cookie } });
      expect(await response.json()).toEqual({ type: "none", source: "none" });
    }
  });

  it("renews the read cookie only for the board page that holds the header token", async () => {
    const { token } = await signIn();
    expect((await fetch(`${base}/api/local-operator/read-cookie`, { method: "POST" })).status).toBe(403);
    const renewed = await fetch(`${base}/api/local-operator/read-cookie`, {
      method: "POST",
      headers: { [LOCAL_OPERATOR_HEADER]: token },
    });
    expect(renewed.status).toBe(204);
    expect(renewed.headers.get("set-cookie")).toMatch(/HttpOnly/i);
  });

  it("accepts the token on a socket upgrade, where a browser cannot set headers, and nowhere else", async () => {
    const { token, cookie } = await signIn();
    const whoamiOver = (url: string, headers: Record<string, string>) => new Promise<unknown>((resolve, reject) => {
      http.get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve(JSON.parse(body)));
      }).on("error", reject);
    });
    const socketPath = `${base}/api/plugins/p1/api/socket?operator=${encodeURIComponent(token)}`;
    const upgrade = { upgrade: "websocket", connection: "Upgrade" };
    expect(await whoamiOver(socketPath, upgrade)).toEqual({ type: "board", source: "local_implicit" });
    expect(await whoamiOver(socketPath, {})).toEqual({ type: "none", source: "none" });
    // An Upgrade header without a real upgrade handshake is a plain request.
    expect(await whoamiOver(socketPath, { upgrade: "websocket", connection: "keep-alive" }))
      .toEqual({ type: "none", source: "none" });
    expect(await whoamiOver(`${base}/api/plugins/p1/api/socket`, { ...upgrade, cookie }))
      .toEqual({ type: "none", source: "none" });
  });

  it("accepts each sign-in link only once", async () => {
    const url = operator.signInUrl(base);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(403);
  });

  it("refuses a forged credential and a tampered link", async () => {
    const forged = await fetch(`${base}/api/whoami`, { headers: { [LOCAL_OPERATOR_HEADER]: "v1.forged" } });
    expect(await forged.json()).toEqual({ type: "none", source: "none" });
    const tampered = new URL(operator.signInUrl(base));
    tampered.searchParams.set("e", String(Date.now() + 60_000));
    expect((await fetch(tampered, { redirect: "manual" })).status).toBe(403);
  });

  it("returns to a page on the board after signing in, never another site", async () => {
    const next = await fetch(operator.signInUrl(base, "/issues"), { redirect: "manual" });
    expect(new URL(next.headers.get("location")!, base).pathname).toBe("/issues");
    const offsite = new URL(operator.signInUrl(base));
    offsite.searchParams.set("next", "//evil.example");
    // The signature covers only the nonce and expiry, so the redirect target is sanitized instead.
    const response = await fetch(offsite, { redirect: "manual" });
    expect(new URL(response.headers.get("location")!, base).origin).toBe(base);
  });

  it("names its cookie per instance so two local boards do not sign each other out", () => {
    const other = ensureLocalOperatorKey(path.join(dir, "other.key"));
    const mine = readLocalOperatorKey(path.join(dir, "secrets", "local-operator.key"))!;
    expect(localOperatorReadCookieName(other)).not.toBe(localOperatorReadCookieName(mine));
  });
});

describe("operator key file", () => {
  it("is created once and reused", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "paperclip-operator-"));
    try {
      const keyPath = path.join(dir, "secrets", "local-operator.key");
      expect(readLocalOperatorKey(keyPath)).toBeNull();
      const first = ensureLocalOperatorKey(keyPath);
      expect(ensureLocalOperatorKey(keyPath).equals(first)).toBe(true);
      expect(readLocalOperatorKey(keyPath)?.equals(first)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
