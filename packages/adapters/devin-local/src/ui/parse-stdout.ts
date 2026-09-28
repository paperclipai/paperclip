import { type TranscriptEntry } from '@paperclipai/adapter-utils';
import { stripAnsi } from '../ansi.js';

// Devin's `-p` print lane streams the agent's final answer as plain markdown,
// so there is no structured event stream to decode. This parser classifies
// print-mode output: adapter/paperclip bookkeeping lines become system
// entries, everything else is the agent's answer.

const ADAPTER_LINE = /^\s*\[(adapter|paperclip)\]/i;

export function parseDevinStdoutLine(
  line: string,
  ts: string,
): TranscriptEntry[] {
  const trimmed = line.trim();
  if (trimmed.length === 0) return [];

  const cleaned = stripAnsi(line);
  const cleanedTrimmed = cleaned.trim();
  if (cleanedTrimmed.length === 0) return [];
  if (ADAPTER_LINE.test(cleanedTrimmed)) {
    return [{ kind: 'system', ts, text: cleanedTrimmed }];
  }
  return [{ kind: 'assistant', ts, text: cleaned }];
}
