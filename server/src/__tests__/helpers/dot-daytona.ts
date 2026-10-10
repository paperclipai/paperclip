import { createRequire } from "node:module";
import { createHash, randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { shellQuote } from "@paperclipai/adapter-utils/ssh";

/** Opt-in, bounded live fixture. Every invocation owns and deletes its sandbox. */
export async function startDotDaytona(localRoot: string) {
  const image = process.env.PAPERCLIP_DOT_DAYTONA_IMAGE;
  if (!image || !/@sha256:[a-f0-9]{64}$/.test(image)) throw new Error("Dot live tests require an immutable Daytona image digest");
  const require = createRequire(new URL("../../../../packages/plugins/sandbox-providers/daytona/package.json", import.meta.url));
  const { Daytona } = require("@daytonaio/sdk");
  const sandbox = await new Daytona({ apiKey: process.env.DAYTONA_API_KEY }).create({
    image, public: false, autoStopInterval: 10, ttlMinutes: 20,
    labels: { "paperclip-test": "dot-managed-runner" },
  }, { timeout: 180 });
  const workspace = "/home/daytona/dot-managed-test";
  const executeSource = `
    const {spawn} = require('node:child_process');
    const input = JSON.parse(process.argv[1]);
    const child = spawn(input.command, input.args || [], {
      cwd: input.cwd, env: {...process.env, ...input.env}, timeout: input.timeoutMs || 30000
    });
    const stdout = [], stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.on('error', error => stderr.push(Buffer.from(error.message)));
    child.on('close', (exitCode, signal) => process.stdout.write(JSON.stringify({
      exitCode, signal, timedOut: signal === 'SIGTERM', pid: null,
      startedAt: new Date().toISOString(),
      stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString()
    })));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stderr.push(Buffer.from(error.message)); });
    child.stdin.end(input.stdin || '');
  `;
  const runner: CommandManagedRuntimeRunner = {
    execute: async input => {
      const command = `node --input-type=commonjs -e ${shellQuote(executeSource)} ${shellQuote(JSON.stringify(input))}`;
      const result = await sandbox.process.executeCommand(command, undefined, undefined, Math.ceil((input.timeoutMs ?? 30000) / 1000) + 10);
      if (result.exitCode !== 0) throw new Error(`Daytona command transport failed (exit ${result.exitCode})`);
      return JSON.parse(result.result);
    },
    syncIn: async operations => {
      const results = [];
      for (const operation of operations) {
        let bytesTransferred = 0;
        for (const file of operation.files) {
          if (file.kind !== "file") throw new Error("Dot test stages only the verified runner artifact");
          await sandbox.fs.createFolder(dirname(file.targetPath), "700");
          const bytes = await readFile(file.sourcePath);
          await sandbox.fs.uploadFile(bytes, file.targetPath);
          await sandbox.fs.setFilePermissions(file.targetPath, { mode: (file.mode ?? 0o600).toString(8) });
          bytesTransferred += bytes.length;
        }
        results.push({ operationId: operation.operationId, filesTransferred: operation.files.length, bytesTransferred });
      }
      return { operations: results };
    },
  };
  try {
    const setup = await runner.execute({ command: "mkdir", args: ["-p", workspace], timeoutMs: 10000 });
    if (setup.exitCode !== 0) throw new Error("Daytona test workspace creation failed");
    const binary = process.env.PAPERCLIP_DOT_DAYTONA_RUNNER_BINARY
      ? await readFile(process.env.PAPERCLIP_DOT_DAYTONA_RUNNER_BINARY)
      : await sandbox.fs.downloadFile("/usr/local/bin/paperclip-runnerd");
    const runnerBinary = join(localRoot, "daytona-paperclip-runnerd");
    await writeFile(runnerBinary, binary, { mode: 0o700 });
    const qualificationBinary = join(workspace, "qualification-runnerd");
    await sandbox.fs.uploadFile(binary, qualificationBinary);
    await sandbox.fs.setFilePermissions(qualificationBinary, { mode: "700" });
    const metadata = await runner.execute({ command: qualificationBinary, args: ["--build-metadata"], timeoutMs: 10000 });
    if (metadata.exitCode !== 0) throw new Error("Daytona qualification runner build metadata missing");
    const evidence = { image, sandboxId: sandbox.id, binarySha256: createHash("sha256").update(binary).digest("hex"), metadata: JSON.parse(metadata.stdout) };
    const evidencePath = process.env.PAPERCLIP_DOT_DAYTONA_EVIDENCE;
    if (evidencePath) await writeFile(evidencePath, JSON.stringify(evidence, null, 2));
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: "daytona", environmentId: randomUUID(),
      leaseId: randomUUID(), remoteCwd: workspace, runner,
      effectiveCapabilities: { runnerWebSocketIngress: true } as AdapterSandboxExecutionTarget["effectiveCapabilities"],
      getRunnerIngressEndpoint: async ({ port, path }) => {
        const preview = await sandbox.getPreviewLink(port);
        const url = new URL(preview.url);
        url.protocol = "wss:";
        url.pathname = `${url.pathname.replace(/\/$/, "")}${path}`;
        return { kind: "authenticated_websocket", websocketUrl: url.toString(),
          secretHeaders: [{ name: "X-Daytona-Preview-Token", value: preview.token }],
          generation: "dot-test", refresh: () => target.getRunnerIngressEndpoint!({ leaseId: target.leaseId!, port, path }), close: async () => {} };
      },
    };
    return { target, runnerBinary, evidence, close: async () => {
      await sandbox.delete();
      if (evidencePath) await writeFile(evidencePath, JSON.stringify({ ...evidence, cleanup: "deleted" }, null, 2));
    } };
  } catch (error) { await sandbox.delete(); throw error; }
}
