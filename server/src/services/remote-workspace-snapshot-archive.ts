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
  maxEntries?: number;
  maxManifestBytes?: number;
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
  check();
  const hashFile = async (file: string) => {
    check();
    const hash = crypto.createHash("sha256"); let size = 0;
    for await (const bytes of createReadStream(file, { signal: input.signal })) { check(); hash.update(bytes); size += bytes.length; }
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
    const command = child.execFile("git", ["-c", "core.fsmonitor=false", "-c", "pack.threads=1", "-c", "protocol.allow=never", "-c", `core.hooksPath=${os.devNull}`, "-C", cwd, ...args], {
      signal: input.signal, timeout: 300_000, maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: os.devNull, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0",
        GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined,
        GIT_OBJECT_DIRECTORY: undefined, GIT_ALTERNATE_OBJECT_DIRECTORIES: undefined, GIT_CONFIG_PARAMETERS: undefined, GIT_CONFIG_COUNT: "0", GIT_TEMPLATE_DIR: undefined,
        GIT_AUTHOR_NAME: "Paperclip", GIT_COMMITTER_NAME: "Paperclip", GIT_AUTHOR_EMAIL: "workspace@paperclip.invalid", GIT_COMMITTER_EMAIL: "workspace@paperclip.invalid",
        GIT_AUTHOR_DATE: "@0 +0000", GIT_COMMITTER_DATE: "@0 +0000", GIT_NO_LAZY_FETCH: "1" },
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
    if (stdin !== undefined) command.stdin?.end(stdin);
  });
  const portableRemoteUrl = (value: string) => {
    if (!value || /[\u0000-\x20\u007f\\]/u.test(value)) return false;
    if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(value)) {
      let url: URL; try { url = new URL(value); } catch { return false; }
      if (!["http:", "https:", "ssh:", "git:"].includes(url.protocol)) return false;
      if (url.password || (url.username && url.protocol !== "ssh:") || url.search || url.hash) fail("credential_in_git_remote");
      return Boolean(url.hostname);
    }
    if (/^[a-z]:[\/\\]/iu.test(value)) return false;
    return /^(?:[a-z0-9._-]+@)?(?:[a-z0-9._-]+|\[[a-f0-9:]+\]):[^\s]+$/iu.test(value);
  };
  const portableGitSettings = async (repo: string) => {
    // Read only the repository's own allowlisted values. Includes, execution
    // hooks, filters, credential helpers, and machine-specific paths stay out.
    const read = (scope: string, pattern: string) => git(repo, ["config", "--null", scope, "--no-includes", "--get-regexp", pattern])
      .catch((error: { code?: number }) => { if (error.code === 1) return ""; throw error; });
    const sparsePattern = "^(core\\.(sparsecheckout|sparsecheckoutcone)|index\\.sparse)$";
    const perWorktree = await git(repo, ["config", "--local", "--no-includes", "--bool", "--get", "extensions.worktreeConfig"])
      .catch((error: { code?: number }) => { if (error.code === 1) return "false"; throw error; });
    const raw = await read("--local", "^(remote\\..*\\.(url|pushurl|fetch|promisor|partialclonefilter)|branch\\..*\\.(remote|merge|rebase)|user\\.(name|email)|extensions\\.partialclone|core\\.(sparsecheckout|sparsecheckoutcone)|index\\.sparse)$")
      + (perWorktree.trim() === "true" ? await read("--worktree", sparsePattern) : "");
    const boolean = (value: string) => /^(true|yes|on|1|)$/iu.test(value) ? "true"
      : /^(false|no|off|0)$/iu.test(value) ? "false" : fail("unsupported_git_setting");
    const rows = raw.split("\0").filter(Boolean).map(row => {
      const split = row.indexOf("\n"), key = row.slice(0, split), value = row.slice(split + 1);
      if (split < 1 || /[\u0000-\x20\u007f\\]/u.test(key) || /[\u0000-\u001f\u007f\\]/u.test(value)) fail("unsupported_git_setting");
      return { key, value, remote: /^remote\.(.+)\.(url|pushurl|fetch|promisor|partialclonefilter)$/.exec(key),
        branch: /^branch\.(.+)\.(remote|merge|rebase)$/.exec(key), identity: /^user\.(name|email)$/.test(key),
        sparse: /^(core\.(sparsecheckout|sparsecheckoutcone)|index\.sparse)$/.test(key) };
    });
    const settings = rows.filter((row, index) => !row.sparse || rows.findLastIndex(other => other.key === row.key) === index);
    const remotes = new Set(settings.flatMap(item => item.remote?.[2] === "url" ? [item.remote[1]!] : []));
    for (const setting of settings) if (setting.remote && ["url", "pushurl"].includes(setting.remote[2]!)) {
      if (!portableRemoteUrl(setting.value)) remotes.delete(setting.remote[1]!);
    }
    const promisors = new Set(settings.filter(setting => setting.remote?.[2] === "promisor" && boolean(setting.value) === "true")
      .map(setting => setting.remote![1]!));
    if ([...promisors].some(name => !remotes.has(name))) fail("unsupported_git_setting");
    const branches = new Map<string, boolean>();
    for (const setting of settings) if (setting.branch?.[2] === "remote") {
      const name = setting.branch[1]!;
      branches.set(name, (branches.get(name) ?? true) && (setting.value === "." || remotes.has(setting.value)));
    }
    const retained: Array<{ key: string; value: string }> = [];
    for (const setting of settings) {
      if (setting.remote) {
        if (!remotes.has(setting.remote[1]!)) continue;
        if (setting.remote[2] === "promisor") setting.value = boolean(setting.value);
        if (setting.remote[2] === "partialclonefilter" && (!promisors.has(setting.remote[1]!)
          || !/^(blob:none|blob:limit=[0-9]+[kmg]?|tree:[0-9]+)$/iu.test(setting.value))) fail("unsupported_git_setting");
        if (setting.remote[2] === "fetch") {
          const refs = setting.value.replace(/^[+^]/u, "").split(":");
          if (refs.length > 2 || !refs.some(Boolean)) fail("unsupported_git_setting");
          for (const ref of refs.filter(Boolean)) {
            if (ref.startsWith("-")) fail("unsupported_git_setting");
            await git(repo, ["check-ref-format", "--allow-onelevel", "--refspec-pattern", ref]).catch(() => fail("unsupported_git_setting"));
          }
        }
      } else if (setting.branch) {
        if (!(branches.get(setting.branch[1]!) ?? remotes.has("origin"))) continue;
        if (setting.branch[2] === "merge") {
          if (setting.value.startsWith("-")) fail("unsupported_git_setting");
          await git(repo, ["check-ref-format", "--allow-onelevel", setting.value]).catch(() => fail("unsupported_git_setting"));
        }
        if (setting.branch[2] === "rebase" && !["true", "false", "merges", "interactive", "preserve", "yes", "no", "on", "off", "1", "0", ""].includes(setting.value)) fail("unsupported_git_setting");
      } else if (setting.sparse) setting.value = boolean(setting.value);
      else if (setting.key === "extensions.partialclone") {
        if (!promisors.has(setting.value)) fail("unsupported_git_setting");
      } else if (!setting.identity) fail("unsupported_git_setting");
      retained.push({ key: setting.key, value: setting.value });
    }
    return retained;
  };
  const assertRepositoryRoot = async (repo: string) => {
    // A damaged `.git` entry, such as a partly removed worktree, is not this
    // directory's repository. Git would fail with a raw command error that
    // names local paths, or discover an enclosing repository and save that
    // repository's settings, refs and index as this directory's state.
    // Git's error wording differs by version and locale, and a valid repository
    // can also fail for other reasons, such as unsafe ownership or a full disk.
    // Those keep their existing diagnostic; only a damaged entry is named here.
    const top = await git(repo, ["rev-parse", "--path-format=absolute", "--show-toplevel"])
      .catch(async (error: unknown) => {
        check();
        if (await damagedGitEntry(repo)) fail("invalid_git_repository");
        throw error;
      });
    if (await fs.realpath(top.trim()).catch(() => null) !== repo) fail("invalid_git_repository");
  };
  const damagedGitEntry = async (repo: string) => {
    // Git's own test for a repository: a `gitdir:` file or a directory with a
    // valid HEAD, and objects and refs in its common directory.
    const isDirectory = (directory: string) => fs.stat(directory).then(entry => entry.isDirectory(), () => false);
    // A non-blocking open never waits on a named pipe; only a regular file is read.
    const readSmall = async (file: string) => {
      check();
      const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK).catch(() => null);
      if (!handle) return null;
      try {
        if (!(await handle.stat()).isFile()) return null;
        const bytes = Buffer.alloc(4096), { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
        return bytes.subarray(0, bytesRead).toString("utf8");
      } finally { await handle.close(); }
    };
    const entry = path.join(repo, ".git");
    let gitDir = entry;
    if ((await fs.lstat(entry).catch(() => null))?.isFile()) {
      const link = /^gitdir: (.+)$/mu.exec(await readSmall(entry) ?? "");
      if (!link) return true;
      gitDir = path.resolve(repo, link[1]!.trim());
    }
    const head = await readSmall(path.join(gitDir, "HEAD"));
    if (!/^(ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\s*$/u.test(head ?? "")) return true;
    let common = gitDir;
    if (await fs.lstat(path.join(gitDir, "commondir")).then(() => true, () => false)) {
      const value = await readSmall(path.join(gitDir, "commondir"));
      if (!value?.trim()) return true;
      common = path.resolve(gitDir, value.trim());
    }
    return !await isDirectory(path.join(common, "objects")) || !await isDirectory(path.join(common, "refs"));
  };
  const assertGitOperationComplete = async (repo: string) => {
    await assertRepositoryRoot(repo);
    const gitDir = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
    // A mirror plus the selected index is not a portable continuation of an
    // unfinished Git operation. Never acknowledge a copy that drops its todo,
    // scripts, autostash, or operation-only object references. Inspect the
    // selected worktree's administration directory without following links.
    for (const name of ["rebase-merge", "rebase-apply", "sequencer", "CHERRY_PICK_HEAD",
      "REVERT_HEAD", "MERGE_AUTOSTASH", "BISECT_START"]) {
      const state = await fs.lstat(path.join(gitDir, name)).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (state) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
    }
    const readState = async (name: string, limit: number) => {
      const file = path.join(gitDir, name), entry = await fs.lstat(file).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return null;
      });
      if (!entry) return null;
      if (!entry.isFile() || entry.isSymbolicLink() || entry.size > limit) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      const chunks: Buffer[] = []; let size = 0;
      const saved = await readStableFile(file, async chunk => {
        size += chunk.length;
        if (size > limit) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
        chunks.push(chunk);
      });
      return { name, sha256: saved.sha256, text: Buffer.concat(chunks).toString("utf8") };
    };
    const mergeHead = await readState("MERGE_HEAD", 8192);
    if (mergeHead) {
      for (const name of ["MERGE_RR", "REBASE_HEAD"]) {
        const exists = await fs.lstat(path.join(gitDir, name)).then(() => true, (error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
          return false;
        });
        if (exists) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      }
      if (await git(repo, ["ls-files", "--unmerged", "-z"])) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      const mode = await readState("MERGE_MODE", 16), message = await readState("MERGE_MSG", 4 * 1024 * 1024);
      const original = await readState("ORIG_HEAD", 128), automatic = await readState("AUTO_MERGE", 128);
      if (!original || !message || mode && !["", "no-ff"].includes(mode.text.trim())) return fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      const objects = [...mergeHead.text.trim().split("\n").map(object => ({ object, type: "commit" })),
        { object: original.text.trim(), type: "commit" }, ...(automatic ? [{ object: automatic.text.trim(), type: "tree" }] : [])];
      for (const { object, type } of objects) {
        if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)
          || await git(repo, ["rev-parse", "--verify", `${object}^{${type}}`]).then(value => value.trim()).catch(() => null) !== object) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      }
      return { objects, metadata: ([["MERGE_HEAD", mergeHead], ["MERGE_MODE", mode], ["MERGE_MSG", message], ["ORIG_HEAD", original], ["AUTO_MERGE", automatic]] as const)
        .map(([name, entry]) => ({ name, sha256: entry?.sha256 ?? null })) };
    }
    const bookmark = path.join(gitDir, "REBASE_HEAD");
    const state = await fs.lstat(bookmark).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (!state) return null;
    if (!state.isFile() || state.isSymbolicLink() || state.size > 128) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
    const bytes: Buffer[] = []; let size = 0;
    const entry = await readStableFile(bookmark, async chunk => {
      size += chunk.length;
      if (size > 128) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
      bytes.push(chunk);
    });
    const object = Buffer.concat(bytes).toString("utf8").trim();
    if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(object)
      || await git(repo, ["rev-parse", "--verify", "REBASE_HEAD^{commit}"]).then(value => value.trim()).catch(() => null) !== object
      || await git(repo, ["ls-files", "--unmerged", "-z"])) fail("git_operation_in_progress: finish or abort the Git operation before saving the workspace");
    return { objects: [{ object, type: "commit" }], metadata: [{ name: "REBASE_HEAD", sha256: entry.sha256 }] };
  };
  const readStableFile = async (source: string, consume?: (bytes: Buffer) => Promise<void>) => {
    check();
    const original = await fs.lstat(source, { bigint: true });
    const handle = await fs.open(source, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || original.dev !== before.dev || original.ino !== before.ino || await fs.realpath(source) !== source) fail("changed");
      const digest = crypto.createHash("sha256"); let size = 0;
      for await (const bytes of handle.createReadStream({ autoClose: false, signal: input.signal })) {
        check(); digest.update(bytes); size += bytes.length;
        await consume?.(bytes);
      }
      const after = await handle.stat({ bigint: true }), current = await fs.lstat(source, { bigint: true });
      if (size !== Number(before.size) || await fs.realpath(source) !== source
        || ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]
          || after[key as keyof typeof after] !== current[key as keyof typeof current])) fail("changed");
      return { sha256: digest.digest("hex"), size, mode: Number(before.mode & 0o777n) };
    } finally { await handle.close(); }
  };
  const copyGitFile = async (source: string, destination: string) => {
    const entry = await fs.lstat(source).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; return null; });
    if (!entry) return;
    if (!entry.isFile() || entry.isSymbolicLink()) fail("unsafe_git_link");
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
    const output = await fs.open(destination, "w", 0o600);
    try { await readStableFile(source, bytes => output.writeFile(bytes)); } finally { await output.close(); }
  };
  const gitStatePath = async (repo: string, name: string) => (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", name])).trim();
  const gitStateHash = async (repo: string, name: string) => {
    const file = await gitStatePath(repo, name);
    return readStableFile(file).then(entry => entry.sha256).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error; return null;
    });
  };
  const gitObjectFiles = async (repo: string) => {
    const objects = await gitStatePath(repo, "objects");
    const files: Array<{ path: string; identity: string[] }> = [];
    const visit = async (relative: string) => {
      const directory = path.join(objects, relative), entry = await fs.lstat(directory);
      if (!entry.isDirectory() || entry.isSymbolicLink() || await fs.realpath(directory) !== directory) fail("unsafe_git_link");
      for (const name of (await fs.readdir(directory)).sort()) {
        const next = relative ? `${relative}/${name}` : name, stat = await fs.lstat(path.join(objects, next), { bigint: true });
        if (stat.isSymbolicLink()) fail("unsafe_git_link");
        if (!relative && (name === "pack" || name === "info" || /^[a-f0-9]{2}$/u.test(name))) { await visit(next); continue; }
        // Alternates are a separate local object store. The ordinary mirror
        // path still dissociates them; this offline path must not drop them.
        if (relative === "info" && ["alternates", "http-alternates"].includes(name)) fail("unsupported_git_setting");
        if (relative === "info" && name === "commit-graphs" && stat.isDirectory()) continue;
        const object = /^[a-f0-9]{2}\/[a-f0-9]{38}(?:[a-f0-9]{24})?$/u.test(next)
          || /^pack\/pack-[a-f0-9]{40}(?:[a-f0-9]{24})?\.(pack|idx|promisor|rev|bitmap|keep)$/u.test(next);
        if (object) {
          if (!stat.isFile()) fail("unsafe_git_link");
          files.push({ path: next, identity: [stat.dev, stat.ino, stat.size, stat.mode, stat.mtimeNs, stat.ctimeNs].map(String) });
        } else if (!stat.isFile()) fail("unsupported_git_setting");
      }
    };
    await visit("");
    return { objects, files };
  };
  const directories: string[] = [];
  const excludedPaths = new Set<string>();
  const excluded = (next: string) => input.exclude?.some(item => next === item || next.startsWith(`${item}/`))
    || next === ".paperclip-runtime" || next.startsWith(".paperclip-runtime/");
  const walk = async (root: string, skipGit = false) => {
    const entries: Entry[] = [];
    const visit = async (relative: string, parentIsRepository = false) => {
      const directory = relative ? path.join(root, relative) : root;
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || await fs.realpath(directory) !== directory) fail("changed");
      const names = (await fs.readdir(directory)).sort();
      const inRepository = parentIsRepository || names.includes(".git");
      if (skipGit && names.includes(".git") && !excluded(relative ? `${relative}/.git` : ".git")) {
        // Validate the repository before any Git read below, including the
        // tracked check for node_modules, can use a damaged entry.
        if ((await fs.lstat(path.join(directory, ".git"))).isSymbolicLink()) fail("unsafe_git_link");
        await assertRepositoryRoot(directory);
      }
      for (const name of names) {
        check();
        const next = relative ? `${relative}/${name}` : name;
        if (!safeRelative(next)) fail("unsupported_filename");
        if (excluded(next)) {
          excludedPaths.add(next); continue;
        }
        const source = path.join(root, next);
        const stat = await fs.lstat(source);
        if (skipGit && name === ".git") { if (stat.isSymbolicLink()) fail("unsafe_git_link"); directories.push(relative); continue; }
        if (stat.isDirectory()) {
          // Reinstallable dependency trees: npm packages beside package.json, and
          // a Python virtual environment, which links its interpreter by absolute
          // path and has a PEP 405 pyvenv.cfg at its root.
          const marker = await fs.lstat(name === "node_modules" ? path.join(directory, "package.json")
            : path.join(source, "pyvenv.cfg")).catch(() => null);
          if (marker?.isFile() && !marker.isSymbolicLink()) {
            // A failing Git read cannot establish that data is untracked.
            const tracked = inRepository ? await git(directory, ["ls-files", "-z", "--", name]) : "";
            if (!tracked) { excludedPaths.add(next); continue; }
          }
        }
        if (stat.isSocket()) {
          // Runtime IPC endpoints have no portable file contents. Record the
          // exclusion without removing the endpoint or dropping adjacent work.
          excludedPaths.add(next); continue;
        }
        if (stat.isDirectory()) {
          entries.push({ path: next, type: "directory", mode: stat.mode & 0o777 });
          await visit(next, inRepository);
        } else if (stat.isSymbolicLink()) {
          const link = await fs.readlink(source);
          if (!safeLink(next, link)) fail("unsafe_symlink");
          entries.push({ path: next, type: "symlink", target: link });
        } else if (stat.isFile()) {
          entries.push({ path: next, type: "file", ...await readStableFile(source) });
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
    let archiveCreated = false, completed = false;
    try {
      const tree = path.join(scratch, "tree"); await fs.mkdir(tree, { mode: 0o700 });
      const before = await walk(root, true);
      const repositories = [...new Set(directories)];
      const gitSignatures = new Map<string, string>();
      const signature = async (repo: string, settings?: Awaited<ReturnType<typeof portableGitSettings>>) => {
        const operation = await assertGitOperationComplete(repo);
        const index = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
        const indexHash = await hashFile(index).catch((error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error));
        const config = settings ?? await portableGitSettings(repo), shallow = await gitStateHash(repo, "shallow");
        const partial = config.some(setting => /^remote\..*\.promisor$/u.test(setting.key) && setting.value === "true");
        return JSON.stringify([await git(repo, ["status", "--porcelain=v2", "-z", "--untracked-files=no"]), await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]), await git(repo, ["symbolic-ref", "-q", "HEAD"]).catch(() => git(repo, ["rev-parse", "HEAD"])), indexHash, config,
          shallow, await gitStateHash(repo, "info/sparse-checkout"), shallow || partial ? (await gitObjectFiles(repo)).files : null, operation]);
      };
      for (let index = 0; index < repositories.length; index++) {
        const relative = repositories[index]!, repo = path.join(root, relative), normalized = path.join(scratch, `repo-${index}.git`);
        const settings = await portableGitSettings(repo);
        gitSignatures.set(relative, await signature(repo, settings));
        const offline = await gitStateHash(repo, "shallow") !== null
          || settings.some(setting => /^remote\..*\.promisor$/u.test(setting.key) && setting.value === "true");
        if (offline) {
          // A shallow local clone uses upload-pack. It drops index-only objects
          // and asks a filtered source for promised blobs it never downloaded.
          // Preserve its existing stores and promisor boundaries without fetch.
          await git(repo, ["fsck", "--full", "--no-dangling"]);
          const format = (await git(repo, ["rev-parse", "--show-object-format"])).trim();
          if (!["sha1", "sha256"].includes(format)) fail("unsupported_git_setting");
          await git(root, ["init", "--bare", "--template=", `--object-format=${format}`, normalized]);
          const { objects, files } = await gitObjectFiles(repo);
          for (const file of files) await copyGitFile(path.join(objects, file.path), path.join(normalized, "objects", file.path));
        } else {
          // Dissociation brings borrowed objects into the private repository.
          await git(root, ["-c", "protocol.file.allow=always", "clone", "--mirror", "--no-hardlinks", "--dissociate", "--template=", "--", repo, normalized]);
        }
        const destination = path.join(tree, relative, ".git");
        await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
        await fs.rename(normalized, destination);
        const sourceGit = (await git(repo, ["rev-parse", "--absolute-git-dir"])).trim();
        const sourceCommon = (await git(repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
        for (const name of ["HEAD", "index", "ORIG_HEAD", "MERGE_HEAD", "MERGE_MSG", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
          await fs.copyFile(path.join(sourceGit, name), path.join(destination, name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        for (const name of ["REBASE_HEAD", "MERGE_MODE", "AUTO_MERGE"]) await copyGitFile(path.join(sourceGit, name), path.join(destination, name));
        for (const directory of new Set([sourceGit, sourceCommon])) {
          for (const name of await fs.readdir(directory)) if (/^sharedindex\.[a-f0-9]+$/.test(name)) await fs.copyFile(path.join(directory, name), path.join(destination, name));
        }
        for (const name of ["exclude", "attributes"]) {
          await fs.mkdir(path.join(destination, "info"), { recursive: true });
          await fs.copyFile(path.join(sourceCommon, "info", name), path.join(destination, "info", name)).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error; });
        }
        await copyGitFile(await gitStatePath(repo, "shallow"), path.join(destination, "shallow"));
        await copyGitFile(await gitStatePath(repo, "info/sparse-checkout"), path.join(destination, "info", "sparse-checkout"));
        const restoredRepo = path.join(tree, relative);
        await git(restoredRepo, ["config", "core.bare", "false"]);
        await git(restoredRepo, ["config", "--unset-all", "remote.origin.mirror"]).catch(() => undefined);
        await git(restoredRepo, ["remote", "remove", "origin"]).catch(() => undefined);
        for (const setting of settings) await git(restoredRepo, ["config", "--add", setting.key, setting.value]);
        // Removing the source-only remote also removes its refs. Restore every
        // source ref without using the network; objects are already self-contained.
        const refs = await git(repo, ["for-each-ref", "--format=%(objectname) %(refname)"]);
        const updates = refs.split("\n").filter(Boolean).map(row => {
          const [object, ref] = row.split(" "); return `update ${ref} ${object}\n`;
        }).join("");
        if (updates) await git(restoredRepo, ["update-ref", "--stdin"], updates);
        const operation = await assertGitOperationComplete(repo);
        for (const entry of operation?.metadata ?? []) {
          if (await gitStateHash(restoredRepo, entry.name) !== entry.sha256) fail("changed");
        }
        for (const { object, type } of operation?.objects ?? []) {
          const present = await git(restoredRepo, ["cat-file", "-e", `${object}^{${type}}`]).then(() => true).catch(() => false);
          if (!present && !offline) await git(restoredRepo, ["-c", "protocol.file.allow=always", "fetch", "--no-tags", "--no-recurse-submodules",
            "--no-write-fetch-head", "--no-auto-maintenance", "--", repo, object]);
          await git(restoredRepo, ["cat-file", "-e", `${object}^{${type}}`]);
        }
        await fs.rm(path.join(destination, "objects", "info", "alternates"), { force: true });
        await git(restoredRepo, ["fsck", "--full", "--no-dangling"]);
        if (await signature(repo) !== gitSignatures.get(relative)) fail("changed");
      }
      const originals = new Map(before.map(entry => [entry.path, entry]));
      const entries = [...before, ...(await walk(tree)).filter(entry => !originals.has(entry.path))]
        .sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
      const manifest = { schema, exclusionPolicy: "paperclip.remote-workspace-exclusions.v1", excluded: [...excludedPaths].sort(), entries }, body = Buffer.from(JSON.stringify(manifest));
      if (body.length > 64 * 1024 * 1024) fail("manifest_too_large");
      const digest = manifestHash(manifest), length = Buffer.alloc(4); length.writeUInt32BE(body.length);
      const output = await fs.open(input.archivePath, "wx", 0o600);
      archiveCreated = true;
      try {
        await output.writeFile(Buffer.concat([magic, length, body]));
        for (const entry of entries) if (entry.type === "file") {
          const observed = await readStableFile(path.join(originals.has(entry.path) ? root : tree, entry.path), bytes => output.writeFile(bytes));
          if (observed.size !== entry.size || observed.sha256 !== entry.sha256 || observed.mode !== entry.mode) fail("changed");
        }
      } finally { await output.close(); }
      directories.length = 0;
      if (JSON.stringify(before) !== JSON.stringify(await walk(root, true))) fail("changed");
      for (const relative of repositories) {
        if (await signature(path.join(root, relative)) !== gitSignatures.get(relative)) fail("changed");
      }
      if (input.manifestPath) await fs.writeFile(input.manifestPath, body, { flag: "wx", mode: 0o600 });
      const content = await hashFile(input.archivePath);
      completed = true;
      return { schema, manifestDigest: digest, ...content, entries: entries.length };
    } finally {
      if (archiveCreated && !completed) await fs.rm(input.archivePath, { force: true });
      await fs.rm(scratch, { recursive: true, force: true });
    }
  }
  if (!input.targetDir || !/^[a-f0-9]{64}$/.test(input.expectedManifestDigest ?? "")) fail("restore_binding_invalid");
  if (input.maxEntries !== undefined && (!Number.isSafeInteger(input.maxEntries) || input.maxEntries < 0)) fail("restore_binding_invalid");
  if (input.maxManifestBytes !== undefined && (!Number.isSafeInteger(input.maxManifestBytes) || input.maxManifestBytes < 0)) fail("restore_binding_invalid");
  const archive = await fs.open(input.archivePath, "r");
  let staging: string | undefined;
  const stagedDirectories: string[] = [];
  try {
    const prefix = Buffer.alloc(magic.length + 4);
    if ((await archive.read(prefix, 0, prefix.length, 0)).bytesRead !== prefix.length || !prefix.subarray(0, magic.length).equals(magic)) fail("invalid_header");
    check();
    const manifestSize = prefix.readUInt32BE(magic.length);
    if (manifestSize > 64 * 1024 * 1024 || input.maxManifestBytes !== undefined && manifestSize > input.maxManifestBytes) fail("manifest_too_large");
    const bytes = Buffer.alloc(manifestSize);
    if ((await archive.read(bytes, 0, manifestSize, prefix.length)).bytesRead !== manifestSize) fail("truncated");
    check();
    const manifest = JSON.parse(bytes.toString("utf8")) as { schema: string; entries: Entry[] };
    if (manifest.schema !== schema || !Array.isArray(manifest.entries) || manifestHash(manifest) !== input.expectedManifestDigest) fail("manifest_mismatch");
    if (input.maxEntries !== undefined && manifest.entries.length > input.maxEntries) fail("entry_limit");
    const kinds = new Map<string, string>(); let bodySize = 0;
    for (const entry of manifest.entries) {
      check();
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
    check();
    staging = await fs.mkdtemp(path.join(parent, ".workspace-restore-"));
    let offset = prefix.length + manifestSize;
    const buffer = Buffer.alloc(1024 * 1024);
    for (const entry of manifest.entries) {
      check(); const target = path.join(staging, entry.path);
      if (entry.type === "directory") { await fs.mkdir(target, { mode: 0o700 }); stagedDirectories.push(target); }
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
    for (const entry of manifest.entries.filter(entry => entry.type === "directory").reverse()) {
      check(); await fs.chmod(path.join(staging, entry.path), entry.mode!);
    }
    const content = await hashFile(input.archivePath);
    check();
    await fs.rename(staging, input.targetDir!); staging = undefined;
    return { schema, manifestDigest: input.expectedManifestDigest!, ...content, entries: manifest.entries.length };
  } finally {
    await archive.close();
    if (staging) {
      for (const directory of stagedDirectories) await fs.chmod(directory, 0o700).catch(() => undefined);
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}

export function captureRemoteWorkspaceDirectory(input: { cwd: string; archivePath: string; manifestPath?: string; exclude?: string[]; signal?: AbortSignal }) {
  return workspaceArchive({ ...input, kind: "capture" });
}

export function restoreRemoteWorkspaceArchive(input: { archivePath: string; targetDir: string; expectedManifestDigest: string; signal?: AbortSignal; maxEntries?: number; maxManifestBytes?: number }) {
  return workspaceArchive({ ...input, kind: "restore" });
}

export function remoteWorkspaceCaptureFailureMessage(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const failure = error as { message?: unknown; code?: unknown; stderr?: unknown };
  const diskFull = "remote_workspace_sandbox_disk_full: the sandbox disk is full; free space in the sandbox before saving the workspace";
  const validation = [
    "remote_workspace_archive_changed", "remote_workspace_archive_unsupported_filename",
    "remote_workspace_archive_unsafe_git_link", "remote_workspace_archive_invalid_git_repository",
    "remote_workspace_archive_unsafe_symlink",
    "remote_workspace_archive_unsupported_entry", "remote_workspace_archive_source_missing",
    "remote_workspace_archive_source_invalid", "remote_workspace_archive_credential_in_git_remote",
    "remote_workspace_archive_unsupported_git_setting", "remote_workspace_archive_manifest_too_large",
    "remote_workspace_archive_git_operation_in_progress: finish or abort the Git operation before saving the workspace",
    diskFull,
  ];
  if (typeof failure.message === "string" && validation.includes(failure.message)) return failure.message;
  const childText = (typeof failure.stderr === "string" ? failure.stderr : "")
    + (typeof failure.message === "string" ? failure.message : "");
  if (failure.code === "ENOSPC" || failure.code === "EDQUOT" || /No space left on device|Disk quota exceeded/i.test(childText)) return diskFull;
  for (const code of ["EACCES", "EPERM", "ENOENT", "ENOTDIR", "EISDIR", "ELOOP", "EMFILE", "ENFILE", "EIO", "EROFS", "EEXIST"]) {
    const message = `remote_workspace_archive_fs_${code.toLowerCase()}`;
    if (failure.code === code || failure.message === message) return message;
  }
  return null;
}

/**
 * A bounded cause for an unclassified sandbox failure. It runs in the sandbox,
 * so it is self-contained. Each field has a fixed key and a value of at most 64
 * `[A-Za-z0-9_]` characters taken from structured error properties; it never
 * includes error text, command lines, or paths.
 */
export function remoteWorkspaceFailureDetail(error: unknown): string {
  if (!error || typeof error !== "object") return "";
  const failure = error as { code?: unknown; signal?: unknown; syscall?: unknown; killed?: unknown; cmd?: unknown; name?: unknown; message?: unknown };
  const fields: string[] = [];
  if (typeof failure.code === "string" && /^(E[A-Z0-9]{1,20}|ERR_[A-Z0-9_]{1,56})$/.test(failure.code)) fields.push(`code=${failure.code}`);
  if (typeof failure.code === "number" && Number.isSafeInteger(failure.code) && failure.code >= 0 && failure.code <= 255) fields.push(`exit=${failure.code}`);
  if (typeof failure.signal === "string" && /^SIG[A-Z0-9]{1,12}$/.test(failure.signal)) fields.push(`signal=${failure.signal}`);
  if (typeof failure.syscall === "string" && /^[a-z_]{1,24}$/.test(failure.syscall)) fields.push(`syscall=${failure.syscall}`);
  if (failure.killed === true) fields.push("killed=true");
  if (typeof failure.cmd === "string" && failure.cmd.startsWith("git ")) fields.push("program=git");
  if (typeof failure.name === "string" && ["TypeError", "RangeError", "SyntaxError", "ReferenceError", "AbortError"].includes(failure.name)) {
    fields.push(`name=${failure.name}`);
  }
  const reason = typeof failure.message === "string" ? /^(?:remote_workspace_archive_)?([a-z_]{1,48})$/.exec(failure.message)?.[1] : undefined;
  if (reason && (failure.message !== reason || ["unsafe", "unsafe_capture", "invalid_capture", "capture_missing"].includes(reason))) {
    fields.push(`reason=${reason}`);
  }
  return fields.join(" ");
}

export function remoteWorkspaceArchiveScript(): string {
  // tsx's function-name preservation helper may appear in Function#toString.
  const source = workspaceArchive.toString().replaceAll("__vite_ssr_dynamic_import__", "import");
  return `const __name = (value) => value;\nconst captureFailure = ${remoteWorkspaceCaptureFailureMessage.toString()};\nconst failureDetail = ${remoteWorkspaceFailureDetail.toString()};\nconst archive = ${source};\nconst [kind, first, second, digest] = process.argv.slice(2);\narchive(kind === 'capture' ? {kind,cwd:first,archivePath:second} : {kind,archivePath:first,targetDir:second,expectedManifestDigest:digest}).then(value=>process.stdout.write(JSON.stringify(value))).catch(error=>{const detail = failureDetail(error);process.stderr.write(kind === 'capture' ? captureFailure(error) ?? ('remote_workspace_archive_failed' + (detail ? ': ' + detail : '')) : error.message);process.exitCode=1;});\n`;
}
