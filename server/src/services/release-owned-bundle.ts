import fs from "node:fs";
import path from "node:path";

function trustedEntry(entry: fs.Stats, serviceUid: number): boolean {
  // Symlink mode bits are meaningless on Linux; the checked parent controls
  // whether an agent can replace the link itself.
  return (entry.uid === serviceUid || entry.uid === 0) &&
    (entry.isSymbolicLink() || (entry.mode & 0o022) === 0);
}

function pathParts(absolute: string): { root: string; remaining: string[] } {
  const root = path.parse(absolute).root;
  return { root, remaining: absolute.slice(root.length).split(path.sep).filter(Boolean) };
}

function hasInternalParentTraversal(value: string): boolean {
  let enteredDirectory = false;
  for (const segment of value.split(path.sep)) {
    if (segment === ".." && enteredDirectory) return true;
    if (segment && segment !== "." && segment !== "..") enteredDirectory = true;
  }
  return false;
}

/** Check each original path component, including links hidden by realpath. */
function checkedRealpathSync(input: string, serviceUid: number): string | null {
  if (input.split(path.sep).includes("..")) return null;
  let { root, remaining } = pathParts(path.resolve(input));
  let current = root;
  let links = 0;
  if (!trustedEntry(fs.lstatSync(root), serviceUid)) return null;
  while (remaining.length) {
    const candidate = path.join(current, remaining.shift()!);
    const entry = fs.lstatSync(candidate);
    if (!trustedEntry(entry, serviceUid)) return null;
    if (entry.isSymbolicLink()) {
      if (++links > 40) return null;
      const target = fs.readlinkSync(candidate);
      if (hasInternalParentTraversal(target)) return null;
      ({ root, remaining } = pathParts(path.resolve(current, target, ...remaining)));
      current = root;
    } else {
      if (remaining.length && !entry.isDirectory()) return null;
      current = candidate;
    }
  }
  // Reject unusual link paths whose kernel resolution differs from the
  // lexical walk (for example a linked component followed by `..`).
  return fs.realpathSync(input) === current ? current : null;
}

async function checkedRealpath(input: string, serviceUid: number): Promise<string | null> {
  if (input.split(path.sep).includes("..")) return null;
  let { root, remaining } = pathParts(path.resolve(input));
  let current = root;
  let links = 0;
  if (!trustedEntry(await fs.promises.lstat(root), serviceUid)) return null;
  while (remaining.length) {
    const candidate = path.join(current, remaining.shift()!);
    const entry = await fs.promises.lstat(candidate);
    if (!trustedEntry(entry, serviceUid)) return null;
    if (entry.isSymbolicLink()) {
      if (++links > 40) return null;
      const target = await fs.promises.readlink(candidate);
      if (hasInternalParentTraversal(target)) return null;
      ({ root, remaining } = pathParts(path.resolve(current, target, ...remaining)));
      current = root;
    } else {
      if (remaining.length && !entry.isDirectory()) return null;
      current = candidate;
    }
  }
  return await fs.promises.realpath(input) === current ? current : null;
}

export function isReleaseOwnedBundleTree(bundlePath: string): boolean {
  const serviceUid = process.getuid?.();
  if (process.platform !== "linux" || serviceUid === undefined || serviceUid === 0) return false;

  const visitedDirectories = new Set<string>();
  const pending = [bundlePath];
  while (pending.length > 0) {
    const actual = checkedRealpathSync(pending.pop()!, serviceUid);
    if (!actual) return false;
    const entry = fs.lstatSync(actual);
    if (entry.isFile()) continue;
    if (!entry.isDirectory()) return false;
    if (visitedDirectories.has(actual)) continue;
    visitedDirectories.add(actual);
    for (const name of fs.readdirSync(actual)) pending.push(path.join(actual, name));
  }
  return true;
}

const inFlightBundleChecks = new Map<string, Promise<boolean>>();

/** Share simultaneous checks while keeping later activation checks fresh. */
export function isReleaseOwnedBundleTreeAsync(bundlePath: string): Promise<boolean> {
  const key = path.resolve(bundlePath);
  const existing = inFlightBundleChecks.get(key);
  if (existing) return existing;
  const check = (async () => {
    const serviceUid = process.getuid?.();
    if (process.platform !== "linux" || serviceUid === undefined || serviceUid === 0) return false;
    const visitedDirectories = new Set<string>();
    const pending = [bundlePath];
    while (pending.length > 0) {
      const actual = await checkedRealpath(pending.pop()!, serviceUid);
      if (!actual) return false;
      const entry = await fs.promises.lstat(actual);
      if (entry.isFile()) continue;
      if (!entry.isDirectory()) return false;
      if (visitedDirectories.has(actual)) continue;
      visitedDirectories.add(actual);
      for (const name of await fs.promises.readdir(actual)) pending.push(path.join(actual, name));
    }
    return true;
  })();
  inFlightBundleChecks.set(key, check);
  void check.then(
    () => { if (inFlightBundleChecks.get(key) === check) inFlightBundleChecks.delete(key); },
    () => { if (inFlightBundleChecks.get(key) === check) inFlightBundleChecks.delete(key); },
  );
  return check;
}
