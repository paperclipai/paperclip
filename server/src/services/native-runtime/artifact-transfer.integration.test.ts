import { randomUUID, createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, assets, companies, createDb, heartbeatRuns, issues, runnerApiResponseReservations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { PaperclipRunnerToolAuthority } from "./paperclip-runner-tool-authority.js";
import { SemanticToolOutcomeUnknownError } from "../../vendor/paperclip-runner/index.js";
import { createArtifactInstaller } from "./artifact-transfer.js";
import type { StorageService } from "../../storage/types.js";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { CodexAppServerDriver, createCodexTaskEnvelope, type CodexAppServerTransport, type CodexRpcServerRequest } from "@paperclipai/paperclip-runner";

type TestTransport = CodexAppServerTransport & { invoke(request: CodexRpcServerRequest): Promise<Record<string, unknown>> };
const { FakeCodexTransport } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/codex/codex-app-server-driver.test-support.ts", import.meta.url).href) as { FakeCodexTransport: new () => TestTransport };

const combinedRunner: Pick<CommandManagedRuntimeRunner, "execute"> = {
  execute: input => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, input.args, { cwd: input.cwd, env: { ...process.env, ...input.env }, stdio: "pipe" });
    let stdout = "";
    child.stdout.on("data", data => { stdout += data; });
    child.stderr.on("data", data => { stdout += data; });
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal, stdout, stderr: "", timedOut: false, pid: child.pid ?? null, startedAt: null }));
    child.stdin.on("error", () => {});
    child.stdin.end(input.stdin ?? "");
  }),
};

describe.skipIf(process.platform !== "linux")("native authenticated artifact installation", () => {
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("artifact-transfer-");
    db = createDb(temporary.connectionString);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  it("materializes all 388131 synthetic bytes without model transcription and verifies a retry", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), artifactId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Synthetic transfer", issuePrefix: `A${companyId.slice(0, 6)}` });
    await db.insert(agents).values({ id: agentId, companyId, name: "Transfer", role: "ceo", status: "active", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Transfer synthetic bytes", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", runtimeMode: "native", nativeIssueId: issueId, invocationSource: "assignment", triggerDetail: "system", contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const unit = Buffer.from('🧭é"\\\n\u0000 synthetic transfer\n');
    const bytes = Buffer.concat([Buffer.concat(Array.from({ length: Math.floor(388131 / unit.length) }, () => unit)), Buffer.alloc(388131 % unit.length, 65)]);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const objectKey = `${companyId}/synthetic/${artifactId}`;
    await db.insert(assets).values({ id: artifactId, companyId, provider: "local_disk", objectKey, contentType: "application/octet-stream", byteSize: bytes.length, sha256, createdByAgentId: agentId });
    let storedBytes = bytes;
    let beforeRead: (() => Promise<void>) | undefined;
    const getObject = vi.fn(async () => { await beforeRead?.(); return { stream: Readable.from([storedBytes.subarray(0, 24576), storedBytes.subarray(24576)]) }; });
    const storage = { getObject } as unknown as StorageService;
    const root = await mkdtemp(join(tmpdir(), "native-artifact-transfer-"));
    try {
      const authority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId, workspaceRoot: root, storage, apiToolsEnabled: true });
      expect(authority.definitions().some(tool => tool.name === "download_artifact")).toBe(true);
      const call = { tool: "download_artifact", callId: "synthetic-install", arguments: { artifactId, destination: "synthetic.bin", byteSize: bytes.length, sha256 } };
      const result = await authority.execute(call);
      expect(result).toMatchObject({ outcome: "completed", byteSize: 388131, sha256, destination: "synthetic.bin" });
      const restored = await readFile(join(root, "synthetic.bin"));
      expect(restored.length).toBe(388131);
      expect(createHash("sha256").update(restored).digest("hex")).toBe(sha256);
      expect(restored.equals(bytes)).toBe(true);
      expect(await authority.execute({ ...call, callId: "retry-install" })).toMatchObject({ outcome: "completed", sha256 });
      expect(await authority.recover(call)).toMatchObject({ result: { outcome: "completed", sha256 } });
      expect(await authority.recover({ ...call, arguments: { ...call.arguments, destination: "missing.bin" } })).toMatchObject({ isError: true, result: { error: "artifact_install_missing" } });
      expect(await readdir(root)).toEqual(["synthetic.bin"]);
      let loseReceipt = true;
      const realInstaller = createArtifactInstaller(root);
      const remoteInstaller = vi.fn<ReturnType<typeof createArtifactInstaller>>(async input => {
        await realInstaller(input);
        if (loseReceipt && !input.verifyOnly) { loseReceipt = false; throw new SemanticToolOutcomeUnknownError("lost commit receipt"); }
      });
      const remoteAuthority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId, workspaceRoot: root, storage,
        executionTargetKind: "remote", installRemoteArtifact: remoteInstaller });
      const remoteCall = { ...call, arguments: { ...call.arguments, destination: "remote-synthetic.bin" } };
      await expect(remoteAuthority.execute(remoteCall)).rejects.toThrow("lost commit receipt");
      expect(await remoteAuthority.recover(remoteCall)).toMatchObject({ result: { outcome: "completed", sha256 } });
      expect(remoteInstaller).toHaveBeenCalledTimes(2);
      expect(remoteInstaller.mock.calls[1][0].verifyOnly).toBe(true);
      expect((await readFile(join(root, "remote-synthetic.bin"))).equals(bytes)).toBe(true);
      await rm(join(root, "remote-synthetic.bin"));

      const combinedAuthority = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId, workspaceRoot: root, storage,
        executionTargetKind: "remote", installRemoteArtifact: createArtifactInstaller(root, combinedRunner) });
      const transport = new FakeCodexTransport();
      const request = transport.request.bind(transport);
      transport.request = async (method, params) => {
        const response = await request(method, params);
        return method === "thread/start" || method === "thread/resume"
          ? { ...response, cwd: root, thread: { ...response.thread as Record<string, unknown>, cwd: root } }
          : response;
      };
      const session = await new CodexAppServerDriver({
        taskEnvelope: createCodexTaskEnvelope({ objective: "Download synthetic bytes", constraints: [] }),
        transportFactory: () => transport, dynamicTools: combinedAuthority.definitions(),
        dynamicToolHandler: call => combinedAuthority.execute(call),
      }).openSession({ runId, normalizedSessionId: randomUUID(), workingDirectory: root });
      try {
        await session.startTurn({ message: { role: "user", text: "Download synthetic bytes" } });
        const invoke = (callId: string) => transport.invoke({ id: callId, method: "item/tool/call", params: {
          threadId: "thread-1", turnId: "turn-1", callId, tool: "download_artifact",
          arguments: { ...call.arguments, destination: "combined.bin" },
        } });
        expect(await invoke("combined-install")).toMatchObject({ success: true });
        expect((await readFile(join(root, "combined.bin"))).equals(bytes)).toBe(true);
        expect(await invoke("combined-identical-retry")).toMatchObject({ success: true });
        await writeFile(join(root, "combined.bin"), "existing conflict");
        expect(await invoke("combined-conflict")).toMatchObject({ success: false,
          contentItems: [{ type: "inputText", text: "artifact_install_conflict" }] });
        expect(await readFile(join(root, "combined.bin"), "utf8")).toBe("existing conflict");
      } finally { await session.close({ reason: "synthetic verification complete" }); }
      await rm(join(root, "combined.bin"));
      expect(await readdir(root)).toEqual(["synthetic.bin"]);
      // Inputs with a different identity or without an available asset fail before storage.
      for (const arguments_ of [{ ...call.arguments, artifactId: randomUUID() }, { ...call.arguments, sha256: "0".repeat(64) }, { ...call.arguments, byteSize: 388130 }]) {
        getObject.mockClear();
        await expect(authority.execute({ ...call, arguments: arguments_ })).rejects.toThrow();
        expect(getObject).not.toHaveBeenCalled();
      }
      const foreignCompany = randomUUID(), foreignAsset = randomUUID();
      await db.insert(companies).values({ id: foreignCompany, name: "Foreign synthetic", issuePrefix: `F${foreignCompany.slice(0, 6)}` });
      await db.insert(assets).values({ id: foreignAsset, companyId: foreignCompany, provider: "local_disk", objectKey: `${foreignCompany}/synthetic/file`, contentType: "application/octet-stream", byteSize: bytes.length, sha256 });
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, artifactId: foreignAsset } })).rejects.toThrow("company");
      expect(getObject).not.toHaveBeenCalled();

      // The content-read ACL retains capture ownership, independently of company membership.
      const foreignRun = randomUUID(), foreignAgent = randomUUID(), privateAsset = randomUUID();
      await db.insert(agents).values({ id: foreignAgent, companyId, name: "Other", status: "active", adapterType: "paperclip_runner" });
      await db.insert(heartbeatRuns).values({ id: foreignRun, companyId, agentId: foreignAgent, status: "succeeded", invocationSource: "assignment", triggerDetail: "system" });
      await db.insert(assets).values({ id: privateAsset, companyId, provider: "local_disk", objectKey: `${companyId}/assets/runner-api/private`, contentType: "application/json", byteSize: bytes.length, sha256 });
      await db.insert(runnerApiResponseReservations).values({ companyId, runId: foreignRun, assetId: privateAsset, reservedBytes: bytes.length });
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, artifactId: privateAsset } })).rejects.toThrow("actor");
      expect(getObject).not.toHaveBeenCalled();
      await db.update(heartbeatRuns).set({ agentId, responsibleUserId: "other-synthetic-user" }).where(eq(heartbeatRuns.id, foreignRun));
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, artifactId: privateAsset } })).rejects.toThrow("actor");
      expect(getObject).not.toHaveBeenCalled();

      for (const binding of [{ workMode: "planning" as const }, { executionTargetKind: "remote" as const }, { firstPartyOnly: true }, { dotRuntime: true }, { museRuntime: true }, { apiToolsEnabled: false }]) {
        const restricted = new PaperclipRunnerToolAuthority(db, { companyId, agentId, issueId, runId, workspaceRoot: root, storage, ...binding });
        expect(restricted.definitions().some(tool => tool.name === "download_artifact")).toBe(false);
        await expect(restricted.execute(call)).rejects.toThrow();
      }
      storedBytes = bytes.subarray(0, bytes.length - 1);
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, destination: "truncated.bin" } })).rejects.toThrow("identity");
      storedBytes = bytes;
      beforeRead = async () => { await db.update(heartbeatRuns).set({ status: "cancelled" }).where(eq(heartbeatRuns.id, runId)); };
      await expect(authority.execute({ ...call, arguments: { ...call.arguments, destination: "revoked.bin" } })).rejects.toThrow("not_authorized");
      expect(await readdir(root)).toEqual(["synthetic.bin"]);

    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
