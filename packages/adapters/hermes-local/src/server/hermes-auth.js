
import path from 'node:path';
import { asRecord, asTrimmedString, fileExistsSync, readFileIfExistsSync, resolveHermesHome } from '../shared/utils.js';

/**
 * Best-effort parse of Hermes auth.json.
 * The file is not required for the adapter to work, so failures are non-fatal.
 *
 * @param {{config?: Record<string, unknown>, authPath?: string}=} options
 */
export function readHermesAuthFile(options = {}) {
  const authPath = options.authPath || path.join(resolveHermesHome(options.config || {}), 'auth.json');
  try {
    const raw = readFileIfExistsSync(authPath);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return asRecord(parsed);
  } catch {
    return {};
  }
}

/**
 * Hermes documentation notes that Anthropic / Claude credentials may live in
 * Claude Code's own credential store. We treat the presence of that file as a
 * credential hint during environment testing.
 */
export function detectClaudeCodeCredentialHint() {
  const candidates = [
    path.join(process.env.HOME || '', '.claude', '.credentials.json'),
    path.join(process.env.USERPROFILE || '', '.claude', '.credentials.json'),
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (fileExistsSync(candidate)) {
      return { found: true, path: candidate };
    }
  }
  return { found: false, path: '' };
}

/**
 * Lightweight detection of GitHub CLI / Copilot command availability.
 */
export function detectCopilotCommand(commandName = 'copilot') {
  const pathParts = String(process.env.PATH || '').split(path.delimiter);
  const suffixes = process.platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : [''];
  for (const dir of pathParts) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${commandName}${suffix}`);
      if (fileExistsSync(candidate)) return { found: true, path: candidate };
    }
  }
  return { found: false, path: '' };
}
