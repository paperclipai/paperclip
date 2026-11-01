import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentialPath, mcpAccessToken, mcpResource, mcpRpc, replaceMcpCredential, withMcpCredentialLock } from "../client/mcp-auth.js";

const resource = "https://paperclip.example/mcp/paperclip";
let home: string;
beforeEach(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-credentials-")); vi.stubEnv("PAPERCLIP_HOME", home); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); await fs.rm(home, { recursive: true, force: true }); });
async function seed(value: unknown, mode = 0o600) {
  const file = credentialPath(resource);
  await fs.mkdir(path.dirname(file), { mode: 0o700 });
  await fs.writeFile(file, typeof value === "string" ? value : JSON.stringify(value), { mode });
  return file;
}
const stored = () => ({ resource, issuer: "https://paperclip.example", clientId: "client", companyId: "company", accessToken: "private-access", refreshToken: "private-refresh", expiresAt: 0 });
describe("MCP protected credential transport", () => {
  it("rejects noncanonical resources and isolates credential files by resource", () => {
    for (const url of ["http://evil.example/mcp/paperclip", resource + "?token=secret", resource + "#x", "https://u:p@paperclip.example/mcp/paperclip", "https://paperclip.example/other"]) expect(() => mcpResource(url)).toThrow();
    expect(mcpResource("http://127.0.0.1:3100/mcp/paperclip")).toContain("127.0.0.1");
    expect(credentialPath(resource)).not.toBe(credentialPath("https://other.example/mcp/paperclip"));
  });
  it("serializes rotating refreshes and persists only the replacement token privately", async () => {
    const file = await seed(stored()); let refreshes = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      if (url.includes("oauth-protected-resource")) return Response.json({ resource, authorization_servers: ["https://paperclip.example"] });
      if (url.includes("oauth-authorization-server")) return Response.json({ issuer: "https://paperclip.example", token_endpoint: "https://paperclip.example/mcp/oauth/token", device_authorization_endpoint: "https://paperclip.example/mcp/oauth/device_authorization", registration_endpoint: "https://paperclip.example/mcp/oauth/register" });
      expect(url).toBe("https://paperclip.example/mcp/oauth/token");
      expect(JSON.parse(init!.body as string).refresh_token).toBe("private-refresh"); refreshes++;
      return Response.json({ access_token: "replacement-access", refresh_token: "replacement-refresh", token_type: "Bearer", expires_in: 900 });
    }));
    expect(await Promise.all([mcpAccessToken(resource), mcpAccessToken(resource)])).toEqual(["replacement-access", "replacement-access"]);
    expect(refreshes).toBe(1);
    expect((await fs.stat(file)).mode & 0o077).toBe(0);
    expect(await fs.readFile(file, "utf8")).not.toContain("private-refresh");
  });
  it("never sends a stored credential to another issuer", async () => {
    await seed({ ...stored(), issuer: "https://evil.example" }); const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    await expect(mcpAccessToken(resource)).rejects.toThrow("Connect first"); expect(fetcher).not.toHaveBeenCalled();
  });
  it("fails closed when discovery changes without sending refresh credentials", async () => {
    await seed(stored()); const fetcher = vi.fn(async () => Response.json({ resource, authorization_servers: ["https://evil.example"] })); vi.stubGlobal("fetch", fetcher);
    await expect(mcpAccessToken(resource)).rejects.toThrow("does not match"); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects readable or malformed credential files without echoing secrets", async () => {
    const file = await seed(stored(), 0o644);
    await expect(mcpAccessToken(resource)).rejects.toThrow("private");
    await fs.chmod(file, 0o600); await fs.writeFile(file, '{private-secret');
    await expect(mcpAccessToken(resource)).rejects.toThrow("Invalid MCP credential file. Sign in again.");
  });
  it("does not expose upstream response text in protocol errors or retry writes", async () => {
    const fetcher = vi.fn(async () => new Response("private-upstream-token", { status: 200 })); vi.stubGlobal("fetch", fetcher);
    await expect(mcpRpc(resource, "private-access", "tools/call", { name: "paperclip_create_task" })).rejects.toThrow("invalid response");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("releases the refresh mutex after failed work", async () => {
    const file = credentialPath(resource);
    await expect(withMcpCredentialLock(file, async () => { throw new Error("failed"); })).rejects.toThrow("failed");
    await expect(withMcpCredentialLock(file, async () => "recovered")).resolves.toBe("recovered");
  });
  it("recovers an OS mutex after its owner is killed without a stale-file takeover", async () => {
    const file = await seed(stored());
    await fs.writeFile(file + ".mutex.sqlite", "", { mode: 0o600 });
    const child = spawn(process.execPath, ["--input-type=module", "-e", 'import {DatabaseSync} from "node:sqlite"; const db=new DatabaseSync(process.argv[1]); db.exec("BEGIN IMMEDIATE"); console.log("locked"); setInterval(()=>{},1000);', file + ".mutex.sqlite"], { stdio: ["ignore", "pipe", "pipe"] });
    try {
      await once(child.stdout!, "data");
      let entered = false;
      const next = withMcpCredentialLock(file, async () => { entered = true; return "recovered"; });
      await new Promise(resolve => setTimeout(resolve, 150));
      expect(entered).toBe(false);
      const exit = once(child, "exit"); child.kill("SIGKILL"); await exit;
      await expect(next).resolves.toBe("recovered");
    } finally { child.kill("SIGKILL"); }
  });
  it("preserves a working connection when replacement storage fails", async () => {
    const file = await seed(stored());
    const fetcher = vi.fn(); vi.stubGlobal("fetch", fetcher);
    vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("disk failure"));
    await expect(replaceMcpCredential(file, { ...stored(), accessToken: "new-access" }, vi.fn())).rejects.toThrow("disk failure");
    expect(JSON.parse(await fs.readFile(file, "utf8")).accessToken).toBe("private-access");
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("keeps the OS lock held while a same-process caller waits", async () => {
    const file = await seed(stored());
    let release!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const first = withMcpCredentialLock(file, async () => { entered(); await held; });
    await ready;
    let secondEntered = false;
    const second = withMcpCredentialLock(file, async () => { secondEntered = true; });
    try {
      await new Promise(resolve => setTimeout(resolve, 100));
      const probe = spawnSync(process.execPath, ["--input-type=module", "-e", 'import{DatabaseSync}from"node:sqlite";const db=new DatabaseSync(process.argv[1]);try{db.exec("BEGIN IMMEDIATE");process.exitCode=0}catch(e){process.exitCode=e.errcode===5?5:1}finally{db.close()}', file + ".mutex.sqlite"]);
      expect(probe.status).toBe(5);
      expect(secondEntered).toBe(false);
    } finally { release(); await Promise.all([first, second]); }
  });
  it("retains the new saved credential and reports failed previous-grant cleanup", async () => {
    const file = await seed(stored()); const notify = vi.fn();
    vi.stubGlobal("fetch", vi.fn(async () => {
      expect(JSON.parse(await fs.readFile(file, "utf8")).accessToken).toBe("new-access");
      return new Response(null, { status: 503 });
    }));
    await replaceMcpCredential(file, { ...stored(), accessToken: "new-access" }, notify);
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("revoke it in Paperclip Connections"));
  });
});
