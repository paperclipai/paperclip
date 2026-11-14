import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, existsSync } from "node:fs";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import os from "node:os";
import path from "node:path";
import express from "express";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  LOCAL_OPERATOR_COOKIE_NAME,
  ensureLocalOperatorKey,
  readLocalOperatorKey,
} from "@paperclipai/shared/local-operator-credential";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
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
  app.use(boardMutationGuard());
  const whoami = (req: express.Request, res: express.Response) => {
    res.json({ type: req.actor.type, source: req.actor.source ?? null });
  };
  app.get("/api/whoami", whoami);
  app.post("/api/whoami", whoami);
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

  async function signIn(): Promise<string> {
    const response = await fetch(operator.signInUrl(base), { redirect: "manual" });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/");
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Strict/i);
    return setCookie.split(";")[0]!;
  }

  it("keeps the operator key private to the operator's account", () => {
    operator.signInUrl(base);
    expect(statSync(path.join(dir, "secrets", "local-operator.key")).mode & 0o077).toBe(0);
  });

  it("refuses a request that carries no operator credential", async () => {
    const response = await fetch(`${base}/api/whoami`);
    expect(await response.json()).toEqual({ type: "none", source: "none" });
  });

  it("grants board access to a browser that signed in through the operator's link", async () => {
    const cookie = await signIn();
    const response = await fetch(`${base}/api/whoami`, { headers: { cookie } });
    expect(await response.json()).toEqual({ type: "board", source: "local_implicit" });
  });

  it("accepts each sign-in link only once", async () => {
    const url = operator.signInUrl(base);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(303);
    expect((await fetch(url, { redirect: "manual" })).status).toBe(403);
  });

  it("refuses a forged or stale browser credential and a tampered link", async () => {
    const forged = await fetch(`${base}/api/whoami`, { headers: { cookie: `${LOCAL_OPERATOR_COOKIE_NAME}=v1.forged` } });
    expect(await forged.json()).toEqual({ type: "none", source: "none" });
    const tampered = new URL(operator.signInUrl(base));
    tampered.searchParams.set("e", String(Date.now() + 60_000));
    expect((await fetch(tampered, { redirect: "manual" })).status).toBe(403);
  });

  it("only accepts the signed-in browser's changes from the board's own pages", async () => {
    const cookie = await signIn();
    const sameOrigin = await fetch(`${base}/api/whoami`, { method: "POST", headers: { cookie, origin: base } });
    expect(sameOrigin.status).toBe(200);
    const otherLocalPage = await fetch(`${base}/api/whoami`, {
      method: "POST",
      headers: { cookie, origin: "http://localhost:5173" },
    });
    expect(otherLocalPage.status).toBe(403);
  });

  it("returns to a page on the board after signing in, never another site", async () => {
    const next = new URL(operator.signInUrl(base, "/issues"));
    expect((await fetch(next, { redirect: "manual" })).headers.get("location")).toBe("/issues");
    const offsite = new URL(operator.signInUrl(base));
    offsite.searchParams.set("next", "//evil.example");
    // The signature covers only the nonce and expiry, so the redirect target is sanitized instead.
    expect((await fetch(offsite, { redirect: "manual" })).headers.get("location")).toBe("/");
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
