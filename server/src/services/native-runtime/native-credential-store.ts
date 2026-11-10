import { rm } from "node:fs/promises";
import { join, posix } from "node:path";
import type { CommandManagedRuntimeRunner } from "@paperclipai/adapter-utils/command-managed-runtime";
import { readLocalAiCredentialFile } from "../local-ai-credential-file.js";

// Descriptor reads keep credentials private, bounded, and independent of the workspace.
const READ_CREDENTIAL = `
const fs = require('node:fs'), path = require('node:path');
let fd;
try {
  const file = process.argv[1];
  let parent = path.dirname(file);
  while (true) {
    if (!fs.lstatSync(parent).isDirectory()) throw Error('directory');
    const next = path.dirname(parent);
    if (next === parent) break;
    parent = next;
  }
  fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  const before = fs.fstatSync(fd);
  if (!before.isFile() || before.uid !== process.getuid() || (before.mode & 511) !== 384 || before.size > 65536) throw Error('credential');
  const bytes = Buffer.alloc(65537);
  let size = 0;
  while (size < bytes.length) {
    const count = fs.readSync(fd, bytes, size, bytes.length - size, size);
    if (!count) break;
    size += count;
  }
  const after = fs.fstatSync(fd);
  if (size > 65536 || ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].some(key => before[key] !== after[key])) throw Error('credential');
  process.stdout.write(bytes.subarray(0, size).toString('base64'));
  bytes.fill(0);
} catch (error) {
  process.exitCode = error.code === 'ENOENT' ? 66 : 1;
} finally {
  if (fd !== undefined) fs.closeSync(fd);
}`;

export function createNativeCredentialStore(input: {
  provider: "codex" | "grok";
  localHome: string;
  remoteHome?: string;
  runner?: Pick<CommandManagedRuntimeRunner, "execute">;
}) {
  if (Boolean(input.remoteHome) !== Boolean(input.runner)) throw new Error("native_credential_store_target_unavailable");
  const names = ["auth.json", "auth-refresh.json"];
  const read = async (name: string): Promise<string> => {
    if (!input.runner || !input.remoteHome) return readLocalAiCredentialFile(join(input.localHome, name));
    // Remote isolated-home preparation already requires Node. Read only on a refresh or retirement.
    const result = await input.runner.execute({ command: "node", args: ["-e", READ_CREDENTIAL, posix.join(input.remoteHome, name)], bypassSession: true, timeoutMs: 10_000 });
    if (result.exitCode !== 0 || result.timedOut) throw Object.assign(new Error("Native credential export unavailable"), {
      code: result.exitCode === 66 && !result.timedOut ? "ENOENT" : "INVALID_CREDENTIAL",
    });
    const encoded = result.stdout.trim(), bytes = Buffer.from(encoded, "base64");
    if (bytes.length > 65_536 || bytes.toString("base64") !== encoded) throw new Error("Native credential export invalid");
    return bytes.toString("utf8");
  };
  return {
    read: async () => {
      try { return await read(names[0]!); }
      catch (error) {
        if (names.length !== 2 || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return read(names[1]!);
      }
    },
    remove: async () => {
      for (const name of [...names, "auth-refresh.json.tmp"]) {
        await rm(join(input.localHome, name), { force: true });
        if (input.runner && input.remoteHome) {
          const result = await input.runner.execute({ command: "rm", args: ["-f", "--", posix.join(input.remoteHome, name)], bypassSession: true, timeoutMs: 10_000 });
          if (result.exitCode !== 0 || result.timedOut) throw new Error("Native credential cleanup failed");
        }
      }
    },
  };
}
