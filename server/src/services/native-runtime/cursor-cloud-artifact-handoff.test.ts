import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { lstat, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readVerifiedWorkspaceFile, type NativeRunnerFileHandoffInput } from "./native-runner-file-handoff.js";

const { stageCursorCloudArtifact } = await import(new URL("../../../../packages/paperclip-runner/src/drivers/cursor-cloud/artifact-delivery.ts", import.meta.url).href);

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "cursor-cloud-handoff-"));
  roots.push(root);
  const artifactRoot = join(root, "artifacts");
  const body = Buffer.from("verified cloud artifact\n");
  const args = {
    contentRef: "cursor-artifact:artifacts/result.txt", filename: "result.txt",
    title: "Cloud result", contentType: "text/plain", byteSize: body.length,
    sha256: createHash("sha256").update(body).digest("hex"),
  };
  const stage = () => stageCursorCloudArtifact({
    arguments: args, agentId: "owned-agent", runtimeDirectory: root, artifactRoot,
    client: {
      listArtifacts: async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: body.length, updatedAt: "2026-10-28" }] }),
      downloadArtifact: async () => body,
    },
    signal: new AbortController().signal,
  });
  const binding = {
    companyId: "company", issueId: "issue", runId: "run", agentId: "agent",
    workspaceRoot: artifactRoot, executionTargetKind: "local" as const,
  };
  return { root, artifactRoot, args, binding, body, stage };
}

describe("Cursor Cloud staged artifact to Core handoff", () => {
  it("lets Core independently verify fresh and repeated provider staging", async () => {
    const f = await fixture();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const staged = await f.stage();
      const verified = await readVerifiedWorkspaceFile(f.binding, staged as unknown as NativeRunnerFileHandoffInput);
      expect(verified).toEqual({ body: f.body, contentType: "text/plain", filename: "result.txt", sha256: f.args.sha256, title: "Cloud result" });
    }
  });

  it("recovers a crash after publication before alias removal through the unchanged verified reader", async () => {
    const f = await fixture();
    const target = join(f.artifactRoot, f.args.sha256, f.args.filename);
    const script = join(f.root, "crash-after-publication.mjs");
    await writeFile(script, `
      import fs from "node:fs/promises";
      import { syncBuiltinESMExports } from "node:module";
      const original = fs.link;
      fs.link = async (...args) => {
        await original(...args);
        if (String(args[1]) === ${JSON.stringify(target)}) {
          process.send("published-before-alias-removal");
          await new Promise(resolve => process.once("message", resolve));
        }
      };
      syncBuiltinESMExports();
      const { stageCursorCloudArtifact } = await import(${JSON.stringify(new URL("../../../../packages/paperclip-runner/src/drivers/cursor-cloud/artifact-delivery.ts", import.meta.url).href)});
      const bytes = Buffer.from(${JSON.stringify(f.body.toString("base64"))}, "base64");
      await stageCursorCloudArtifact({ arguments: ${JSON.stringify(f.args)}, agentId: "owned-agent", runtimeDirectory: ${JSON.stringify(f.root)}, artifactRoot: ${JSON.stringify(f.artifactRoot)},
        client: { listArtifacts: async () => ({ items: [{ path: "artifacts/result.txt", sizeBytes: bytes.length }] }), downloadArtifact: async () => bytes }, signal: new AbortController().signal });
      process.send("unexpected-completed");
    `, { mode: 0o600 });
    const child = spawn(process.execPath, ["--import", new URL("../../../../packages/paperclip-runner/node_modules/tsx/dist/loader.mjs", import.meta.url).pathname, script], { env: {}, stdio: ["ignore", "ignore", "pipe", "ipc"] });
    let stderr = ""; child.stderr?.on("data", bytes => { stderr = (stderr + bytes).slice(-4_096); });
    const exited = once(child, "exit");
    try {
      const message = await Promise.race([once(child, "message"), exited.then(() => { throw new Error(`publication crash fixture exited early: ${stderr}`); })]);
      expect(message[0]).toBe("published-before-alias-removal");
      expect((await lstat(target)).nlink).toBe(2);
      child.kill("SIGKILL"); expect(await exited).toEqual([null, "SIGKILL"]);
      const staged = await f.stage();
      const verified = await readVerifiedWorkspaceFile(f.binding, staged as unknown as NativeRunnerFileHandoffInput);
      expect(verified).toEqual({ body: f.body, contentType: "text/plain", filename: "result.txt", sha256: f.args.sha256, title: "Cloud result" });
      expect((await lstat(target)).nlink).toBe(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });

  it("keeps Core hash verification after provider staging", async () => {
    const f = await fixture();
    const staged = await f.stage();
    await writeFile(join(f.artifactRoot, f.args.sha256, "result.txt"), Buffer.alloc(f.body.length, 120));
    await expect(readVerifiedWorkspaceFile(f.binding, staged as unknown as NativeRunnerFileHandoffInput)).rejects.toThrow("paperclip_runner_file_handoff_hash_mismatch");
  });
});
