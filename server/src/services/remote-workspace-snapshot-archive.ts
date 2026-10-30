/**
 * A portable, streaming workspace archive. This function is intentionally
 * self-contained: the same implementation runs locally and in a sandbox.
 */
async function workspaceArchive(input: {
  kind: "capture" | "restore";
  cwd?: string;
  archivePath: string;
  manifestPath?: string;
  targetDir?: string;
  expectedManifestDigest?: string;
  exclude?: string[];
  signal?: AbortSignal;
}): Promise<{ schema: "paperclip.remote-workspace-archive.v1"; manifestDigest: string; byteSize: number; sha256: string; entries: number }> {
  const fs = await import("node:fs/promises");
  const { createReadStream } = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const child = await import("node:child_process");
  const schema = "paperclip.remote-workspace-archive.v1" as const;
  const magic = Buffer.from("PCWS1\n");
  type Entry = { path: string; type: "directory" | "file" | "symlink"; mode?: number; size?: number; sha256?: string; target?: string };
  const fail = (reason: string): never => { throw new Error(`remote_workspace_archive_${reason}`); };
  const check = () => input.signal?.throwIfAborted();
  const hashFile = async (file: string) => {
    const hash = crypto.createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(file)) { check(); hash.update(bytes); size += bytes.length; }
    return { sha256: hash.digest("hex"), byteSize: size };
  };
  const safeRelative = (value: unknown): value is string => typeof value === "string" && value.length > 0
    && !value.includes("\\") && !/[\u0000-\u001f\u007f]/u.test(value) && !path.posix.isAbsolute(value)
    && value.split("/").every(part => part !== "" && part !== "." && part !== "..");
  const safeLink = (relative: string, target: string) => {
    if (typeof target !== "string" || !target || target.includes("\\") || /[\u0000-\u001f\u007f]/u.test(target) || path.posix.isAbsolute(target)) return false;
    const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(relative), target));
    return resolved !== ".." && !resolved.startsWith("../");
  };
  const git = (cwd: string, args: string[], stdin?: string) => new Promise<string>((resolve, reject) => {
    check();
    const command = child.execFile("git", ["-c", "core.fsmonitor=false", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
      signal: input.signal, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    if (stdin !== undefined) command.stdin?.end(stdin);
  });
  const directories: string[] = [];
  const walk = async (root: string, copyTo?: string, skipGit = false) => {
    const entries: Entry[] = [];
    const visit = async (relative: string) => {
      const directory = relative ? path.join(root, relative) : root;
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(directory) !== directory) fail("changed");
      for (const name of (await fs.readdir(directory)).sort()) {
        check();
        const next = relative ? `${relative}/${name}` : name;
        if (!safeRelative(next)) fail("unsupported_filename");
        if (input.exclude?.some(excluded => next === excluded || next.startsWith(`${excluded}/`)) || next === ".paperclip-runtime" || next.startsWith(".paperclip-runtime/")) continue;
        const source = path.join(root, next), target = copyTo ? path.join(copyTo, next) : null;
        const stat = await fs.lstat(source);
        if (skipGit && name === ".git") { if (stat.isSymbolicLink()) fail("unsafe_git_link"); directories.push(relative); continue; }
        if (stat.isDirectory()) {
          entries.push({ path: next, type: "directory", mode: stat.mode & 0o777 });
          if (target) await fs.mkdir(target, { mode: 0o700 });
          await visit(next);
        } else if (stat.isSymbolicLink()) {
          const link = await fs.readlink(source);
          if (!safeLink(next, link)) fail("unsafe_symlink");
          entries.push({ path: next, type: "symlink", target: link });
          if (target) await fs.symlink(link, target);
        } else if (stat.isFile()) {
          const handle = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
          let output: Awaited<ReturnType<typeof fs.open>> | undefined;
          try {
            const before = await handle.stat({ bigint: true });
            if (!before.isFile() || BigInt(stat.dev) !== before.dev || BigInt(stat.ino) !== before.ino || await fs.realpath(source) !== source) fail("changed");
            if (target) output = await fs.open(target, "wx", 0o600);
            const digest = crypto.createHash("sha256"); let bytes = 0;
            for await (const part of handle.createReadStream({ autoClose: false })) {
              check(); digest.update(part); bytes += part.length;
              await output?.writeFile(part);
            }
            const after = await handle.stat({ bigint: true }), current = await fs.lstat(source, { bigint: true });
            if (bytes !== Number(before.size) || await fs.realpath(source) !== source || ["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after] || after[key as keyof typeof after] !== current[key as keyof typeof current])) fail("changed");
            entries.push({ path: next, type: "file", mode: stat.mode & 0o777, size: bytes, sha256: digest.digest("hex") });
            if (target) await fs.chmod(target, stat.mode & 0o777);
          } finally { await output?.close(); await handle.close(); }
        } else fail("unsupported_entry");
      }
    };
    await visit("");
    return entries;
  };
  const manifestHash = (manifest: { schema: string; entries: Entry[] }) => crypto.createHash("sha256").update(JSON.stringify(manifest)).digest("hex");
  if (input.kind === "capture") {
    if (!input.cwd) fail("source_missing");
    const sourceEntry = await fs.lstat(input.cwd!);
    if (!sourceEntry.isDirectory() || sourceEntry.isSymbolicLink()) fail("source_invalid");
    const root = await fs.realpath(input.cwd!);
    if (!(await fs.lstat(root)).isDirectory()) fail("source_invalid");
    const scratch = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pc-workspace-capture-")));
    try {
      const tree = path.join(scratch, "tree"); await fs.mkdir(tree, { mode: 0o700 });
      const before = await walk(root, tree, true);
      const repositories = [...new Set(directories)];
      const gitSignatures = new Map<string, string>();
      const signature = async (repo: string) => {
        const index = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
        const indexHash = await hashFile(index).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
        return JSON.stringify([await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]), await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]), await git(repo, ["symbolic-ref", "-q", "HEAD"]).catch(() => git(repo, ["rev-parse", "HEAD"])), indexHash]);
      };
      for (let index = 0; index < repositories.length; index++) {
        const relative = repositories[index]!, repo = path.join(root, relative), normalized = path.join(scratch, `repo-${index}.git`);
        gitSignatures.set(relative, await signature(repo));
        // Mirror copies all refs; dissociation brings borrowed objects into this
        // private repository. The selected worktree's index and HEAD are separate.
        await git(root, ["clone", "--mirror", "--no-hardlinks", "--dissociate", "--", repo, normalized]);
        const destination = path.join(tree, relative, ".git");
        await fs.rename(normalized, destination);
        const sourceGit = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
        const sourceCommon = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
        for (const name of ["HEAD", "index", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
          await fs.copyFile(path.join(sourceGit, name), path.join(destination, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        for (const directory of new Set([sourceGit, sourceCommon])) {
          for (const name of await fs.readdir(directory)) if (/^sharedindex\.[a-f0-9]+$/.test(name)) await fs.copyFile(path.join(directory, name), path.join(destination, name));
        }
        for (const name of ["exclude", "attributes"]) {
          await fs.mkdir(path.join(destination, "info"), { recursive: true });
          await fs.copyFile(path.join(sourceCommon, "info", name), path.join(destination, "info", name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        const restoredRepo = path.join(tree, relative);
        await git(restoredRepo, ["config", "core.bare", "false"]);
        await git(restoredRepo, ["config", "--unset-all", "remote.origin.mirror"]).catch(() => undefined);
        const origin = (await git(repo, ["remote", "get-url", "origin"]).catch(() => "")).trim();
        await git(restoredRepo, ["remote", "remove", "origin"]).catch(() => undefined);
        if (origin) {
          if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(origin)) {
            const parsed = new URL(origin); if (parsed.password || (["https:", "http:"].includes(parsed.protocol) && parsed.username)) fail("credential_in_git_remote");
          }
          await git(restoredRepo, ["remote", "add", "origin", origin]);
        }
        // Removing the source-only remote also removes its refs. Restore every
        // source ref without using the network; objects are already self-contained.
        const refs = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]);
        const updates = refs.split("\n").filter(Boolean).map(row => {
          const [object, ref] = row.split(" "); return `update ${ref} ${object}\n`;
        }).join("");
        if (updates) await git(restoredRepo, ["update-ref", "--stdin"], updates);
        await git(restoredRepo, ["repack", "-a", "-d"]);
        await fs.rm(path.join(destination, "objects", "info", "alternates"), { force: true });
        await git(restoredRepo, ["fsck", "--connectivity-only", "--no-dangling"]);
        if (await signature(repo) !== gitSignatures.get(relative)) fail("changed");
      }
      directories.length = 0;
      const after = await walk(root, undefined, true);
      if (JSON.stringify(before) !== JSON.stringify(after)) fail("changed");
      const entries = await walk(tree);
      // Parent modes are applied after traversal, so source read-only folders do
      // not prevent staging their children.
      for (const entry of before.filter(entry => entry.type === "directory").reverse()) await fs.chmod(path.join(tree, entry.path), entry.mode!);
      const originals = new Map(before.map(entry => [entry.path, entry]));
      for (const entry of entries) if (entry.type === "directory") {
        const original = originals.get(entry.path); if (original) entry.mode = original.mode;
      }
      const manifest = { schema, entries }, body = Buffer.from(JSON.stringify(manifest));
      if (body.length > 64 * 1024 * 1024) fail("manifest_too_large");
      const digest = manifestHash(manifest), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
      const output = await fs.open(input.archivePath, "wx", 0o600);
      try {
        await output.writeFile(Buffer.concat([magic, length, body]));
        for (const entry of entries) if (entry.type === "file") {
          for await (const bytes of createReadStream(path.join(tree, entry.path))) { check(); await output.writeFile(bytes); }
        }
      } finally { await output.close(); }
      if (input.manifestPath) await fs.writeFile(input.manifestPath, body, { flag: "wx", mode: 0o600 });
      return { schema, manifestDigest: digest, ...await hashFile(input.archivePath), entries: entries.length };
    } finally { await fs.rm(scratch, { recursive: true, force: true }); }
  }
  if (!input.targetDir || !/^[a-f0-9]{64}$/.test(input.expectedManifestDigest ?? "")) fail("restore_binding_invalid");
  const archive = await fs.open(input.archivePath, "r");
  let staging: string | undefined;
  try {
    const prefix = Buffer.alloc(magic.length + 4);
    if ((await archive.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, magic.length).equals(magic)) fail("invalid_header");
    const manifestSize = prefix.readUInt32BE(magic.length);
    if (manifestSize > 64 * 1024 * 1024) fail("manifest_too_large");
    const bytes = Buffer.alloc(manifestSize);
    if ((await archive.read(bytes, 0, manifestSize, prefix.length)).bytesRead !== manifestSize) fail("truncated");
    const manifest = JSON.parse(bytes.toString("utf8")) as { schema: string; entries: Entry[] };
    if (manifest.schema !== schema || !Array.isArray(manifest.entries) || manifestHash(manifest) !== input.expectedManifestDigest) fail("manifest_mismatch");
    const kinds = new Map<string, string>(); let bodySize = 0;
    for (const entry of manifest.entries) {
      if (!entry || !safeRelative(entry.path) || kinds.has(entry.path)) fail("invalid_entry");
      const parent = path.posix.dirname(entry.path);
      if (parent !== "." && kinds.get(parent) !== "directory") fail("invalid_parent");
      if (entry.type === "file") {
        if (!Number.isSafeInteger(entry.size) || entry.size! < 0 || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail("invalid_file");
        bodySize += entry.size!;
      } else if (entry.type === "symlink") { if (!safeLink(entry.path, entry.target!)) fail("unsafe_symlink"); }
      else if (entry.type !== "directory") fail("invalid_type");
      if (entry.type !== "symlink" && (!Number.isInteger(entry.mode) || entry.mode! < 0 || entry.mode! > 0o777)) fail("invalid_mode");
      kinds.set(entry.path, entry.type);
    }
    if (!Number.isSafeInteger(bodySize) || (await archive.stat()).size !== prefix.length + manifestSize + bodySize) fail("size_mismatch");
    const parent = await fs.realpath(path.dirname(input.targetDir!));
    const existing = await fs.lstat(input.targetDir!).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (existing && (!existing.isDirectory() || existing.isSymbolicLink() || (await fs.readdir(input.targetDir!)).length)) fail("target_not_empty");
    staging = await fs.mkdtemp(path.join(parent, ".workspace-restore-"));
    let offset = prefix.length + manifestSize;
    const buffer = Buffer.alloc(1024 * 1024);
    for (const entry of manifest.entries) {
      check(); const target = path.join(staging, entry.path);
      if (entry.type === "directory") await fs.mkdir(target, { mode: 0o700 });
      else if (entry.type === "symlink") await fs.symlink(entry.target!, target);
      else {
        const output = await fs.open(target, "wx", 0o600), digest = crypto.createHash("sha256");
        try {
          let remaining = entry.size!;
          while (remaining) {
            check(); const read = await archive.read(buffer, 0, Math.min(buffer.length, remaining), offset);
            if (!read.bytesRead) fail("truncated");
            const part = buffer.subarray(0, read.bytesRead); await output.writeFile(part); digest.update(part);
            offset += read.bytesRead; remaining -= read.bytesRead;
          }
          if (digest.digest("hex") !== entry.sha256) fail("file_hash_mismatch");
        } finally { await output.close(); }
        await fs.chmod(target, entry.mode!);
      }
    }
    for (const entry of manifest.entries.filter(entry => entry.type === "directory").reverse()) await fs.chmod(path.join(staging, entry.path), entry.mode!);
    await fs.rename(staging, input.targetDir!); staging = undefined;
    return { schema, manifestDigest: input.expectedManifestDigest!, ...await hashFile(input.archivePath), entries: manifest.entries.length };
  } finally { await archive.close(); if (staging) await fs.rm(staging, { recursive: true, force: true }); }
}

export function captureRemoteWorkspaceDirectory(input: { cwd: string; archivePath: string; manifestPath?: string; exclude?: string[]; signal?: AbortSignal }) {
  return workspaceArchive({ ...input, kind: "capture" });
}

export function restoreRemoteWorkspaceArchive(input: { archivePath: string; targetDir: string; expectedManifestDigest: string; signal?: AbortSignal }) {
  return workspaceArchive({ ...input, kind: "restore" });
}

export function remoteWorkspaceArchiveScript(): string {
  // tsx's function-name preservation helper may appear in Function#toString.
  const source = workspaceArchive.toString().replaceAll("__vite_ssr_dynamic_import__", "import");
  return `const __name = (value) => value;\nconst archive = ${source};\nconst [kind, first, second, digest] = process.argv.slice(2);\narchive(kind === 'capture' ? {kind,cwd:first,archivePath:second} : {kind,archivePath:first,targetDir:second,expectedManifestDigest:digest}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{process.stderr.write(error.message);process.exitCode=1;});\n`;
}
