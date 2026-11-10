import { promises as fs } from "node:fs";
import path from "node:path";
import { classifyRecoveryEntry, cutoverStatus, recoveryKinds } from "./recovery-cutover-policy.mjs";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Inspect every ancestor: lstat on only the final component would follow an
// intermediate symlink. No directory/file names or OS errors enter the report.
async function directoryState(directory, io) {
  const parsed = path.parse(directory);
  let current = parsed.root;
  for (const part of directory.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try {
      const stat = await io.lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return "unsafe";
    } catch (error) {
      return error?.code === "ENOENT" ? "absent" : "unreadable";
    }
  }
  return "directory";
}

/** Read-only, bounded entry inventory. Run with producers stopped on the retained
 * volume. This is not an atomic snapshot and does not establish DB settlement.
 * io exists for deterministic fault tests; production uses the actual filesystem. */
export async function inventoryRecoveryFiles({ instanceRoot, orphanDirectory, maxEntries = 10_000 }, io = fs) {
  if (!path.isAbsolute(instanceRoot) || (orphanDirectory !== undefined && !path.isAbsolute(orphanDirectory))) {
    throw new Error("Recovery inventory requires absolute directories");
  }
  if (!Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > 100_000) {
    throw new Error("Entry limit must be between 1 and 100000");
  }
  const root = path.resolve(instanceRoot);
  const rootState = await directoryState(root, io);
  const directories = [path.join(root, "accounting-receipts"), path.join(root, "quota-credential-recovery"),
    orphanDirectory === undefined ? path.join(root, "data", "sandbox-orphan-cleanup") : path.resolve(orphanDirectory)];
  let remaining = maxEntries;
  const summaries = [];
  for (const [index, directory] of directories.entries()) {
    const summary = { kind: recoveryKinds[index], presence: "unknown", observedEntries: 0,
      unverifiedFiles: 0, unknownEntries: 0, readFailures: 0, complete: true, status: "unknown" };
    if (rootState !== "directory") {
      summary.complete = false;
    } else {
      const state = await directoryState(directory, io);
      if (state === "absent") summary.presence = "absent";
      else if (state !== "directory") {
        summary.unknownEntries++;
        summary.complete = false;
        if (state === "unreadable") summary.readFailures++;
      } else {
        summary.presence = "present";
        async function scan(target, depth) {
          let handle;
          try {
            handle = await io.opendir(target);
            while (true) {
              // Read one sentinel entry to distinguish exactly-at-limit from
              // truncated scans. The sentinel is not included in observed counts.
              const entry = await handle.read();
              if (entry === null) break;
              if (remaining === 0) { summary.complete = false; break; }
              remaining--;
              summary.observedEntries++;
              const entryKind = entry.isFile() ? "file"
                : entry.isDirectory() && uuid.test(entry.name) ? "company-directory" : "other";
              const classification = classifyRecoveryEntry(summary.kind, depth, entryKind);
              if (classification === "descend") {
                const child = path.join(target, entry.name);
                // Recheck the entry before traversing; never intentionally follow
                // links. Operators must quiesce writers for the snapshot to hold.
                if (await directoryState(child, io) !== "directory") {
                  summary.unknownEntries++;
                  summary.complete = false;
                } else await scan(child, depth + 1);
              } else summary[classification]++;
              if (!summary.complete && remaining === 0) break;
            }
          } catch {
            summary.readFailures++;
            summary.complete = false;
          } finally {
            if (handle) {
              try { await handle.close(); }
              catch { summary.readFailures++; summary.complete = false; }
            }
          }
        }
        await scan(directory, 0);
      }
    }
    summary.status = cutoverStatus(summary);
    summaries.push(summary);
  }
  return { schema: "paperclip/recovery-cutover-inventory/v1", status:
    summaries.some(s => s.status === "unknown") ? "unknown" : summaries.some(s => s.status === "blocked") ? "blocked" : "clear",
    instanceStatus: rootState, contentInspection: "none", counts: "observed-lower-bounds", maxEntries, directories: summaries };
}
