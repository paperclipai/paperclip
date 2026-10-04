import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, heartbeatRuns, issueAttachments, issueComments, issues, issueWorkProducts } from "@paperclipai/db";
import { startAdapterExecutionTargetPaperclipBridge, type AdapterSandboxExecutionTarget } from "@paperclipai/adapter-utils/execution-target";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { PaperclipRunnerToolAuthority } from "../services/native-runtime/paperclip-runner-tool-authority.js";
import { readVerifiedRemoteWorkspaceFile } from "../services/native-runtime/remote-deliverable-file.js";
import { startFileDeliveryDaytona } from "./helpers/file-delivery-daytona.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const liveDaytona = process.env.PAPERCLIP_FILE_DELIVERY_DAYTONA === "1";
const helper = path.resolve(import.meta.dirname, "../../../skills/paperclip/scripts/paperclip-upload-artifact.sh");
// A real PNG and a PDF with binary bytes in its comment exercise UTF-8 corruption.
const files = [
  { name: "猫 picture.png", type: "image/png", body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1sAAAAASUVORK5CYII=", "base64") },
  { name: "résumé report.pdf", type: "application/pdf", body: Buffer.concat([Buffer.from("%PDF-1.4\n%"), Buffer.from([255, 0, 128, 254]), Buffer.from("\n1 0 obj <</Type /Catalog>> endobj\n%%EOF\n")]) },
];

function localProcessRunner(): CommandManagedRuntimeRunner {
  return {
    execute: input => runChildProcess("file-delivery-test", input.command, input.args ?? [], {
      cwd: input.cwd ?? process.cwd(), env: input.env ?? {}, stdin: input.stdin,
      timeoutSec: (input.timeoutMs ?? 30_000) / 1000, graceSec: 1, onLog: async () => {},
    }),
    openDuplexChannel: async ({ command }) => {
      const child = spawn(command[0], command.slice(1), { stdio: ["pipe", "pipe", "pipe"] });
      child.stderr.resume();
      return {
        write: data => { child.stdin.write(data); },
        onData: listener => { child.stdout.on("data", listener); },
        onExit: listener => { child.once("exit", exitCode => listener({ exitCode })); },
        stop: () => { child.kill(); },
        close: async () => { child.stdin.end(); child.kill(); },
      };
    },
  };
}

describe(`durable file delivery (${liveDaytona ? "Daytona" : "local processes"})`, () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
  async function execution(localWorkspace: string) {
    const live = liveDaytona ? await startFileDeliveryDaytona() : null;
    const workspace = live?.workspace ?? localWorkspace;
    const runner = live?.runner ?? localProcessRunner();
    let closed = false;
    const close = async () => { if (closed) return; closed = true; await live?.close(); };
    cleanup.push(close);
    const run = async (command: string, args: string[], env: Record<string, string> = {}) => {
      const result = await runner.execute({ command, args, env, timeoutMs: 90_000 });
      expect(result.exitCode, result.stderr).toBe(0);
      return result.stdout;
    };
    const write = async (relative: string, body: Buffer) => {
      const destination = path.join(workspace, relative);
      await run("node", ["-e", "const fs=require('fs');fs.mkdirSync(require('path').dirname(process.argv[1]),{recursive:true});fs.writeFileSync(process.argv[1],Buffer.from(process.argv[2],'base64'))", destination, body.toString("base64")]);
      return destination;
    };
    const fetchFromWorkspace = async (url: string, headers: Record<string, string>) => {
      const output = await run("node", ["-e", "fetch(process.argv[1],{headers:JSON.parse(process.argv[2])}).then(async r=>console.log(JSON.stringify({status:r.status,body:Buffer.from(await r.arrayBuffer()).toString('base64')})))", url, JSON.stringify(headers)]);
      const response = JSON.parse(output);
      return new Response(Buffer.from(response.body, "base64"), { status: response.status });
    };
    return { workspace, runner, close, run, write, fetch: fetchFromWorkspace };
  }
  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-file-delivery-test-secret");
    server = await startRunnerApiTestServer();
  });
  afterAll(async () => { await server?.close(); vi.unstubAllEnvs(); });

  it.each([false, true])("runs the actual Bash helper with HTTP/2 enabled=%s", async duplex => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    await server.db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, fixture.agentId));
    await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, fixture.runId));
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "codex_local", fixture.runId)!;
    const remote = await execution(fixture.workspace);
    const installedHelper = await remote.write("paperclip-upload-artifact.sh", await readFile(helper));
    const target: AdapterSandboxExecutionTarget = {
      kind: "remote", transport: "sandbox", providerKey: liveDaytona ? "daytona" : "local-test", remoteCwd: remote.workspace,
      runner: remote.runner, timeoutMs: 30_000,
      effectiveCapabilities: {
        reusableLeases: false, nativeSyncIn: false, nativeSyncOut: false,
        persistentProcessSessions: false, independentControlCommands: false,
        incrementalSessionOutput: false, concurrentSyncOperations: false,
        duplexCommandStream: true, runnerWebSocketIngress: false,
      },
    };
    const bridge = await startAdapterExecutionTargetPaperclipBridge({
      runId: fixture.runId, target, runtimeRootDir: path.join(remote.workspace, ".runtime"),
      adapterKey: "codex", hostApiToken: token, hostApiUrl: server.apiUrl,
      enableSandboxDuplexBridge: duplex,
    });
    expect(bridge?.env.PAPERCLIP_API_BRIDGE_MODE).toBe(duplex ? "http2_v1" : "queue_v1");
    const env = { ...bridge!.env, PAPERCLIP_RUN_ID: fixture.runId,
      PAPERCLIP_COMPANY_ID: fixture.companyId, PAPERCLIP_TASK_ID: fixture.issueId,
      PAPERCLIP_HELPER_STATE_DIR: path.join(remote.workspace, ".helper-state") };
    const headers = { authorization: `Bearer ${bridge!.env.PAPERCLIP_API_KEY}` };
    const receipts: Array<{ attachment: { id: string; contentPath: string; downloadPath: string } }> = [];
    try {
      for (const file of files) {
        const local = await remote.write(file.name, file.body);
        const args = [installedHelper, local, "--content-type", file.type, "--title", file.name, "--chat-comment", "Requested files", "--output", "json"];
        const receipt = JSON.parse(await remote.run("bash", args, env));
        const duplicate = JSON.parse(await remote.run("bash", args, env));
        expect(duplicate.attachment.id).toBe(receipt.attachment.id);
        expect(duplicate.workProduct.id).toBe(receipt.workProduct.id);
        expect(duplicate.chatComment.id).toBe(receipt.chatComment.id);
        expect(receipt.attachment.originalFilename).toBe(file.name);
        expect(receipt.attachment.originatingRunId).toBe(fixture.runId);
        const download = await remote.fetch(bridge!.env.PAPERCLIP_API_URL + receipt.attachment.downloadPath, headers);
        expect(download.status).toBe(200);
        expect(Buffer.from(await download.arrayBuffer())).toEqual(file.body);
        receipts.push(receipt);
      }
      const foreign = await server.fixture();
      const denied = await remote.fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/${foreign.issueId}/attachments`, headers);
      expect(denied.status).toBe(404);
      const unauthorized = await remote.fetch(`${bridge!.env.PAPERCLIP_API_URL}/api/issues/${fixture.issueId}/attachments`, { authorization: "Bearer wrong-token" });
      expect(unauthorized.status).toBe(401);
      expect(await server.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.issueId))).toHaveLength(2);
      expect(await server.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId))).toHaveLength(2);
      expect(await server.db.select().from(issueComments).where(eq(issueComments.issueId, fixture.issueId))).toHaveLength(1);
    } finally { await bridge?.stop(); await remote.close(); }
    // The workspace and runner are gone; a fresh request still reads persisted bytes.
    await rm(fixture.workspace, { recursive: true, force: true });
    for (const [index, receipt] of receipts.entries()) {
      const download = await fetch(server.apiUrl + receipt.attachment.contentPath, { headers: { authorization: `Bearer ${token}` } });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(files[index].body);
    }
  }, liveDaytona ? 240_000 : 60_000);

  it("registers native files with API tools disabled and returns durable download receipts", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    const remote = await execution(fixture.workspace);
    const authority = new PaperclipRunnerToolAuthority(server.db, { ...fixture,
      workspaceRoot: remote.workspace, executionTargetKind: liveDaytona ? "remote" : "local",
      readRemoteWorkspaceFile: liveDaytona ? request => readVerifiedRemoteWorkspaceFile({ ...request, runner: remote.runner, workspaceRoot: remote.workspace }) : undefined,
    });
    expect(authority.definitions().some(definition => definition.name === "register_deliverable")).toBe(true);
    expect(authority.definitions().some(definition => definition.name === "api_post")).toBe(false);
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "paperclip_runner", fixture.runId)!;
    const receipts: Array<{ downloadPath: string }> = [];
    for (const file of files) {
      await remote.write(`out/${file.name}`, file.body);
      const call = { tool: "register_deliverable", callId: file.name, arguments: {
        contentRef: `out/${file.name}`, filename: file.name, contentType: file.type, byteSize: file.body.length,
        sha256: createHash("sha256").update(file.body).digest("hex"), title: file.name, idempotencyKey: file.name,
      } };
      const receipt = await authority.execute(call) as { attachmentId: string; contentPath: string; downloadPath: string; entityRefs: string[] };
      expect(receipt.attachmentId).toBe(receipt.entityRefs[0]);
      expect(await authority.execute(call)).toEqual(receipt);
      receipts.push(receipt);
    }
    await remote.close();
    await rm(fixture.workspace, { recursive: true, force: true });
    for (const [index, receipt] of receipts.entries()) {
      const download = await fetch(server.apiUrl + receipt.downloadPath, { headers: { authorization: `Bearer ${token}` } });
      expect(download.status).toBe(200);
      expect(Buffer.from(await download.arrayBuffer())).toEqual(files[index].body);
    }
    const rows = await server.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.issueId));
    expect(rows).toHaveLength(2);
    expect(rows.every(row => row.originatingRunId === fixture.runId && row.issueCommentId)).toBe(true);
    await server.db.update(issues).set({ executionRunId: null }).where(eq(issues.id, fixture.issueId));
    await expect(authority.execute({ tool: "register_deliverable", callId: "stale", arguments: {} })).rejects.toThrow();
  }, liveDaytona ? 240_000 : 15_000);
});
