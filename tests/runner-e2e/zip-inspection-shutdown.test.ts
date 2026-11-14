import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { inspectZip } from "./evidence.js";

it.skipIf(process.platform === "win32")("finishes a rejected ZIP scan even when the scanner ignores SIGTERM", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "zip-shutdown-"));
  const source = path.join(root, "report.zip");
  const executable = path.join(root, "unzip");
  const secret = "synthetic-zip-secret-928472";
  await writeFile(executable, `#!${process.execPath}
const fs = require('node:fs');
process.on('SIGTERM', () => {});
fs.writeFileSync(process.argv[3] + '.pid', String(process.pid));
process.stdout.write(${JSON.stringify(secret)});
setInterval(() => {}, 1000);
`);
  await chmod(executable, 0o700);
  vi.stubEnv("PATH", `${root}${path.delimiter}${process.env.PATH ?? ""}`);
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const scan = inspectZip(source, [secret]).then(result => { stopped = true; return result; });
  try {
    const result = await Promise.race([
      scan,
      new Promise<string>(resolve => { timer = setTimeout(() => resolve("scanner did not stop"), 2000); }),
    ]);
    expect(result).toBe("exact secret value");
  } finally {
    clearTimeout(timer);
    vi.unstubAllEnvs();
    const pid = Number(await readFile(`${source}.pid`, "utf8").catch(() => "0"));
    if (!stopped && pid > 0) {
      try { process.kill(pid, "SIGKILL"); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    }
    await scan;
    await rm(root, { recursive: true, force: true });
  }
});
