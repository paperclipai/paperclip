import { existsSync, promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { onNativeHarnessBackupChange } from "../native-harness-backup-expiration-notifications.js";
import { publishNativeHarnessBackup } from "./native-harness-backup-publication.js";

describe("native harness backup publication", () => {
  let backupRoot = "";
  let unsubscribe: (() => void) | undefined;
  afterEach(async () => {
    unsubscribe?.(); unsubscribe = undefined;
    if (backupRoot) await fs.rm(backupRoot, { recursive: true, force: true });
  });
  async function fixture() {
    backupRoot = await fs.mkdtemp(path.join(os.tmpdir(), "native-backup-publication-"));
    const current = path.join(backupRoot, "current"), pendingRoot = path.join(backupRoot, "pending");
    await fs.mkdir(current); await fs.mkdir(pendingRoot);
    await fs.writeFile(path.join(current, "manifest.json"), "saved");
    await fs.writeFile(path.join(pendingRoot, "manifest.json"), "replacement");
    return { db: {}, companyId: "company", scopeDigest: "scope", backupRoot, pendingRoot, current };
  }
  it("restores the existing backup when its lease stamp fails without publishing a false change", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    unsubscribe = onNativeHarnessBackupChange(input.db, change => changes.push(change));
    await expect(publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
      throw new Error("stamp transaction rejected");
    } })).rejects.toThrow("stamp transaction rejected");
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("saved");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]); expect(changes).toEqual([]);
  });
  it("publishes the completed replacement once and removes its predecessor", async () => {
    const input = await fixture(); const changes: unknown[] = [];
    const previous = path.join(backupRoot, "previous");
    for (const root of [input.current, previous]) {
      const skill = path.join(root, "skills", "immutable");
      await fs.mkdir(skill, { recursive: true });
      await fs.writeFile(path.join(skill, "SKILL.md"), "saved instructions", { mode: 0o444 });
      await fs.chmod(skill, 0o555);
    }
    unsubscribe = onNativeHarnessBackupChange(input.db, change => {
      expect(existsSync(previous)).toBe(false);
      changes.push(change);
    });
    await publishNativeHarnessBackup({ ...input, stamp: async current => {
      expect(changes).toEqual([]);
      expect(await fs.readFile(path.join(current, "manifest.json"), "utf8")).toBe("replacement");
    } });
    expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    expect(await fs.readdir(backupRoot)).toEqual(["current"]);
    expect(changes).toEqual([{ companyId: input.companyId, scopeDigest: input.scopeDigest }]);
  });
  it("serves an unrelated request while a retired backup is being removed", async () => {
    const input = await fixture();
    for (let index = 0; index < 40; index++) {
      const directory = path.join(input.current, `skill-${index}`);
      await fs.mkdir(directory);
      await Promise.all(Array.from({ length: 50 }, (_, file) =>
        fs.writeFile(path.join(directory, `file-${file}`), "retired instructions", { mode: 0o444 })));
      await fs.chmod(directory, 0o555);
    }
    let publishing = false;
    let probeReceived: (response: ServerResponse | null) => void;
    const probeReady = new Promise<ServerResponse | null>(resolve => { probeReceived = resolve; });
    const server = createServer((request, response) => {
      if (request.url === "/probe") { probeReceived(response); return; }
      response.end("ok");
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("HTTP probe did not start");
    const client = spawn(process.execPath, ["--input-type=module", "-e", `
      import { Agent, get } from "node:http";
      const agent = new Agent({ keepAlive: true });
      const request = path => new Promise((resolve, reject) => {
        get({ hostname: "127.0.0.1", port: Number(process.argv[1]), path, agent }, response => {
          response.resume();
          response.on("end", () => resolve(response.headers["x-publication-active"]));
        }).on("error", reject);
      });
      await request("/");
      process.send({ kind: "ready" });
      process.once("message", async () => {
        const active = await request("/probe");
        process.send({ kind: "result", active }, () => { agent.destroy(); process.disconnect(); });
      });
    `, String(address.port)], { stdio: ["ignore", "ignore", "inherit", "ipc"] });
    const message = (kind: string) => new Promise<{ active?: string }>((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error(`HTTP probe ${kind} timed out`)); }, 10_000);
      const received = (value: { kind?: string; active?: string }) => {
        if (value.kind === kind) { cleanup(); resolve(value); }
      };
      const failed = () => { cleanup(); reject(new Error(`HTTP probe exited before ${kind}`)); };
      const cleanup = () => {
        clearTimeout(timer); client.off("message", received); client.off("exit", failed); client.off("error", failed);
      };
      client.on("message", received); client.once("exit", failed); client.once("error", failed);
    });
    let publication: Promise<void> | undefined;
    try {
      await message("ready");
      const response = message("result");
      publishing = true;
      publication = publishNativeHarnessBackup({
        ...input,
        stamp: async () => {
          client.send({ kind: "probe" });
          const response = await probeReady;
          if (!response) return;
          setImmediate(() => {
            response.setHeader("x-publication-active", publishing ? "1" : "0");
            response.end("ok");
          });
        },
      }).finally(() => { publishing = false; });
      const result = await response;
      await publication;
      expect(result.active).toBe("1");
      expect(await fs.readdir(backupRoot)).toEqual(["current"]);
      expect(await fs.readFile(path.join(input.current, "manifest.json"), "utf8")).toBe("replacement");
    } finally {
      probeReceived!(null);
      try { await publication; }
      finally {
        client.kill();
        server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }
  }, 15_000);
});
