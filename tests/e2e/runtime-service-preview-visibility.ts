import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect, type Browser, type Page, type TestInfo } from "@playwright/test";
import type { RuntimeService } from "../../packages/shared/src/runtime-services";

// Playwright's ordinary contexts force focus, so bringToFront alone leaves
// background pages visible. Connect without those overrides to a browser and
// profile owned only by this fixture. Never attach to a user's browser.
async function naturalVisibilityBrowser() {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-preview-visibility-browser-"));
  const process = spawn(chromium.executablePath(), ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "about:blank"], { stdio: "ignore" });
  let error: Error | undefined, browser: Browser | undefined;
  process.once("error", (cause) => { error = cause; });
  const close = async () => {
    try { await browser?.close(); }
    finally {
      if (process.exitCode === null && process.signalCode === null) process.kill("SIGTERM");
      await expect.poll(() => Boolean(error) || process.exitCode !== null || process.signalCode !== null,
        { timeout: 10_000, message: "Owned visibility browser exits before removing its profile" }).toBe(true);
      await fs.rm(profile, { recursive: true, force: true });
    }
  };
  try {
    let port = "";
    await expect.poll(async () => {
      if (error) throw error;
      if (process.exitCode !== null || process.signalCode !== null) throw new Error("Owned visibility browser exited during startup");
      try { port = (await fs.readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]!; }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause; }
      return /^\d+$/.test(port);
    }, { timeout: 10_000 }).toBe(true);
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    return { context: browser.contexts()[0]!, close };
  } catch (cause) { await close(); throw cause; }
}

export async function verifyHiddenPreviewActivity(input: {
  page: Page; testInfo: TestInfo; trackService: (cwd: string, apiPath?: string) => void;
}) {
  const { page, testInfo, trackService } = input;
  const natural = await naturalVisibilityBrowser();
  try {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-hidden-preview-")); trackService(cwd);
    await fs.writeFile(path.join(cwd, "app.cjs"), `const http=require('node:http'),crypto=require('node:crypto');
const server=http.createServer((req,res)=>{if(req.url==='/background-poll'){res.end('ok');return}res.setHeader('Content-Type','text/html');res.end('<!doctype html><html><head><title>Visibility preview</title></head><body><h1>Visibility preview</h1><script>window.polls=0;window.frames=0;setInterval(()=>fetch("/background-poll").then(r=>{if(r.ok)window.polls++}).catch(()=>{}),1000);const socket=new WebSocket(location.origin.replace("http","ws")+"/events");socket.onmessage=()=>window.frames++;</script></body></html>')});
server.on('upgrade',(req,socket)=>{const key=crypto.createHash('sha1').update(req.headers['sec-websocket-key']+'258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');socket.write('HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: Upgrade\\r\\nSec-WebSocket-Accept: '+key+'\\r\\n\\r\\n');const timer=setInterval(()=>socket.write(Buffer.from([129,2,111,107])),200);socket.on('error',()=>{});socket.on('close',()=>clearInterval(timer))});server.listen(Number(process.env.PORT),'127.0.0.1');`);
    const company = await (await page.request.post("/api/companies", { data: { name: "Hidden preview acceptance" } })).json();
    const created = await page.request.post(`/api/companies/${company.id}/runtime-services`, { data: {
      requestId: randomUUID(), name: "Visibility preview", cwd, command: "node app.cjs", endpoints: [{ name: "web" }], policy: { idleSeconds: 30 },
    } });
    expect(created.status()).toBe(202);
    const service: RuntimeService = await created.json(), apiPath = `/api/companies/${company.id}/runtime-services/${service.id}`;
    trackService(cwd, apiPath);
    const read = async (): Promise<RuntimeService> => (await page.request.get(apiPath)).json();
    await expect.poll(async () => (await read()).endpoints[0]?.status, { timeout: 40_000 }).toBe("ready");
    const url = (await read()).endpoints[0]!.url!, preview = await natural.context.newPage();
    const signals: boolean[] = [];
    preview.on("response", (response) => {
      if (new URL(response.url()).pathname === "/.paperclip/activity" && response.status() === 204) {
        signals.push(response.request().postDataJSON().visible);
      }
    });
    await preview.goto(`${url}/retained-route`); await preview.bringToFront();
    await expect(preview.getByRole("heading", { name: "Visibility preview" })).toBeVisible();
    await expect.poll(() => preview.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => signals.includes(true)).toBe(true);
    await preview.evaluate(() => localStorage.setItem("retained", "yes"));
    const first = await read(), visibleUntil = Date.now() + 45_000;
    do {
      expect((await read()).state).toBe("ready");
      expect(await preview.evaluate(() => document.visibilityState)).toBe("visible");
      await delay(1_000);
    } while (Date.now() < visibleUntil);
    const active = await read();
    expect(Date.parse(active.lastActivityAt) - Date.parse(first.lastActivityAt)).toBeGreaterThan(30_000);
    const background = await natural.context.newPage();
    await background.goto("data:text/html,<title>Another task</title><h1>Another task</h1>");
    await background.bringToFront();
    await expect.poll(() => preview.evaluate(() => document.visibilityState)).toBe("hidden");
    await expect.poll(() => signals.includes(false)).toBe(true);
    const hidden = await read();
    const traffic = await preview.evaluate(() => ({ polls: (window as unknown as { polls: number }).polls, frames: (window as unknown as { frames: number }).frames }));
    await expect.poll(async () => {
      const current = await read();
      expect(await preview.evaluate(() => document.visibilityState)).toBe("hidden");
      expect(current.lastActivityAt).toBe(hidden.lastActivityAt);
      return current.state;
    }, { timeout: 40_000, intervals: [1_000] }).toBe("sleeping");
    const after = await preview.evaluate(() => ({ polls: (window as unknown as { polls: number }).polls, frames: (window as unknown as { frames: number }).frames }));
    expect(after.polls).toBeGreaterThan(traffic.polls);
    expect(after.frames).toBeGreaterThan(traffic.frames);
    expect(await read()).toMatchObject({ stopReason: "idle", endpoints: [{ url }] });
    // Switching back runs the production visibility listener. No synthetic
    // activity request or model turn is used to wake the retained service.
    const priorSignals = signals.length;
    await preview.bringToFront();
    await expect.poll(() => preview.evaluate(() => document.visibilityState)).toBe("visible");
    await expect.poll(() => signals.slice(priorSignals).includes(true)).toBe(true);
    await expect.poll(async () => (await read()).state, { timeout: 30_000 }).toBe("ready");
    await preview.reload();
    await expect(preview.getByRole("heading", { name: "Visibility preview" })).toBeVisible();
    expect(preview.url()).toBe(`${url}/retained-route`);
    expect(await preview.evaluate(() => localStorage.getItem("retained"))).toBe("yes");
    await preview.screenshot({ path: testInfo.outputPath("returned-visible-preview.png"), fullPage: true });
    const proof = { serviceId: service.id, origin: url, browserHeadless: true, browserFocusEmulation: false, visibleSeconds: 45,
      hiddenActivityUnchanged: true, backgroundPolls: after.polls - traffic.polls, backgroundFrames: after.frames - traffic.frames,
      signals, sleptWhileHidden: true, becameVisibleAndWoke: true, retainedOriginPathAndStorage: true };
    const proofPath = testInfo.outputPath("hidden-preview.json");
    await fs.writeFile(proofPath, JSON.stringify(proof, null, 2));
    await testInfo.attach("hidden-preview", { path: proofPath, contentType: "application/json" });
  } finally { await natural.close(); }
}
