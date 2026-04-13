import fs from "node:fs/promises";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";

const ENTRY_FILE_DEFAULT = "COMPANY.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

type CompanyInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
};

type CompanyInstructionsFileDetail = CompanyInstructionsFileSummary & {
  content: string;
};

type CompanyInstructionsBundle = {
  companyId: string;
  rootPath: string;
  entryFile: string;
  files: CompanyInstructionsFileSummary[];
};

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

export function resolveCompanyInstructionsRoot(companyId: string): string {
  return path.resolve(resolvePaperclipInstanceRoot(), "companies", companyId, "instructions");
}

function shouldIgnoreEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<CompanyInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
  };
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

export function companyInstructionsService() {
  const entryFile = ENTRY_FILE_DEFAULT;

  async function getBundle(companyId: string): Promise<CompanyInstructionsBundle> {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const stat = await statIfExists(rootPath);
    if (!stat?.isDirectory()) {
      return { companyId, rootPath, entryFile, files: [] };
    }
    const files = await listFilesRecursive(rootPath);
    const summaries = await Promise.all(
      files.map((relativePath) => readFileSummary(rootPath, relativePath, entryFile)),
    );
    return { companyId, rootPath, entryFile, files: summaries };
  }

  async function readFile(companyId: string, relativePath: string): Promise<CompanyInstructionsFileDetail> {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Instructions file not found");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === entryFile,
      content,
    };
  }

  async function writeFile(
    companyId: string,
    relativePath: string,
    content: string,
  ): Promise<{ bundle: CompanyInstructionsBundle; file: CompanyInstructionsFileDetail }> {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    await fs.mkdir(rootPath, { recursive: true });
    const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    await fs.writeFile(absolutePath, content, "utf8");
    const [bundle, file] = await Promise.all([
      getBundle(companyId),
      readFile(companyId, relativePath),
    ]);
    return { bundle, file };
  }

  async function deleteFile(
    companyId: string,
    relativePath: string,
  ): Promise<{ bundle: CompanyInstructionsBundle }> {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const bundle = await getBundle(companyId);
    return { bundle };
  }

  async function resolveEntryContent(companyId: string): Promise<string | null> {
    const rootPath = resolveCompanyInstructionsRoot(companyId);
    const entryPath = path.resolve(rootPath, entryFile);
    try {
      const content = await fs.readFile(entryPath, "utf8");
      return content.trim().length > 0 ? content : null;
    } catch {
      return null;
    }
  }

  return {
    getBundle,
    readFile,
    writeFile,
    deleteFile,
    resolveEntryContent,
  };
}
