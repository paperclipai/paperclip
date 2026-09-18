import { describe, expect, it, vi } from 'vitest';
import {
  createServerAdapter,
  describeDevinFailure,
  extractDevinAnswer,
  isDevinUnknownSessionError,
  sessionCodec,
} from '@paperclipai/adapter-devin-local/server';
import { parseDevinStdoutLine } from '@paperclipai/adapter-devin-local/ui';
import { printDevinStreamEvent } from '@paperclipai/adapter-devin-local/cli';

const TS = '2026-08-09T00:00:00.000Z';

describe('devin_local server parser', () => {
  it('detects stale and unknown sessions on stderr only, never from agent stdout', () => {
    expect(
      isDevinUnknownSessionError('', 'Error: unknown session abc-123'),
    ).toBe(true);
    expect(
      isDevinUnknownSessionError('session id not found: abc-123', ''),
    ).toBe(false);
    expect(isDevinUnknownSessionError('all good', '')).toBe(false);
  });

  it('describes terminal failures from stderr first', () => {
    expect(
      describeDevinFailure('', 'Error: authentication failed, run devin login'),
    ).toContain('authentication failed');
    expect(describeDevinFailure('rate limited, retry later', '')).toContain(
      'rate limited',
    );
    expect(describeDevinFailure('the answer is 42', '')).toBeNull();
  });

  it('extracts the agent answer with adapter noise and ANSI stripped', () => {
    const stdout = [
      '[adapter] starting run',
      '\u001b[30mDone: fixed the parser.\u001b[0m',
      '[paperclip] posted comment',
    ].join('\n');
    const answer = extractDevinAnswer(stdout);
    expect(answer).toBe('Done: fixed the parser.');
  });
});

describe('devin_local ui stdout parser', () => {
  it('returns assistant text for plain print-mode lines', () => {
    const result = parseDevinStdoutLine('This is the answer.', TS);
    expect(result).toEqual([
      { kind: 'assistant', ts: TS, text: 'This is the answer.' },
    ]);
  });

  it('classifies adapter bookkeeping lines as system', () => {
    const result = parseDevinStdoutLine('[adapter] posted response', TS);
    expect(result).toEqual([
      { kind: 'system', ts: TS, text: '[adapter] posted response' },
    ]);
  });
});

describe('devin_local cli formatter', () => {
  it('prints plain print-mode output without throwing', () => {
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      printDevinStreamEvent('plain answer line', false);
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe('devin_local session codec', () => {
  it('round-trips sessionId, cwd, and the usage resume baseline', () => {
    const baseline = {
      totalSteps: 12,
      totalPromptTokens: 3456,
      totalCompletionTokens: 222,
      totalCachedTokens: 999,
    };
    const serialized = sessionCodec.serialize({
      sessionId: 'sess-1',
      cwd: '/tmp/work',
      resumeBaseline: baseline,
    });
    expect(serialized).toEqual({
      sessionId: 'sess-1',
      cwd: '/tmp/work',
      resumeBaseline: baseline,
    });
    expect(sessionCodec.deserialize(serialized)).toEqual({
      sessionId: 'sess-1',
      cwd: '/tmp/work',
      resumeBaseline: baseline,
    });
  });

  it('drops a malformed baseline on deserialize', () => {
    expect(
      sessionCodec.deserialize({
        sessionId: 'sess-1',
        resumeBaseline: { totalSteps: 'junk' },
      }),
    ).toEqual({ sessionId: 'sess-1' });
  });

  it('round-trips sessionId and cwd', () => {
    const serialized = sessionCodec.serialize({
      sessionId: 'sess-1',
      cwd: '/tmp/work',
    });
    expect(serialized).toEqual({ sessionId: 'sess-1', cwd: '/tmp/work' });
    expect(sessionCodec.deserialize(serialized)).toEqual({
      sessionId: 'sess-1',
      cwd: '/tmp/work',
    });
    expect(sessionCodec.getDisplayId(serialized)).toBe('sess-1');
  });

  it('rejects payloads without a session id', () => {
    expect(sessionCodec.deserialize({ cwd: '/tmp/work' })).toBeNull();
    expect(sessionCodec.deserialize(null)).toBeNull();
    expect(sessionCodec.serialize(null)).toBeNull();
  });
});

describe('devin_local server module', () => {
  it('exposes the expected adapter shape and capability flags', () => {
    const mod = createServerAdapter();
    expect(mod.type).toBe('devin_local');
    expect(typeof mod.execute).toBe('function');
    expect(typeof mod.testEnvironment).toBe('function');
    expect(mod.supportsLocalAgentJwt).toBe(true);
    expect(mod.supportsInstructionsBundle).toBe(true);
    expect(mod.instructionsPathKey).toBe('instructionsFilePath');
    expect(mod.requiresMaterializedRuntimeSkills).toBe(true);
    expect(mod.sessionCodec).toBeDefined();
    expect(mod.sessionManagement?.supportsSessionResume).toBe(true);
  });

  it('describes the runtime command; installCommand stays null (no curl|bash self-install)', () => {
    const mod = createServerAdapter();
    for (const config of [{}, { command: '/opt/devin/bin/devin' }]) {
      const spec = mod.getRuntimeCommandSpec?.(config);
      expect(spec?.detectCommand).toBe(spec?.command);
      expect(spec?.installCommand).toBeNull();
    }
    expect(mod.getRuntimeCommandSpec?.({})?.command).toBe('devin');
    expect(mod.getRuntimeCommandSpec?.({ command: '/opt/devin/bin/devin' })?.command).toBe('/opt/devin/bin/devin');
  });
});
