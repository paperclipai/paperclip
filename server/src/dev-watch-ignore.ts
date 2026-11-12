import fs from "node:fs";
import path from "node:path";

function toGlobstarPath(candidate: string): string {
  return `${candidate.replaceAll(path.sep, "/")}/**`;
}

function addIgnorePath(target: Set<string>, candidate: string): void {
  target.add(candidate);
  target.add(toGlobstarPath(candidate));
  try {
    const realPath = fs.realpathSync(candidate);
    target.add(realPath);
    target.add(toGlobstarPath(realPath));
  } catch {
    // Ignore paths that do not exist in the current checkout.
  }
}

export function resolveServerDevWatchIgnorePaths(serverRoot: string): string[] {
  const checkoutRoot = path.dirname(serverRoot);
  const linkedWorktreesRoot = path.dirname(checkoutRoot);
  const isLinkedWorktree =
    path.basename(linkedWorktreesRoot) === "worktrees" &&
    path.basename(path.dirname(linkedWorktreesRoot)) === ".paperclip";
  const ignorePaths = new Set<string>([
    "**/{node_modules,bower_components,vendor}/**",
    "**/.vite-temp/**",
  ]);

  for (const relativePath of [
    "../ui/node_modules",
    "../ui/node_modules/.vite-temp",
    "../ui/.vite",
    "../ui/dist",
    // Git worktrees live under <repo>/.paperclip/worktrees, each a full
    // checkout (source + its own .paperclip). Watching them can add hundreds
    // of thousands of files, stalling tsx watch before it ever spawns the
    // server. None of them are part of this checkout's reloadable source.
    // A linked checkout has serverRoot at
    // <repo>/.paperclip/worktrees/<branch>/server. In that case, the shared
    // worktree directory is the checkout's parent, not a nested path.
    isLinkedWorktree ? "../.." : "../.paperclip/worktrees",
    // npm install during reinstall would trigger a restart mid-request
    // if tsx watch sees the new files. Exclude the managed plugins dir.
    process.env.HOME + "/.paperclip/adapter-plugins",
  ]) {
    addIgnorePath(ignorePaths, path.resolve(serverRoot, relativePath));
  }

  return [...ignorePaths];
}
