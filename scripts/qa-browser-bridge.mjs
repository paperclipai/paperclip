#!/usr/bin/env node
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { chromium } from "@playwright/test";

function parseArgs(argv) {
  const args = {
    host: "127.0.0.1",
    port: 3320,
    baseUrl: process.env.QA_BROWSER_BASE_URL ?? "http://127.0.0.1:3100",
    profileDir: process.env.QA_BROWSER_PROFILE_DIR,
    screenshotDir: process.env.QA_BROWSER_SCREENSHOT_DIR,
    headless: process.env.QA_BROWSER_HEADLESS !== "0",
    channel: process.env.PAPERCLIP_PLAYWRIGHT_CHANNEL,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--host" && next) {
      args.host = next;
      i += 1;
    } else if (arg === "--port" && next) {
      args.port = Number(next);
      i += 1;
    } else if (arg === "--base-url" && next) {
      args.baseUrl = next;
      i += 1;
    } else if (arg === "--profile-dir" && next) {
      args.profileDir = next;
      i += 1;
    } else if (arg === "--screenshot-dir" && next) {
      args.screenshotDir = next;
      i += 1;
    } else if (arg === "--headed") {
      args.headless = false;
    } else if (arg === "--channel" && next) {
      args.channel = next;
      i += 1;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    }
  }

  const cwd = process.cwd();
  args.profileDir ??= path.join(cwd, ".paperclip", "qa-browser", `profile-${args.port}`);
  args.screenshotDir ??= path.join(cwd, "screenshots", "qa-browser");
  args.baseUrl = args.baseUrl.replace(/\/+$/, "");
  return args;
}

function printHelp() {
  console.log(`Usage: node scripts/qa-browser-bridge.mjs [options]

Starts a localhost-only Playwright browser bridge with an isolated persistent
Chromium profile. The bridge exposes JSON primitives for QA agents:

  GET  /health
  GET  /manifest
  POST /navigate        { "url": "http://...", "path": "/optional" }
  POST /click           { "selector": "button", "timeoutMs": 5000 }
  POST /type            { "selector": "input", "text": "...", "clear": true }
  POST /waitFor         { "selector": "...", "url": "**/issues/**", "loadState": "networkidle" }
  POST /evaluate        { "expression": "() => document.title", "arg": null }
  POST /extract         { "selector": "main" }
  POST /screenshot      { "path": "optional.png", "fullPage": true }
  POST /auth/sign-up-or-in { "email": "...", "password": "...", "name": "QA User" }

Options:
  --host <host>             Bind host. Defaults to 127.0.0.1.
  --port <port>             Bind port. Defaults to 3320.
  --base-url <url>          App URL. Defaults to QA_BROWSER_BASE_URL or http://127.0.0.1:3100.
  --profile-dir <path>      Persistent browser profile directory.
  --screenshot-dir <path>   Screenshot output directory.
  --headed                  Launch a visible browser.
  --channel <name>          Playwright browser channel, for example chrome.
`);
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  return JSON.parse(text);
}

function sanitizeFileName(value) {
  return String(value)
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 120) || "screenshot";
}

function resolveTargetUrl(baseUrl, body) {
  if (typeof body.url === "string" && body.url.trim()) {
    return new URL(body.url, baseUrl).toString();
  }
  if (typeof body.path === "string" && body.path.trim()) {
    return new URL(body.path, `${baseUrl}/`).toString();
  }
  return baseUrl;
}

function safeError(err) {
  return {
    error: err instanceof Error ? err.message : String(err),
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  fs.mkdirSync(args.profileDir, { recursive: true });
  fs.mkdirSync(args.screenshotDir, { recursive: true });

  const context = await chromium.launchPersistentContext(args.profileDir, {
    headless: args.headless,
    viewport: { width: 1440, height: 1000 },
    ...(args.channel ? { channel: args.channel } : {}),
  });
  const page = context.pages()[0] ?? await context.newPage();

  page.setDefaultTimeout(10_000);
  await page.goto(args.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);

  const manifest = {
    name: "paperclip-qa-browser-bridge",
    baseUrl: args.baseUrl,
    profileDir: args.profileDir,
    screenshotDir: args.screenshotDir,
    isolated: true,
    primitives: ["navigate", "click", "type", "waitFor", "evaluate", "screenshot", "extract"],
    auth: {
      endpoint: "/auth/sign-up-or-in",
      credentialSource: "Request body or a Paperclip secret resolved into the caller environment.",
      notes: "The bridge never logs submitted passwords.",
    },
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${args.host}:${args.port}`);

      if (req.method === "GET" && url.pathname === "/health") {
        sendJson(res, 200, {
          ok: true,
          currentUrl: page.url(),
          title: await page.title().catch(() => ""),
          ...manifest,
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/manifest") {
        sendJson(res, 200, manifest);
        return;
      }

      if (req.method !== "POST") {
        sendJson(res, 404, { error: "Not found" });
        return;
      }

      const body = await readJson(req);

      if (url.pathname === "/navigate") {
        const target = resolveTargetUrl(args.baseUrl, body);
        await page.goto(target, { waitUntil: body.waitUntil ?? "domcontentloaded", timeout: body.timeoutMs ?? 30_000 });
        sendJson(res, 200, { ok: true, url: page.url(), title: await page.title().catch(() => "") });
        return;
      }

      if (url.pathname === "/click") {
        if (typeof body.selector !== "string") throw new Error("selector is required");
        await page.locator(body.selector).click({ timeout: body.timeoutMs ?? 10_000 });
        sendJson(res, 200, { ok: true, url: page.url() });
        return;
      }

      if (url.pathname === "/type") {
        if (typeof body.selector !== "string") throw new Error("selector is required");
        if (typeof body.text !== "string") throw new Error("text is required");
        const locator = page.locator(body.selector);
        if (body.clear !== false) {
          await locator.fill(body.text, { timeout: body.timeoutMs ?? 10_000 });
        } else {
          await locator.type(body.text, { timeout: body.timeoutMs ?? 10_000 });
        }
        sendJson(res, 200, { ok: true, url: page.url() });
        return;
      }

      if (url.pathname === "/waitFor") {
        const timeout = body.timeoutMs ?? 10_000;
        if (typeof body.selector === "string") {
          await page.locator(body.selector).waitFor({ timeout });
        }
        if (typeof body.url === "string") {
          await page.waitForURL(body.url, { timeout });
        }
        if (typeof body.loadState === "string") {
          await page.waitForLoadState(body.loadState, { timeout });
        }
        if (typeof body.ms === "number") {
          await page.waitForTimeout(body.ms);
        }
        sendJson(res, 200, { ok: true, url: page.url() });
        return;
      }

      if (url.pathname === "/evaluate") {
        if (typeof body.expression !== "string") throw new Error("expression is required");
        const value = await page.evaluate(body.expression, body.arg);
        sendJson(res, 200, { ok: true, value });
        return;
      }

      if (url.pathname === "/extract") {
        if (typeof body.selector === "string") {
          const locator = page.locator(body.selector).first();
          await locator.waitFor({ timeout: body.timeoutMs ?? 10_000 });
          sendJson(res, 200, {
            ok: true,
            url: page.url(),
            text: await locator.innerText().catch(() => null),
            html: body.html === true ? await locator.innerHTML().catch(() => null) : undefined,
          });
          return;
        }
        sendJson(res, 200, {
          ok: true,
          url: page.url(),
          title: await page.title().catch(() => ""),
          text: await page.locator("body").innerText({ timeout: body.timeoutMs ?? 10_000 }).catch(() => ""),
        });
        return;
      }

      if (url.pathname === "/screenshot") {
        const defaultName = `${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
        const requested = typeof body.path === "string" && body.path.trim() ? body.path : defaultName;
        const fileName = sanitizeFileName(path.basename(requested));
        const target = path.isAbsolute(requested)
          ? requested
          : path.join(args.screenshotDir, fileName);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await page.screenshot({ path: target, fullPage: body.fullPage !== false });
        sendJson(res, 200, { ok: true, path: target, url: page.url() });
        return;
      }

      if (url.pathname === "/auth/sign-up-or-in") {
        if (typeof body.email !== "string") throw new Error("email is required");
        if (typeof body.password !== "string") throw new Error("password is required");
        const name = typeof body.name === "string" && body.name.trim() ? body.name : "QA Browser";
        await page.goto(args.baseUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
        const result = await page.evaluate(
          async ({ baseUrl, email, password, name }) => {
            async function post(path, payload) {
              const response = await fetch(`${baseUrl}${path}`, {
                method: "POST",
                credentials: "include",
                headers: { "Content-Type": "application/json", Accept: "application/json" },
                body: JSON.stringify(payload),
              });
              const text = await response.text();
              let json = null;
              try {
                json = text ? JSON.parse(text) : null;
              } catch {
                json = null;
              }
              return { ok: response.ok, status: response.status, json };
            }

            let signIn = await post("/api/auth/sign-in/email", { email, password });
            let mode = "sign-in";
            if (!signIn.ok && [400, 401, 403, 404, 422].includes(signIn.status)) {
              const signUp = await post("/api/auth/sign-up/email", { email, password, name });
              mode = signUp.ok ? "sign-up" : "sign-up-failed";
              signIn = signUp.ok ? await post("/api/auth/sign-in/email", { email, password }) : signIn;
              if (!signUp.ok && signUp.status === 404) {
                return { ok: true, authRequired: false, mode: "local-trusted", status: signUp.status };
              }
            }

            return {
              ok: signIn.ok,
              authRequired: true,
              mode,
              status: signIn.status,
              code: signIn.json?.code ?? signIn.json?.error?.code ?? null,
              message: signIn.ok ? null : signIn.json?.message ?? signIn.json?.error?.message ?? signIn.json?.error ?? null,
            };
          },
          { baseUrl: args.baseUrl, email: body.email, password: body.password, name },
        );
        sendJson(res, result.ok ? 200 : 400, {
          ...result,
          email: body.email,
          url: page.url(),
        });
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    })().catch((err) => sendJson(res, 500, safeError(err)));
  });

  server.listen(args.port, args.host, () => {
    console.log(JSON.stringify({
      ok: true,
      url: `http://${args.host}:${args.port}`,
      baseUrl: args.baseUrl,
      profileDir: args.profileDir,
      screenshotDir: args.screenshotDir,
      pid: process.pid,
    }, null, 2));
  });

  async function shutdown() {
    server.close();
    await context.close().catch(() => undefined);
    process.exit(0);
  }
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
