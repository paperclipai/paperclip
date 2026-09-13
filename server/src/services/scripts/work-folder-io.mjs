// Executed inside a sandbox using its existing Node runtime. No storage secrets
// or database credentials enter this process. Each command has bounded output.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";

const commandStartedAt = performance.now();
const remotePhases = [];
let performanceRequested = true;
const metrics = { droppedPhases: 0, executionMs: 0, scanMs: 0, listMs: 0, gitListMs: 0, hashMs: 0, readMs: 0, writeMs: 0, publishMs: 0,
  decodeMs: 0, encodeMs: 0, files: 0, bytes: 0, hashFiles: 0, hashBytes: 0, requestCount: 0 };
function measured(key, work) {
  if (!performanceRequested) return work();
  const startedAt = performance.now();
  try { return work(); } finally {
    const durationMs = performance.now() - startedAt;
    metrics[key] += durationMs;
    if (remotePhases.length < 256) remotePhases.push({ phase: key, startOffsetMs: startedAt - commandStartedAt, durationMs });
    else metrics.droppedPhases++;
  }
}
let input = measured("decodeMs", () => JSON.parse(Buffer.from(process.argv[1], "base64").toString("utf8")));
performanceRequested = input.performance === true;
function output(result) {
  const encoded = measured("encodeMs", () => JSON.stringify(result));
  metrics.executionMs = performance.now() - commandStartedAt;
  process.stdout.write(performanceRequested
    ? `{"workFolderPerformanceVersion":1,"result":${encoded},"performance":${JSON.stringify(metrics)},"remotePhases":${JSON.stringify(remotePhases)}}`
    : encoded);
}
const MAX_CHUNK = 256 * 1024;
const MAX_ENTRIES = 100_000;
function safeRelative(value) {
  if (typeof value !== "string" || !value || /[\\\x00-\x1f\x7f]/.test(value)
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe_path");
  return value;
}
// Hold every parent directory open while resolving its child. On Linux this
// uses procfs descriptor paths, so swapping a parent for a symlink cannot send
// an operation into another scope or a CLI credential directory.
function withParent(target, create, callback) {
  const resolved = path.resolve(target);
  const segments = resolved.split(path.sep).filter(Boolean);
  const name = segments.pop();
  if (!name) throw new Error("invalid_root");
  let current = path.parse(resolved).root;
  let fd = fs.openSync(current, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  try {
    for (const segment of segments) {
      const next = process.platform === "linux" ? `/proc/self/fd/${fd}/${segment}` : path.join(current, segment);
      if (create) {
        try { fs.mkdirSync(next, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
      }
      const stat = fs.lstatSync(next);
      if (stat.isSymbolicLink()) throw new Error("symlink_not_allowed");
      const child = fs.openSync(next, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
      fs.closeSync(fd); fd = child;
      current = path.join(current, segment);
    }
    return callback(process.platform === "linux" ? `/proc/self/fd/${fd}/${name}` : path.join(current, name), fd);
  } finally { fs.closeSync(fd); }
}
function checked(target, directory = false) {
  return withParent(target, false, (anchored) => {
    if (fs.lstatSync(anchored).isSymbolicLink()) throw new Error("symlink_not_allowed");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | (directory ? fs.constants.O_DIRECTORY : 0));
    const stat = fs.fstatSync(fd);
    if ((directory && !stat.isDirectory()) || (!directory && !stat.isFile())) { fs.closeSync(fd); throw new Error("unsupported_file"); }
    if (!directory && stat.nlink !== 1) { fs.closeSync(fd); throw new Error("hardlink_not_allowed"); }
    return fd;
  });
}
function children(target) {
  const fd = checked(target, true);
  try { return measured("listMs", () => fs.readdirSync(process.platform === "linux" ? `/proc/self/fd/${fd}` : target).sort()); }
  finally { fs.closeSync(fd); }
}
function checksum(target) {
  return measured("hashMs", () => {
    const fd = checked(target);
    try {
      const hash = createHash("sha256");
      const buffer = Buffer.alloc(MAX_CHUNK);
      let count;
      while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
        metrics.hashBytes += count; hash.update(buffer.subarray(0, count));
      }
      return hash.digest("hex");
    } finally { fs.closeSync(fd); metrics.hashFiles++; }
  });
}
function ensureDirectory(target) {
  withParent(target, false, (anchored) => {
    try { fs.mkdirSync(anchored, { mode: 0o700 }); } catch (error) { if (error.code !== "EEXIST") throw error; }
    if (fs.lstatSync(anchored).isSymbolicLink()) throw new Error("symlink_not_allowed");
    const fd = fs.openSync(anchored, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
    fs.closeSync(fd);
  });
}
function full(relative) { return path.join(input.root, safeRelative(relative)); }
function parents(relative) {
  const parts = safeRelative(relative).split("/");
  let current = input.root;
  for (const part of parts.slice(0, -1)) { current = path.join(current, part); ensureDirectory(current); }
}
function scan() {
  const results = [];
  function entry(relative) {
    if (relative.split("/").includes(".paperclip-runtime")) return;
    if (relative.startsWith(".git/") && relative.endsWith(".lock")) throw new Error("repository_write_in_progress");
    if (results.length >= MAX_ENTRIES) throw new Error("too_many_files");
    const target = full(relative);
    const stat = withParent(target, false, (anchored) => fs.lstatSync(anchored));
    if (stat.isSymbolicLink()) {
      if (!input.repository || relative.startsWith(".git/")) throw new Error("symlink_not_allowed");
      const linkTarget = withParent(target, false, (anchored) => fs.readlinkSync(anchored));
      const destination = path.resolve(path.dirname(full(relative)), linkTarget);
      if (path.isAbsolute(linkTarget) || !destination.startsWith(`${input.root}/`)
        || destination === `${input.root}/.git` || destination.startsWith(`${input.root}/.git/`)) throw new Error("symlink_outside_repository");
      try { if (!fs.realpathSync(target).startsWith(`${input.root}/`)) throw new Error("symlink_outside_repository"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      results.push({ path: relative, kind: "file", byteSize: Buffer.byteLength(linkTarget),
        sha256: createHash("sha256").update(linkTarget).digest("hex"), executable: false, linkTarget });
      return;
    }
    if (stat.isDirectory()) {
      const fd = checked(target, true); fs.closeSync(fd);
      results.push({ path: relative, kind: "directory", byteSize: 0, sha256: null, executable: false });
      for (const child of children(target)) entry(`${relative}/${child}`);
    } else if (stat.isFile()) {
      results.push({ path: relative, kind: "file", byteSize: stat.size, sha256: checksum(target), executable: Boolean(stat.mode & 0o111) });
    } else throw new Error("unsupported_file");
  }
  if (input.repository) {
    const gitDir = path.join(input.root, ".git");
    const fd = checked(gitDir, true); fs.closeSync(fd);
    if (fs.existsSync(path.join(gitDir, "objects/info/alternates"))) throw new Error("repository_is_not_independent");
    const files = measured("gitListMs", () => execFileSync("git", ["-C", input.root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 })).split("\0").filter(Boolean);
    for (const relative of [...new Set(files)].sort()) {
      // Git reports nested repositories with a trailing slash. Private runner
      // caches can contain them and must be excluded before path validation.
      if (relative.split("/").includes(".paperclip-runtime")) continue;
      try { fs.lstatSync(full(relative)); entry(relative); } catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    for (const name of children(gitDir)) {
      if (["config", "config.worktree", "hooks"].includes(name)) continue;
      if (name.endsWith(".lock")) throw new Error("repository_write_in_progress");
      entry(`.git/${name}`);
    }
  } else {
    for (const name of children(input.root)) entry(name);
  }
  return results.sort((a, b) => a.path.localeCompare(b.path));
}

function execute(request) {
input = request;
metrics.requestCount++;
let result;
if (input.operation === "home") {
  result = { home: os.homedir() };
} else if (input.operation === "mkdir-root") {
  ensureDirectory(input.root); result = {};
} else if (input.operation === "move-root") {
  const fd = checked(input.source, true); fs.closeSync(fd);
  withParent(input.source, false, (source) => withParent(input.root, false, (target) => {
    try { fs.lstatSync(target); throw new Error("repository_destination_already_exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    fs.renameSync(source, target);
  })); result = {};
} else {
  const rootFd = checked(input.root, true); fs.closeSync(rootFd);
  if (input.operation === "scan") result = measured("scanMs", () => scan());
  else if (input.operation === "read") {
    const fd = checked(full(input.path));
    try {
      const length = input.length ?? MAX_CHUNK;
      if (!Number.isSafeInteger(length) || length < 1 || length > 1024 * 1024) throw new Error("invalid_read_length");
      const buffer = Buffer.alloc(length);
      const count = measured("readMs", () => fs.readSync(fd, buffer, 0, buffer.length, input.offset));
      metrics.files++; metrics.bytes += count;
      result = { data: measured("encodeMs", () => buffer.subarray(0, count).toString("base64")) };
    } finally { fs.closeSync(fd); }
  } else if (input.operation === "mkdir") {
    parents(input.path); ensureDirectory(full(input.path)); result = {};
  } else if (input.operation === "write") {
    parents(input.path);
    const buffer = measured("decodeMs", () => Buffer.from(input.data, "base64"));
    if (buffer.length > MAX_CHUNK) throw new Error("chunk_too_large");
    const target = full(input.path);
    // Temporary writes happen in a separate host-selected staging root.
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW | (input.offset === 0 ? fs.constants.O_EXCL : 0);
    withParent(target, false, (anchored) => {
      const fd = fs.openSync(anchored, flags, 0o600);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.nlink !== 1) throw new Error("unsupported_file");
        if (stat.size !== input.offset) throw new Error("invalid_chunk_offset");
        measured("writeMs", () => fs.writeSync(fd, buffer, 0, buffer.length, input.offset));
        metrics.files++; metrics.bytes += buffer.length;
      } finally { fs.closeSync(fd); }
    });
    result = {};
  } else if (input.operation === "publish") {
    parents(input.path);
    const source = path.join(input.stagingRoot, safeRelative(input.stagingPath));
    if (checksum(source) !== input.sha256) throw new Error("content_changed_during_transfer");
    const sourceFd = checked(source);
    try { fs.fchmodSync(sourceFd, input.executable ? 0o700 : 0o600); } finally { fs.closeSync(sourceFd); }
    const target = full(input.path);
    try { const fd = checked(target); fs.closeSync(fd); } catch (error) { if (error.code !== "ENOENT") throw error; }
    measured("publishMs", () => withParent(source, false, (from) => withParent(target, false, (to) => fs.renameSync(from, to)))); result = {};
  } else if (input.operation === "symlink") {
    parents(input.path);
    const target = full(input.path);
    if (typeof input.linkTarget !== "string" || /[\x00-\x1f\x7f]/.test(input.linkTarget) || path.isAbsolute(input.linkTarget)
      || !path.resolve(path.dirname(target), input.linkTarget).startsWith(`${input.root}/`)) throw new Error("symlink_outside_repository");
    const temporary = path.join(input.stagingRoot, safeRelative(input.stagingPath));
    withParent(temporary, false, (from) => {
      fs.symlinkSync(input.linkTarget, from);
      withParent(target, false, (to) => fs.renameSync(from, to));
    }); result = {};
  } else if (input.operation === "remove") {
    const target = full(input.path);
    // Never recursively follow a user-created symlink during deletion.
    try {
      const stat = withParent(target, false, (anchored) => fs.lstatSync(anchored));
      const fd = checked(target, stat.isDirectory()); fs.closeSync(fd);
      withParent(target, false, (anchored) => { if (stat.isDirectory()) fs.rmdirSync(anchored); else fs.unlinkSync(anchored); });
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    result = {};
  } else throw new Error("unknown_operation");
}
return result;
}

// Receipts recover uncertain bulk responses, not arbitrary filesystem mutations.
// The key detects forged preexisting receipts; it is not an isolation boundary
// against the sandbox OS user, who may inspect this process's argv.
const RECEIPT_LIMIT = 4096;
function batchReceipt(request) {
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.batchId ?? "")
    || !/^[a-f0-9]{64}$/.test(request.batchSha256 ?? "")
    || !/^[a-f0-9]{64}$/.test(request.batchReceiptKey ?? "")) throw new Error("invalid_batch_identity");
  for (const root of [request.root, request.stagingRoot]) {
    if (typeof root !== "string" || !path.isAbsolute(root) || path.resolve(root) !== root
      || /[\x00-\x1f\x7f]/.test(root)) throw new Error("invalid_batch_root");
    const fd = checked(root, true); fs.closeSync(fd);
  }
  const directory = path.join(request.stagingRoot, ".batch-receipts");
  const target = path.join(directory, request.batchId);
  const identity = { version: 1, batchId: request.batchId, root: request.root,
    stagingRoot: request.stagingRoot, batchSha256: request.batchSha256 };
  const sign = (value) => createHmac("sha256", Buffer.from(request.batchReceiptKey, "hex"))
    .update(JSON.stringify(value)).digest("hex");
  function read() {
    let fd;
    try { fd = checked(target); } catch (error) { if (error.code === "ENOENT") return { state: "missing" }; throw error; }
    try {
      const size = fs.fstatSync(fd).size;
      if (size === 0) return { state: "running" }; // Exclusive claim, before atomic signed publication.
      if (size > RECEIPT_LIMIT) throw new Error("invalid_batch_receipt");
      const buffer = Buffer.alloc(RECEIPT_LIMIT + 1);
      const count = fs.readSync(fd, buffer, 0, buffer.length, 0);
      if (count !== size) throw new Error("invalid_batch_receipt");
      let receipt;
      try { receipt = JSON.parse(buffer.subarray(0, count).toString("utf8")); }
      catch { throw new Error("invalid_batch_receipt"); }
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("invalid_batch_receipt");
      for (const [key, value] of Object.entries(identity)) {
        if (receipt[key] !== value) throw new Error("batch_receipt_identity_mismatch");
      }
      if (!["running", "completed", "failed"].includes(receipt.state)) throw new Error("invalid_batch_receipt");
      const payload = { ...identity, state: receipt.state };
      if (receipt.state === "completed") {
        if (!Number.isSafeInteger(receipt.completed) || receipt.completed < 0 || receipt.completed > 512) throw new Error("invalid_batch_receipt");
        payload.completed = receipt.completed;
      } else if (receipt.state === "failed") {
        if (receipt.error !== "batch_execution_failed") throw new Error("invalid_batch_receipt");
        payload.error = receipt.error;
      }
      const keys = [...Object.keys(payload), "signature"].sort();
      if (JSON.stringify(Object.keys(receipt).sort()) !== JSON.stringify(keys)
        || !/^[a-f0-9]{64}$/.test(receipt.signature ?? "")
        || !timingSafeEqual(Buffer.from(receipt.signature, "hex"), Buffer.from(sign(payload), "hex"))) throw new Error("invalid_batch_receipt");
      return receipt.state === "completed" ? { state: "completed", completed: receipt.completed }
        : receipt.state === "failed" ? { state: "failed", error: receipt.error } : { state: "running" };
    } finally { fs.closeSync(fd); }
  }
  function replace(state, completed) {
    const payload = { ...identity, state, ...(state === "completed" ? { completed }
      : state === "failed" ? { error: "batch_execution_failed" } : {}) };
    const bytes = Buffer.from(JSON.stringify({ ...payload, signature: sign(payload) }));
    if (bytes.length > RECEIPT_LIMIT) throw new Error("invalid_batch_receipt");
    const temporary = path.join(directory, `${request.batchId}.${randomUUID()}.tmp`);
    withParent(temporary, false, (from) => {
      const fd = fs.openSync(from, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
      try {
        if (!fs.fstatSync(fd).isFile() || fs.fstatSync(fd).nlink !== 1) throw new Error("unsupported_file");
        fs.writeFileSync(fd, bytes); fs.fsyncSync(fd);
      } finally { fs.closeSync(fd); }
      try {
        const sourceFd = checked(temporary); fs.closeSync(sourceFd);
        const targetFd = checked(target); fs.closeSync(targetFd);
        withParent(target, false, (to, parentFd) => { fs.renameSync(from, to); fs.fsyncSync(parentFd); });
      } finally {
        try { fs.unlinkSync(from); } catch (error) { if (error.code !== "ENOENT") throw error; }
      }
    });
  }
  function claim() {
    ensureDirectory(directory);
    try {
      withParent(target, false, (anchored, parentFd) => {
        const fd = fs.openSync(anchored, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
        try { fs.fsyncSync(fd); fs.fsyncSync(parentFd); } finally { fs.closeSync(fd); }
      });
    } catch (error) { if (error.code === "EEXIST") return false; throw error; }
    replace("running");
    return true;
  }
  function confined(operation) {
    if (Object.hasOwn(operation, "root") || Object.hasOwn(operation, "stagingRoot") || Object.hasOwn(operation, "source")) throw new Error("invalid_batch_operation");
    const root = operation.operation === "write" ? request.stagingRoot : request.root;
    const targets = [path.join(root, safeRelative(operation.path))];
    if (operation.operation === "publish") targets.push(path.join(request.stagingRoot, safeRelative(operation.stagingPath)));
    if (targets.some(value => value === directory || value.startsWith(`${directory}/`))) throw new Error("reserved_batch_receipt_path");
  }
  return { read, replace, claim, confined };
}

const request = input;
if (request.operation === "read-batch") {
  if (!Array.isArray(request.entries) || request.entries.length > 64) throw new Error("invalid_read_batch");
  let bytes = 0;
  for (const entry of request.entries) {
    safeRelative(entry.path);
    if (!Number.isSafeInteger(entry.byteSize) || entry.byteSize < 0) throw new Error("invalid_read_length");
    bytes += entry.byteSize;
    if (bytes > 1024 * 1024) throw new Error("read_batch_too_large");
  }
  const results = request.entries.map((entry) => execute({ operation: "read", root: request.root,
    path: entry.path, offset: 0, length: Math.max(1, entry.byteSize) }));
  output(results);
} else if (request.operation === "batch-status") {
  output(batchReceipt(request).read());
} else if (request.operation === "batch") {
  // Stdin is bounded and hashed exactly, before parsing or claiming execution.
  const chunks = [];
  let size = 0;
  const buffer = Buffer.alloc(64 * 1024);
  let count;
  while ((count = fs.readSync(0, buffer, 0, buffer.length, null)) > 0) {
    size += count;
    if (size > 8 * 1024 * 1024) throw new Error("batch_too_large");
    chunks.push(Buffer.from(buffer.subarray(0, count)));
  }
  const body = Buffer.concat(chunks);
  if (createHash("sha256").update(body).digest("hex") !== request.batchSha256) throw new Error("batch_body_hash_mismatch");
  const receipt = batchReceipt(request);
  const operations = measured("decodeMs", () => JSON.parse(body.toString("utf8")));
  if (!Array.isArray(operations) || operations.length > 512) throw new Error("invalid_batch");
  for (const operation of operations) {
    if (!operation || !["write", "publish", "mkdir"].includes(operation.operation)) throw new Error("invalid_batch_operation");
    receipt.confined(operation);
  }
  if (!receipt.claim()) {
    const status = receipt.read();
    if (status.state === "completed") output({ completed: status.completed });
    else if (status.state === "running") output({ pending: true });
    else throw new Error(status.state === "failed" ? "batch_execution_failed" : "batch_receipt_disappeared");
  } else {
    try {
      for (const operation of operations) {
        // Roots always come from the host envelope, never the batch body.
        execute({ ...operation, root: operation.operation === "write" ? request.stagingRoot : request.root,
          stagingRoot: request.stagingRoot });
      }
      receipt.replace("completed", operations.length);
    } catch (error) {
      receipt.replace("failed");
      // Known helper codes contain no paths, file bytes or credentials. Native
      // filesystem error messages may contain paths, so keep those private.
      const safeErrors = ["unsafe_path", "invalid_root", "symlink_not_allowed", "unsupported_file",
        "hardlink_not_allowed", "chunk_too_large", "invalid_chunk_offset", "content_changed_during_transfer"];
      throw new Error(safeErrors.includes(error.message) ? error.message : "batch_execution_failed");
    }
    output({ completed: operations.length });
  }
} else {
  output(execute(request));
}
