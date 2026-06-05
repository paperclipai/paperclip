import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const defaultUrl = process.env.VIRTUAL_OFFICE_URL ?? "http://localhost:5173/AI/office";
const extraUrls = (process.env.VIRTUAL_OFFICE_PR_SCREENSHOT_URLS ?? "")
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);
const captureUrls = [defaultUrl, ...extraUrls];
const cdpPort = Number(process.env.VIRTUAL_OFFICE_PR_SCREENSHOT_CDP_PORT ?? 9241);
const timeoutMs = Number(process.env.VIRTUAL_OFFICE_PR_SCREENSHOT_TIMEOUT_MS ?? 45000);
const repoRoot = path.resolve(import.meta.dirname, "..");
const userDataDir = path.join(repoRoot, ".paperclip-local", "virtual-office-pr-screenshots-browser");
const outputDir = path.join(repoRoot, ".paperclip-local", "virtual-office-pr-screenshots");

function findBrowserExecutable() {
  const platform = os.platform();
  const candidates =
    platform === "win32"
      ? [
          process.env.VIRTUAL_OFFICE_RENDER_BROWSER,
          "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
          "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
        ]
      : platform === "darwin"
        ? [
            process.env.VIRTUAL_OFFICE_RENDER_BROWSER,
            "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
            "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
          ]
        : [
            process.env.VIRTUAL_OFFICE_RENDER_BROWSER,
            "/usr/bin/google-chrome",
            "/usr/bin/google-chrome-stable",
            "/usr/bin/chromium",
            "/usr/bin/chromium-browser",
            "/usr/bin/microsoft-edge",
          ];

  return candidates.find((candidate) => candidate && existsSync(candidate));
}

function requestJson(url, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(url, { method: options.method ?? "GET" }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}: ${body.slice(0, 300)}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });
    request.on("error", reject);
    request.end();
  });
}

async function waitForCdp() {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      return await requestJson(`http://127.0.0.1:${cdpPort}/json/version`);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  throw new Error(`Timed out waiting for browser CDP: ${lastError?.message ?? "unknown error"}`);
}

function createCdpClient(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  let nextId = 1;
  const pending = new Map();

  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) {
      reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      return;
    }
    resolve(message.result);
  });

  return {
    waitOpen() {
      return new Promise((resolve, reject) => {
        socket.addEventListener("open", resolve, { once: true });
        socket.addEventListener("error", reject, { once: true });
      });
    },
    send(method, params = {}) {
      const id = nextId;
      nextId += 1;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
      });
    },
    close() {
      socket.close();
    },
  };
}

function slugForUrl(url, index) {
  const parsed = new URL(url);
  const slug = `${parsed.hostname}${parsed.pathname}`
    .replace(/[^a-z0-9]+/gi, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  return `${String(index + 1).padStart(2, "0")}-${slug || "page"}.png`;
}

async function waitForVirtualOffice(client) {
  const deadline = Date.now() + timeoutMs;
  let lastSnapshot = null;
  while (Date.now() < deadline) {
    const result = await client.send("Runtime.evaluate", {
      expression: `(() => {
        const root = document.querySelector("#root");
        const text = document.body?.innerText || "";
        const hasExpectedText = /Virtual Office/.test(text);
        const hasWorkbenchText = /A visual control room|New Agent|New Work/.test(text);
        return {
          readyState: document.readyState,
          url: location.href,
          title: document.title,
          rootChildCount: root?.children.length ?? 0,
          bodyTextLength: text.length,
          hasExpectedText,
          hasWorkbenchText,
          bodyPreview: text.slice(0, 240)
        };
      })()`,
      returnByValue: true,
    });
    lastSnapshot = result.result.value;
    if (
      lastSnapshot?.readyState === "complete" &&
      lastSnapshot.rootChildCount > 0 &&
      lastSnapshot.bodyTextLength > 900 &&
      lastSnapshot.hasExpectedText &&
      lastSnapshot.hasWorkbenchText
    ) {
      return lastSnapshot;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }

  throw new Error(`Virtual Office did not render expected content: ${JSON.stringify(lastSnapshot, null, 2)}`);
}

async function main() {
  const browserExecutable = findBrowserExecutable();
  if (!browserExecutable) {
    throw new Error("No Chrome/Edge browser executable found for PR screenshot capture.");
  }

  rmSync(userDataDir, { recursive: true, force: true });
  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(userDataDir, { recursive: true });
  mkdirSync(outputDir, { recursive: true });

  const browser = spawn(
    browserExecutable,
    [
      "--headless=new",
      "--disable-gpu",
      "--disable-extensions",
      "--no-first-run",
      "--no-default-browser-check",
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${userDataDir}`,
      "about:blank",
    ],
    { stdio: "ignore" },
  );

  let client;
  try {
    await waitForCdp();
    const target = await requestJson(`http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent("about:blank")}`, {
      method: "PUT",
    });
    client = createCdpClient(target.webSocketDebuggerUrl);
    await client.waitOpen();
    await client.send("Page.enable");
    await client.send("Runtime.enable");
    await client.send("Emulation.setDeviceMetricsOverride", {
      width: 1440,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });

    const captures = [];
    for (const [index, url] of captureUrls.entries()) {
      await client.send("Page.navigate", { url });
      const snapshot = await waitForVirtualOffice(client);
      const screenshot = await client.send("Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: false,
      });
      const fileName = slugForUrl(url, index);
      const filePath = path.join(outputDir, fileName);
      writeFileSync(filePath, Buffer.from(screenshot.data, "base64"));
      captures.push({
        url: snapshot.url,
        title: snapshot.title,
        file: filePath,
        bodyTextLength: snapshot.bodyTextLength,
        reviewRequired: true,
        warning:
          snapshot.bodyTextLength < 900
            ? "Screenshot may show only the app shell or loading skeleton. Review manually before attaching to a public PR."
            : undefined,
      });
    }

    const manifestPath = path.join(outputDir, "manifest.json");
    writeFileSync(
      manifestPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          note: "Local-only PR screenshot evidence. Review for private data before attaching to a public PR.",
          captures,
        },
        null,
        2,
      ),
    );

    console.log("Virtual Office PR screenshots captured");
    console.log(`Output: ${outputDir}`);
    const warnings = captures.filter((capture) => capture.warning);
    if (warnings.length > 0) {
      console.log("");
      console.log("Manual review warnings:");
      for (const warning of warnings) {
        console.log(`  - ${path.basename(warning.file)}: ${warning.warning}`);
      }
    }
    console.log(JSON.stringify({ captures, manifestPath }, null, 2));
  } finally {
    client?.close();
    browser.kill();
  }
}

main().catch((error) => {
  console.error("Virtual Office PR screenshot capture: blocked");
  console.error(error.message);
  process.exit(1);
});
