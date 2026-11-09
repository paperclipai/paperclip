import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
import { runnerE2EServerControlPaths } from "./harness-env.js";
import { redactText, sanitizeJson } from "./redaction.js";

export async function copySharedEvidence(privateRoot: string, casePrivateDir: string,
  temporaryRoot: string, secrets: readonly string[]) {
  for (const relative of [
    "server.log",
    "playwright.log",
    "junit.xml",
    "html-report",
    "blob-report",
    "playwright-output",
  ]) {
    await cp(
      path.join(privateRoot, relative),
      path.join(casePrivateDir, relative),
      { recursive: true, force: true },
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
  // The supervisor records each phase before it can fail. Copy its receipts
  // independently of the successful-restart acknowledgement before cleanup.
  const { controlDirectory } = runnerE2EServerControlPaths(temporaryRoot);
  const entries = await readdir(controlDirectory, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile() || !/^controller-outage-[A-Za-z0-9._:-]{1,200}\.json$/.test(entry.name)) continue;
    const raw = await readFile(path.join(controlDirectory, entry.name), "utf8");
    const snapshots = path.join(casePrivateDir, "snapshots", "controller-outages");
    await mkdir(snapshots, { recursive: true });
    let receipt: unknown;
    try { receipt = JSON.parse(raw); }
    catch {
      // Never include parser excerpts: they can quote private receipt bytes.
      receipt = { schema: "paperclip.e2e.controller-outage-parse-error/v1", source: entry.name,
        error: "invalid_json", byteLength: Buffer.byteLength(raw), sha256: createHash("sha256").update(raw).digest("hex") };
      await writeFile(path.join(snapshots, `${entry.name}.invalid.txt`), redactText(raw, secrets), { mode: 0o600 });
    }
    await writeFile(path.join(snapshots, entry.name), `${JSON.stringify(sanitizeJson(receipt, secrets), null, 2)}\n`, { mode: 0o600 });
  }
}
