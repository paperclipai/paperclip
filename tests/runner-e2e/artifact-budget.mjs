import { constants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, mkdir, open, opendir, realpath, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const ARTIFACT_BOUNDS = Object.freeze({
  lock: 16 * 1024 * 1024,
  build: 1024 * 1024 * 1024,
  evidence: 256 * 1024 * 1024,
  report: 256 * 1024 * 1024,
  receipt: 8 * 1024 * 1024,
  entries: 4096,
});

export async function checkArtifactFiles(kind, files) {
  if (!["lock", "build"].includes(kind) || !files.length) throw new Error("Invalid artifact size check");
  let bytes = 0;
  for (const file of files) {
    const info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size === 0) throw new Error("Invalid artifact input file");
    bytes += info.size;
    if (!Number.isSafeInteger(bytes) || bytes > ARTIFACT_BOUNDS[kind]) throw new Error(`${kind} artifact exceeds its source-byte allowance`);
  }
  return { kind, files: files.length, sourceBytes: bytes, limitBytes: ARTIFACT_BOUNDS[kind] };
}

function priority(relative) {
  if (relative === "scheduled" || relative.startsWith("scheduled/")) return 0;
  if (/\.(json|jsonl)$/.test(relative)) return 1;
  if (/\.(md|html|xml|txt|log)$/.test(relative)) return 2;
  return 3;
}

export async function stageBoundedArtifact(kind, source, destination, bounds = ARTIFACT_BOUNDS) {
  if (!["evidence", "report"].includes(kind) || !Number.isSafeInteger(bounds[kind])
      || !Number.isSafeInteger(bounds.receipt) || bounds[kind] <= bounds.receipt
      || !Number.isSafeInteger(bounds.entries) || bounds.entries < 1 || bounds.entries > ARTIFACT_BOUNDS.entries) {
    throw new Error("Invalid artifact staging allowance");
  }
  const root = path.resolve(source), out = path.resolve(destination);
  if (out === root || out.startsWith(`${root}${path.sep}`) || root.startsWith(`${out}${path.sep}`)) {
    throw new Error("Artifact staging paths must be separate");
  }
  await mkdir(out, { mode: 0o700 });
  const receipt = { version: 1, kind, sourceComplete: true, inventoryComplete: true,
    scope: "Artifact evidence; regular playwright-output/.last-run.json bookkeeping is excluded",
    sourceBytes: 0, retainedBytes: 0, limitBytes: bounds[kind], entryLimit: bounds.entries,
    findings: [], files: [] };
  const candidates = [];
  let visited = 0;
  const finding = code => { receipt.sourceComplete = false; if (!receipt.findings.includes(code)) receipt.findings.push(code); };
  const skipped = (relative, reason, subtree = false) => {
    const shortened = relative.length > 512 || Buffer.byteLength(JSON.stringify(relative)) > 1024;
    receipt.files.push({ path: shortened ? `${relative.slice(0, 160)}…${relative.slice(-80)}` : relative,
      ...(shortened ? { pathTruncated: true, pathSha256: createHash("sha256").update(relative).digest("hex") } : {}),
      ...(subtree ? { scope: "subtree" } : {}), retained: false, reason });
  };
  const scan = async () => {
    const pending = [{ absolute: root, relative: ".", depth: 0, order: 0 }];
    while (pending.length) {
      pending.sort((a, b) => a.order - b.order || a.depth - b.depth || a.relative.localeCompare(b.relative));
      const directory = pending.shift();
      if (visited >= bounds.entries || directory.depth > 24) {
        const reason = visited >= bounds.entries ? "entry_limit" : "directory_depth_limit";
        receipt.inventoryComplete = false; finding(reason); skipped(directory.relative, reason, true); continue;
      }
      try {
        const handle = await opendir(directory.absolute);
        for await (const entry of handle) {
          if (visited >= bounds.entries) {
            receipt.inventoryComplete = false; finding("entry_limit"); skipped(directory.relative, "entry_limit", true); break;
          }
          visited++;
          const absolute = path.join(directory.absolute, entry.name), relative = path.relative(root, absolute).split(path.sep).join("/");
          if (relative.length > 512 || Buffer.byteLength(JSON.stringify(relative)) > 1024) {
            receipt.inventoryComplete = false; finding("path_length_limit"); skipped(relative, "path_length_limit", entry.isDirectory()); continue;
          }
          if (entry.isFile() && /(?:^|\/)playwright-output\/\.last-run\.json$/.test(relative)) {
            skipped(relative, "playwright_bookkeeping_excluded"); continue;
          }
          if (entry.name.startsWith(".")) {
            receipt.inventoryComplete = false; finding("hidden_path_excluded"); skipped(relative, "hidden_path_excluded", entry.isDirectory()); continue;
          }
          if (entry.isDirectory()) {
            const diagnostic = /(?:^|\/)(?:blob-report|html-report|playwright-output)(?:\/|$)/.test(relative);
            pending.push({ absolute, relative, depth: directory.depth + 1,
              order: diagnostic ? 3 : relative === "scheduled" || relative.startsWith("scheduled/") ? 0 : 1 });
          } else if (entry.isFile()) candidates.push({ absolute, relative });
          else { finding("non_regular_file"); skipped(relative, "non_regular_file"); }
        }
      } catch { receipt.inventoryComplete = false; finding("inventory_failed"); skipped(directory.relative, "inventory_failed", true); }
    }
  };
  try {
    const metadata = await lstat(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error("Invalid evidence root");
    await scan();
  } catch { receipt.inventoryComplete = false; finding("inventory_failed"); skipped(".", "inventory_failed", true); }
  const canonicalRoot = await realpath(root).catch(() => root);
  candidates.sort((a, b) => priority(a.relative) - priority(b.relative) || a.relative.localeCompare(b.relative));
  for (const { absolute, relative } of candidates) {
    let input, output;
    const target = path.join(out, relative);
    const row = { path: relative, retained: false };
    receipt.files.push(row);
    try {
      if (relative === "artifact-budget-receipt.json") throw new Error("reserved_path");
      const canonical = await realpath(absolute);
      if (!canonical.startsWith(`${canonicalRoot}${path.sep}`)) throw new Error("source_escaped");
      input = await open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW);
      const before = await input.stat();
      if (!before.isFile()) throw new Error("non_regular_file");
      row.sourceBytes = before.size;
      receipt.sourceBytes += before.size;
      if (!Number.isSafeInteger(receipt.sourceBytes)) throw new Error("source_size_overflow");
      if (receipt.retainedBytes + before.size > bounds[kind] - bounds.receipt) throw new Error("byte_limit");
      await mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      output = await open(target, "wx", 0o600);
      const buffer = Buffer.alloc(64 * 1024), hash = createHash("sha256");
      let copied = 0;
      while (copied < before.size) {
        const read = await input.read(buffer, 0, Math.min(buffer.length, before.size - copied), copied);
        if (!read.bytesRead) throw new Error("source_changed");
        hash.update(buffer.subarray(0, read.bytesRead));
        let written = 0;
        while (written < read.bytesRead) {
          const part = await output.write(buffer, written, read.bytesRead - written, copied + written);
          if (!part.bytesWritten) throw new Error("copy_failed");
          written += part.bytesWritten;
        }
        copied += read.bytesRead;
      }
      const after = await input.stat();
      if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error("source_changed");
      await output.sync();
      row.retained = true; row.sha256 = hash.digest("hex");
      receipt.retainedBytes += copied;
    } catch (error) {
      const code = ["reserved_path", "source_escaped", "non_regular_file", "source_size_overflow", "byte_limit", "source_changed"].includes(error.message) ? error.message : "copy_failed";
      row.reason = code; finding(code);
    } finally {
      await input?.close(); await output?.close();
      if (!row.retained) await rm(target, { force: true });
    }
  }
  const serialized = `${JSON.stringify(receipt, null, 2)}\n`;
  if (Buffer.byteLength(serialized) > bounds.receipt) throw new Error("Artifact receipt exceeds reserved allowance");
  await writeFile(path.join(out, "artifact-budget-receipt.json"), serialized, { mode: 0o600, flag: "wx" });
  return { ...receipt, stagedBytes: receipt.retainedBytes + Buffer.byteLength(serialized) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [command, kind, ...args] = process.argv.slice(2);
  if (command === "check") console.log(JSON.stringify(await checkArtifactFiles(kind, args)));
  else if (command === "stage" && args.length === 2) {
    const receipt = await stageBoundedArtifact(kind, args[0], args[1]);
    if (process.env.GITHUB_OUTPUT) await writeFile(process.env.GITHUB_OUTPUT, `complete=${receipt.sourceComplete}\n`, { flag: "a" });
    const summary = `Eval ${kind}: retained ${receipt.retainedBytes} source bytes; staged ${receipt.stagedBytes} bytes; complete=${receipt.sourceComplete}. Findings: ${receipt.findings.join(", ") || "none"}.`;
    if (process.env.GITHUB_STEP_SUMMARY) await writeFile(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`, { flag: "a" });
    console.log(summary);
  } else throw new Error("Usage: artifact-budget.mjs check <lock|build> <files...> | stage <evidence|report> <source> <destination>");
}
