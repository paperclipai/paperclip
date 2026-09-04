import { describe, expect, it } from 'vitest';
import {
  isDevinUnknownSessionError,
  describeDevinFailure,
  extractDevinAnswer,
} from './parse.js';

describe('isDevinUnknownSessionError', () => {
  it('detects unknown/invalid/stale session phrasing on stderr', () => {
    expect(
      isDevinUnknownSessionError('', 'Error: unknown session abc123'),
    ).toBe(true);
    expect(isDevinUnknownSessionError('', 'session not found')).toBe(true);
    expect(isDevinUnknownSessionError('', 'could not resume session')).toBe(
      true,
    );
  });

  it("matches the CLI's real stale-session error on stderr", () => {
    // Captured verbatim from `devin -r <bogus>` (CLI 3000.6.12).
    expect(
      isDevinUnknownSessionError(
        '',
        "Error: No session found matching 'nope-not-a-session'",
      ),
    ).toBe(true);
  });

  it('never treats agent stdout as a session error (answers routinely contain such phrases)', () => {
    expect(
      isDevinUnknownSessionError('Error: unknown session abc123', ''),
    ).toBe(false);
    expect(
      isDevinUnknownSessionError(
        'I could not resume session state because...',
        '',
      ),
    ).toBe(false);
    expect(
      isDevinUnknownSessionError('Here is the final answer to your task.'),
    ).toBe(false);
  });
});

describe('describeDevinFailure', () => {
  it('surfaces a stderr failure line', () => {
    const detail = describeDevinFailure('', 'fatal: not authenticated');
    expect(detail).toContain('not authenticated');
  });

  it('returns null when there is no failure signal', () => {
    expect(
      describeDevinFailure('all good\n[adapter] posted response', ''),
    ).toBeNull();
  });

  it('ignores adapter bookkeeping lines when scanning stdout', () => {
    // The only line matching a failure phrase is an [adapter] line, which must be skipped.
    expect(
      describeDevinFailure(
        '[adapter] error while posting\nHere is your answer',
        '',
      ),
    ).toBeNull();
  });
});

describe('extractDevinAnswer', () => {
  it('strips adapter/paperclip bookkeeping lines and trims', () => {
    const stdout = [
      '[adapter] injected task context',
      'Hello, here is the plan.',
      '[paperclip] internal note',
      'Step 2.',
    ].join('\n');
    expect(extractDevinAnswer(stdout)).toBe(
      'Hello, here is the plan.\nStep 2.',
    );
  });

  it('returns an empty string when there is only adapter noise', () => {
    expect(extractDevinAnswer('[adapter] one\n[paperclip] two')).toBe('');
  });

  it('strips ANSI escape sequences from the final answer', () => {
    const stdout = [
      '\x1b[30mPlease review and approve or request changes.\x1b[0m',
      '\x1b[1;32m✓ Done\x1b[0m',
    ].join('\n');
    expect(extractDevinAnswer(stdout)).toBe(
      'Please review and approve or request changes.\n✓ Done',
    );
  });
});

describe('ANSI stripping', () => {
  it('detects session errors hidden in ANSI-colored output', () => {
    expect(
      isDevinUnknownSessionError('', '\x1b[31mError: unknown session\x1b[0m'),
    ).toBe(true);
  });

  it('surfaces failures from ANSI-colored stderr', () => {
    const detail = describeDevinFailure(
      '',
      '\x1b[31mfatal: not authenticated\x1b[0m',
    );
    expect(detail).toContain('not authenticated');
  });
});
