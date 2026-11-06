/** Runs unchanged in the sandbox and on its transferred, private controller copy. */
export async function readWorkspaceInventory(root: string, controllerCopy = false, signal?: AbortSignal) {
  const fs = await import("node:fs/promises"), path = await import("node:path"), crypto = await import("node:crypto");
  const fail = (): never => { throw new Error("remote_workspace_readonly_capture_unsafe"); };
  const budget = (): never => { throw new Error("remote_workspace_readonly_capture_budget"); };
  const check = () => signal?.throwIfAborted();
  check();
  if (!path.isAbsolute(root) || await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) fail();
  const digest = crypto.createHash("sha256"), exclude = [".paperclip-runtime"];
  const repositories: string[] = [], configs: string[] = [];
  let entries = 0, scannedEntries = 0, byteSize = 0, configBytes = 0;
  const gitRead = async (cwd: string, args: string[]) => {
    check();
    const { execFile } = await import("node:child_process");
    return new Promise<string>((resolve, reject) => execFile("git", ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-C", cwd, ...args], {
      signal, timeout: 10_000, maxBuffer: 64 * 1024 * 1024,
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
        GIT_OPTIONAL_LOCKS: "0", GIT_NO_LAZY_FETCH: "1" },
    }, (error, result) => error ? reject(new Error("remote_workspace_readonly_capture_unsafe")) : resolve(result)));
  };
  const visit = async (relative: string, parentRepository: string | null = null) => {
    check();
    const directory = path.join(root, relative), before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) fail();
    const names: string[] = [];
    for await (const entry of await fs.opendir(directory)) {
      check(); if (++scannedEntries > 100_000) budget(); names.push(entry.name);
    }
    const inGit = relative.split("/").includes(".git");
    const repository = !inGit && names.includes(".git") ? directory : parentRepository;
    if (!inGit && names.includes(".git")) {
      const entry = await fs.lstat(path.join(directory, ".git"));
      if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
      repositories.push(directory); if (repositories.length > 64) budget();
      // The sandbox uses the same tracked-dependency rule as normal capture.
      // Controller verification never invokes repository-aware Git here.
      if (!controllerCopy && await fs.realpath((await gitRead(directory, ["rev-parse", "--show-toplevel"])).trim()) !== directory) fail();
    }
    for (const name of names.sort()) {
      check();
      const next = relative ? `${relative}/${name}` : name;
      if (next === ".paperclip-runtime") continue;
      if (!name || name === "." || name === ".." || /[\\\u0000-\u001f\u007f]/u.test(name)) fail();
      const file = path.join(root, next), stat = await fs.lstat(file);
      // A copied worktree pointer or alternate could resolve against the
      // controller's filesystem. Only standalone, self-contained Git metadata
      // can use this fallback; the sandbox remains retained otherwise.
      const parts = next.split("/"), git = parts.indexOf(".git");
      if (name === ".git" && !stat.isDirectory()) fail();
      // Git follows configuration and administrative links itself. A link
      // inside this tree must not bypass the controller config-file check.
      if (git >= 0 && stat.isSymbolicLink()) fail();
      const administrationPath = parts.slice(git + 1).join("/");
      const foldedAdministrationPath = administrationPath.toLowerCase();
      // A case-sensitive sandbox may be copied onto a case-insensitive host.
      // Reject aliases before Git can interpret them as controller metadata.
      if (git >= 0 && ((foldedAdministrationPath === "config" && administrationPath !== "config")
        || ["commondir", "config.worktree", "objects/info/alternates", "objects/info/http-alternates"]
          .includes(foldedAdministrationPath))) fail();
      if (stat.isSocket()) { exclude.push(next); continue; }
      if (stat.isDirectory()) {
        if (!controllerCopy && !inGit) {
          const marker = await fs.lstat(name === "node_modules" ? path.join(directory, "package.json")
            : path.join(file, "pyvenv.cfg")).catch(() => null);
          if (marker?.isFile() && !marker.isSymbolicLink()
            && (!repository || !(await gitRead(directory, ["ls-files", "-z", "--", name])))) {
            exclude.push(next); continue;
          }
        }
        digest.update(JSON.stringify([next, "directory", stat.mode & 0o777])); entries++;
        await visit(next, repository);
      } else if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file), resolved = path.posix.normalize(path.posix.join(path.posix.dirname(next), target));
        if (!target || path.posix.isAbsolute(target) || /[\\\u0000-\u001f\u007f]/u.test(target)
          || resolved === ".." || resolved.startsWith("../")) fail();
        digest.update(JSON.stringify([next, "symlink", target])); entries++;
      } else if (stat.isFile()) {
        if (git >= 0 && parts.slice(git + 1).join("/") === "config") {
          configs.push(file); configBytes += stat.size;
          if (stat.size > 65_536 || configBytes > 1024 * 1024) budget();
        }
        const original = await fs.lstat(file, { bigint: true });
        const handle = await fs.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
        const hash = crypto.createHash("sha256"); let size = 0;
        try {
          const before = await handle.stat({ bigint: true });
          const fields = ["dev", "ino", "size", "mode", "mtimeNs", "ctimeNs"] as const;
          if (!before.isFile() || !original.isFile() || Number(before.dev) !== stat.dev || Number(before.ino) !== stat.ino
            || Number(before.size) !== stat.size || Number(before.mode) !== stat.mode
            || fields.some(key => original[key] !== before[key]) || await fs.realpath(file) !== file) fail();
          for await (const bytes of handle.createReadStream({ autoClose: false, signal })) { check(); size += bytes.length; hash.update(bytes); }
          const after = await handle.stat({ bigint: true }), current = await fs.lstat(file, { bigint: true });
          if (!current.isFile() || size !== Number(before.size) || await fs.realpath(file) !== file
            || fields.some(key => before[key] !== after[key] || after[key] !== current[key])) fail();
        } finally { await handle.close(); }
        byteSize += size;
        if (!Number.isSafeInteger(byteSize)) fail();
        digest.update(JSON.stringify([next, "file", stat.mode & 0o777, size, hash.digest("hex")])); entries++;
      } else fail();
    }
    const after = await fs.lstat(directory);
    if (before.dev !== after.dev || before.ino !== after.ino || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) fail();
  };
  await visit("");
  if (Buffer.byteLength(JSON.stringify(exclude)) > 65_536) fail();
  if (controllerCopy) {
    // Bound the complete tree and verify every repository layout before the
    // first controller subprocess. Files named config inside Git metadata are
    // ordinary data unless they are the exact repository-root configuration.
    for (const repository of repositories) {
      check();
      const directory = path.join(repository, ".git"), head = path.join(directory, "HEAD");
      if ((await fs.stat(head)).size > 4096 || !/^(ref: refs\/\S+|[0-9a-f]{40}|[0-9a-f]{64})\s*$/u.test(await fs.readFile(head, "utf8"))) fail();
      if (!(await fs.lstat(path.join(directory, "objects"))).isDirectory()
        || !(await fs.lstat(path.join(directory, "refs")).catch(() => fs.lstat(path.join(directory, "reftable")))).isDirectory()) fail();
    }
    let settings = 0, refspecs = 0;
    for (const config of configs) {
      check();
      // Parse this file as data. Never discover a repository or follow includes.
      const keys = (await gitRead(path.dirname(root), ["config", "--file", config, "--no-includes", "--null", "--name-only", "--list"]))
        .split("\0").filter(Boolean);
      settings += keys.length; refspecs += keys.filter(key => /^remote\..+\.fetch$|^branch\..+\.merge$/u.test(key)).length;
      if (settings > 1024 || refspecs > 256) budget();
      const portableKey = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|sparsecheckout|sparsecheckoutcone)|index\.sparse|extensions\.(?:objectformat|refstorage|partialclone)|remote\..+\.(?:url|pushurl|fetch|promisor|partialclonefilter)|branch\..+\.(?:remote|merge|rebase)|user\.(?:name|email))$/u;
      if (!keys.every(key => portableKey.test(key))) fail();
    }
  }
  return { sha256: digest.digest("hex"), byteSize, entries, exclude };
}

export function readonlyWorkspaceInventoryScript() {
  const source = readWorkspaceInventory.toString().replaceAll("__vite_ssr_dynamic_import__", "import");
  return `const __name=value=>value;const inspect=${source};inspect(process.argv[1]).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>{process.stderr.write('remote_workspace_readonly_capture_unsafe');process.exitCode=1});`;
}
