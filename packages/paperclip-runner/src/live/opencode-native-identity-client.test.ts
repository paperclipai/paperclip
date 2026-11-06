import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { chmod, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { expect, it } from "vitest";
import { closedRejection, diagnosticChildEnvironment, identityCallIds, identityResponse } from "../../test-support/opencode-identity-script.js";

// No native resolution, lifecycle hooks, install, or subprocess runs on a Mac.
const linuxCi = process.platform === "linux" && process.env.GITHUB_ACTIONS === "true";
function signalGroup(pid: number | undefined, signal: NodeJS.Signals) {
  if (!pid) return;
  try { process.kill(-pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}
it.skipIf(!linuxCi)("attests real OpenCode client acceptance through runnerd, proxy and MCP without model inference", async () => {
  const { resolvePinnedOpenCodeCommand, QUALIFIED_OPENCODE_VERSION } = await import("../drivers/opencode/opencode-server-driver.js");
  const root = await mkdtemp(join(tmpdir(), "opencode-native-identity-"));
  const environment = diagnosticChildEnvironment(`${dirname(process.execPath)}:/usr/bin:/bin`);
  const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
  try {
    const executable = resolvePinnedOpenCodeCommand();
    const versionConfig = join(root, "version-config.json");
    await writeFile(versionConfig, JSON.stringify({ share: "disabled", autoupdate: false, plugin: [] }), { mode: 0o600 });
    const versionEnvironment = { ...environment, OPENCODE_CONFIG: versionConfig, OPENCODE_DISABLE_PROJECT_CONFIG: "true",
      OPENCODE_DISABLE_MODELS_FETCH: "true", OPENCODE_DISABLE_DEFAULT_PLUGINS: "true" };
    const version = execFileSync(executable, ["--version"], { env: versionEnvironment, encoding: "utf8", timeout: 10_000 }).trim();
    expect(version).toBe("1.18.34"); expect(version).toBe(QUALIFIED_OPENCODE_VERSION);
    const binarySha256 = hash(await readFile(executable));
    const node = join(root, "node"); await cp(process.execPath, node, { dereference: true }); await chmod(node, 0o500);
    const proxy = join(root, "opencode-app-server-proxy.cjs");
    const proxyBytes = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import { bundleVerifiedProviderEntrypoints } from "./scripts/build-verified-provider-entrypoints.mjs";
      const entry = (await bundleVerifiedProviderEntrypoints({ write: false })).find(value => value.entrypoint.name === "opencode-app-server-proxy");
      process.stdout.write(entry.verifiedResult.outputFiles[0].contents);
    `], { env: environment, maxBuffer: 16 * 1024 * 1024, timeout: 20_000 });
    await writeFile(proxy, proxyBytes, { mode: 0o500 });
    const counts: number[] = [];
    for (const negative of [false, true]) {
      const accepted = new Set<string>(); let negativeObserved = false, requests = 0, fixtureError = false;
      let justIssued: string | undefined;
      const rejections: ReturnType<typeof closedRejection>[] = [];
      const provider = createServer(async (request, response) => {
        let stage = "route", body: unknown;
        try {
          if (request.method !== "POST" || request.url !== "/v1/chat/completions" || ++requests > 12) throw new Error("diagnostic_route");
          stage = "body";
          let size = 0; const chunks: Buffer[] = [];
          for await (const chunk of request) { size += chunk.length; if (size > 1024 * 1024) throw new Error("diagnostic_body_bound"); chunks.push(chunk); }
          stage = "parse"; body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          stage = "script";
          const scripted = identityResponse(body, negative, justIssued);
          if (!scripted.auxiliary) justIssued = scripted.delta.tool_calls?.[0]?.id;
          for (const id of scripted.accepted) accepted.add(id);
          negativeObserved ||= scripted.negativeObserved;
          stage = "respond";
          if (scripted.auxiliary && (body as Record<string, unknown>).stream !== true) {
            response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify({ id: "synthetic-title",
              object: "chat.completion", created: 1, model: "protocol-diagnostic", choices: [{ index: 0,
                message: { role: "assistant", content: "Protocol diagnostic" }, finish_reason: "stop" }] }));
            return;
          }
          response.writeHead(200, { "Content-Type": "text/event-stream" });
          for (const [delta, finish_reason] of [[scripted.delta, null], [{}, scripted.finish]]) response.write(`data: ${JSON.stringify({
            id: "synthetic-diagnostic", object: "chat.completion.chunk", created: 1, model: "protocol-diagnostic", choices: [{ index: 0, delta, finish_reason }],
          })}\n\n`);
          response.end("data: [DONE]\n\n");
        } catch (error) {
          fixtureError = true;
          if (rejections.length < 13) rejections.push(closedRejection(error, stage, requests, body, justIssued));
          response.writeHead(400).end("diagnostic_fixture_rejected");
        }
      });
      provider.listen(0, "127.0.0.1"); await once(provider, "listening");
      let child: ReturnType<typeof spawn> | undefined;
      try {
        const address = provider.address(); if (!address || typeof address === "string") throw new Error("diagnostic_loopback_unavailable");
        const workspace = join(root, negative ? "negative" : "positive"); await mkdir(workspace);
        child = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"),
          resolve("test-support/opencode-native-identity-worker.ts"), JSON.stringify({ root: workspace, node, executable, proxy,
            providerUrl: `http://127.0.0.1:${address.port}/v1`, negative })], {
          env: { ...environment, PAPERCLIP_NATIVE_PROTOCOL_DIAGNOSTIC: "1" }, stdio: ["ignore", "pipe", "pipe"], detached: true,
        });
        let stdout = "";
        child.stdout!.on("data", chunk => { stdout = (stdout + chunk).slice(-8192); });
        // Consume but never print or retain native diagnostics or provider content.
        child.stderr!.on("data", () => {});
        let hardKill: ReturnType<typeof setTimeout> | undefined;
        const timer = setTimeout(() => { signalGroup(child?.pid, "SIGTERM"); hardKill = setTimeout(() => signalGroup(child?.pid, "SIGKILL"), 3000); }, 40_000);
        let code: number | null;
        try { [code] = await once(child, "exit") as [number | null]; } finally { clearTimeout(timer); if (hardKill) clearTimeout(hardKill); }
        const phase = negative ? "negative" : "positive";
        if (fixtureError) console.info(`OPENCODE_CLIENT_DIAGNOSTIC_REJECTION ${JSON.stringify({ phase, version, binarySha256, rejections })}`);
        const line = stdout.split("\n").find(value => value.startsWith("DIAGNOSTIC_RESULT "));
        if (!line) throw new Error("diagnostic_native_receipt_missing");
        const receipt = JSON.parse(line.slice("DIAGNOSTIC_RESULT ".length));
        const status = ["completed", "failed"].includes(receipt.status) ? receipt.status : "unknown";
        const terminalStatus = ["completed", "failed", "cancelled", "interrupted"].includes(receipt.terminalStatus) ? receipt.terminalStatus : "unknown";
        console.info(`OPENCODE_NATIVE_TERMINAL ${JSON.stringify({ phase, status, terminalStatus })}`);
        if (code !== 0) throw new Error("diagnostic_native_child_failed");
        expect(terminalStatus).toBe("completed");
        expect(receipt.status).toBe("completed"); expect(receipt.backendCalls).toBeGreaterThanOrEqual(1);
        expect(receipt.backendCalls).toBeLessThanOrEqual(5); expect(fixtureError).toBe(false);
        counts.push(receipt.backendCalls);
        if (negative) { expect(negativeObserved).toBe(true); expect(accepted.size).toBe(0); }
        else { expect([...accepted]).toEqual(identityCallIds); expect(negativeObserved).toBe(false); }
      } finally {
        if (child && child.exitCode === null) signalGroup(child.pid, "SIGTERM");
        provider.closeAllConnections(); await new Promise<void>(done => provider.close(() => done()));
      }
    }
    console.info(`OPENCODE_CLIENT_DIAGNOSTIC ${JSON.stringify({ version, binarySha256, proxySha256: hash(proxyBytes),
      platform: process.platform, acceptedLogicalIds: identityCallIds.length, negativeRejected: true, backendCalls: counts })}`);
  } finally { await rm(root, { recursive: true, force: true }); }
}, 120_000);
