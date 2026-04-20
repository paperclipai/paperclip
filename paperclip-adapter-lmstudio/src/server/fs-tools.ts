import { readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { glob as globPromise } from "node:fs/promises";
import { safePath } from "./path-safety.js";

// ToolResult is defined in paperclip-tools.ts (Task 3).
// We re-declare it here as a local interface so this module compiles
// independently; the shapes are identical.
export interface ToolResult {
  content: string;
  isError: boolean;
}

async function readFileHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path), allowedWriteRoots);
  const content = await readFile(targetPath, "utf-8");

  let lines = content.split("\n");
  const offset = typeof args.offset === "number" ? Math.max(0, args.offset - 1) : 0;
  const limit = typeof args.limit === "number" ? args.limit : lines.length;
  lines = lines.slice(offset, offset + limit);

  return { content: lines.join("\n"), isError: false };
}

async function writeFileHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path), allowedWriteRoots);
  await mkdir(dirname(targetPath), { recursive: true });
  const content = String(args.content);
  await writeFile(targetPath, content, "utf-8");
  const size = Buffer.byteLength(content, "utf-8");
  return { content: `File written: ${args.path} (${size} bytes)`, isError: false };
}

async function listDirectoryHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const targetPath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const entries = await readdir(targetPath, { withFileTypes: true });
  const lines = entries.map((e) => {
    const suffix = e.isDirectory() ? "/" : "";
    return `${e.name}${suffix}`;
  });
  return { content: lines.join("\n"), isError: false };
}

async function globHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const pattern = String(args.pattern);
  const matches: string[] = [];
  for await (const entry of globPromise(pattern, { cwd: basePath })) {
    matches.push(entry);
  }
  return { content: matches.join("\n"), isError: false };
}

async function grepHandler(args: Record<string, unknown>, cwd: string, allowedWriteRoots: string[]): Promise<ToolResult> {
  const basePath = safePath(cwd, String(args.path ?? "."), allowedWriteRoots);
  const pattern = String(args.pattern);
  const globFilter = args.glob ? String(args.glob) : "**/*";
  const regex = new RegExp(pattern);

  const results: string[] = [];
  for await (const entry of globPromise(globFilter, { cwd: basePath })) {
    const fullPath = safePath(basePath, entry, allowedWriteRoots);
    try {
      const content = await readFile(fullPath, "utf-8");
      const lines = content.split("\n");
      lines.forEach((line, i) => {
        if (regex.test(line)) {
          results.push(`${entry}:${i + 1}: ${line}`);
        }
      });
    } catch {
      // Skip unreadable files (directories, binary files, etc.)
    }
  }

  return { content: results.join("\n") || "(no matches)", isError: false };
}

export async function executeFsTool(
  name: string,
  args: Record<string, unknown>,
  cwd: string,
  allowedWriteRoots: string[] = [],
): Promise<ToolResult> {
  try {
    switch (name) {
      case "fs_read_file": return await readFileHandler(args, cwd, allowedWriteRoots);
      case "fs_write_file": return await writeFileHandler(args, cwd, allowedWriteRoots);
      case "fs_list_directory": return await listDirectoryHandler(args, cwd, allowedWriteRoots);
      case "fs_glob": return await globHandler(args, cwd, allowedWriteRoots);
      case "fs_grep": return await grepHandler(args, cwd, allowedWriteRoots);
      default:
        return { content: `Unknown fs tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: msg, isError: true };
  }
}
