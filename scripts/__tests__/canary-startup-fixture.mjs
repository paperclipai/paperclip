import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// Exercise the real startup helper and child-process boundary without registry
// traffic. The npm fixture installs a real executable into its isolated prefix.
export async function canaryStartup({ mode, onboard = "success", budget = 5000, delay = 5, cancelAtKind, playwright = false }) {
  const root = mkdtempSync(path.join(os.tmpdir(), "canary-startup-test-"));
  const calls = path.join(root, "calls.jsonl");
  const fixtureBin = path.join(root, "bin");
  mkdirSync(fixtureBin);
  const npmFixture = path.join(fixtureBin, "npm");
  const port = await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => { const port = server.address().port; server.close(() => resolve(port)); });
  });
  const cli = `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({kind:"onboard", pid:process.pid, args:process.argv.slice(2)}) + "\\n");
if (process.env.FIXTURE_ONBOARD === "fail") { console.error("npm error code ETARGET"); process.exit(17); }
if (process.env.FIXTURE_ONBOARD === "hang") { setTimeout(() => {}, 10000); }
if (process.env.FIXTURE_ONBOARD === "serve") {
 const { spawn } = require("node:child_process");
 const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{}); setTimeout(()=>process.exit(0),10000)"], {stdio:"ignore"});
 appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({kind:"descendant", pid:child.pid}) + "\\n");
 process.on("SIGTERM", () => {});
 setTimeout(() => process.exit(0), 10000);
 require("node:http").createServer((req,res) => {res.end("ok");}).listen(Number(process.env.FIXTURE_PORT), "127.0.0.1");
}
`;
  writeFileSync(npmFixture, `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const args = process.argv.slice(2);
const entries = fs.existsSync(process.env.FIXTURE_CALLS) ? fs.readFileSync(process.env.FIXTURE_CALLS, "utf8").trim().split("\\n").filter(Boolean).map(JSON.parse) : [];
const attempt = entries.filter(e => e.kind === "npm").length + 1;
fs.appendFileSync(process.env.FIXTURE_CALLS, JSON.stringify({kind:"npm", pid:process.pid, args, cache:process.env.npm_config_cache}) + "\\n");
const mode = process.env.FIXTURE_MODE;
if (mode === "hang") { setTimeout(() => {}, 10000); }
else if (mode === "permanent" || (mode === "recover" && attempt === 1)) { console.error("npm error code ETARGET"); process.exit(1); }
else if (mode === "auth") { console.error("npm error code E401"); process.exit(1); }
else if (mode === "mixed") { console.error("npm error code ETARGET\\nnpm error code E401"); process.exit(1); }
else if (mode === "network") { console.error("npm error code ECONNRESET"); process.exit(1); }
else {
 const prefix = args[args.indexOf("--prefix") + 1];
 const bin = path.join(prefix, "node_modules", ".bin");
 fs.mkdirSync(bin, {recursive:true});
 fs.writeFileSync(path.join(bin, "paperclipai"), ${JSON.stringify(cli).replaceAll('$','\$')});
 fs.chmodSync(path.join(bin, "paperclipai"), 0o755);
}
`);
  chmodSync(npmFixture, 0o755);
  const helper = new URL("../../tests/canary-onboarding/start-published-canary.mjs", import.meta.url).href;
  const driver = path.join(root, "driver.mjs");
  writeFileSync(driver, `import { startPublishedCanary } from ${JSON.stringify(helper)};
try { await startPublishedCanary({version:"2026.1009.0-canary.1", workspace:${JSON.stringify(root)}, dataDir:${JSON.stringify(path.join(root,"data"))}, installBudgetMs:${budget}, retryDelayMs:${delay}}); }
catch (error) { console.error(error.message); process.exitCode = 1; }
`);
  const playwrightConfig = path.join(root, "playwright.config.mjs");
  if (playwright) {
    const originalConfig = path.join(repoRoot, "tests/canary-onboarding/playwright.config.ts");
    const testApi = new URL("../../node_modules/@playwright/test/index.mjs", import.meta.url).href;
    writeFileSync(path.join(root,"fixture.spec.mjs"), `import { test } from ${JSON.stringify(testApi)}; test("fixture", async()=>{});`);
    writeFileSync(playwrightConfig, `import original from ${JSON.stringify(originalConfig)};
export default {...original, testDir:${JSON.stringify(root)}, testMatch:"fixture.spec.mjs", reporter:"list", projects:[{name:"fixture"}], webServer:{...original.webServer, timeout:${mode === "hang" ? 2500 : 300000}}};`);
  }
  const started = Date.now();
  try {
    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, playwright
        ? [path.join(repoRoot, "node_modules/@playwright/test/cli.js"), "test", "--config", playwrightConfig]
        : cancelAtKind
          ? [fileURLToPath(helper), "2026.1009.0-canary.1", root, path.join(root, "data")]
          : [driver], { cwd: repoRoot, env: {
        ...process.env, PATH: fixtureBin + path.delimiter + process.env.PATH,
        FIXTURE_MODE: mode, FIXTURE_ONBOARD: onboard, FIXTURE_CALLS: calls, FIXTURE_PORT: String(port),
        PAPERCLIPAI_VERSION: "2026.1009.0-canary.1", PAPERCLIP_CANARY_SMOKE_BASE_URL: `http://127.0.0.1:${port}`, PAPERCLIP_CANARY_SMOKE_SERVER_LOG: path.join(root,"server.log"),
        npm_config_cache: path.join(root, "fresh-cache"),
      }, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      const cancellation = cancelAtKind && setInterval(() => {
        if (!existsSync(calls)) return;
        const rows = readFileSync(calls, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
        if (rows.some(row => row.kind === cancelAtKind)) {
          clearInterval(cancellation);
          child.kill("SIGTERM");
        }
      }, 10);
      child.stdout.on("data", (data) => { output += data; });
      child.stderr.on("data", (data) => { output += data; });
      child.on("error", reject);
      child.on("close", (code) => { clearInterval(cancellation); resolve({code, output}); });
    });
    if (playwright && existsSync(path.join(root,"server.log"))) result.output += readFileSync(path.join(root,"server.log"), "utf8");
    const records = existsSync(calls) ? readFileSync(calls,"utf8").trim().split("\n").filter(Boolean).map(JSON.parse) : [];
    const prefixes = records.filter(call => call.kind === "npm").map(call => call.args[call.args.indexOf("--prefix") + 1]);
    if (playwright) {
      const deadline = Date.now() + 2000;
      while (prefixes.some(prefix => existsSync(prefix)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    assert.deepEqual(prefixes.filter(prefix => existsSync(prefix)), [], "helper-owned install prefixes must be removed");
    return { ...result, elapsed: Date.now()-started, calls: records };

  } finally { rmSync(root, {recursive:true, force:true}); }
}
