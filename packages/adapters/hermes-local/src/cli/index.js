
import { createHermesStdoutParser } from '../server/parse.js';

const stdoutParser = createHermesStdoutParser();

/**
 * Minimal CLI adapter surface for hosts that want a stdout formatter entrypoint.
 * This is intentionally tiny because the main value lives in the structured
 * parser itself.
 *
 * @param {string} line
 * @param {boolean} debug
 */
export function formatStdoutEvent(line, debug = false) {
  const ts = new Date().toISOString();
  const entries = stdoutParser.parseLine(line, ts);
  for (const entry of entries) {
    if (entry.kind === 'assistant' || entry.kind === 'system') {
      process.stdout.write(`${entry.text}\n`);
    } else if (debug) {
      process.stdout.write(`${JSON.stringify(entry)}\n`);
    }
  }
}

export const type = 'hermes_local';
