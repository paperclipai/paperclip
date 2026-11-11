import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, mkdir, readdir, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

/** Records which Playwright output files were dropped because the per-cell HTML
 * report already holds the identical bytes. It names paths and digests only. */
export const PRIVATE_REPORT_COPIES_RECEIPT = "snapshots/playwright-output-copies.json";

export interface DroppedReportCopy { path: string; keptAt: string; bytes: number; sha256: string }

const outputDirectory = "playwright-output";
const dataDirectory = "html-report/data";
const entryAllowance = 4096;
const depthAllowance = 16;
// The JSON framework reporter registers playwright-output attachments by path;
// those trees have no HTML report copy and must stay untouched.
const frameworkReports = ["framework-report.json", "snapshots/playwright-framework.json"];

async function entry(file: string) {
  return lstat(file).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
}

async function digests(file: string) {
  const sha1 = createHash("sha1"), sha256 = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file, { flags: "r" }) as AsyncIterable<Buffer>) {
    sha1.update(chunk); sha256.update(chunk); bytes += chunk.length;
  }
  return { sha1: sha1.digest("hex"), sha256: sha256.digest("hex"), bytes };
}

/**
 * Playwright's HTML reporter copies every test attachment, including the failure
 * trace and video, into html-report/data/<sha1 of content><extension>. The same
 * bytes also stay in playwright-output, so a retained failure stores its largest
 * files twice before the blob report adds a third (compressed) copy.
 *
 * This removes a playwright-output file only when the HTML report holds an
 * independently verified, byte-identical regular file under the content-derived
 * name. The HTML report and its trace viewer keep working, the blob report is
 * untouched, and every remaining file still passes the normal packaging,
 * sealing and transfer checks. Anything unexpected leaves the file in place.
 */
export async function dropDuplicatePlaywrightOutput(cellDirectory: string): Promise<DroppedReportCopy[]> {
  const root = await realpath(cellDirectory);
  const rootInfo = await lstat(cellDirectory);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink() || root !== path.resolve(cellDirectory))
    throw new Error("Invalid private report cell directory");
  for (const relative of frameworkReports) if (await entry(path.join(root, relative))) return [];
  const output = path.join(root, outputDirectory), data = path.join(root, dataDirectory);
  for (const directory of [output, path.join(root, "html-report"), data]) {
    const info = await entry(directory);
    if (!info || !info.isDirectory() || info.isSymbolicLink()) return [];
  }
  const dropped: DroppedReportCopy[] = [];
  let visited = 0;
  async function visit(relative: string, depth: number): Promise<boolean> {
    if (depth > depthAllowance) return false;
    const directory = path.join(root, relative);
    let remaining = 0;
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (++visited > entryAllowance) throw new Error("Playwright output exceeds entry allowance");
      const name = `${relative}/${item.name}`, file = path.join(root, name);
      if (item.isDirectory() && !item.isSymbolicLink()) {
        if (await visit(name, depth + 1)) await rmdir(file); else remaining++;
        continue;
      }
      remaining++;
      if (!item.isFile() || item.isSymbolicLink()) continue;
      const before = await lstat(file);
      if (!before.isFile() || before.isSymbolicLink() || before.size === 0) continue;
      const extension = path.extname(item.name);
      if (!/^\.[A-Za-z0-9]{1,16}$/.test(extension)) continue;
      const source = await digests(file);
      const keptAt = `${dataDirectory}/${source.sha1}${extension}`, kept = path.join(root, keptAt);
      const keptInfo = await entry(kept);
      if (!keptInfo || !keptInfo.isFile() || keptInfo.isSymbolicLink() || keptInfo.size !== before.size || source.bytes !== before.size) continue;
      const copy = await digests(kept);
      const after = await lstat(file);
      if (copy.sha256 !== source.sha256 || copy.bytes !== source.bytes || after.ino !== before.ino
        || after.size !== before.size || after.mtimeMs !== before.mtimeMs) continue;
      await unlink(file);
      remaining--;
      dropped.push({ path: name, keptAt, bytes: source.bytes, sha256: source.sha256 });
    }
    return remaining === 0;
  }
  await visit(outputDirectory, 0);
  if (!dropped.length) return dropped;
  dropped.sort((a, b) => a.path.localeCompare(b.path));
  const receipt = path.join(root, PRIVATE_REPORT_COPIES_RECEIPT);
  await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
  await writeFile(receipt, `${JSON.stringify({ schema: "paperclip.private-report-copies/v1",
    meaning: "playwright-output files removed because html-report/data holds identical bytes", dropped }, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  return dropped;
}
