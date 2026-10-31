import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";

vi.mock("./plugin.js", async () => {
  const { NOOP_PLUGIN_TRACER } = await import("@paperclipai/plugin-sdk");
  return { getPluginTracer: () => NOOP_PLUGIN_TRACER };
});
import { performSyncOut } from "./file-sync.js";

// Fault only the archive's output sink. /dev/full gives real GNU tar ENOSPC
// without exhausting a shared provider host or changing the retained source.
it.skipIf(!process.env.DAYTONA_API_KEY)("preserves a stopped Daytona workspace after archive ENOSPC", async () => {
  const { Daytona } = await import("@daytonaio/sdk");
  const client = new Daytona({ apiKey: process.env.DAYTONA_API_KEY });
  const sandbox = await client.create({
    name: `archive-capacity-${randomUUID()}`, image: "ubuntu:24.04", user: "root",
    resources: { cpu: 1, memory: 1, disk: 1 }, autoStopInterval: 5,
  });
  const output = await fs.mkdtemp(path.join(os.tmpdir(), "daytona-capacity-live-"));
  const remote = "/tmp/archive-capacity-proof";
  try {
    const setup = await sandbox.process.executeCommand(
      `mkdir -p ${remote}/ignored && head -c 5242880 /dev/urandom > ${remote}/saved.bin && ` +
      `chmod 600 ${remote}/saved.bin && printf retained > ${remote}/.hidden && ` +
      `printf omitted > ${remote}/ignored/output && ln -s .hidden ${remote}/safe-link && ` +
      `ln -s /etc/passwd ${remote}/unsafe-link && sha256sum ${remote}/saved.bin`,
    );
    expect(setup.exitCode).toBe(0);
    const sourceDigest = setup.result.trim().split(/\s/)[0];
    // Recovery resumes the same stopped source before calling syncOut.
    await sandbox.stop();
    await sandbox.start();
    const execute = sandbox.process.executeCommand.bind(sandbox.process);
    const failures: string[] = [];
    sandbox.process.executeCommand = async (...args: Parameters<typeof execute>) => {
      if (args[0].includes("tar -c")) args[0] = args[0].replace(/\/tmp\/archive-capacity-proof\/\.paperclip-upload-[\w-]+\.tar/g, "/dev/full");
      const result = await execute(...args);
      if (result.exitCode !== 0) failures.push(result.result);
      return result;
    };
    let archiveRecoveries = 0;
    const sync = () => performSyncOut({
      sandbox, remoteDir: remote, timeoutSeconds: 120,
      onArchiveRecovery: () => { archiveRecoveries += 1; },
      operations: [{ operationId: "preserve", files: [{ sourcePath: remote, targetPath: output, kind: "directory", exclude: ["ignored"] }] }],
    });
    await sync();
    expect(failures.join("\n")).toMatch(/No space left on device|Wrote only \d+ of \d+ bytes/);
    expect(archiveRecoveries).toBe(1);
    const saved = await fs.readFile(path.join(output, "saved.bin"));
    expect(createHash("sha256").update(saved).digest("hex")).toBe(sourceDigest);
    expect((await fs.stat(path.join(output, "saved.bin"))).mode & 0o777).toBe(0o600);
    expect(await fs.readFile(path.join(output, "safe-link"), "utf8")).toBe("retained");
    expect(await fs.readdir(output)).toEqual(expect.arrayContaining([".hidden", "saved.bin", "safe-link"]));
    expect(await fs.readdir(output)).not.toEqual(expect.arrayContaining(["unsafe-link"]));
    expect(await fs.readdir(output)).not.toEqual(expect.arrayContaining(["ignored"]));
    const retained = await execute(`sha256sum ${remote}/saved.bin && readlink ${remote}/unsafe-link && find ${remote} -name '.paperclip-upload*'`);
    expect(retained.result.trim().split("\n")).toEqual([`${sourceDigest}  ${remote}/saved.bin`, "/etc/passwd"]);
    // Reconnect to the retained workspace and export a later saved result.
    await sandbox.stop();
    await sandbox.start();
    expect((await execute(`printf second > ${remote}/next.txt`)).exitCode).toBe(0);
    await sync();
    expect(await fs.readFile(path.join(output, "next.txt"), "utf8")).toBe("second");
    expect(createHash("sha256").update(await fs.readFile(path.join(output, "saved.bin"))).digest("hex")).toBe(sourceDigest);
    console.log("[archive-capacity-live] real Daytona stop/start, ENOSPC, bounded export, safe-link recovery, and second export passed");
  } finally {
    await sandbox.delete();
    await fs.rm(output, { recursive: true, force: true });
  }
}, 300_000);
