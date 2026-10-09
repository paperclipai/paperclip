import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export interface RepositoryFileReceipt { path: string; sha: string; size: number; executable: boolean }
export interface RepositoryBundleReceipt { root: string; wrapper: string; files: RepositoryFileReceipt[] }

export function repositoryRuntimeSessionRoot(instanceRoot: string, sessionId: string): string {
  return path.join(instanceRoot, "runtime", "paperclip-runner", "durable-sessions", createHash("sha256").update(sessionId).digest("hex"));
}

/** Bind disk locations to the active native session, rather than library caches. */
export function isOwnedRepositoryRuntimeRoot(root: string, sessionId: string, location:
  { kind: "local"; instanceRoot: string; contextSkills?: { sessionId: string; roots: string[] } } | { kind: "daytona"; remoteCwd: string }): boolean {
  if (!sessionId || path.posix.normalize(root) !== root) return false;
  const digest = createHash("sha256").update(sessionId).digest("hex");
  const parent = path.posix.dirname(root);
  if (location.kind === "local") return parent === path.join(repositoryRuntimeSessionRoot(location.instanceRoot, sessionId), "codex-home", "skills")
    || (location.contextSkills?.sessionId === sessionId && location.contextSkills.roots.includes(root)
      && parent === path.join(location.instanceRoot, "runtime-context-assets", "bundles"));
  const filesystem = path.posix.join(location.remoteCwd, ".paperclip-runtime", "paperclip-runner", "sessions", digest, "filesystem");
  return parent === path.posix.join(filesystem, "codex-home", "skills")
    || parent === path.posix.join(filesystem, "context", "skills");
}

/** Independent disk evidence; never follows imported links or reads provider auth. */
export function inspectRepositoryBundle(root: string): RepositoryBundleReceipt {
  const canonical = path.join(root, ".paperclip-repository");
  if (lstatSync(canonical).isSymbolicLink() || realpathSync(canonical) !== canonical) throw new Error("Repository root is not a regular directory");
  const files: RepositoryFileReceipt[] = [];
  function walk(directory: string) {
    for (const name of readdirSync(directory).sort()) {
      const file = path.join(directory, name), stat = lstatSync(file);
      if (stat.isDirectory()) walk(file);
      else {
        if (!stat.isFile()) throw new Error("Non-regular repository file");
        const bytes = readFileSync(file);
        const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
        files.push({ path: path.relative(canonical, file).split(path.sep).join("/"), sha, size: bytes.length, executable: Boolean(stat.mode & 0o111) });
      }
    }
  }
  walk(canonical);
  return { root, wrapper: readFileSync(path.join(root, "SKILL.md"), "utf8"), files };
}

/** Equivalent read-only inspector for the owned Linux sandbox. */
export function remoteRepositoryInspector(roots: string[]): string {
  const source = `const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
function inspect(root) {
  root=fs.realpathSync(root);
  const canonical=path.join(root,'.paperclip-repository'),files=[];
  if(fs.lstatSync(canonical).isSymbolicLink()||fs.realpathSync(canonical)!==canonical) throw Error('Invalid repository root');
  function walk(directory) { for(const name of fs.readdirSync(directory).sort()) {
    const file=path.join(directory,name),stat=fs.lstatSync(file);
    if(stat.isDirectory()) walk(file);
    else { if(!stat.isFile()) throw Error('Non-regular repository file');
      const bytes=fs.readFileSync(file);
      files.push({path:path.relative(canonical,file).split(path.sep).join('/'),sha:crypto.createHash('sha1').update('blob '+bytes.length+'\\0').update(bytes).digest('hex'),size:bytes.length,executable:Boolean(stat.mode&0o111)});
    }
  } }
  walk(canonical);
  return {root,wrapper:fs.readFileSync(path.join(root,'SKILL.md'),'utf8'),files};
}
process.stdout.write(JSON.stringify(${JSON.stringify(roots)}.map(inspect)));`;
  return `node -e 'eval(Buffer.from("${Buffer.from(source).toString("base64")}","base64").toString())'`;
}

export function gradeRepositoryBundles(bundles: RepositoryBundleReceipt[], expected: RepositoryFileReceipt[], skills: string[]) {
  const sorted = (files: RepositoryFileReceipt[]) => [...files].sort((a, b) => a.path.localeCompare(b.path));
  return [
    { id: "two-distinct-runtime-packages", passed: bundles.length === skills.length && new Set(bundles.map(bundle => bundle.root)).size === skills.length },
    ...skills.map(skill => ({ id: `canonical-${skill}`, passed: bundles.filter(bundle => bundle.wrapper.includes(`.paperclip-repository/skills/${skill}/SKILL.md`)).length === 1 })),
    { id: "complete-original-repository-bytes-and-modes", passed: bundles.length === skills.length && bundles.every(bundle => JSON.stringify(sorted(bundle.files)) === JSON.stringify(sorted(expected))) },
  ];
}
