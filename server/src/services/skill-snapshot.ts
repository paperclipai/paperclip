import { createHash } from 'node:crypto';
import type { CompanySkillVersionFileInventoryEntry } from '@paperclipai/shared';

export function skillFileBytes(file: { content: string; encoding?: string }): Buffer {
  return Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8');
}
export function snapshotFile(path: string, kind: CompanySkillVersionFileInventoryEntry['kind'], bytes: Buffer, executable = false): CompanySkillVersionFileInventoryEntry {
  const text = bytes.toString('utf8');
  const binary = bytes.includes(0) || !Buffer.from(text).equals(bytes);
  return { path, kind, content: binary ? bytes.toString('base64') : text,
    ...(binary ? { encoding: 'base64' as const } : {}), ...(executable ? { executable: true } : {}) };
}
export function skillSnapshotHash(files: CompanySkillVersionFileInventoryEntry[]) {
  const hash = createHash('sha256');
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path))) {
    hash.update(JSON.stringify([file.path, Boolean(file.executable), skillFileBytes(file).length]));
    hash.update(skillFileBytes(file));
  }
  return hash.digest('hex');
}
export function assertSkillSnapshotPath(value: string) {
  if (!value || value.startsWith('/') || value.includes('\\') || value.includes('\0') || /^[a-z]:/i.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) throw new Error('Invalid skill file path');
  return value;
}
