import { promises as fs } from "node:fs";
import path from "node:path";
import { redactPublicSurfaceText } from "./public-surface-redaction.js";

export const PERSISTENCE_ARTIFACT_FILE_MODE = 0o600;

export type PersistenceRedactionResult = {
  text: string;
  redacted: boolean;
  redactionCount: number;
};

type FileSnapshot = {
  mtimeMs: number;
  size: number;
};

export type PersistenceArtifactSnapshot = Map<string, FileSnapshot>;

function isJsonlArtifact(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".jsonl");
}

async function walkJsonlFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkJsonlFiles(entryPath));
      continue;
    }
    if (entry.isFile() && isJsonlArtifact(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

export function redactPersistenceArtifactText(input: string): PersistenceRedactionResult {
  const result = redactPublicSurfaceText(input, { appendMarker: false });
  return {
    text: result.text,
    redacted: result.redacted,
    redactionCount: result.matches.length,
  };
}

export async function writeOwnerOnlyPersistenceArtifact(filePath: string, contents: string): Promise<void> {
  await fs.writeFile(filePath, contents, { encoding: "utf8", mode: PERSISTENCE_ARTIFACT_FILE_MODE });
  await fs.chmod(filePath, PERSISTENCE_ARTIFACT_FILE_MODE);
}

export async function appendOwnerOnlyPersistenceArtifact(filePath: string, contents: string): Promise<void> {
  await fs.appendFile(filePath, contents, { encoding: "utf8", mode: PERSISTENCE_ARTIFACT_FILE_MODE });
  await fs.chmod(filePath, PERSISTENCE_ARTIFACT_FILE_MODE);
}

export async function snapshotJsonlPersistenceArtifacts(root: string): Promise<PersistenceArtifactSnapshot> {
  const files = await walkJsonlFiles(root);
  const snapshot: PersistenceArtifactSnapshot = new Map();
  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;
    snapshot.set(filePath, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
    });
  }
  return snapshot;
}

export async function redactChangedJsonlPersistenceArtifacts(input: {
  root: string;
  before: PersistenceArtifactSnapshot;
}): Promise<{ filesChecked: number; filesChanged: number; redactionCount: number }> {
  const files = await walkJsonlFiles(input.root);
  let filesChecked = 0;
  let filesChanged = 0;
  let redactionCount = 0;

  for (const filePath of files) {
    const stat = await fs.stat(filePath).catch(() => null);
    if (!stat?.isFile()) continue;

    const previous = input.before.get(filePath);
    const changed = !previous || previous.mtimeMs !== stat.mtimeMs || previous.size !== stat.size;
    if (!changed) continue;

    filesChecked += 1;
    const original = await fs.readFile(filePath, "utf8");
    const redacted = redactPersistenceArtifactText(original);
    if (redacted.redacted) {
      await writeOwnerOnlyPersistenceArtifact(filePath, redacted.text);
      filesChanged += 1;
      redactionCount += redacted.redactionCount;
    } else {
      await fs.chmod(filePath, PERSISTENCE_ARTIFACT_FILE_MODE);
    }
  }

  return { filesChecked, filesChanged, redactionCount };
}
