import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unprocessable } from "../errors.js";

export const MAX_INSTRUCTION_BYTES = 1024 * 1024;
export function instructionPath(value: string): string {
  if (
    !value ||
    value.length > 512 ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[a-z]:/i.test(value) ||
    value.split("/").some((part) => !part || part === "." || part === "..")
  ) {
    throw unprocessable("Use a relative instructions path without traversal", {
      code: "INSTRUCTION_PATH_INVALID",
    });
  }
  return value;
}

export function instructionBytes(content: string | Uint8Array): Buffer {
  const byteLength =
    typeof content === "string"
      ? Buffer.byteLength(content, "utf8")
      : content.byteLength;
  if (byteLength > MAX_INSTRUCTION_BYTES) {
    throw unprocessable("Instructions exceed the 1 MiB limit", {
      code: "INSTRUCTION_CONTENT_INVALID",
    });
  }
  const bytes =
    typeof content === "string"
      ? Buffer.from(content, "utf8")
      : Buffer.from(content);
  try {
    // Preserve BOM; reject invalid UTF-8 and unpaired JS surrogates instead of replacing bytes.
    const decoded = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(bytes);
    if (typeof content === "string" && decoded !== content)
      throw new Error("invalid Unicode");
  } catch {
    throw unprocessable("Instructions must be valid UTF-8", {
      code: "INSTRUCTION_CONTENT_INVALID",
    });
  }
  return bytes;
}

export async function assertInstructionPathSafe(
  root: string,
  entryFile: string,
) {
  instructionPath(entryFile);
  let absolute = path.resolve(root, entryFile);
  // macOS exposes its system temporary directories through root-owned aliases.
  // Resolve only those fixed OS aliases, never a link in operator/agent storage.
  if (process.platform === "darwin") {
    const alias = absolute.split(path.sep)[1];
    if (alias === "var" || alias === "tmp" || alias === "etc") {
      const systemPath = `/${alias}`;
      const stat = await fs.lstat(systemPath);
      if (stat.isSymbolicLink() && stat.uid === 0 && await fs.realpath(systemPath) === `/private/${alias}`) {
        absolute = `/private${absolute}`;
      }
    }
  }
  let current = path.parse(absolute).root;
  const parts = absolute.slice(current.length).split(path.sep);
  for (const [i, part] of parts.entries()) {
    current = path.join(current, part);
    const stat = await fs
      .lstat(current)
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
      });
    if (!stat) continue;
    if (
      stat.isSymbolicLink() ||
      (i < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())
    ) {
      throw unprocessable(
        "Instructions require regular files and directories without symlinks",
        { code: "INSTRUCTION_PATH_INVALID" },
      );
    }
  }
  return absolute;
}

export async function readInstructionBytes(
  root: string,
  entryFile: string,
): Promise<Buffer | null> {
  const absolute = await assertInstructionPathSafe(root, entryFile);
  const file = await fs
    .open(absolute, constants.O_RDONLY | constants.O_NOFOLLOW)
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
  if (!file) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_INSTRUCTION_BYTES) {
      throw unprocessable(
        "Instructions must be a regular UTF-8 file of at most 1 MiB",
        { code: "INSTRUCTION_CONTENT_INVALID" },
      );
    }
    const buffer = Buffer.alloc(MAX_INSTRUCTION_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const result = await file.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (result.bytesRead === 0) break;
      length += result.bytesRead;
    }
    return instructionBytes(buffer.subarray(0, length));
  } finally {
    await file.close();
  }
}

/** Call while holding the canonical agent lock. Never writes through a symlink. */
export async function materializeInstructionBytes(
  root: string,
  entryFile: string,
  bytes: Buffer,
) {
  const absolute = await assertInstructionPathSafe(root, entryFile);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await assertInstructionPathSafe(root, entryFile);
  const temporary = path.join(
    path.dirname(absolute),
    `.instruction-${randomUUID()}.tmp`,
  );
  try {
    const file = await fs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await assertInstructionPathSafe(root, entryFile);
    await fs.rename(temporary, absolute);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

// Keep the reserved runtime directory out of Git using a self-ignoring file
// inside that directory. Never write to a gitdir or exclude path derived from
// repository-controlled metadata; legitimate worktrees can keep external gitdirs.
export const instructionGitExcludeProgram = String.raw`
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const cwd=fs.realpathSync(process.argv[1]);
const root=path.join(cwd,'.paperclip-runtime'),filename=path.join(root,'.gitignore');
const stat=(name)=>{try{return fs.lstatSync(name)}catch(e){if(e.code==='ENOENT')return null;throw e}};
const directory=stat(root);
if(directory && (directory.isSymbolicLink() || !directory.isDirectory()))throw Error('Unsafe runtime exclusion directory');
if(!directory)fs.mkdirSync(root,{mode:0o700});
const existing=stat(filename);
if(existing && (existing.isSymbolicLink() || !existing.isFile()))throw Error('Unsafe runtime exclusion file');
const temporary=path.join(root,'.ignore-'+crypto.randomUUID()+'.tmp');
try{fs.writeFileSync(temporary,'*\n',{flag:'wx',mode:0o600});fs.renameSync(temporary,filename)}finally{fs.rmSync(temporary,{force:true})}
`;
