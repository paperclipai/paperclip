
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createHermesStdoutParser,
  parseHermesOutput,
  parseHermesStdoutLine,
  isUnknownSessionError,
} from '../src/server/parse.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixturesDir = path.join(__dirname, 'fixtures');

function readFixture(name) {
  return fs.readFileSync(path.join(fixturesDir, name), 'utf8');
}

function parseFixtureTranscript(name, ts = '2026-01-01T00:00:00Z') {
  const parser = createHermesStdoutParser();
  return readFixture(name)
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .flatMap((line) => parser.parseLine(line, ts));
}

test('parseHermesOutput extracts final assistant text from non-quiet Hermes fixture output', () => {
  const stdout = `${readFixture('banner-simple.stdout')}\nsession_id: SESSION_ID`;
  const stderr = 'tokens: 12 input 34 output\ncost: $0.12';
  const parsed = parseHermesOutput(stdout, stderr);
  assert.equal(parsed.sessionId, 'SESSION_ID');
  assert.equal(parsed.response, 'OK');
  assert.deepEqual(parsed.usage, { inputTokens: 12, outputTokens: 34 });
  assert.equal(parsed.costUsd, 0.12);
});

test('parseHermesStdoutLine parses real Hermes tool preview rows', () => {
  const entries = parseHermesStdoutLine('  ┊ 💻 $         pwd  0.2s', '2026-01-01T00:00:00Z');
  assert.equal(entries.length, 2);
  assert.equal(entries[0].kind, 'tool_call');
  assert.equal(entries[0].name, 'shell');
  assert.deepEqual(entries[0].input, { command: 'pwd' });
  assert.equal(entries[1].kind, 'tool_result');
  assert.equal(entries[1].content, 'status: completed\nduration: 0.2s\n\npwd');
});

test('createHermesStdoutParser suppresses Hermes boilerplate and keeps assistant panels from fixture captures', () => {
  const ts = '2026-01-01T00:00:00Z';
  const entries = parseFixtureTranscript('banner-tool.stdout', ts);
  assert.deepEqual(
    entries,
    [
      {
        kind: 'tool_call',
        ts,
        name: 'shell',
        input: { command: 'pwd' },
        toolUseId: entries[0]?.toolUseId,
      },
      {
        kind: 'tool_result',
        ts,
        toolUseId: entries[0]?.toolUseId,
        toolName: 'shell',
        content: 'status: completed\nduration: 0.2s\n\npwd',
        isError: false,
      },
      { kind: 'assistant', ts, text: 'The current working directory is /home/toor.' },
    ]
  );
});

test('createHermesStdoutParser parses quiet tool previews without panel footers from fixture captures', () => {
  const ts = '2026-01-01T00:00:00Z';
  const entries = parseFixtureTranscript('quiet-tool.stdout', ts);
  assert.deepEqual(
    entries,
    [
      {
        kind: 'tool_call',
        ts,
        name: 'shell',
        input: { command: 'pwd' },
        toolUseId: entries[0]?.toolUseId,
      },
      {
        kind: 'tool_result',
        ts,
        toolUseId: entries[0]?.toolUseId,
        toolName: 'shell',
        content: 'status: completed\nduration: 0.2s\n\npwd',
        isError: false,
      },
      { kind: 'assistant', ts, text: 'The working directory is /home/toor.' },
    ]
  );
});

test('createHermesStdoutParser parses inline Hermes diffs from fixture captures', () => {
  const ts = '2026-01-01T00:00:00Z';
  const entries = parseFixtureTranscript('quiet-write-diff.stdout', ts);
  assert.deepEqual(
    entries,
    [
      {
        kind: 'tool_call',
        ts,
        name: 'write',
        input: { path: 'hello.txt' },
        toolUseId: entries[0]?.toolUseId,
      },
      {
        kind: 'tool_result',
        ts,
        toolUseId: entries[0]?.toolUseId,
        toolName: 'write',
        content: 'status: completed\nduration: 0.4s\n\nhello.txt',
        isError: false,
      },
      { kind: 'diff', ts, changeType: 'file_header', text: 'a/hello.txt -> b/hello.txt' },
      { kind: 'diff', ts, changeType: 'hunk', text: '@@ -0,0 +1 @@' },
      { kind: 'diff', ts, changeType: 'add', text: '+hello world' },
      {
        kind: 'assistant',
        ts,
        text: 'I have created the file `hello.txt` containing the text "hello world". Let me know if there\'s anything else you\'d like me to do!',
      },
    ]
  );
});

test('createHermesStdoutParser parses failed shell previews from fixture captures', () => {
  const ts = '2026-01-01T00:00:00Z';
  const entries = parseFixtureTranscript('quiet-failed-shell.stdout', ts);
  assert.deepEqual(
    entries,
    [
      {
        kind: 'tool_call',
        ts,
        name: 'shell',
        input: { command: 'exit 7' },
        toolUseId: entries[0]?.toolUseId,
      },
      {
        kind: 'tool_result',
        ts,
        toolUseId: entries[0]?.toolUseId,
        toolName: 'shell',
        content: 'status: failed\nexit_code: 7\nduration: 0.2s\n\nexit 7',
        isError: true,
      },
      {
        kind: 'assistant',
        ts,
        text: 'The shell command was executed and failed with an exit code of 7.',
      },
    ]
  );
});

test('createHermesStdoutParser suppresses skin-specific full banners and strips reasoning box borders', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    '╭──────────────────────── Ares Agent v0.7.0 (2026.4.3) ───────────────────────╮',
    '│ Available Tools │',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Query: explain the plan',
    '┌─ Reasoning ─────────────────────────────────────────────────────────────────┐',
    '│ First think step                                                           │',
    '│ Second think step                                                          │',
    '└─────────────────────────────────────────────────────────────────────────────┘',
    '╭─ ⚔ Ares ────────────────────────────────────────────────────────────────────╮',
    'The plan is ready.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    { kind: 'thinking', ts, text: 'First think step' },
    { kind: 'thinking', ts, text: 'Second think step' },
    { kind: 'assistant', ts, text: 'The plan is ready.' },
  ]);
});

test('parseToolCompletionLine recognizes the Hermes tool preview variants emitted by display.py', () => {
  const samples = [
    ['┊ 🔍 search    llm evals  0.3s', 'search'],
    ['┊ 📄 fetch     example.com  0.4s', 'fetch'],
    ['┊ 🕸️  crawl     example.com  0.5s', 'crawl'],
    ['┊ 💻 $         pwd  0.2s', 'shell'],
    ['┊ ⚙️  proc      ls processes  0.1s', 'process'],
    ['┊ 📖 read      README.md  0.1s', 'read'],
    ['┊ ✍️  write     hello.txt  0.1s', 'write'],
    ['┊ 🔧 patch     hello.txt  0.1s', 'patch'],
    ['┊ 🔎 grep      TODO  0.1s', 'search'],
    ['┊ 🌐 navigate  example.com  0.1s', 'browser'],
    ['┊ 📸 snapshot  compact  0.1s', 'browser'],
    ['┊ 👆 click     12  0.1s', 'browser'],
    ['┊ ⌨️  type      "hello"  0.1s', 'browser'],
    ['┊ ↓  scroll    down  0.1s', 'browser'],
    ['┊ ◀️  back      0.1s', 'browser'],
    ['┊ ⌨️  press     Enter  0.1s', 'browser'],
    ['┊ 🚪 close     browser  0.1s', 'browser'],
    ['┊ 🖼️  images    extracting  0.1s', 'browser'],
    ['┊ 👁️  vision    analyzing page  0.1s', 'browser'],
    ['┊ 📋 plan      update 3 task(s)  0.1s', 'plan'],
    ['┊ 🔍 recall    "cached query"  0.1s', 'recall'],
    ['┊ 🧠 memory    +facts: "remember this"  0.1s', 'memory'],
    ['┊ 📚 skills    list all  0.1s', 'skills'],
    ['┊ 📚 skill     dogfood  0.1s', 'skill'],
    ['┊ 🎨 create    sunset over ocean  0.1s', 'image'],
    ['┊ 🔊 speak     hello world  0.1s', 'speech'],
    ['┊ 👁️  vision    classify this image  0.1s', 'vision'],
    ['┊ 🧠 reason    compare options  0.1s', 'reason'],
    ['┊ 📨 send      worker: "please continue"  0.1s', 'message'],
    ['┊ ⏰ cron      create heartbeat  0.1s', 'cron'],
    ['┊ 🧪 rl        list envs  0.1s', 'rl'],
    ['┊ 🐍 exec      print("hi")  0.1s', 'execute_code'],
    ['┊ 🔀 delegate  2 parallel tasks  0.1s', 'delegate'],
    ['┊ ⚡ customtool sync cache  0.1s', 'customtool'],
    ['╎ 💻 $         pwd  0.2s', 'shell'],
    ['│ 🔍 search    roadmap  0.2s', 'search'],
  ];

  for (const [line, expectedName] of samples) {
    const parsed = parseHermesStdoutLine(line, '2026-01-01T00:00:00Z');
    assert.equal(parsed[0]?.kind, 'tool_call', line);
    assert.equal(parsed[0]?.name, expectedName, line);
    assert.equal(parsed[1]?.kind, 'tool_result', line);
  }
});

test('createHermesStdoutParser suppresses preparing and resume footer lines while preserving diff truncation entries', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    'session_id: SESSION_ID',
    '  ┊ 💻 preparing terminal…',
    '  ┊ review diff',
    'a/child.txt → b/child.txt',
    '@@ -0,0 +1 @@',
    '+delegated work',
    '… omitted 12 diff line(s)',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Delegation recorded.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Resume this session with:',
    '  hermes --resume 20260405_155219_11945e',
    '  hermes -c "Delegation follow-up"',
    'Session:        20260405_155219_11945e',
    'Title:          Delegation follow-up',
    'Duration:       20s',
    'Messages:       10 (1 user, 8 tool calls)',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    { kind: 'diff', ts, changeType: 'file_header', text: 'a/child.txt -> b/child.txt' },
    { kind: 'diff', ts, changeType: 'hunk', text: '@@ -0,0 +1 @@' },
    { kind: 'diff', ts, changeType: 'add', text: '+delegated work' },
    { kind: 'diff', ts, changeType: 'truncation', text: '… omitted 12 diff line(s)' },
    { kind: 'assistant', ts, text: 'Delegation recorded.' },
  ]);
});

test('createHermesStdoutParser suppresses ascii-dot preparing tool previews too', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    '  ┊ 💻 preparing terminal...',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Ready after preparing.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    { kind: 'assistant', ts, text: 'Ready after preparing.' },
  ]);
});

test('createHermesStdoutParser classifies Hermes operational status lines cleanly', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    '[@ context: 2 ref(s), 137 tokens]',
    '⚠ context injection refused for /tmp/secret.txt',
    'Failed to initialize agent: missing config.yaml',
    'Session not found: deadbeef',
    'Use a session ID from a previous CLI run (hermes sessions list).',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    { kind: 'system', ts, text: '[@ context: 2 ref(s), 137 tokens]' },
    { kind: 'stderr', ts, text: '⚠ context injection refused for /tmp/secret.txt' },
    { kind: 'stderr', ts, text: 'Failed to initialize agent: missing config.yaml' },
    { kind: 'stderr', ts, text: 'Session not found: deadbeef' },
    {
      kind: 'stderr',
      ts,
      text: 'Use a session ID from a previous CLI run (hermes sessions list).',
    },
  ]);
});

test('createHermesStdoutParser suppresses non-tty [tool] spinner lines before [done] completions', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    '  [tool] running terminal command',
    '[done] ┊ 💻 $         pwd  0.2s',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Spinner noise suppressed.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    {
      kind: 'tool_call',
      ts,
      name: 'shell',
      input: { command: 'pwd' },
      toolUseId: entries[0]?.toolUseId,
    },
    {
      kind: 'tool_result',
      ts,
      toolUseId: entries[0]?.toolUseId,
      toolName: 'shell',
      content: 'status: completed\nduration: 0.2s\n\npwd',
      isError: false,
    },
    { kind: 'assistant', ts, text: 'Spinner noise suppressed.' },
  ]);
});

test('cleanResponse suppresses bare fallback banner rows including MCP and no-skills summaries', () => {
  const parsed = parseHermesOutput(
    [
      '╭─────────────────────── Hermes Agent v0.7.0 (2026.4.3) ───────────────────────╮',
      '│ Available Tools │',
      '│ MCP Servers │',
      '│ Available Skills │',
      '│ No skills installed │',
      '│ 31 tools · 0 skills · /help for commands │',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
      '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
      'Hello from Hermes.',
      '╰──────────────────────────────────────────────────────────────────────────────╯',
    ].join('\n'),
    '',
  );

  assert.equal(parsed.response, 'Hello from Hermes.');
});

test('createHermesStdoutParser suppresses interactive-only Honcho and context pressure lines if they leak into stdout', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    'Honcho session: scratch-session',
    '  ⚠ context ▰▰▱▱▱ 20% to compaction  64k threshold (80%) · compaction approaching',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'Background noise suppressed.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    {
      kind: 'assistant',
      ts,
      text: 'Background noise suppressed.',
    },
  ]);
});

test('createHermesStdoutParser treats [thinking] previews as thinking and suppresses follow-up summary lines', () => {
  const ts = '2026-01-01T00:00:00Z';
  const parser = createHermesStdoutParser();
  const transcript = [
    '  [thinking] Compare the existing delegated issue with the completed child work.',
    '  Decide whether follow-up is still needed.',
    '╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮',
    'The delegated work is complete. I will mark the parent issue done.',
    '╰──────────────────────────────────────────────────────────────────────────────╯',
    'Resume this session with:',
    '  hermes --resume 20260405_155219_11945e',
    'Session:        20260405_155219_11945e',
    'Title:          Delegation follow-up',
    'Duration:       20s',
    'Messages:       10 (1 user, 8 tool calls)',
  ];

  const entries = transcript.flatMap((line) => parser.parseLine(line, ts));
  assert.deepEqual(entries, [
    {
      kind: 'thinking',
      ts,
      text: 'Compare the existing delegated issue with the completed child work.',
    },
    {
      kind: 'thinking',
      ts,
      text: 'Decide whether follow-up is still needed.',
    },
    {
      kind: 'assistant',
      ts,
      text: 'The delegated work is complete. I will mark the parent issue done.',
    },
  ]);
});

test('isUnknownSessionError detects resume failures', () => {
  assert.equal(isUnknownSessionError('', 'Unknown session: abc'), true);
  assert.equal(isUnknownSessionError('', 'all good'), false);
});
