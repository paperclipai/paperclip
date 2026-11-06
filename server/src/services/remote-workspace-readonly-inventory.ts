/** Runs unchanged in the sandbox and on its transferred, private controller copy. */
export async function readWorkspaceInventory(root: string, controllerCopy = false) {
  const fs = await import("node:fs/promises"), path = await import("node:path"), crypto = await import("node:crypto");
  const { createReadStream } = await import("node:fs");
  const fail = (): never => { throw new Error("remote_workspace_readonly_capture_unsafe"); };
  if (!path.isAbsolute(root) || await fs.realpath(root) !== root || !(await fs.lstat(root)).isDirectory()) fail();
  const digest = crypto.createHash("sha256"), exclude = [".paperclip-runtime"];
  let entries = 0, byteSize = 0;
  const visit = async (relative: string) => {
    const directory = path.join(root, relative), before = await fs.lstat(directory);
    if (!before.isDirectory() || before.isSymbolicLink() || await fs.realpath(directory) !== directory) fail();
    for (const name of (await fs.readdir(directory)).sort()) {
      const next = relative ? `${relative}/${name}` : name;
      if (next === ".paperclip-runtime") continue;
      if (!name || name === "." || name === ".." || /[\\\u0000-\u001f\u007f]/u.test(name)) fail();
      const file = path.join(root, next), stat = await fs.lstat(file);
      // A copied worktree pointer or alternate could resolve against the
      // controller's filesystem. Only standalone, self-contained Git metadata
      // can use this fallback; the sandbox remains retained otherwise.
      const parts = next.split("/"), git = parts.lastIndexOf(".git");
      if (name === ".git" && !stat.isDirectory()) fail();
      // Git follows configuration and administrative links itself. A link
      // inside this tree must not bypass the controller config-file check.
      if (git >= 0 && stat.isSymbolicLink()) fail();
      if (git >= 0 && ["commondir", "config.worktree", "objects/info/alternates", "objects/info/http-alternates"]
        .includes(parts.slice(git + 1).join("/"))) fail();
      if (stat.isSocket()) { exclude.push(next); continue; }
      if (stat.isDirectory()) {
        digest.update(JSON.stringify([next, "directory", stat.mode & 0o777])); entries++;
        await visit(next);
      } else if (stat.isSymbolicLink()) {
        const target = await fs.readlink(file), resolved = path.posix.normalize(path.posix.join(path.posix.dirname(next), target));
        if (!target || path.posix.isAbsolute(target) || /[\\\u0000-\u001f\u007f]/u.test(target)
          || resolved === ".." || resolved.startsWith("../")) fail();
        digest.update(JSON.stringify([next, "symlink", target])); entries++;
      } else if (stat.isFile()) {
        if (controllerCopy && git >= 0 && name === "config") {
          const { execFile } = await import("node:child_process");
          // Parse only this file, without discovering a repository or following
          // includes. Normalization may use Git only after all configs fit the
          // portable key contract. Path-bearing and executable settings cannot
          // make that later Git process read or execute controller resources.
          const portableKey = /^(?:core\.(?:repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks|sparsecheckout|sparsecheckoutcone)|index\.sparse|extensions\.(?:objectformat|refstorage|partialclone)|remote\..+\.(?:url|pushurl|fetch|promisor|partialclonefilter)|branch\..+\.(?:remote|merge|rebase)|user\.(?:name|email))$/u;
          await new Promise<void>((resolve, reject) => execFile("git", ["config", "--file", file, "--no-includes", "--null", "--name-only", "--list"], {
            timeout: 10_000, maxBuffer: 65_536,
            env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" },
          }, (error, keys) => !error && keys.split("\0").filter(Boolean).every(key => portableKey.test(key))
            ? resolve() : reject(new Error("remote_workspace_readonly_capture_unsafe"))));
        }
        const hash = crypto.createHash("sha256"); let size = 0;
        for await (const bytes of createReadStream(file)) { size += bytes.length; hash.update(bytes); }
        const after = await fs.lstat(file);
        if (!after.isFile() || stat.dev !== after.dev || stat.ino !== after.ino || stat.size !== after.size
          || stat.mtimeMs !== after.mtimeMs || stat.ctimeMs !== after.ctimeMs || size !== stat.size) fail();
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
  return { sha256: digest.digest("hex"), byteSize, entries, exclude };
}

export function readonlyWorkspaceInventoryScript() {
  const source = readWorkspaceInventory.toString().replaceAll("__vite_ssr_dynamic_import__", "import");
  return `const __name=value=>value;const inspect=${source};inspect(process.argv[1]).then(value=>process.stdout.write(JSON.stringify(value))).catch(()=>{process.stderr.write('remote_workspace_readonly_capture_unsafe');process.exitCode=1});`;
}
